/**
 * Star Wars TCG — the deck picker.
 *
 * When a player arrives at the table a dialog opens for them alone. It offers three ways to get a
 * deck onto the table:
 *
 *   1. **Browse public decks** — every public list on swtcg-deckdb.com, searchable by name and
 *      filterable by side (Light / Dark / Vong / Neutral).
 *   2. **My decks** — the same catalogue narrowed to one deck-db username, which the player types
 *      once and the table remembers.
 *   3. **Paste a link** — the original flow: a deck id, or a whole `/deck/<id>` permalink.
 *
 * Choosing a deck spawns it as a face-down pile (plus its supply pile, when it has one), with card
 * art resolved from this mod's own catalogue.
 *
 * ## What this script may and may not do
 *
 * It has NO network access: the publish scanner rejects every browser networking API by name, and
 * it matches on raw text with no lexer — so naming one of them even inside a comment is itself a
 * publish failure. (An earlier version of this docstring listed them, and was rejected.) The
 * network hop happens server-side, in the `community.swtcg-deckdb` plugin's data half, and reaches
 * this script only through `api.callPlugin`.
 *
 * Both the plugin id and the function name at every call site are written as plain string
 * literals, inline. The scanner must be able to follow *mod call -> plugin function -> endpoint ->
 * origin* statically, so even a `var` holding the id reads as a computed target and fails publish
 * with `dynamic-plugin-call`.
 *
 * ## Only the host draws
 *
 * `api.setUiElement` is host-only — a player's or spectator's call REJECTS. Every peer runs this
 * script, so the first write is also how the script learns which peer it is on: it tries, and a
 * rejection means "not the host, do nothing". There is no `api.isHost()` and this needs none.
 *
 * The dialog is therefore built ON THE HOST and scoped to one audience with `visibility`, which is
 * what makes "a modal for the player who just joined" a normal replicated element rather than a
 * special case. Clicks come back through `onUiEvent` with `actorPeerId`, so the host can check that
 * the person pressing a button is the person the dialog was opened for.
 *
 * ## Only PUBLIC decks are readable
 *
 * The provider exposes no per-viewer identity to us and we send none upstream, so "My decks" is a
 * filter on the public catalogue's `owner_username`, not an authenticated view. A deck a player has
 * not made public on swtcg-deckdb.com cannot appear here, and saying so in the UI is better than
 * letting them hunt for it.
 *
 * ## Card art
 *
 * The deck-db plugin returns NAMES and counts only — it ships no card data or art, by design. So
 * this script resolves each name against the mod's OWN catalogue (`data/cardSchema.json` ->
 * `assets/cards/swtcg.cards.json`) with `api.resolveCards`, which returns the catalogue row for
 * each card including its absolute `art` URL. Those URLs are attached to the spawned pile as
 * `metadata.faceUrls` (keyed by card name), and the platform textures the card faces directly on
 * the table and in the hand drawer. Face URLs identify a card, so the platform redacts them for
 * face-down / hidden cards exactly like the card ids — a face-down pile leaks nothing.
 */

/* ------------------------------------------------------------------------------------------- */
/* Constants                                                                                     */
/* ------------------------------------------------------------------------------------------- */

/** Where an imported pile lands. Clear of the play mat's centre. */
var SPAWN_POSITION = { x: 0, y: 1.2, z: -2.5 };

/** Guard against a paste of a whole URL, and against the deck exceeding what a pile can hold. */
var MAX_DECK_ID_LENGTH = 16;
var MAX_STACK = 1000;

/** Deck rows drawn per page. Keeps one rebuild well inside the per-tick UI mutation budget. */
var PAGE_SIZE = 10;

/** How long a burst of typing is collapsed for before the results redraw. */
var SEARCH_REDRAW_DELAY_MS = 300;

/**
 * The provider's `side` codes, in the order the chips are drawn.
 *
 * `""` is the unfiltered chip rather than a code. `N` (Neutral) is rare — one deck in the whole
 * catalogue at the time of writing — but a side that exists and cannot be selected is worse than
 * a chip nobody presses.
 */
var SIDES = [
  { code: "", label: "All sides" },
  { code: "L", label: "Light" },
  { code: "D", label: "Dark" },
  { code: "Y", label: "Vong" },
  { code: "N", label: "Neutral" }
];

var VIEW_BROWSE = "browse";
var VIEW_MINE = "mine";
var VIEW_LINK = "link";

/* ------------------------------------------------------------------------------------------- */
/* Host state                                                                                    */
/* ------------------------------------------------------------------------------------------- */

/**
 * False once a UI write has been refused — i.e. this peer is not the host.
 *
 * Latched rather than re-tested per call: a refused peer would otherwise attempt (and log) a
 * rejection for every widget of every dialog it tries to build.
 */
var canDraw = true;

/** The public deck catalogue, fetched once and filtered locally. */
var catalogue = null;
var catalogueError = null;
var catalogueLoading = false;

/** Open dialogs, keyed by token. One per audience. */
var pickers = {};
var nextToken = 1;

/** The reopen button's element id, so it is created once and updated in place. */
var REOPEN_ID = "swtcg-reopen";

/* ------------------------------------------------------------------------------------------- */
/* Small helpers                                                                                 */
/* ------------------------------------------------------------------------------------------- */

function text(value) {
  return typeof value === "string" ? value : "";
}

function lower(value) {
  return text(value).toLowerCase();
}

/** The label for a provider side code. Unknown codes show as themselves rather than vanishing. */
function sideLabel(code) {
  for (var i = 0; i < SIDES.length; i += 1) {
    if (SIDES[i].code === code) {
      return SIDES[i].label;
    }
  }
  return code ? String(code) : "—";
}

/**
 * Accept either a bare deck id or a pasted permalink.
 *
 * The endpoint declares `deckId` as a `token`, so anything with a slash would be refused
 * server-side anyway — but refusing here gives the player a sentence instead of a generic failure.
 */
function normalizeDeckId(raw) {
  var value = text(raw).trim();
  var slash = value.lastIndexOf("/");
  if (slash >= 0) {
    value = value.slice(slash + 1);
  }
  var query = value.indexOf("?");
  if (query >= 0) {
    value = value.slice(0, query);
  }
  if (value.length === 0 || value.length > MAX_DECK_ID_LENGTH) {
    return null;
  }
  // Mirror the endpoint's `token` format: letters, digits, dot, underscore, hyphen.
  for (var i = 0; i < value.length; i += 1) {
    var c = value.charAt(i);
    var ok =
      (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") ||
      c === "." || c === "_" || c === "-";
    if (!ok) {
      return null;
    }
  }
  return value;
}

/**
 * Flatten `[{count, name}]` into one entry per physical card.
 *
 * `metadata.cards` is the ordered physical stack, so a playset of 4 is four entries, not one with
 * a count. Ids are made unique per copy because a repeated id in one pile is ambiguous to anything
 * that later addresses a single card.
 */
function expandCards(lines) {
  var entries = [];
  if (!lines || typeof lines.length !== "number") {
    return entries;
  }
  for (var i = 0; i < lines.length; i += 1) {
    var line = lines[i];
    if (!line || typeof line.name !== "string") {
      continue;
    }
    var count = typeof line.count === "number" && line.count > 0 ? Math.floor(line.count) : 1;
    for (var copy = 0; copy < count; copy += 1) {
      if (entries.length >= MAX_STACK) {
        return entries;
      }
      entries.push({ cardId: line.name + "#" + (copy + 1), faceDown: true });
    }
  }
  return entries;
}

/** Strip the `#copy` suffix `expandCards` adds, to recover the card name. */
function baseName(cardId) {
  var value = text(cardId);
  var hash = value.lastIndexOf("#");
  return hash >= 0 ? value.slice(0, hash) : value;
}

/**
 * Resolve every distinct card NAME in `entries` to its catalogue `art` URL.
 *
 * The deck-db plugin hands back names only; `api.resolveCards` reads the mod's own catalogue and
 * (via its name fallback) returns the row for each name, including `art`. Returns a plain object
 * keyed by card name, ready to be `metadata.faceUrls`.
 */
async function resolveFaceUrls(entries) {
  var names = [];
  var seen = {};
  for (var i = 0; i < entries.length; i += 1) {
    var name = baseName(entries[i].cardId);
    if (name && !seen[name]) {
      seen[name] = true;
      names.push(name);
    }
  }
  if (names.length === 0) {
    return {};
  }
  var rows = await api.resolveCards(names);
  var faceUrls = {};
  for (var r = 0; r < rows.length; r += 1) {
    var row = rows[r];
    var art = row && row.data ? row.data.art : null;
    if (typeof art === "string" && art.length > 0) {
      // Key by the base card id (the name) — `metadata.cards[].cardId` is `name#copy`, and the
      // platform maps a card back to its base id to find its face URL.
      faceUrls[row.cardId] = art;
    }
  }
  return faceUrls;
}

function spawnPile(label, entries, position, faceUrls) {
  if (entries.length === 0) {
    return false;
  }
  var metadata = {
    cards: entries,
    // Provenance, so a player can tell where a pile came from and re-import it later.
    swtcgDeckDbImport: true
  };
  if (faceUrls && Object.keys(faceUrls).length > 0) {
    // Absolute art URLs, keyed by card name. The platform textures the faces on the table and in
    // the hand, and redacts them for face-down/hidden cards so the pile leaks nothing.
    metadata.faceUrls = faceUrls;
  }
  api.createObject({
    kind: "deck",
    label: label,
    displayName: label,
    position: position,
    faceDown: true,
    stackCount: entries.length,
    metadata: metadata
  });
  return true;
}

/* ------------------------------------------------------------------------------------------- */
/* UI writes — every one of them goes through here                                               */
/* ------------------------------------------------------------------------------------------- */

/**
 * Write one element, and latch {@link canDraw} off when the host refuses.
 *
 * A refusal is the ONLY way this script learns it is running on a player rather than the host, so
 * it is caught here rather than at each of the twenty call sites.
 */
async function put(element) {
  if (!canDraw) {
    return null;
  }
  try {
    return await api.setUiElement(element);
  } catch (error) {
    canDraw = false;
    return null;
  }
}

async function drop(elementId) {
  if (!canDraw) {
    return;
  }
  try {
    await api.deleteUiElement(elementId);
  } catch (error) {
    canDraw = false;
  }
}

/* ------------------------------------------------------------------------------------------- */
/* The public deck catalogue                                                                     */
/* ------------------------------------------------------------------------------------------- */

/**
 * Load the public deck summaries once.
 *
 * Card lists are NOT included in this response — it is a browse index. The chosen deck's actual
 * list is fetched separately by {@link importDeckId}, so opening the dialog costs one request no
 * matter how many decks a player scrolls past.
 */
async function ensureCatalogue() {
  if (catalogue || catalogueLoading) {
    return;
  }
  catalogueLoading = true;
  catalogueError = null;

  // Both targets inline and literal — see the header note on `dynamic-plugin-call`.
  var result = await api.callPlugin("community.swtcg-deckdb", "publicDecks", {});

  catalogueLoading = false;
  if (!result || result.ok !== true || !result.data || typeof result.data.length !== "number") {
    // The failure enum is deliberately coarse — `unavailable | rate-limited | not-found | refused`
    // — so a plugin cannot probe its own budget. Say what the player can act on, not more.
    var reason = result && result.reason ? result.reason : "unavailable";
    catalogueError = reason === "rate-limited"
      ? "The deck database is busy. Try again shortly."
      : "Could not reach the deck database. You can still paste a deck link.";
    return;
  }

  var rows = [];
  for (var i = 0; i < result.data.length; i += 1) {
    var row = result.data[i];
    if (!row || typeof row.id !== "string") {
      continue;
    }
    rows.push({
      id: row.id,
      name: text(row.name) || "Untitled deck",
      side: text(row.side),
      format: text(row.format),
      pool: text(row.pool),
      owner: text(row.owner_username),
      cardCount: typeof row.card_count === "number" ? row.card_count : null
    });
  }
  catalogue = rows;
}

/** Every distinct owner in the catalogue, sorted — the "My decks" picker's options. */
function catalogueOwners() {
  var seen = {};
  var owners = [];
  var rows = catalogue || [];
  for (var i = 0; i < rows.length; i += 1) {
    var owner = rows[i].owner;
    if (owner && !seen[owner]) {
      seen[owner] = true;
      owners.push(owner);
    }
  }
  owners.sort(function (a, b) {
    return lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0;
  });
  return owners;
}

/** The rows one picker's current filters select, in catalogue order. */
function filterDecks(picker) {
  var rows = catalogue || [];
  var query = lower(picker.search).trim();
  var out = [];
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    if (picker.side && row.side !== picker.side) {
      continue;
    }
    if (picker.view === VIEW_MINE) {
      if (!picker.owner || lower(row.owner) !== lower(picker.owner)) {
        continue;
      }
    }
    if (query) {
      // Name, owner and format are all things a person types when hunting for a deck they half
      // remember, so all three are searched rather than the name alone.
      var haystack = lower(row.name) + " " + lower(row.owner) + " " + lower(row.format) + " " + lower(row.pool);
      if (haystack.indexOf(query) < 0) {
        continue;
      }
    }
    out.push(row);
  }
  return out;
}

/* ------------------------------------------------------------------------------------------- */
/* Dialog lifecycle                                                                              */
/* ------------------------------------------------------------------------------------------- */

/** Fresh picker state. `audience` is a `TableUiVisibilityTarget` — one peer, one seat, or all. */
function makePicker(audience, who) {
  var token = "p" + nextToken;
  nextToken += 1;
  var picker = {
    token: token,
    root: "swtcg-" + token,
    audience: audience,
    who: who || null,
    view: VIEW_BROWSE,
    side: "",
    search: "",
    owner: "",
    link: "",
    page: 0,
    status: "",
    busy: false,
    /** Deck id per drawn row, so a click resolves without the id being in the element id. */
    rowDeckIds: [],
    /** How many result rows currently exist, so a shorter page deletes the surplus. */
    rowCount: 0,
    /** Pending debounced results redraw, or null. See `scheduleResultsRedraw`. */
    redrawTimer: null
  };
  pickers[token] = picker;
  return picker;
}

function pickerFor(elementId) {
  var value = text(elementId);
  if (value.indexOf("swtcg-") !== 0) {
    return null;
  }
  var rest = value.slice("swtcg-".length);
  var dash = rest.indexOf("-");
  var token = dash < 0 ? rest : rest.slice(0, dash);
  return pickers[token] || null;
}

/** The trailing argument encoded in an element id (`swtcg-p1-side-L` -> `"L"`), or "". */
function argFor(elementId, kind) {
  var value = text(elementId);
  var marker = "-" + kind + "-";
  var at = value.indexOf(marker);
  return at < 0 ? "" : value.slice(at + marker.length);
}

/**
 * Is this interaction from the person the dialog belongs to?
 *
 * The dialog is only VISIBLE to its audience — `filterVisibleUiElements` never renders it for
 * anyone else — so this is a second, cheap check rather than the control. It matters because a
 * peer can post an interaction for an element it was never shown.
 */
function isAudience(picker, actorPeerId) {
  if (!picker || !picker.audience) {
    return false;
  }
  if (picker.audience.scope !== "players") {
    return true;
  }
  var ids = picker.audience.peerIds || [];
  for (var i = 0; i < ids.length; i += 1) {
    if (ids[i] === actorPeerId) {
      return true;
    }
  }
  return false;
}

async function closePicker(picker) {
  if (!picker) {
    return;
  }
  if (picker.redrawTimer !== null) {
    clearTimeout(picker.redrawTimer);
    picker.redrawTimer = null;
  }
  // Deleting the root takes the whole subtree with it, so the children need no individual drop.
  await drop(picker.root);
  delete pickers[picker.token];
}

/* ------------------------------------------------------------------------------------------- */
/* Rendering                                                                                     */
/* ------------------------------------------------------------------------------------------- */

/**
 * Build or refresh one dialog.
 *
 * Every element carries a STABLE id derived from the picker token, so a refresh is a series of
 * in-place updates rather than a delete-and-rebuild — which keeps a redraw well inside the
 * 120-mutations-per-tick budget and stops the dialog flickering when a filter changes.
 *
 * The one exception is the result rows: a shorter page deletes the surplus, because there is no
 * "hidden" flag on an element and an empty row is still a row.
 */
/**
 * Redraw ONLY the result list, its pager and the status line, after a short delay.
 *
 * Two separate savings, both needed. The delay collapses a burst of keystrokes into one
 * redraw; the narrower redraw costs ~13 `setUiElement` calls instead of ~30. Together they
 * keep typing comfortably inside the host's 120-mutations-per-tick budget, which a redraw per
 * keystroke blew through after four characters.
 *
 * `setTimeout` is the only timer a mod may use; the repeating one is refused by the publish
 * scanner, deliberately, so a mod cannot install a loop.
 */
function scheduleResultsRedraw(picker) {
  if (picker.redrawTimer !== null) {
    return;
  }
  picker.redrawTimer = setTimeout(function () {
    picker.redrawTimer = null;
    if (pickers[picker.token]) {
      void renderCatalogueView(picker);
      void renderStatus(picker);
    }
  }, SEARCH_REDRAW_DELAY_MS);
}

/** The status line, on its own, so an import can report without redrawing the whole dialog. */
async function renderStatus(picker) {
  await put({
    id: picker.root + "-status",
    parentId: picker.root,
    type: "text",
    order: 90,
    props: {
      text: picker.status,
      variant: picker.status.indexOf("Could not") === 0 || picker.status.indexOf("No public deck") === 0
        ? "error"
        : "caption"
    }
  });
}

async function renderPicker(picker) {
  if (!canDraw || !pickers[picker.token]) {
    return;
  }
  var id = picker.root;

  await put({
    id: id,
    type: "panel",
    visibility: picker.audience,
    presentation: {
      mode: "modal",
      title: "Choose your deck",
      subtitle: picker.who
        ? picker.who + " — pick a deck to put on the table."
        : "Pick a deck to put on the table.",
      size: "large",
      dismissible: true
    },
    layout: { direction: "column", gap: 10 },
    props: { onDismiss: "swtcgClose" }
  });

  await renderTabs(picker);
  if (picker.view === VIEW_LINK) {
    await renderLinkView(picker);
  } else {
    await renderCatalogueView(picker);
  }
  await renderStatus(picker);
}

async function renderTabs(picker) {
  var id = picker.root;
  await put({
    id: id + "-tabs",
    parentId: id,
    type: "layout",
    order: 0,
    layout: { direction: "row", gap: 6, wrap: true }
  });
  var tabs = [
    { view: VIEW_BROWSE, label: "Public decks" },
    { view: VIEW_MINE, label: "My decks" },
    { view: VIEW_LINK, label: "Paste a link" }
  ];
  for (var i = 0; i < tabs.length; i += 1) {
    await put({
      id: id + "-tab-" + tabs[i].view,
      parentId: id + "-tabs",
      type: "button",
      order: i,
      props: {
        text: tabs[i].label,
        variant: "ghost",
        selected: picker.view === tabs[i].view,
        onClick: "swtcgTab"
      }
    });
  }
}

async function renderLinkView(picker) {
  var id = picker.root;
  // The catalogue half is torn down so the two views cannot leave each other's controls behind.
  await clearCatalogueView(picker);

  await put({
    id: id + "-linkbox",
    parentId: id,
    type: "layout",
    order: 10,
    layout: { direction: "column", gap: 6 }
  });
  await put({
    id: id + "-linkhelp",
    parentId: id + "-linkbox",
    type: "text",
    order: 0,
    props: {
      text: "Paste a swtcg-deckdb.com deck link, or just its id (for example nmPcAc).",
      variant: "body"
    }
  });
  await put({
    id: id + "-linkinput",
    parentId: id + "-linkbox",
    type: "input",
    order: 1,
    props: { value: picker.link, placeholder: "Deck id or link", onChange: "swtcgLink" }
  });
  await put({
    id: id + "-linkgo",
    parentId: id + "-linkbox",
    type: "button",
    order: 2,
    props: { text: picker.busy ? "Importing…" : "Import deck", variant: "primary", disabled: picker.busy, onClick: "swtcgImportLink" }
  });
}

async function clearLinkView(picker) {
  await drop(picker.root + "-linkbox");
}

async function clearCatalogueView(picker) {
  await drop(picker.root + "-filters");
  await drop(picker.root + "-results");
  await drop(picker.root + "-pager");
  picker.rowCount = 0;
  picker.rowDeckIds = [];
}

async function renderCatalogueView(picker) {
  var id = picker.root;
  await clearLinkView(picker);

  /* ---- filters ---- */
  await put({
    id: id + "-filters",
    parentId: id,
    type: "layout",
    order: 10,
    layout: { direction: "column", gap: 6 }
  });
  await put({
    id: id + "-search",
    parentId: id + "-filters",
    type: "input",
    order: 0,
    props: { value: picker.search, placeholder: "Search by deck name, owner or format", onChange: "swtcgSearch" }
  });
  await put({
    id: id + "-sides",
    parentId: id + "-filters",
    type: "layout",
    order: 1,
    layout: { direction: "row", gap: 6, wrap: true, align: "center" }
  });
  for (var s = 0; s < SIDES.length; s += 1) {
    await put({
      id: id + "-side-" + (SIDES[s].code || "any"),
      parentId: id + "-sides",
      type: "button",
      order: s,
      props: {
        text: SIDES[s].label,
        variant: "ghost",
        selected: picker.side === SIDES[s].code,
        onClick: "swtcgSide"
      }
    });
  }

  if (picker.view === VIEW_MINE) {
    var owners = catalogueOwners();
    var options = [{ value: "", label: "— choose your deck-db name —" }];
    for (var o = 0; o < owners.length; o += 1) {
      options.push({ value: owners[o], label: owners[o] });
    }
    await put({
      id: id + "-owner",
      parentId: id + "-filters",
      type: "select",
      order: 2,
      props: {
        value: picker.owner,
        placeholder: "Your deck-db name",
        options: options,
        onChange: "swtcgOwner"
      }
    });
    await put({
      id: id + "-ownerhelp",
      parentId: id + "-filters",
      type: "text",
      order: 3,
      props: {
        text: "Only decks you have made PUBLIC on swtcg-deckdb.com appear here — nothing is signed in on your behalf.",
        variant: "caption"
      }
    });
  } else {
    await drop(id + "-owner");
    await drop(id + "-ownerhelp");
  }

  /* ---- results ---- */
  await put({
    id: id + "-results",
    parentId: id,
    type: "layout",
    order: 20,
    layout: { direction: "column", gap: 4, grow: true, scroll: true, maxHeight: 320 }
  });

  if (catalogueLoading) {
    await renderRows(picker, []);
    await putEmptyNote(picker, "Loading decks…");
    return;
  }
  if (catalogueError) {
    await renderRows(picker, []);
    await putEmptyNote(picker, catalogueError);
    return;
  }
  if (picker.view === VIEW_MINE && !picker.owner) {
    await renderRows(picker, []);
    await putEmptyNote(picker, "Choose your deck-db name to see your public decks.");
    return;
  }

  var matches = filterDecks(picker);
  var pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  if (picker.page >= pages) {
    picker.page = pages - 1;
  }
  var start = picker.page * PAGE_SIZE;
  var page = matches.slice(start, start + PAGE_SIZE);

  await renderRows(picker, page);
  if (matches.length === 0) {
    await putEmptyNote(picker, "No public deck matches those filters.");
  } else {
    await drop(picker.root + "-empty");
  }
  await renderPager(picker, matches.length, pages, start, page.length);
}

async function putEmptyNote(picker, message) {
  await put({
    id: picker.root + "-empty",
    parentId: picker.root + "-results",
    type: "text",
    order: 0,
    props: { text: message, variant: "caption" }
  });
}

/**
 * Draw one page of deck rows.
 *
 * Rows are POSITIONAL (`…-row-0`, `…-row-1`), never keyed by deck id: a page change then updates
 * ten elements in place instead of deleting ten and creating ten. The deck each row currently
 * stands for is remembered in `picker.rowDeckIds`, which is also what a click resolves against —
 * so a deck id never has to be encoded into an element id or a hook name.
 */
async function renderRows(picker, rows) {
  var id = picker.root;
  picker.rowDeckIds = [];
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    picker.rowDeckIds.push(row.id);
    var facts = [sideLabel(row.side)];
    if (row.owner) {
      facts.push(row.owner);
    }
    if (row.format) {
      facts.push(row.format);
    }
    if (row.cardCount !== null) {
      facts.push(row.cardCount + " cards");
    }
    await put({
      id: id + "-row-" + i,
      parentId: id + "-results",
      type: "button",
      order: i + 1,
      // A list row reads as a row, not as a centred label: making the button its own flex line
      // and justifying to the start is how the hint vocabulary spells left-aligned button text.
      layout: { direction: "row", justify: "start", align: "center" },
      props: {
        text: row.name + "  ·  " + facts.join(" · "),
        variant: "ghost",
        disabled: picker.busy,
        onClick: "swtcgPickDeck"
      }
    });
  }
  // A shorter page leaves rows behind, and an element has no hidden flag — so the surplus goes.
  for (var extra = rows.length; extra < picker.rowCount; extra += 1) {
    await drop(id + "-row-" + extra);
  }
  picker.rowCount = rows.length;
}

async function renderPager(picker, total, pages, start, shown) {
  var id = picker.root;
  if (pages <= 1) {
    await drop(id + "-pager");
    return;
  }
  await put({
    id: id + "-pager",
    parentId: id,
    type: "layout",
    order: 30,
    layout: { direction: "row", gap: 8, align: "center", justify: "between" }
  });
  await put({
    id: id + "-prev",
    parentId: id + "-pager",
    type: "button",
    order: 0,
    props: { text: "Previous", variant: "secondary", disabled: picker.page <= 0, onClick: "swtcgPrev" }
  });
  await put({
    id: id + "-count",
    parentId: id + "-pager",
    type: "text",
    order: 1,
    props: { text: (start + 1) + "–" + (start + shown) + " of " + total, variant: "caption" }
  });
  await put({
    id: id + "-next",
    parentId: id + "-pager",
    type: "button",
    order: 2,
    props: { text: "Next", variant: "secondary", disabled: picker.page >= pages - 1, onClick: "swtcgNext" }
  });
}

/* ------------------------------------------------------------------------------------------- */
/* Opening                                                                                       */
/* ------------------------------------------------------------------------------------------- */

/**
 * Open a dialog for one audience, replacing any dialog that audience already had.
 *
 * The catalogue load is awaited AFTER the first render so the dialog appears immediately with a
 * "Loading decks…" note, rather than the player waiting on a request before anything is drawn.
 */
async function openPicker(audience, who) {
  if (!canDraw) {
    return;
  }
  // One dialog per audience: a player who joins, leaves and rejoins must not accumulate them.
  var existing = Object.keys(pickers);
  for (var i = 0; i < existing.length; i += 1) {
    var other = pickers[existing[i]];
    if (other && sameAudience(other.audience, audience)) {
      await closePicker(other);
    }
  }

  var picker = makePicker(audience, who);
  await renderPicker(picker);
  if (!catalogue && !catalogueError) {
    await ensureCatalogue();
    // The dialog may have been dismissed while the request was in flight.
    if (pickers[picker.token]) {
      await renderPicker(picker);
    }
  }
}

function sameAudience(a, b) {
  if (!a || !b || a.scope !== b.scope) {
    return false;
  }
  if (a.scope === "players") {
    return (a.peerIds || []).join(",") === (b.peerIds || []).join(",");
  }
  if (a.scope === "seat") {
    return (a.seats || []).join(",") === (b.seats || []).join(",");
  }
  return true;
}

/**
 * The always-present way back in.
 *
 * A dialog that can only ever be opened by joining is a dialog a player loses for the rest of the
 * session the first time they dismiss it. This is one button, visible to everyone, that opens a
 * fresh dialog scoped to whoever pressed it.
 */
async function renderReopenButton() {
  await put({
    id: REOPEN_ID,
    type: "button",
    // NOT the upper-right corner. That is where the table toolbar sits on desktop, and on a
    // phone the toolbar covers it outright — the button shipped there and was unreachable.
    // The left edge is free at every width.
    presentation: { mode: "screen", anchor: "middle-left", offsetX: 12, offsetY: 0 },
    props: { text: "Choose a deck", variant: "secondary", onClick: "swtcgOpen" }
  });
}

/* ------------------------------------------------------------------------------------------- */
/* Importing                                                                                     */
/* ------------------------------------------------------------------------------------------- */

/** Fetch one decklist and put it on the table. Returns a status sentence for the dialog. */
async function importDeckId(deckId) {
  // Both targets inline and literal — see the header note on `dynamic-plugin-call`.
  var result = await api.callPlugin("community.swtcg-deckdb", "deckById", { deckId: deckId });

  if (!result || result.ok !== true) {
    var reason = result && result.reason ? result.reason : "unavailable";
    if (reason === "not-found") {
      return "No public deck with id " + deckId + ".";
    }
    if (reason === "rate-limited") {
      return "The deck database is busy. Try again shortly.";
    }
    return "Could not reach the deck database.";
  }

  var deck = result.data || {};
  var name = text(deck.name) || "Imported deck";
  var main = expandCards(deck.cards);
  var supply = expandCards(deck.supply);

  if (main.length === 0 && supply.length === 0) {
    return "That deck is empty.";
  }

  // Resolve art once for every distinct card across both piles.
  var faceUrls = await resolveFaceUrls(main.concat(supply));

  spawnPile(name, main, SPAWN_POSITION, faceUrls);
  if (supply.length > 0) {
    spawnPile(name + " — Supply", supply, {
      x: SPAWN_POSITION.x + 1.6,
      y: SPAWN_POSITION.y,
      z: SPAWN_POSITION.z
    }, faceUrls);
  }

  api.log("Imported " + name + ": " + main.length + " cards, " + supply.length + " supply.");
  return "Imported “" + name + "” — " + main.length + " cards"
    + (supply.length > 0 ? " and " + supply.length + " supply" : "") + ".";
}

/** Run an import for one dialog, keeping its busy state and status in step. */
async function runImport(picker, deckId) {
  if (picker.busy) {
    return;
  }
  picker.busy = true;
  picker.status = "Importing " + deckId + "…";
  await renderStatus(picker);

  var message = await importDeckId(deckId);

  picker.busy = false;
  if (!pickers[picker.token]) {
    return;
  }
  picker.status = message;
  await renderStatus(picker);
}

/* ------------------------------------------------------------------------------------------- */
/* Hooks                                                                                         */
/* ------------------------------------------------------------------------------------------- */

/**
 * Resolve the dialog an interaction belongs to, refusing anyone it does not belong to.
 *
 * Every hook below starts here, so the audience check is stated once. It is defence in depth: the
 * dialog is not rendered for anyone outside its audience in the first place.
 */
function ownerOf(payload) {
  var picker = pickerFor(payload && payload.elementId);
  if (!picker || !isAudience(picker, payload ? payload.actorPeerId : null)) {
    return null;
  }
  return picker;
}

api.on("swtcgTab", function (payload) {
  var picker = ownerOf(payload);
  if (!picker) {
    return;
  }
  var view = argFor(payload.elementId, "tab");
  if (view !== VIEW_BROWSE && view !== VIEW_MINE && view !== VIEW_LINK) {
    return;
  }
  picker.view = view;
  picker.page = 0;
  void renderPicker(picker);
});

api.on("swtcgSide", function (payload) {
  var picker = ownerOf(payload);
  if (!picker) {
    return;
  }
  var code = argFor(payload.elementId, "side");
  picker.side = code === "any" ? "" : code;
  picker.page = 0;
  void renderPicker(picker);
});

api.on("swtcgSearch", function (payload) {
  var picker = ownerOf(payload);
  if (!picker) {
    return;
  }
  picker.search = text(payload.value);
  picker.page = 0;
  // DEBOUNCED, and only the results are redrawn.
  //
  // A full redraw is ~30 `setUiElement` calls and the host allows 120 UI mutations per TICK
  // across every mod. Redrawing everything on each keystroke therefore exhausted the budget
  // after four characters, at which point `setUiElement` starts returning null and the dialog
  // silently stops updating — which is what "the search doesn't work and it locks up" was.
  scheduleResultsRedraw(picker);
});

api.on("swtcgOwner", function (payload) {
  var picker = ownerOf(payload);
  if (!picker) {
    return;
  }
  picker.owner = text(payload.value);
  picker.page = 0;
  void renderPicker(picker);
});

api.on("swtcgLink", function (payload) {
  var picker = ownerOf(payload);
  if (!picker) {
    return;
  }
  // Just record it. The field holds its own text on the client, so there is nothing to redraw
  // for a keystroke — and redrawing would spend the per-tick mutation budget for nothing.
  picker.link = text(payload.value);
});

api.on("swtcgImportLink", function (payload) {
  var picker = ownerOf(payload);
  if (!picker) {
    return;
  }
  var deckId = normalizeDeckId(picker.link);
  if (!deckId) {
    picker.status = "Enter a deck id, for example nmPcAc — or paste a deck link.";
    void renderPicker(picker);
    return;
  }
  void runImport(picker, deckId);
});

api.on("swtcgPickDeck", function (payload) {
  var picker = ownerOf(payload);
  if (!picker) {
    return;
  }
  var index = Number(argFor(payload.elementId, "row"));
  if (!(index >= 0) || index >= picker.rowDeckIds.length) {
    return;
  }
  void runImport(picker, picker.rowDeckIds[index]);
});

api.on("swtcgPrev", function (payload) {
  var picker = ownerOf(payload);
  if (!picker) {
    return;
  }
  picker.page = Math.max(0, picker.page - 1);
  void renderPicker(picker);
});

api.on("swtcgNext", function (payload) {
  var picker = ownerOf(payload);
  if (!picker) {
    return;
  }
  picker.page += 1;
  void renderPicker(picker);
});

api.on("swtcgClose", function (payload) {
  var picker = ownerOf(payload);
  if (!picker) {
    return;
  }
  // The close button dispatches this hook and deletes nothing by itself — UI elements are
  // replicated host state, so the dialog goes away when the mod says it does.
  void closePicker(picker);
});

api.on("swtcgOpen", function (payload) {
  var peerId = payload ? payload.actorPeerId : null;
  if (!peerId) {
    return;
  }
  void openPicker({ scope: "players", peerIds: [peerId] }, null);
});

/**
 * A player arrived. Open their dialog.
 *
 * Fires on every peer, but only the host's copy of this script can draw, so exactly one dialog is
 * created. It is scoped to the joiner's peer id, so nobody else sees it.
 */
api.on("onPeerJoined", function (payload) {
  if (!payload || typeof payload.peerId !== "string" || payload.role === "spectator") {
    return;
  }
  void openPicker({ scope: "players", peerIds: [payload.peerId] }, text(payload.displayName) || null);
});

/** A player left. Drop the dialog that was theirs, so it does not linger for a reused peer id. */
api.on("onPeerLeft", function (payload) {
  if (!payload || typeof payload.peerId !== "string") {
    return;
  }
  var tokens = Object.keys(pickers);
  for (var i = 0; i < tokens.length; i += 1) {
    var picker = pickers[tokens[i]];
    if (picker && isAudience(picker, payload.peerId)) {
      void closePicker(picker);
    }
  }
});

/**
 * Someone took a seat. Open their dialog if they do not already have one.
 *
 * `onPeerJoined` covers arrival; this covers the person who joined as a spectator and then sat
 * down, which is the other way a player ends up needing a deck.
 */
api.on("onSeatChanged", function (payload) {
  if (!payload || typeof payload.peerId !== "string" || !payload.seat || payload.previousSeat) {
    return;
  }
  void openPicker({ scope: "players", peerIds: [payload.peerId] }, null);
});

/* ------------------------------------------------------------------------------------------- */
/* Boot                                                                                          */
/* ------------------------------------------------------------------------------------------- */

/**
 * The host never receives an `onPeerJoined` for itself, so its own dialog is opened here.
 *
 * Scoped to the host's SEAT rather than a peer id, because a script has no way to ask for its own
 * peer id — and a seat is the more durable handle anyway. An unseated host gets the reopen button
 * and nothing more, which is right: a spectating host has no deck to draw.
 */
async function boot() {
  await renderReopenButton();
  if (!canDraw) {
    return;
  }
  var seat = api.getMySeat();
  if (seat) {
    await openPicker({ scope: "seat", seats: [seat] }, null);
  } else {
    await ensureCatalogue();
  }
}

void boot();
