/**
 * Star Wars TCG — the deck gate.
 *
 * A seat cannot play without a deck, so this script asks for one and keeps asking until it has it.
 * When a deck arrives it is not merely dumped on the table: the main list is shuffled into that
 * seat's Deck zone, the supply into its Supply zone, and one resource card is turned face up in
 * its Resource zone, each oriented to face the seat it belongs to.
 *
 * =====================================================================================
 * THE TWO HALVES
 * =====================================================================================
 *
 * This one file runs on every peer, and the halves do different jobs because the platform gives
 * them different powers:
 *
 *   * **The HOST draws and spawns.** `api.setUiElement` and `api.createObject` reject on anyone
 *     else, so every dialog at this table is built by the host's copy of this script and merely
 *     *shown* to whoever it is scoped to.
 *
 *   * **Each PLAYER reads its own library.** `api.listDecks` / `api.getDeck` read with the
 *     credentials of the peer that calls them, so only your own copy of this script can see your
 *     private decks — and the host's copy cannot, which is exactly right. The host asking on your
 *     behalf would either fail (the row is private) or, worse, list the HOST'S decks to you.
 *
 * `api.sendToHost` is the bridge. A player's copy reads its own shelf and sends the RESULT up; the
 * host's copy draws it and, when a deck is chosen, receives the decklist and puts it on the table.
 * There is no host-to-player direction and none is needed: everything the host decides is already
 * visible to everyone as replicated state.
 *
 * Nothing about identity travels in a message. `onHostMessage` carries `actorPeerId`, stamped by
 * the host from the data channel the message arrived on, and every authority decision below keys
 * on that — never on a seat or a peer id inside the payload, which would be the sender's claim
 * about itself.
 *
 * =====================================================================================
 * NO NETWORK
 * =====================================================================================
 *
 * This script has none. The publish scanner rejects every browser networking API by name and
 * matches on raw text with no lexer, so naming one even inside a comment is itself a publish
 * failure. The hop to swtcg-deckdb.com happens server-side, in the `community.swtcg-deckdb`
 * plugin's data half, and reaches this script only through `api.callPlugin`. The plugin id and the
 * function name are plain string literals at every call site: the scanner must be able to follow
 * *mod call -> plugin function -> endpoint -> origin* statically, so even a `var` holding the id
 * reads as a computed target and fails publish with `dynamic-plugin-call`.
 *
 * =====================================================================================
 * THE THREE ZONES
 * =====================================================================================
 *
 * Placement reads the seat's own zones with `api.listSeatZones` and matches them by their AUTHORED
 * NAME — `Deck`, `Supply`, `Resource`, as named on the seat template. That is what makes the
 * layout follow a seat that is moved, rotated or rescaled in Edit Mode rather than being pinned to
 * coordinates that quietly stop being right, and it is why both seats work from one template.
 *
 * A table whose seats lack them still works: piles land on a fallback shelf and the activity log
 * names the missing zone. Silence there would read as a broken mod.
 *
 * =====================================================================================
 * CARD ART
 * =====================================================================================
 *
 * The deck-db plugin returns NAMES and counts only; a DiceyTable deck stores card IDS. Either way
 * the faces are resolved against this mod's own catalogue (`data/cardSchema.json` ->
 * `assets/cards/swtcg.cards.json`) with `api.resolveCards`, which returns each row including its
 * absolute `art` URL. Those ride on the spawned pile as `metadata.faceUrls`; the platform textures
 * the faces on the table and in the hand drawer, and redacts them for face-down cards exactly like
 * the card ids, so a face-down pile leaks nothing.
 */

/* ------------------------------------------------------------------------------------------- */
/* Constants                                                                                     */
/* ------------------------------------------------------------------------------------------- */

/**
 * The authored zone names on this game's seat template.
 *
 * Matched case-insensitively against `ModSeatZone.name`. Rename a box in Edit Mode and rename it
 * here; nothing else in this file knows where anything goes.
 */
var ZONE_DECK = "Deck";
var ZONE_SUPPLY = "Supply";
var ZONE_RESOURCE = "Resource";

/**
 * Where a pile lands when the seat has no matching zone.
 *
 * A visible shelf clear of the play mat rather than the middle of the table: a pile obviously in
 * the wrong place beats one overlapping the board, and the activity log says which zone was
 * missing.
 */
var FALLBACK_ORIGIN = { x: 0, y: 1.2, z: -2.5 };
var FALLBACK_STEP = 0.6;

/** How high above a zone a piece is dropped. Enough to settle, not enough to bounce off. */
var DROP_HEIGHT = 0.25;

/** Guard against a paste of a whole URL, and against a deck exceeding what a pile can hold. */
var MAX_DECK_ID_LENGTH = 16;
var MAX_STACK = 1000;

/** Deck rows drawn per page. Keeps one rebuild well inside the per-tick UI mutation budget. */
var PAGE_SIZE = 8;

/** The catalogue `type` value that counts as a resource. */
var RESOURCE_TYPE = "resource";

/** Partition ids this game's `data/cardSchema.json` declares. */
var PARTITION_MAIN = "main";
var PARTITION_SUPPLY = "supply";
var PARTITION_RESOURCE = "resource";

/**
 * The provider's `side` codes, in the order the chips are drawn.
 *
 * `""` is the unfiltered chip rather than a code. `N` (Neutral) is rare — one deck in the whole
 * catalogue at the time of writing — but a side that exists and cannot be selected is worse than a
 * chip nobody presses.
 */
var SIDES = [
  { code: "", label: "All sides" },
  { code: "L", label: "Light" },
  { code: "D", label: "Dark" },
  { code: "Y", label: "Vong" },
  { code: "N", label: "Neutral" }
];

var VIEW_MINE = "mine";
var VIEW_COMMUNITY = "community";
var VIEW_BROWSE = "browse";
var VIEW_LINK = "link";

/** Message names on the player -> host channel. */
var MSG_DECKS = "swtcg-decks";
var MSG_LOAD = "swtcg-load";

/* ------------------------------------------------------------------------------------------- */
/* State                                                                                         */
/* ------------------------------------------------------------------------------------------- */

/**
 * False once a UI write has been refused — i.e. this peer is not the host.
 *
 * Latched rather than re-tested per call: a refused peer would otherwise attempt (and log) a
 * rejection for every widget of every dialog it tries to build. It is also, in practice, this
 * script's answer to "which half am I", which is why there is no `api.isHost()` and none is needed.
 */
var canDraw = true;

/** HOST: the deck-db public catalogue, fetched once and filtered locally. */
var catalogue = null;
var catalogueError = null;
var catalogueLoading = false;

/** HOST: open dialogs, keyed by token. One per audience. */
var pickers = {};
var nextToken = 1;

/** HOST: unique suffix for every object this script mints, so two spawns never collide. */
var nextObjectSerial = 1;

/** HOST: seats this script has placed a deck for, so the gate knows who is still waiting. */
var seatedDecks = {};

/** HOST: seat by peer id, built from the seat hooks. The ONLY way a peer id becomes a seat. */
var seatByPeer = {};

/**
 * HOST: the deck rows each peer has reported for itself, by peer id then scope.
 *
 * The host never asks for these — it cannot — so they arrive unsolicited from each peer's own
 * copy of this script and are simply held until a dialog wants to draw them.
 */
var reportedDecks = {};

/**
 * The key the HOST's own reported decks live under.
 *
 * A script cannot ask for its own peer id, so there is nothing to key the host's own entry on.
 * A reserved string is honest about that, and cannot collide with a peer id because a peer id is
 * a uuid.
 */
var SELF = "@self";

/** The nag button's element id, so it is created once and updated in place. */
var NAG_ID = "swtcg-nag";

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

/** A fresh, unique id for a pile or a card this script spawns. */
function mintId(kind, seat) {
  var id = "swtcg-" + kind + "-" + text(seat || "x") + "-" + nextObjectSerial;
  nextObjectSerial += 1;
  return id;
}

/**
 * Accept either a bare deck-db id or a pasted permalink.
 *
 * The endpoint declares `deckId` as a `token`, so anything with a slash would be refused
 * server-side anyway — but refusing here gives the player a sentence instead of a generic failure.
 */
function normalizeDeckDbId(raw) {
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
 * Flatten `[{count, name|cardId}]` into one entry per PHYSICAL card.
 *
 * `metadata.cards` is the ordered physical stack, so a playset of 4 is four entries and not one
 * with a count. Ids are made unique per copy because a repeated id in one pile is ambiguous to
 * anything that later addresses a single card.
 */
function expandCards(lines) {
  var entries = [];
  if (!lines || typeof lines.length !== "number") {
    return entries;
  }
  for (var i = 0; i < lines.length; i += 1) {
    var line = lines[i];
    if (!line) {
      continue;
    }
    var key = typeof line.cardId === "string" ? line.cardId : line.name;
    if (typeof key !== "string" || key.length === 0) {
      continue;
    }
    var count = typeof line.count === "number" && line.count > 0 ? Math.floor(line.count) : 1;
    for (var copy = 0; copy < count; copy += 1) {
      if (entries.length >= MAX_STACK) {
        return entries;
      }
      entries.push({ cardId: key + "#" + (copy + 1), faceDown: true });
    }
  }
  return entries;
}

/** Strip the `#copy` suffix `expandCards` adds, to recover the card key. */
function baseKey(cardId) {
  var value = text(cardId);
  var hash = value.lastIndexOf("#");
  return hash >= 0 ? value.slice(0, hash) : value;
}

/** Fisher-Yates, so a shuffled pile is shuffled rather than merely reordered. */
function shuffleEntries(entries) {
  for (var i = entries.length - 1; i > 0; i -= 1) {
    var j = Math.floor(Math.random() * (i + 1));
    var swap = entries[i];
    entries[i] = entries[j];
    entries[j] = swap;
  }
  return entries;
}

/* ------------------------------------------------------------------------------------------- */
/* UI writes — every one of them goes through here                                               */
/* ------------------------------------------------------------------------------------------- */

/**
 * Write one element, and latch {@link canDraw} off when the host refuses.
 *
 * A refusal is the ONLY way this script learns it is running on a player rather than the host, so
 * it is caught here rather than at each of the thirty call sites.
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
/* HOST: the seat's three zones                                                                  */
/* ------------------------------------------------------------------------------------------- */

/**
 * Does this zone answer to `name`?
 *
 * The AUTHORED box name, never the materialized `id`: an id derived from a seat template is a
 * string whose shape is not a contract and which is truncated for a long template id.
 */
function zoneAnswersTo(zone, name) {
  return lower(zone.name) === lower(name);
}

function findZone(zones, name) {
  for (var i = 0; i < zones.length; i += 1) {
    if (zoneAnswersTo(zones[i], name)) {
      return zones[i];
    }
  }
  return null;
}

/**
 * Resolve the three areas for one seat, with a fallback for each that is missing.
 *
 * Returns `{ deck, supply, resource, missing }`, where each area is `{ position, rotationY }` and
 * `missing` names the zones that were not found so the caller can say so once rather than thrice.
 */
async function areasForSeat(seat) {
  var zones = [];
  try {
    zones = await api.listSeatZones(seat);
  } catch (error) {
    // An unclaimed seat has no live zones, which is an ordinary state — degrade to the fallback
    // shelf rather than refusing the deck.
    zones = [];
  }

  var wanted = [
    { key: "deck", name: ZONE_DECK },
    { key: "supply", name: ZONE_SUPPLY },
    { key: "resource", name: ZONE_RESOURCE }
  ];
  var areas = { missing: [] };
  for (var i = 0; i < wanted.length; i += 1) {
    var zone = findZone(zones, wanted[i].name);
    if (zone) {
      areas[wanted[i].key] = {
        position: {
          x: zone.position.x,
          y: zone.position.y + DROP_HEIGHT,
          z: zone.position.z
        },
        // The zone's own yaw. This is what makes a pile face its seat instead of the table origin,
        // and omitting it does not look like a rotation bug — it looks like every card at the far
        // seat is upside down.
        rotationY: zone.rotationY
      };
    } else {
      areas.missing.push(wanted[i].name);
      areas[wanted[i].key] = {
        position: {
          x: FALLBACK_ORIGIN.x + i * FALLBACK_STEP,
          y: FALLBACK_ORIGIN.y,
          z: FALLBACK_ORIGIN.z
        },
        rotationY: 0
      };
    }
  }
  return areas;
}

/* ------------------------------------------------------------------------------------------- */
/* HOST: card data                                                                               */
/* ------------------------------------------------------------------------------------------- */

/**
 * Resolve every distinct card key in `entries` against this mod's own catalogue.
 *
 * `api.resolveCards` matches on the schema's `key` role and falls back to a name match, which is
 * what lets a deck-db list (names only) and a DiceyTable deck (ids) both resolve through one call.
 */
async function resolveRows(entries) {
  var keys = [];
  var seen = {};
  for (var i = 0; i < entries.length; i += 1) {
    var key = baseKey(entries[i].cardId);
    if (key && !seen[key]) {
      seen[key] = true;
      keys.push(key);
    }
  }
  if (keys.length === 0) {
    return {};
  }
  var rows = await api.resolveCards(keys);
  var byKey = {};
  for (var r = 0; r < rows.length; r += 1) {
    if (rows[r] && rows[r].cardId) {
      byKey[rows[r].cardId] = rows[r].data || {};
    }
  }
  return byKey;
}

/** The `art` URL for each resolved card, ready to become `metadata.faceUrls`. */
function faceUrlsFrom(byKey) {
  var faceUrls = {};
  var keys = Object.keys(byKey);
  for (var i = 0; i < keys.length; i += 1) {
    var art = byKey[keys[i]].art;
    if (typeof art === "string" && art.length > 0) {
      faceUrls[keys[i]] = art;
    }
  }
  return faceUrls;
}

/** Is this card a resource, according to the catalogue row resolved for it? */
function isResource(byKey, cardId) {
  var row = byKey[baseKey(cardId)];
  return !!row && lower(row.type) === RESOURCE_TYPE;
}

/**
 * Take ONE resource out of the first list that has one, and return it.
 *
 * The order is the game's, not an implementation detail: a deck that separates its resources says
 * which card it wants turned up, so that list is asked first; failing that the main deck, where a
 * resource normally sits; failing that the supply. Returns null when no list holds one.
 *
 * ⚠ It SPLICES. The card is moved to the resource zone, so leaving a copy behind would put the
 * same card on the table twice.
 */
function takeResource(byKey, lists) {
  for (var l = 0; l < lists.length; l += 1) {
    var entries = lists[l];
    if (!entries) {
      continue;
    }
    for (var i = 0; i < entries.length; i += 1) {
      if (isResource(byKey, entries[i].cardId)) {
        return entries.splice(i, 1)[0];
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------------------------------- */
/* HOST: placement                                                                               */
/* ------------------------------------------------------------------------------------------- */

/** Spawn one face-down pile at an area, and return its id (or null when there was nothing). */
function spawnPile(label, entries, area, faceUrls, seat) {
  if (entries.length === 0) {
    return null;
  }
  var id = mintId("pile", seat);
  var metadata = {
    cards: entries,
    // Provenance, so the gate can tell whose deck this is across a reload.
    swtcgDeckGate: true,
    swtcgSeat: seat
  };
  if (faceUrls && Object.keys(faceUrls).length > 0) {
    metadata.faceUrls = faceUrls;
  }
  api.createObject({
    id: id,
    kind: "deck",
    label: label,
    displayName: label,
    position: area.position,
    rotation: { x: 0, y: area.rotationY, z: 0 },
    faceDown: true,
    stackCount: entries.length,
    metadata: metadata
  });
  return id;
}

/**
 * Put one deck on the table for one seat: main, supply, and a resource.
 *
 * Returns a sentence for the dialog. Every branch returns one — a placement that silently does
 * nothing is the failure this whole script exists to remove.
 */
async function placeDeck(seat, name, mainLines, supplyLines, resourceLines) {
  var main = expandCards(mainLines);
  var supply = expandCards(supplyLines);
  var resources = expandCards(resourceLines);

  if (main.length === 0 && supply.length === 0 && resources.length === 0) {
    return "That deck is empty.";
  }

  // One catalogue pass for every card in every list: the art map and the resource search read the
  // same rows, and asking twice would resolve the same file twice.
  var byKey = await resolveRows(main.concat(supply).concat(resources));
  var faceUrls = faceUrlsFrom(byKey);

  // The resource comes out BEFORE the piles are built, so the card turned up in the resource zone
  // is not also sitting in the deck.
  var resource = takeResource(byKey, [resources, main, supply]);

  // Anything left in the resource partition belongs with the main deck: it is still part of the
  // deck, it simply was not the one card turned up.
  main = main.concat(resources);

  var areas = await areasForSeat(seat);
  shuffleEntries(main);

  var deckId = spawnPile(name, main, areas.deck, faceUrls, seat);
  if (deckId) {
    // The local shuffle above fixes the order the pile is CREATED with; this is the host's own
    // authoritative shuffle, which is the one players see happen and the event log records.
    api.objectAction(deckId, "shuffle");
  }
  if (supply.length > 0) {
    spawnPile(name + " — Supply", supply, areas.supply, faceUrls, seat);
  }

  if (resource) {
    var resourceKey = baseKey(resource.cardId);
    var row = byKey[resourceKey] || {};
    api.createObject({
      id: mintId("resource", seat),
      kind: "card",
      // For `kind: "card"` the label IS the card id, which is what lets the platform resolve its
      // face against the catalogue.
      label: resourceKey,
      displayName: typeof row.name === "string" && row.name.length > 0 ? row.name : resourceKey,
      position: areas.resource.position,
      rotation: { x: 0, y: areas.resource.rotationY, z: 0 },
      // A resource in play is public information, so it starts face up. The two PILES do not.
      faceDown: false,
      metadata: {
        cardId: resourceKey,
        swtcgDeckGate: true,
        swtcgSeat: seat,
        faceUrls: faceUrls
      }
    });
  }

  seatedDecks[seat] = true;

  var said = "Loaded “" + name + "” for " + seat + " — " + main.length + " cards";
  if (supply.length > 0) {
    said += ", " + supply.length + " supply";
  }
  said += resource ? ", and a resource." : ", but no resource card was found in it.";
  if (areas.missing.length > 0) {
    // Named, not swallowed. A pile on the fallback shelf with no explanation reads as a bug in the
    // mod rather than as a scene that has not been set up.
    said += " (This seat has no " + areas.missing.join(" or ") + " zone, so some pieces landed to"
      + " the side.)";
    api.log("Seat " + seat + " is missing zone(s): " + areas.missing.join(", "));
  }
  api.log(said);
  return said;
}

/* ------------------------------------------------------------------------------------------- */
/* HOST: the gate                                                                                */
/* ------------------------------------------------------------------------------------------- */

/**
 * Does this seat already have a deck on the table?
 *
 * Asks the TABLE rather than only this session's memory, so a host who reloads and rejoins is not
 * asked again for a seat whose deck is sitting right there.
 */
async function seatHasDeck(seat) {
  if (!seat) {
    return false;
  }
  if (seatedDecks[seat]) {
    return true;
  }
  var decks = [];
  try {
    decks = await api.listObjects({ kind: "deck" });
  } catch (error) {
    // A read that fails must not lock a player out: an unanswerable question counts as "no deck"
    // and the dialog opens. Being asked once too often is recoverable; being unable to start is not.
    return false;
  }
  for (var i = 0; i < decks.length; i += 1) {
    var meta = decks[i].metadata || {};
    if (meta.swtcgSeat === seat) {
      seatedDecks[seat] = true;
      return true;
    }
  }
  return false;
}

/**
 * The always-present way back in, and the nag half of the gate.
 *
 * A dialog that can only be opened by joining is a dialog a player loses for the session the first
 * time they dismiss it. This is one button that opens a fresh dialog for whoever pressed it, and
 * that keeps saying a deck is needed until one is there.
 */
async function renderNagButton(waiting) {
  await put({
    id: NAG_ID,
    type: "button",
    presentation: { mode: "screen", anchor: "upper-right", offsetX: 16, offsetY: 16 },
    props: {
      text: waiting ? "Choose your deck to start" : "Load another deck",
      variant: waiting ? "primary" : "secondary",
      onClick: "swtcgOpen"
    }
  });
}

/** Re-state the nag for one seat, once its deck status is known. */
async function refreshNag(seat) {
  var has = await seatHasDeck(seat);
  await renderNagButton(!has);
  return has;
}

/* ------------------------------------------------------------------------------------------- */
/* HOST: the deck-db catalogue                                                                   */
/* ------------------------------------------------------------------------------------------- */

/**
 * Load the public deck summaries once.
 *
 * Card lists are NOT in this response — it is a browse index. The chosen deck's list is fetched
 * separately, so opening the dialog costs one request no matter how many decks a player scrolls
 * past. This one runs on the HOST: a plugin call is performed server-side and is not scoped to a
 * person, so there is nothing here only the player could do.
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

/** The deck-db rows one picker's filters select, in catalogue order. */
function filterCatalogue(picker) {
  var rows = catalogue || [];
  var query = lower(picker.search).trim();
  var out = [];
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    if (picker.side && row.side !== picker.side) {
      continue;
    }
    if (query) {
      var haystack = lower(row.name) + " " + lower(row.owner) + " " + lower(row.format) + " " + lower(row.pool);
      if (haystack.indexOf(query) < 0) {
        continue;
      }
    }
    out.push(row);
  }
  return out;
}

/** Fetch one deck-db decklist and put it on the table. Returns a sentence for the dialog. */
async function importDeckDb(seat, deckId) {
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
  return await placeDeck(seat, text(deck.name) || "Imported deck", deck.cards, deck.supply, null);
}

/* ------------------------------------------------------------------------------------------- */
/* PLAYER: this peer's own deck library                                                          */
/* ------------------------------------------------------------------------------------------- */

/**
 * Read THIS peer's own deck rows and report them to the host.
 *
 * 🔴 **This is the half that cannot run on the host.** `api.listDecks` reads with the credentials
 * of the peer that calls it, so a host listing "mine" would list the HOST'S decks — and then draw
 * them into a dialog aimed at somebody else, which is a privacy failure rather than a wrong list.
 * Each peer reads its own and sends the result up; the host draws what it is given.
 *
 * The rows are projections, not the deck: a name, a count and an id. The decklist itself only
 * travels when a deck is actually chosen.
 */
async function reportMyDecks(scope, search) {
  var rows = [];
  try {
    rows = await api.listDecks({ scope: scope, search: text(search), limit: 40 });
  } catch (error) {
    // Empty already means "no decks", "nobody signed in" and "the read failed" — one answer, on
    // purpose — so a throw simply joins them.
    rows = [];
  }
  var summaries = [];
  for (var i = 0; i < (rows || []).length; i += 1) {
    var deck = rows[i];
    summaries.push({
      id: deck.id,
      name: deck.name,
      cards: deck.totals ? deck.totals.cards : 0,
      username: deck.username,
      formatId: deck.formatId,
      visibility: deck.visibility
    });
  }

  if (canDraw) {
    // I am the host, so there is nobody to send to — and, more usefully, no peer id to key on. A
    // script cannot ask for its own peer id, so the host's own dialog is keyed on {@link SELF}
    // instead and this is where that entry is written. One store, two ways in.
    storeReported(SELF, scope, summaries, search);
    return;
  }
  await api.sendToHost(MSG_DECKS, { scope: scope, search: text(search), rows: summaries });
}

/** Record one peer's reported rows and refresh whatever dialog is waiting on them. */
function storeReported(key, scope, rows, search) {
  var bucket = reportedDecks[key] || (reportedDecks[key] = {});
  bucket[scope] = { rows: rows, search: text(search) };
  var waiting = pickerForPeer(key);
  if (waiting) {
    void renderPicker(waiting);
  }
}

/**
 * Read one of THIS peer's decks in full and hand the host the list.
 *
 * The LIST travels, not the id. A deck row is owner-authoritative and defaults to private, so the
 * host cannot read it — whoever asked for it has to supply it. That is the same rule the
 * platform's own deck-load intent follows, for the same reason.
 */
async function sendMyDeck(deckId) {
  var deck = await api.getDeck(deckId);
  var payload = deck
    ? {
      deckId: deckId,
      name: deck.name,
      entries: deck.readable ? deck.entries : [],
      readable: !!deck.readable
    }
    // `null` is "no such deck you may read" — a deck made private since the list was drawn looks
    // exactly like one that never existed, on purpose.
    : { deckId: deckId, name: "", entries: [], readable: false, missing: true };

  if (canDraw) {
    // The host loading its OWN deck takes the same path a remote one does, so there is one
    // placement routine rather than two that can disagree.
    applyChosenDeck(api.getMySeat(), SELF, payload);
    return;
  }
  await api.sendToHost(MSG_LOAD, payload);
}

/* ------------------------------------------------------------------------------------------- */
/* HOST: dialog lifecycle                                                                        */
/* ------------------------------------------------------------------------------------------- */

/**
 * Fresh picker state.
 *
 * `audience` is a `TableUiVisibilityTarget` — one peer, one seat, or all. `peerId` is who the
 * dialog is FOR, which is how the host knows whose reported decks to draw in it.
 */
function makePicker(audience, seat, peerId) {
  var token = "p" + nextToken;
  nextToken += 1;
  var picker = {
    token: token,
    root: "swtcg-" + token,
    audience: audience,
    seat: seat || null,
    peerId: peerId || null,
    view: VIEW_MINE,
    side: "",
    search: "",
    link: "",
    page: 0,
    status: "",
    busy: false,
    /** Element-id suffixes of the rows currently drawn, so a shorter page deletes the surplus. */
    drawnRows: []
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

/**
 * The trailing argument encoded in an element id (`swtcg-p1-side-L` -> `"L"`), or "".
 *
 * Takes the whole remainder rather than one segment, which is what lets a DiceyTable deck id — a
 * uuid, full of dashes — ride in an element id unharmed.
 */
function argFor(elementId, kind) {
  var value = text(elementId);
  var marker = "-" + kind + "-";
  var at = value.indexOf(marker);
  return at < 0 ? "" : value.slice(at + marker.length);
}

/**
 * Is this interaction from the person the dialog belongs to?
 *
 * The dialog is only VISIBLE to its audience, so this is a second, cheap check rather than the
 * control. It matters because a peer can post an interaction for an element it was never shown.
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

async function closePicker(picker) {
  if (!picker) {
    return;
  }
  // Deleting the root takes the whole subtree with it, so the children need no individual drop.
  await drop(picker.root);
  delete pickers[picker.token];
}

/* ------------------------------------------------------------------------------------------- */
/* HOST: rendering                                                                               */
/* ------------------------------------------------------------------------------------------- */

/**
 * Build or refresh one dialog.
 *
 * Every element carries a STABLE id derived from the picker token, so a refresh is a series of
 * in-place updates rather than a delete-and-rebuild — which keeps a redraw well inside the
 * mutations-per-tick budget and stops the dialog flickering when a filter changes.
 */
async function renderPicker(picker) {
  if (!canDraw || !pickers[picker.token]) {
    return;
  }
  var id = picker.root;

  await put({
    id: id,
    type: "panel",
    // The audience, and the only reason this dialog belongs to one person.
    visibility: picker.audience,
    presentation: {
      mode: "modal",
      title: "Choose your deck",
      subtitle: picker.seat
        ? "The " + picker.seat + " seat needs a deck before you can play."
        : "Take a seat first — a deck belongs to a seat.",
      size: "large",
      // Dismissible on purpose: a player may want to look at the table first. The nag button keeps
      // the ask alive, so dismissing costs nothing.
      dismissible: true
    },
    layout: { direction: "column", gap: 10 },
    props: { onDismiss: "swtcgClose" }
  });

  await renderTabs(picker);
  if (picker.view === VIEW_LINK) {
    await renderLinkView(picker);
  } else if (picker.view === VIEW_BROWSE) {
    await renderCatalogueView(picker);
  } else {
    await renderSavedView(picker);
  }
  await put({
    id: id + "-status",
    parentId: id,
    type: "text",
    order: 90,
    props: {
      text: picker.status,
      variant: picker.status.indexOf("Could not") === 0 || picker.status.indexOf("That") === 0
        ? "error"
        : "caption"
    }
  });
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
  // "My decks" is offered to EVERYONE, and it is safe to because the rows in it were read by the
  // peer this dialog belongs to and sent up — never read here with the host's credentials.
  var tabs = [
    { view: VIEW_MINE, label: "My decks" },
    { view: VIEW_COMMUNITY, label: "Community decks" },
    { view: VIEW_BROWSE, label: "Deck database" },
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

/** The two DiceyTable views. Their rows come from the dialog's own peer, not from here. */
async function renderSavedView(picker) {
  var id = picker.root;
  await clearLinkView(picker);
  await drop(id + "-sides");

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
    props: {
      value: picker.search,
      placeholder: picker.view === VIEW_MINE ? "Search your decks" : "Search shared decks",
      onChange: "swtcgSavedSearch"
    }
  });
  await put({
    id: id + "-results",
    parentId: id,
    type: "layout",
    order: 20,
    layout: { direction: "column", gap: 4, grow: true, scroll: true, maxHeight: 300 }
  });

  var scope = picker.view === VIEW_MINE ? "mine" : "public";
  var reported = (reportedDecks[picker.peerId || ""] || {})[scope];
  if (!reported) {
    await renderRows(picker, []);
    await putEmptyNote(picker, "Looking for your decks…");
    await drop(id + "-pager");
    return;
  }

  var rows = reported.rows || [];
  var pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (picker.page >= pages) {
    picker.page = pages - 1;
  }
  var start = picker.page * PAGE_SIZE;
  var page = rows.slice(start, start + PAGE_SIZE);

  var drawn = [];
  for (var i = 0; i < page.length; i += 1) {
    var deck = page[i];
    var facts = [deck.cards + " cards"];
    if (deck.username) {
      facts.push(deck.username);
    }
    if (deck.formatId) {
      facts.push(deck.formatId);
    }
    if (deck.visibility === "private") {
      facts.push("private");
    }
    drawn.push({ kind: "saved", id: deck.id, text: deck.name, facts: facts });
  }

  await renderRows(picker, drawn);
  if (rows.length === 0) {
    await putEmptyNote(
      picker,
      picker.view === VIEW_MINE
        ? "No saved decks for this game yet. Build or import one on the game's page, or use the"
          + " deck database tab."
        : "Nobody has shared a public deck for this game yet. Try the deck database tab."
    );
  } else {
    await drop(id + "-empty");
  }
  await renderPager(picker, rows.length, pages, start, page.length);
}

async function renderCatalogueView(picker) {
  var id = picker.root;
  await clearLinkView(picker);

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
  await put({
    id: id + "-results",
    parentId: id,
    type: "layout",
    order: 20,
    layout: { direction: "column", gap: 4, grow: true, scroll: true, maxHeight: 300 }
  });

  // Fetched HERE rather than only when a dialog opens on this tab: a player usually arrives on
  // another one and switches, and loading only at open time left this tab permanently empty for
  // anyone who did not start on it.
  if (!catalogue && !catalogueError && !catalogueLoading) {
    await renderRows(picker, []);
    await putEmptyNote(picker, "Loading decks…");
    await ensureCatalogue();
    if (!pickers[picker.token]) {
      return;
    }
    await renderCatalogueView(picker);
    return;
  }
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

  var matches = filterCatalogue(picker);
  var pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  if (picker.page >= pages) {
    picker.page = pages - 1;
  }
  var start = picker.page * PAGE_SIZE;
  var page = matches.slice(start, start + PAGE_SIZE);

  var drawn = [];
  for (var i = 0; i < page.length; i += 1) {
    var row = page[i];
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
    drawn.push({ kind: "deckdb", id: row.id, text: row.name, facts: facts });
  }

  await renderRows(picker, drawn);
  if (matches.length === 0) {
    await putEmptyNote(picker, "No public deck matches those filters.");
  } else {
    await drop(id + "-empty");
  }
  await renderPager(picker, matches.length, pages, start, page.length);
}

async function renderLinkView(picker) {
  var id = picker.root;
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
    props: {
      text: picker.busy ? "Loading…" : "Load this deck",
      variant: "primary",
      disabled: picker.busy,
      onClick: "swtcgImportLink"
    }
  });
}

async function clearLinkView(picker) {
  await drop(picker.root + "-linkbox");
}

async function clearCatalogueView(picker) {
  await drop(picker.root + "-filters");
  await drop(picker.root + "-results");
  await drop(picker.root + "-pager");
  picker.drawnRows = [];
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
 * 🔴 **The deck id is IN the element id**, not in a positional side table. That is what lets the
 * player's copy of this script resolve a click to the same deck the host resolves it to, without
 * either side mirroring the other's paging, filtering or ordering — the two peers share the
 * element id and nothing else. `argFor` takes the whole remainder after the marker, so a uuid full
 * of dashes survives it.
 */
async function renderRows(picker, drawn) {
  var id = picker.root;
  var wanted = [];
  for (var i = 0; i < drawn.length; i += 1) {
    var suffix = drawn[i].kind + "-" + drawn[i].id;
    wanted.push(suffix);
    await put({
      id: id + "-row-" + suffix,
      parentId: id + "-results",
      type: "button",
      order: i + 1,
      // A list row reads as a row, not a centred label: making the button its own flex line and
      // justifying to the start is how the hint vocabulary spells left-aligned button text.
      layout: { direction: "row", justify: "start", align: "center" },
      props: {
        text: drawn[i].facts.length > 0
          ? drawn[i].text + "  ·  " + drawn[i].facts.join(" · ")
          : drawn[i].text,
        variant: "ghost",
        disabled: picker.busy,
        onClick: "swtcgPickDeck"
      }
    });
  }
  // Rows are keyed by deck rather than by position, so a page change is a different SET and the
  // ones that left have to go — an element has no hidden flag.
  for (var old = 0; old < picker.drawnRows.length; old += 1) {
    if (wanted.indexOf(picker.drawnRows[old]) < 0) {
      await drop(id + "-row-" + picker.drawnRows[old]);
    }
  }
  picker.drawnRows = wanted;
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
/* HOST: opening and loading                                                                     */
/* ------------------------------------------------------------------------------------------- */

/**
 * Open a dialog for one audience, unless that seat already has a deck.
 *
 * `force` is what the nag button passes: somebody who deliberately asks for the picker gets it
 * even when they are already set up, because loading a second deck is a legitimate thing to want.
 */
async function openPicker(audience, seat, peerId, force) {
  if (!canDraw) {
    return;
  }
  if (!force && await seatHasDeck(seat)) {
    await renderNagButton(false);
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

  var picker = makePicker(audience, seat, peerId);
  await renderPicker(picker);
}

/** Run a load for one dialog, keeping its busy state and status in step. */
async function runLoad(picker, task) {
  if (picker.busy) {
    return;
  }
  if (!picker.seat) {
    picker.status = "Take a seat first — a deck belongs to a seat.";
    await renderPicker(picker);
    return;
  }
  picker.busy = true;
  picker.status = "Loading…";
  await renderPicker(picker);

  var message;
  try {
    message = await task();
  } catch (error) {
    message = "That deck could not be loaded.";
  }

  picker.busy = false;
  if (!pickers[picker.token]) {
    return;
  }
  picker.status = message;
  await renderPicker(picker);
  await refreshNag(picker.seat);
}

/** The open dialog belonging to one peer, or null. */
function pickerForPeer(peerId) {
  var tokens = Object.keys(pickers);
  for (var i = 0; i < tokens.length; i += 1) {
    if (pickers[tokens[i]].peerId === peerId) {
      return pickers[tokens[i]];
    }
  }
  return null;
}

/* ------------------------------------------------------------------------------------------- */
/* The player -> host channel                                                                    */
/* ------------------------------------------------------------------------------------------- */

/**
 * HOST: a peer reported its own decks, or handed over one it chose.
 *
 * 🔴 Every decision here keys on `message.actorPeerId`, which the host stamped from the data
 * channel the message arrived on. A seat named inside the payload would be the sender's claim
 * about itself; the seat used below comes from this script's own record of the seat hooks.
 */
/**
 * HOST: place a deck somebody chose, and tell their dialog what happened.
 *
 * `seat` is the caller's to establish and is never taken from `payload` — see the hook below.
 * `pickerKey` is only ever used to find the dialog to update, so a wrong one loses a status line
 * rather than putting cards in the wrong place.
 */
function applyChosenDeck(seat, pickerKey, payload) {
  var picker = pickerForPeer(pickerKey);
  var settle = function (status) {
    if (!picker || !pickers[picker.token]) {
      return;
    }
    // 🔴 **The load can finish BEFORE the host's own copy of the click runs**, and does whenever
    // the chooser is the host: the interaction is dispatched to the actor first, and a local read
    // needs no round trip, so the whole load completes inside the microtask the dispatcher yields
    // between the two handlers. The click handler would then write "Loading…" over a finished
    // result and leave it there forever, because nothing renders again.
    //
    // Recording the deck lets that handler recognise its own already-finished load and leave the
    // status alone. It is a CORRELATION id and nothing else — the deck a message is about, not a
    // claim about who sent it.
    picker.justSettled = typeof payload.deckId === "string" ? payload.deckId : "?";
    picker.busy = false;
    picker.status = status;
    void renderPicker(picker);
  };

  if (!seat) {
    settle("Take a seat first — a deck belongs to a seat.");
    return;
  }
  if (payload.missing) {
    settle("That deck is no longer available.");
    return;
  }
  if (payload.readable === false) {
    // The row exists and its list could not be parsed. Placing `entries` here would put an empty
    // pile on the table and look as though the deck had been emptied.
    settle("“" + text(payload.name) + "” could not be read, so nothing was placed.");
    return;
  }
  if (!Array.isArray(payload.entries)) {
    settle("That deck could not be read.");
    return;
  }

  // Split by partition. A null partition is the schema's default, which for this game is the main
  // deck.
  var main = [];
  var supply = [];
  var resources = [];
  for (var i = 0; i < payload.entries.length; i += 1) {
    var entry = payload.entries[i];
    if (!entry || typeof entry.cardId !== "string") {
      continue;
    }
    var partition = lower(entry.partitionId || PARTITION_MAIN);
    if (partition === PARTITION_RESOURCE) {
      resources.push(entry);
    } else if (partition === PARTITION_SUPPLY) {
      supply.push(entry);
    } else {
      main.push(entry);
    }
  }

  void (async function () {
    var said = await placeDeck(seat, text(payload.name) || "Deck", main, supply, resources);
    settle(said);
    await refreshNag(seat);
  })();
}

api.on("onHostMessage", function (message) {
  if (!message || typeof message.actorPeerId !== "string") {
    return;
  }
  if (message.actorRole === "spectator") {
    // A spectator can run this mod and can send. It has no seat and no deck to place.
    return;
  }
  var data = message.data || {};

  if (message.name === MSG_DECKS) {
    storeReported(
      message.actorPeerId,
      data.scope === "public" ? "public" : "mine",
      Array.isArray(data.rows) ? data.rows : [],
      data.search
    );
    return;
  }

  if (message.name === MSG_LOAD) {
    // 🔴 The seat comes from THIS script's own record of the seat hooks, keyed on the peer id the
    // host stamped from the channel. A seat inside `data` would be the sender's claim about
    // itself, and believing it would let one player dump a deck into another player's zones.
    applyChosenDeck(seatByPeer[message.actorPeerId], message.actorPeerId, data);
  }
});

/* ------------------------------------------------------------------------------------------- */
/* Hooks — UI                                                                                    */
/* ------------------------------------------------------------------------------------------- */

/**
 * The dialog an interaction belongs to, refusing anyone it does not belong to.
 *
 * HOST-side only: on a player `pickers` is empty, so this answers null and the player's half of
 * each handler runs from the element id alone.
 */
function ownerOf(payload) {
  var picker = pickerFor(payload && payload.elementId);
  if (!picker || !isAudience(picker, payload ? payload.actorPeerId : null)) {
    return null;
  }
  return picker;
}

/**
 * Should THIS peer run the LOCAL-LIBRARY half of an interaction?
 *
 * 🔴 **The bug this closes.** A UI interaction is dispatched to the actor's own peer AND to the
 * host, so a handler that reads the local library ran on BOTH — and the host's copy would call
 * `api.getDeck` for a deck belonging to somebody else. A private one answers null (an odd status
 * line on the host's own dialog); a PUBLIC one answers, and the host would then place the same
 * deck twice: once from its own read and once from the message the real chooser sent.
 *
 * A player only ever receives its own interactions, so on a player the answer is always yes. On
 * the host it is yes only for the host's OWN dialog, which is the one keyed on {@link SELF} —
 * every other dialog belongs to a player, and its local half belongs to that player's peer.
 */
function isActorPeer(payload) {
  if (!canDraw) {
    return true;
  }
  var picker = pickerFor(payload && payload.elementId);
  return !!picker && picker.peerId === SELF;
}

api.on("swtcgTab", function (payload) {
  var view = argFor(payload && payload.elementId, "tab");
  if (view !== VIEW_MINE && view !== VIEW_COMMUNITY && view !== VIEW_BROWSE && view !== VIEW_LINK) {
    return;
  }

  // PLAYER half: switching to a DiceyTable view is the cue to read my own shelf and report it.
  // Guarded, because this handler also runs on the host for a PLAYER'S click — see isActorPeer.
  if (isActorPeer(payload) && (view === VIEW_MINE || view === VIEW_COMMUNITY)) {
    void reportMyDecks(view === VIEW_MINE ? "mine" : "public", "");
  }

  // HOST half.
  var picker = ownerOf(payload);
  if (!picker) {
    return;
  }
  picker.view = view;
  picker.page = 0;
  picker.status = "";
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
  void renderPicker(picker);
});

api.on("swtcgSavedSearch", function (payload) {
  // PLAYER half: the saved views search server-side, so a new term is a new query rather than a
  // filter over the page already in hand — otherwise the box only ever searches the first page.
  var term = text(payload && payload.value);

  // PLAYER half. The rows in any saved view were read by the peer the dialog belongs to, so a
  // new term is a new read on THAT peer. Both scopes are re-reported, which costs two reads of
  // the person's own library and spares this handler having to know which tab is drawn.
  if (isActorPeer(payload)) {
    void reportMyDecks("mine", term);
    void reportMyDecks("public", term);
  }

  // HOST half: remember the term so the input keeps what was typed across a re-render.
  var picker = ownerOf(payload);
  if (!picker) {
    return;
  }
  picker.search = term;
  picker.page = 0;
  void renderPicker(picker);
});

api.on("swtcgLink", function (payload) {
  var picker = ownerOf(payload);
  if (!picker) {
    return;
  }
  picker.link = text(payload.value);
});

api.on("swtcgImportLink", function (payload) {
  var picker = ownerOf(payload);
  if (!picker) {
    return;
  }
  var deckId = normalizeDeckDbId(picker.link);
  if (!deckId) {
    picker.status = "That does not look like a deck id or a deck link.";
    void renderPicker(picker);
    return;
  }
  void runLoad(picker, function () {
    return importDeckDb(picker.seat, deckId);
  });
});

/**
 * A deck row was clicked.
 *
 * Both halves read the SAME element id and reach the same deck, which is why the id carries the
 * deck rather than a position: neither peer has to mirror the other's paging or filtering.
 */
api.on("swtcgPickDeck", function (payload) {
  var suffix = argFor(payload && payload.elementId, "row");
  var dash = suffix.indexOf("-");
  var kind = dash < 0 ? "" : suffix.slice(0, dash);
  var deckId = dash < 0 ? "" : suffix.slice(dash + 1);
  if (!kind || !deckId) {
    return;
  }

  // PLAYER half: a DiceyTable deck can only be read by the peer that owns it, so that peer reads
  // it and sends the list up. A deck-db deck needs nothing from here — the host can ask the
  // plugin itself.
  //
  // Guarded on isActorPeer, and that guard is load-bearing rather than tidy: without it the host
  // ALSO reads, and for a public deck it would place the same one twice.
  if (kind === "saved" && isActorPeer(payload)) {
    void sendMyDeck(deckId);
  }

  // HOST half.
  var picker = ownerOf(payload);
  if (!picker) {
    return;
  }
  if (kind === "deckdb") {
    void runLoad(picker, function () {
      return importDeckDb(picker.seat, deckId);
    });
    return;
  }
  // The saved case completes when the chooser's list arrives on `onHostMessage`. Showing the busy
  // state now is what stops a second click racing the first — UNLESS this click's load has already
  // landed, which happens when the chooser is the host and no round trip was needed. See settle.
  if (picker.justSettled === deckId) {
    picker.justSettled = null;
    return;
  }
  picker.busy = true;
  picker.status = "Loading…";
  void renderPicker(picker);
});

api.on("swtcgPrev", function (payload) {
  var picker = ownerOf(payload);
  if (!picker || picker.page === 0) {
    return;
  }
  picker.page -= 1;
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
  void closePicker(picker);
  // Dismissing does not end the ask — the nag button stays, and says so.
  void refreshNag(picker.seat);
});

api.on("swtcgOpen", function (payload) {
  if (!payload || typeof payload.actorPeerId !== "string") {
    return;
  }
  // PLAYER half: reopening is also a cue to refresh what the host has of my shelf. The nag
  // button belongs to no dialog, so isActorPeer cannot place it on the host — which is fine,
  // because the host's own entry was filled at boot and is refreshed on every tab switch.
  if (!canDraw) {
    void reportMyDecks("mine", "");
    void reportMyDecks("public", "");
  }

  // HOST half. `force`, because this button is somebody asking: a player who wants a second deck
  // should get the dialog rather than a silent no-op.
  //
  // The host pressing its own button has no peer id to key on (see {@link SELF}), and would key
  // on the one the payload carries — which is its own, and which nothing else in this script
  // uses. `canDraw` is settled by now, so "the host pressed it" is knowable: a dialog opened for
  // a peer whose seat this script never recorded is the host's own.
  var actorSeat = seatByPeer[payload.actorPeerId] || null;
  var key = payload.actorPeerId;
  if (!actorSeat && api.getMySeat()) {
    actorSeat = api.getMySeat();
    key = SELF;
  }
  void openPicker(
    key === SELF ? { scope: "seat", seats: [actorSeat] } : { scope: "players", peerIds: [payload.actorPeerId] },
    actorSeat,
    key,
    true
  );
});

/* ------------------------------------------------------------------------------------------- */
/* Hooks — presence                                                                              */
/* ------------------------------------------------------------------------------------------- */

api.on("onPeerJoined", function (payload) {
  if (!payload || typeof payload.peerId !== "string" || payload.role === "spectator") {
    return;
  }
  // No seat on arrival: the gate opens on `onSeatChanged`, which is the moment a deck starts to
  // mean something. The nag button is up in the meantime.
  void renderNagButton(true);
});

api.on("onPeerLeft", function (payload) {
  if (!payload || typeof payload.peerId !== "string") {
    return;
  }
  delete seatByPeer[payload.peerId];
  delete reportedDecks[payload.peerId];
  var tokens = Object.keys(pickers);
  for (var i = 0; i < tokens.length; i += 1) {
    var picker = pickers[tokens[i]];
    if (picker && isAudience(picker, payload.peerId)) {
      void closePicker(picker);
    }
  }
});

/**
 * Somebody took a seat — the moment the gate applies.
 *
 * Leaving a seat clears the record but leaves the deck on the table: the cards are the player's,
 * and sweeping them up because somebody stood up is a rule this script has no business inventing.
 */
api.on("onSeatChanged", function (payload) {
  if (!payload || typeof payload.peerId !== "string") {
    return;
  }
  if (!payload.seat) {
    delete seatByPeer[payload.peerId];
    return;
  }
  seatByPeer[payload.peerId] = payload.seat;

  // PLAYER half. `api.getMySeat()` is this peer's own seat, and a seat holds one person — so a
  // seat change naming MY seat is me sitting down. Report my shelf now, so the host has rows to
  // draw the moment it opens the dialog rather than an empty list and a spinner.
  if (payload.seat === api.getMySeat()) {
    void reportMyDecks("mine", "");
    void reportMyDecks("public", "");
  }

  // HOST half.
  void openPicker(
    { scope: "players", peerIds: [payload.peerId] },
    payload.seat,
    payload.peerId,
    false
  );
});

/* ------------------------------------------------------------------------------------------- */
/* Boot                                                                                          */
/* ------------------------------------------------------------------------------------------- */

/**
 * The host never receives an `onPeerJoined` for itself, so its own dialog is opened here.
 *
 * The host's dialog is scoped to its SEAT rather than to a peer id, because a script cannot ask
 * for its own peer id — and a seat is the more durable handle anyway. An unseated host gets the
 * nag button and nothing more, which is right: a host who is spectating has no deck to draw.
 */
async function boot() {
  var seat = api.getMySeat();
  await renderNagButton(seat ? !(await seatHasDeck(seat)) : true);

  // Every peer reports its own shelf at boot, host included. Deliberately AFTER the nag button:
  // that first `put` is what settles `canDraw`, and `reportMyDecks` branches on it to decide
  // whether to store locally or send up.
  if (seat) {
    void reportMyDecks("mine", "");
    void reportMyDecks("public", "");
  }

  if (!canDraw || !seat) {
    return;
  }
  await openPicker({ scope: "seat", seats: [seat] }, seat, SELF, false);
}

void boot();
