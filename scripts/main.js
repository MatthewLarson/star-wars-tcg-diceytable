/**
 * Star Wars TCG — entry script (mod Surface B, the sandboxed `api`).
 *
 * The Deck Database: every function the `community.swtcg-deckdb` plugin exposes, reachable from
 * the table, for the manual ("Standard") variant.
 *
 *   Starter decks   starterDecks                      full lists, loaded directly
 *   Public decks    publicDecks -> deckById            searchable, side filter, paged
 *   By player       userDecks (when an owner id is known) or the public list narrowed to one owner
 *   Tournaments     tournaments -> tournamentById -> deckById
 *   Link            a pasted swtcg-deckdb.com deck link or id -> deckById
 *   My decks        api.listDecks / api.getDeck, the platform's saved decks for this game
 *   Cards           cardRatings + cardDecks for a face-up card on the table (or a typed name)
 *   (header)        providerStatus
 *
 * ## Variants
 *
 * A variant whose rules are enforced by its scene script ("Scripted") owns the cards, the decks
 * and the turn. This script then does nothing at all except log one line — see `setup`.
 *
 * ## Who does what
 *
 * Every peer runs this script. `api.setUiElement`, `api.createObject` and `api.objectAction` are
 * HOST-ONLY, so every dialog at the table is built by the host's copy and merely shown to one seat
 * with `visibility` (which inherits down the element tree). Clicks reach the host's copy with the
 * clicker's `actorPeerId`, and are checked against the seat the dialog belongs to.
 *
 * A PLAYER'S copy does exactly one job: "My decks". `api.listDecks` / `api.getDeck` read with the
 * credentials of the peer they run on, so a player's own library can only be read by the player's
 * own copy. That copy sees its own user's clicks, reads the library, and hands the result to the
 * host with `api.sendToHost`; the host renders it and spawns the deck.
 *
 * ## What this script may and may not do
 *
 * It has no network access. The hop to swtcg-deckdb.com is performed server-side by the plugin,
 * under the plugin's own origin allowlist and quota, and reaches this script only through
 * `api.callPlugin`. Every call site names the plugin id and the function as plain string literals,
 * inline, because the publish scanner reads them out of this text; a variable holding either is a
 * `dynamic-plugin-call` refusal. The publish scanner is a whole-word text match with no lexer, so
 * this file also never spells a browser global, even in a comment.
 *
 * ## Identity, not art URLs
 *
 * A spawned pile carries the catalogue identity and nothing else: `metadata.cards` (ordered
 * `{ cardId, faceDown }` entries, ids from this game's own catalogue) plus `metadata.cardSource`
 * naming this mod as the source. Every peer resolves names, text and art locally from the
 * catalogue. Decklist NAMES (what the plugin returns) are turned into catalogue ids with
 * `api.resolveCards`, which falls back to a name match.
 */

/* ------------------------------------------------------------------------------------------- */
/* Constants                                                                                     */
/* ------------------------------------------------------------------------------------------- */

/** Fallback when `setup` is handed no manifest id. Matches `diceytable.mod.json`. */
var DEFAULT_MOD_ID = "star-wars-tcg";

/**
 * The seat zone names a pile is placed in, matched case-insensitively against the AUTHORED box
 * name (and the template zone id, with dashes read as spaces). The scene names them "Deck",
 * "Supply" and "Resource"; the "... Area" spellings are what an earlier scene used.
 */
var DECK_ZONE_NAMES = ["deck", "deck area"];
var SUPPLY_ZONE_NAMES = ["supply", "supply area"];
var RESOURCE_ZONE_NAMES = ["resource", "resource area", "resources"];

/** A visible shelf for a seat that lacks a zone, so a misplaced pile is obviously misplaced. */
var FALLBACK_ORIGIN = { x: 0, y: 1.2, z: -2.5 };
var FALLBACK_STEP = 1.6;

/** Dropped this far above the zone's play surface, so the pile settles. */
var DROP_HEIGHT = 0.35;

/** The platform's per-pile ceiling (`DECK_LOAD_MAX_PILE_CARDS`). */
var MAX_PILE = 1000;

/** Rows per page. Keeps one redraw well inside the shared 120-mutations-per-tick UI budget. */
var PAGE_SIZE = 8;

/** Typing is collapsed into one redraw this long after the last keystroke (P6 field report C-3). */
var TYPING_DEBOUNCE_MS = 300;

/** Cached plugin answers are reused for this long. The plugin allows 20 requests a minute. */
var CACHE_MS = 5 * 60 * 1000;
var PROVIDER_STATUS_MS = 2 * 60 * 1000;

/** How long the host waits for a player's copy to send their saved decks before saying so. */
var MINE_WAIT_MS = 10000;

/** The catalogue's `type` value for a resource card. */
var RESOURCE_TYPE = "resource";

/** Partition ids from this game's `data/cardSchema.json`. */
var PARTITION_MAIN = "main";
var PARTITION_SUPPLY = "supply";
var PARTITION_RESOURCE = "resource";

/** The provider's side codes, in chip order. `""` is the unfiltered chip. */
var SIDES = [
  { code: "", label: "All sides" },
  { code: "L", label: "Light" },
  { code: "D", label: "Dark" },
  { code: "Y", label: "Vong" },
  { code: "N", label: "Neutral" },
  { code: "mixed", label: "Mixed" }
];

var VIEWS = [
  { id: "starter", label: "Starter decks" },
  { id: "public", label: "Public decks" },
  { id: "player", label: "By player" },
  { id: "tournaments", label: "Tournaments" },
  { id: "link", label: "Link" },
  { id: "mine", label: "My decks" },
  { id: "cards", label: "Cards" }
];

/** Old element ids written by `scripts/deck-import.js`; dropped on boot so a restored table loses them. */
var LEGACY_NAG_ID = "swtcg-nag";

/* ------------------------------------------------------------------------------------------- */
/* State                                                                                         */
/* ------------------------------------------------------------------------------------------- */

var MOD_ID = DEFAULT_MOD_ID;

/** True on the host's copy. Decided once at setup by a harmless UI write. */
var isHostFrame = false;

/** False once a host-only UI write has been refused; latched so a refused peer stops trying. */
var canDraw = true;

/** Open dialogs by token. */
var pickers = {};
var nextToken = 1;

/** Seats that currently have a bar drawn, and what the bar says ("nag" | "ok"). */
var barState = {};
/** Bar button element id -> seat. */
var barSeatByElement = {};
var barRefreshTimers = {};

/** peerId -> seat, learned from `onSeatChanged` and (first use) from seat-scoped clicks. */
var seatByPeer = {};

/** Object ids most recently named by the event log, newest first. Candidates for "Cards". */
var recentObjectIds = [];

/** Shared plugin caches. */
var plugin = { checked: false, available: true, attribution: "" };
var provider = { at: 0, ok: null, text: "" };
var cache = {
  starters: null,
  publicDecks: null,
  tournaments: null,
  tournamentById: {},
  userDecks: {},
  cardInfo: {}
};

/** A player's copy: what it last saw its own user do in each dialog. */
var localView = {};
var localSearch = {};
var localTimers = {};

/* ------------------------------------------------------------------------------------------- */
/* Small helpers                                                                                 */
/* ------------------------------------------------------------------------------------------- */

function text(value) {
  return typeof value === "string" ? value : "";
}

function lower(value) {
  return text(value).toLowerCase();
}

function clip(value, max) {
  var s = text(value);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isList(value) {
  return Array.isArray(value);
}

function intOr(value, fallback) {
  return typeof value === "number" && isFinite(value) ? Math.floor(value) : fallback;
}

function errorText(error) {
  return error && typeof error.message === "string" ? error.message : String(error);
}

/** Await something that may throw or reject, and hand back `fallback` instead. */
async function attempt(run, fallback) {
  try {
    return await run();
  } catch (error) {
    return fallback;
  }
}

/** The provider's id/token format: letters, digits, dot, underscore, hyphen. */
function isToken(value, max) {
  var s = text(value);
  if (s.length === 0 || s.length > max) {
    return false;
  }
  for (var i = 0; i < s.length; i += 1) {
    var c = s.charAt(i);
    var ok = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9")
      || c === "." || c === "_" || c === "-";
    if (!ok) {
      return false;
    }
  }
  return true;
}

/** A bare deck id or a pasted permalink -> the deck id, or null. */
function normalizeDeckId(raw) {
  var value = text(raw).trim();
  var cut = value.search(/[?#]/);
  if (cut >= 0) {
    value = value.slice(0, cut);
  }
  while (value.length > 0 && value.charAt(value.length - 1) === "/") {
    value = value.slice(0, -1);
  }
  var slash = value.lastIndexOf("/");
  if (slash >= 0) {
    value = value.slice(slash + 1);
  }
  return isToken(value, 16) ? value : null;
}

/** `"bolt#3"` -> `"bolt"`. Only a trailing `#<digits>` is a copy suffix. */
function baseCardId(cardId) {
  var value = text(cardId);
  var match = /^(.*)#\d+$/.exec(value);
  return match ? match[1] : value;
}

/** The platform's instance-id convention: first copy plain, then `#2`, `#3`, ... */
function instanceId(cardId, copyIndex) {
  return copyIndex <= 0 ? cardId : cardId + "#" + (copyIndex + 1);
}

function shuffleInPlace(entries) {
  for (var i = entries.length - 1; i > 0; i -= 1) {
    var j = Math.floor(Math.random() * (i + 1));
    var swap = entries[i];
    entries[i] = entries[j];
    entries[j] = swap;
  }
  return entries;
}

function sideLabel(code) {
  for (var i = 0; i < SIDES.length; i += 1) {
    if (SIDES[i].code === code) {
      return SIDES[i].label;
    }
  }
  return code ? String(code) : "";
}

function ordinal(n) {
  var mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return n + "th";
  }
  var mod10 = n % 10;
  return n + (mod10 === 1 ? "st" : mod10 === 2 ? "nd" : mod10 === 3 ? "rd" : "th");
}

function seatLabel(seat) {
  var s = text(seat);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) + " seat" : "No seat";
}

/** The trailing argument encoded in an element id (`swtcg-p1-side-L` -> `"L"`), or "". */
function argFor(elementId, kind) {
  var value = text(elementId);
  var marker = "-" + kind + "-";
  var at = value.lastIndexOf(marker);
  return at < 0 ? "" : value.slice(at + marker.length);
}

/** `swtcg-p3-...` -> `"p3"`. */
function tokenOf(elementId) {
  var match = /^swtcg-(p\d+)(?:-|$)/.exec(text(elementId));
  return match ? match[1] : "";
}

function reasonText(reason, notFound) {
  if (reason === "rate-limited") {
    return "The deck database is busy right now. Try again in a minute.";
  }
  if (reason === "not-found") {
    return notFound || "The deck database has no such entry.";
  }
  if (reason === "refused") {
    return "The deck database refused that request.";
  }
  if (reason === "no-plugin") {
    return "The deck database plugin is not enabled at this table. Ask the host to add "
      + "swtcg-deckdb in the lobby. My decks still works.";
  }
  return "Could not reach the deck database. Decks already on the table are unaffected.";
}

/* ------------------------------------------------------------------------------------------- */
/* Plugin calls — one literal call site per function                                             */
/* ------------------------------------------------------------------------------------------- */

/**
 * Normalise a plugin call into `{ ok, data }` / `{ ok: false, reason }`. Never throws: a missing
 * capability (a synchronous throw), a rejected promise and a malformed answer all become a
 * reason, so no caller needs its own try.
 */
async function settle(run) {
  if (plugin.checked && !plugin.available) {
    return { ok: false, reason: "no-plugin" };
  }
  try {
    var result = await run();
    if (!isObject(result)) {
      return { ok: false, reason: "unavailable" };
    }
    if (result.ok === true) {
      return { ok: true, data: result.data };
    }
    return { ok: false, reason: typeof result.reason === "string" ? result.reason : "unavailable" };
  } catch (error) {
    return { ok: false, reason: "unavailable" };
  }
}

function callDeckById(deckId) {
  return settle(function () {
    return api.callPlugin("community.swtcg-deckdb", "deckById", { deckId: deckId });
  });
}

function callStarterDecks() {
  return settle(function () {
    return api.callPlugin("community.swtcg-deckdb", "starterDecks", {});
  });
}

function callPublicDecks() {
  return settle(function () {
    return api.callPlugin("community.swtcg-deckdb", "publicDecks", {});
  });
}

function callUserDecks(userId) {
  return settle(function () {
    return api.callPlugin("community.swtcg-deckdb", "userDecks", { userId: userId });
  });
}

function callCardDecks(name, setCode) {
  return settle(function () {
    return api.callPlugin("community.swtcg-deckdb", "cardDecks", { name: name, set: setCode });
  });
}

function callCardRatings(name, setCode) {
  return settle(function () {
    return api.callPlugin("community.swtcg-deckdb", "cardRatings", { name: name, set: setCode });
  });
}

function callTournaments() {
  return settle(function () {
    return api.callPlugin("community.swtcg-deckdb", "tournaments", {});
  });
}

function callTournamentById(tournamentId) {
  return settle(function () {
    return api.callPlugin("community.swtcg-deckdb", "tournamentById", { tournamentId: tournamentId });
  });
}

function callProviderStatus() {
  return settle(function () {
    return api.callPlugin("community.swtcg-deckdb", "providerStatus", {});
  });
}

/**
 * Is the plugin installed at this table? `listPlugins` lists only plugins the manifest declares
 * AND the room selected, so absence means "not enabled here" rather than "broken".
 */
async function ensurePluginPresence() {
  if (plugin.checked) {
    return;
  }
  var list = await attempt(function () { return api.listPlugins(); }, null);
  if (!isList(list)) {
    // Unknown, not absent: leave `available` true and let each call report its own failure.
    return;
  }
  plugin.checked = true;
  plugin.available = false;
  for (var i = 0; i < list.length; i += 1) {
    var entry = list[i];
    if (isObject(entry) && entry.id === "community.swtcg-deckdb") {
      plugin.available = true;
      plugin.attribution = clip(entry.attribution, 300);
    }
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Payload validation — every plugin and peer payload is untrusted                               */
/* ------------------------------------------------------------------------------------------- */

/** `[{ count, name, setCode? }]` -> `[{ key, count }]`, dropping anything malformed. */
function parseCardLines(raw) {
  var out = [];
  if (!isList(raw)) {
    return out;
  }
  for (var i = 0; i < raw.length && i < 500; i += 1) {
    var line = raw[i];
    if (!isObject(line)) {
      continue;
    }
    var name = text(line.name).trim();
    var count = intOr(line.count, 1);
    if (!name || name.length > 200 || count < 1) {
      continue;
    }
    out.push({ key: name, count: Math.min(count, 100) });
  }
  return out;
}

function parseDeckSummary(raw) {
  if (!isObject(raw) || !isToken(raw.id, 16)) {
    return null;
  }
  return {
    id: raw.id,
    name: clip(raw.name, 200) || "Untitled deck",
    side: clip(raw.side, 16),
    format: clip(raw.format, 60),
    pool: clip(raw.pool, 60),
    owner: clip(raw.owner_username, 120),
    ownerId: isToken(raw.owner_id, 64) ? raw.owner_id : null,
    playedBy: clip(raw.played_by, 120),
    cardCount: typeof raw.card_count === "number" ? Math.floor(raw.card_count) : null,
    created: clip(raw.created_at, 60)
  };
}

function parseDeckSummaries(raw) {
  var out = [];
  if (!isList(raw)) {
    return out;
  }
  for (var i = 0; i < raw.length && i < 2000; i += 1) {
    var row = parseDeckSummary(raw[i]);
    if (row) {
      out.push(row);
    }
  }
  return out;
}

function parseDeck(raw) {
  if (!isObject(raw)) {
    return null;
  }
  var cards = parseCardLines(raw.cards);
  var supply = parseCardLines(raw.supply);
  if (cards.length === 0 && supply.length === 0) {
    return null;
  }
  return { name: clip(raw.name, 200) || "Imported deck", cards: cards, supply: supply };
}

function parseStarters(raw) {
  var out = [];
  if (!isList(raw)) {
    return out;
  }
  for (var i = 0; i < raw.length && i < 100; i += 1) {
    var row = raw[i];
    if (!isObject(row)) {
      continue;
    }
    var cards = parseCardLines(row.cards);
    if (cards.length === 0) {
      continue;
    }
    var total = 0;
    for (var c = 0; c < cards.length; c += 1) {
      total += cards[c].count;
    }
    out.push({ name: clip(row.name, 200) || "Starter deck", side: clip(row.side, 16), cards: cards, total: total });
  }
  return out;
}

function parseTournaments(raw) {
  var out = [];
  if (!isList(raw)) {
    return out;
  }
  for (var i = 0; i < raw.length && i < 1000; i += 1) {
    var row = raw[i];
    if (!isObject(row) || !isToken(row.id, 32)) {
      continue;
    }
    out.push({
      id: row.id,
      name: clip(row.name, 200) || "Tournament",
      date: clip(row.date, 32),
      format: clip(row.format, 60),
      pool: clip(row.pool, 60),
      status: clip(row.status, 16)
    });
  }
  return out;
}

function parseTournament(raw) {
  if (!isObject(raw)) {
    return null;
  }
  var entrants = [];
  if (isList(raw.entrants)) {
    for (var i = 0; i < raw.entrants.length && i < 500; i += 1) {
      var e = raw.entrants[i];
      if (!isObject(e)) {
        continue;
      }
      var deckIds = [];
      if (isList(e.deck_ids)) {
        for (var d = 0; d < e.deck_ids.length && d < 20; d += 1) {
          if (isToken(e.deck_ids[d], 16)) {
            deckIds.push(e.deck_ids[d]);
          }
        }
      }
      entrants.push({
        playedBy: clip(e.played_by, 120) || "Unnamed player",
        placement: typeof e.placement === "number" ? Math.floor(e.placement) : null,
        deckIds: deckIds
      });
    }
  }
  entrants.sort(function (a, b) {
    var pa = a.placement === null ? 100000 : a.placement;
    var pb = b.placement === null ? 100000 : b.placement;
    return pa - pb;
  });
  return {
    name: clip(raw.name, 200) || "Tournament",
    date: clip(raw.date, 32),
    format: clip(raw.format, 60),
    status: clip(raw.status, 16),
    entrants: entrants
  };
}

function parseUserDecks(raw) {
  if (!isObject(raw)) {
    return null;
  }
  return { username: clip(raw.username, 120), decks: parseDeckSummaries(raw.decks) };
}

function parseRatings(raw) {
  if (!isObject(raw)) {
    return null;
  }
  var average = typeof raw.average === "number" && raw.average >= 0 && raw.average <= 5 ? raw.average : null;
  return { average: average, count: Math.max(0, intOr(raw.count, 0)) };
}

/** A player's saved-deck summaries, as their own copy sent them. */
function parseMineSummaries(raw) {
  var out = [];
  if (!isList(raw)) {
    return out;
  }
  for (var i = 0; i < raw.length && i < 100; i += 1) {
    var row = raw[i];
    if (!isObject(row) || typeof row.id !== "string" || row.id.length === 0 || row.id.length > 64) {
      continue;
    }
    out.push({
      id: row.id,
      name: row.name === null ? null : clip(row.name, 200),
      isPrivate: row.isPrivate === true,
      cards: Math.max(0, intOr(row.cards, 0)),
      formatId: clip(row.formatId, 64),
      updated: text(row.updated).slice(0, 10)
    });
  }
  return out;
}

/** Decklist entries `{ cardId, count, partitionId }` from `api.getDeck` or a player's message. */
function parseDeckEntries(raw) {
  var out = { main: [], supply: [], resource: [] };
  if (!isList(raw)) {
    return out;
  }
  for (var i = 0; i < raw.length && i < 500; i += 1) {
    var entry = raw[i];
    if (!isObject(entry)) {
      continue;
    }
    var cardId = text(entry.cardId);
    var count = intOr(entry.count, 1);
    if (!cardId || cardId.length > 200 || count < 1) {
      continue;
    }
    var line = { key: cardId, count: Math.min(count, 100) };
    var partition = lower(entry.partitionId || PARTITION_MAIN);
    if (partition.indexOf(PARTITION_RESOURCE) >= 0) {
      out.resource.push(line);
    } else if (partition === PARTITION_SUPPLY) {
      out.supply.push(line);
    } else {
      out.main.push(line);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------- */
/* Cached plugin reads                                                                           */
/* ------------------------------------------------------------------------------------------- */

function fresh(entry, ms) {
  return !!entry && Date.now() - entry.at < (ms || CACHE_MS);
}

async function loadStarters() {
  if (fresh(cache.starters) && cache.starters.ok) {
    return cache.starters;
  }
  var result = await callStarterDecks();
  cache.starters = result.ok
    ? { at: Date.now(), ok: true, rows: parseStarters(result.data) }
    : { at: Date.now(), ok: false, reason: result.reason, rows: [] };
  return cache.starters;
}

async function loadPublicDecks() {
  if (fresh(cache.publicDecks) && cache.publicDecks.ok) {
    return cache.publicDecks;
  }
  var result = await callPublicDecks();
  cache.publicDecks = result.ok
    ? { at: Date.now(), ok: true, rows: parseDeckSummaries(result.data) }
    : { at: Date.now(), ok: false, reason: result.reason, rows: [] };
  return cache.publicDecks;
}

async function loadTournaments() {
  if (fresh(cache.tournaments) && cache.tournaments.ok) {
    return cache.tournaments;
  }
  var result = await callTournaments();
  cache.tournaments = result.ok
    ? { at: Date.now(), ok: true, rows: parseTournaments(result.data) }
    : { at: Date.now(), ok: false, reason: result.reason, rows: [] };
  return cache.tournaments;
}

async function loadTournament(id) {
  var hit = cache.tournamentById[id];
  if (fresh(hit) && hit.ok) {
    return hit;
  }
  var result = await callTournamentById(id);
  var parsed = result.ok ? parseTournament(result.data) : null;
  cache.tournamentById[id] = parsed
    ? { at: Date.now(), ok: true, value: parsed }
    : { at: Date.now(), ok: false, reason: result.ok ? "unavailable" : result.reason };
  return cache.tournamentById[id];
}

async function loadUserDecks(ownerId) {
  var hit = cache.userDecks[ownerId];
  if (fresh(hit) && hit.ok) {
    return hit;
  }
  var result = await callUserDecks(ownerId);
  var parsed = result.ok ? parseUserDecks(result.data) : null;
  cache.userDecks[ownerId] = parsed
    ? { at: Date.now(), ok: true, value: parsed }
    : { at: Date.now(), ok: false, reason: result.ok ? "unavailable" : result.reason };
  return cache.userDecks[ownerId];
}

/** Ratings and decks for one catalogue card, fetched together. */
async function loadCardInfo(card) {
  var key = card.cardId;
  var hit = cache.cardInfo[key];
  if (fresh(hit)) {
    return hit;
  }
  var both = await Promise.all([callCardRatings(card.name, card.set), callCardDecks(card.name, card.set)]);
  var ratings = both[0].ok ? parseRatings(both[0].data) : null;
  var decks = both[1].ok ? parseDeckSummaries(both[1].data) : null;
  cache.cardInfo[key] = {
    at: Date.now(),
    ratings: ratings,
    ratingsReason: both[0].ok ? null : both[0].reason,
    decks: decks,
    decksReason: both[1].ok ? null : both[1].reason
  };
  return cache.cardInfo[key];
}

/** The provider's liveness, for the dialog header. Cached, and never throws. */
async function refreshProviderStatus() {
  if (Date.now() - provider.at < PROVIDER_STATUS_MS && provider.text) {
    return;
  }
  await ensurePluginPresence();
  var result = await callProviderStatus();
  provider.at = Date.now();
  provider.ok = result.ok;
  if (result.ok) {
    provider.text = "swtcg-deckdb.com is reachable.";
  } else if (result.reason === "no-plugin") {
    provider.text = "Deck database plugin not enabled at this table — My decks still works.";
  } else if (result.reason === "rate-limited") {
    provider.text = "swtcg-deckdb.com is busy; lists may be slow to load.";
  } else {
    provider.text = "swtcg-deckdb.com is not answering right now; cached lists and My decks still work.";
  }
}

/* ------------------------------------------------------------------------------------------- */
/* UI writes                                                                                     */
/* ------------------------------------------------------------------------------------------- */

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
/* Seat zones and placement                                                                      */
/* ------------------------------------------------------------------------------------------- */

function zoneMatches(zone, names) {
  var name = lower(zone && zone.name).trim();
  var template = lower(zone && zone.templateZoneId).replace(/[-_]/g, " ").trim();
  for (var i = 0; i < names.length; i += 1) {
    if (name === names[i] || (template.length > 0 && template === names[i])) {
      return true;
    }
  }
  return false;
}

async function zonesForSeat(seat) {
  var zones = await attempt(function () { return api.listSeatZones(seat); }, []);
  return isList(zones) ? zones : [];
}

function findZone(zones, names) {
  for (var i = 0; i < zones.length; i += 1) {
    if (isObject(zones[i]) && zoneMatches(zones[i], names)) {
      return zones[i];
    }
  }
  return null;
}

/**
 * `{ position, rotationY, fallback }` for a zone, or the shelf slot when the seat lacks it.
 *
 * The yaw is the zone's plus 180: a zone's upper edge is its local +Z and card art points its
 * head along the card's own -Z, so this is what makes a pile read the right way up from the seat.
 */
function placementFor(zone, slot) {
  if (zone && isObject(zone.position) && typeof zone.rotationY === "number") {
    return {
      position: { x: zone.position.x, y: zone.position.y + DROP_HEIGHT, z: zone.position.z },
      rotationY: (zone.rotationY + 180) % 360,
      fallback: false
    };
  }
  return {
    position: { x: FALLBACK_ORIGIN.x + slot * FALLBACK_STEP, y: FALLBACK_ORIGIN.y, z: FALLBACK_ORIGIN.z },
    rotationY: 0,
    fallback: true
  };
}

/** The distinct seats that are currently claimed (a seat's zones exist only while claimed). */
async function claimedSeats() {
  var zones = await attempt(function () { return api.listSeatZones(); }, []);
  var seen = {};
  var seats = [];
  if (isList(zones)) {
    for (var i = 0; i < zones.length; i += 1) {
      var seat = zones[i] && zones[i].seat;
      if (typeof seat === "string" && seat && !seen[seat]) {
        seen[seat] = true;
        seats.push(seat);
      }
    }
  }
  var own = attemptSync(function () { return api.getMySeat(); }, null);
  if (typeof own === "string" && own && !seen[own]) {
    seats.push(own);
  }
  return seats;
}

/**
 * Does this seat have a deck on the table? Either one this script placed for it, or any pile
 * standing in its Deck zone — which is how a deck the LOBBY loaded for the seat is recognised.
 * An unanswerable read counts as "no deck": being asked once too often is recoverable, being
 * unable to start is not.
 */
async function seatHasDeck(seat) {
  if (!seat) {
    return false;
  }
  var decks = await attempt(function () { return api.listObjects({ kind: "deck" }); }, []);
  if (isList(decks)) {
    for (var i = 0; i < decks.length; i += 1) {
      var meta = decks[i] && decks[i].metadata;
      if (isObject(meta) && meta.swtcgSeat === seat) {
        return true;
      }
    }
  }
  var zone = findZone(await zonesForSeat(seat), DECK_ZONE_NAMES);
  if (!zone) {
    return false;
  }
  var inside = await attempt(function () { return api.getZoneObjects(seat, zone.id); }, []);
  if (isList(inside)) {
    for (var j = 0; j < inside.length; j += 1) {
      if (inside[j] && (inside[j].kind === "deck" || inside[j].kind === "card")) {
        return true;
      }
    }
  }
  return false;
}

/* ------------------------------------------------------------------------------------------- */
/* Turning a decklist into piles                                                                 */
/* ------------------------------------------------------------------------------------------- */

/**
 * Resolve every distinct decklist key (a catalogue id OR a card name) to its catalogue row.
 * Returns key -> `{ cardId, name, set, type }`; a key with no row is simply absent.
 */
async function resolveKeys(keys) {
  var byKey = {};
  if (keys.length === 0) {
    return byKey;
  }
  var rows = await attempt(function () { return api.resolveCards(keys); }, []);
  if (!isList(rows)) {
    return byKey;
  }
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    if (!isObject(row) || !isObject(row.data)) {
      continue;
    }
    // `cardId` echoes what we asked (a name, for a deck-db list); `data.card_id` is the real id.
    var realId = text(row.data.card_id) || text(row.cardId);
    if (!realId) {
      continue;
    }
    byKey[text(row.cardId)] = {
      cardId: realId,
      name: text(row.data.name) || realId,
      set: text(row.data.set),
      type: text(row.data.type)
    };
  }
  return byKey;
}

/**
 * Expand `[{ key, count }]` into physical entries using catalogue ids. `copies` counts copies per
 * card across the WHOLE load so instance ids never collide between this load's piles.
 */
function expand(lines, byKey, copies, missing) {
  var entries = [];
  for (var i = 0; i < lines.length; i += 1) {
    var row = byKey[baseCardId(lines[i].key)] || byKey[lines[i].key];
    if (!row) {
      missing.push(lines[i].key);
      continue;
    }
    for (var n = 0; n < lines[i].count; n += 1) {
      var index = copies[row.cardId] || 0;
      copies[row.cardId] = index + 1;
      entries.push({ cardId: instanceId(row.cardId, index), base: row.cardId, faceDown: true });
    }
  }
  return entries;
}

function takeResource(byKey, lists) {
  for (var l = 0; l < lists.length; l += 1) {
    var entries = lists[l];
    for (var i = 0; i < entries.length; i += 1) {
      if (lower(byCardId(byKey, entries[i].base).type) === RESOURCE_TYPE) {
        return entries.splice(i, 1)[0];
      }
    }
  }
  return null;
}

function byCardId(byKey, cardId) {
  var keys = Object.keys(byKey);
  for (var i = 0; i < keys.length; i += 1) {
    if (byKey[keys[i]].cardId === cardId) {
      return byKey[keys[i]];
    }
  }
  return {};
}

function cardSourceSlice(deckId, partitionId) {
  return {
    source: { kind: "mod", id: MOD_ID, version: 1 },
    deckId: deckId,
    partitionId: partitionId
  };
}

var nextSerial = 1;

function spawnPile(seat, label, entries, place, partitionId, deckId, faceUp) {
  if (entries.length === 0) {
    return null;
  }
  var id = "swtcg-pile-" + seat + "-" + Date.now().toString(36) + "-" + nextSerial;
  nextSerial += 1;
  var cards = [];
  for (var i = 0; i < entries.length && i < MAX_PILE; i += 1) {
    cards.push({ cardId: entries[i].cardId, faceDown: !faceUp });
  }
  api.createObject({
    id: id,
    kind: "deck",
    label: label,
    displayName: label,
    position: place.position,
    rotation: { x: 0, y: place.rotationY, z: 0 },
    faceDown: !faceUp,
    stackCount: cards.length,
    metadata: {
      cards: cards,
      cardSource: cardSourceSlice(deckId, partitionId),
      swtcgDeckGate: true,
      swtcgSeat: seat
    }
  });
  return id;
}

/**
 * Put one deck on the table for one seat: the main pile (shuffled) in its Deck zone, the supply
 * in its Supply zone, and one resource face up in its Resource zone. Returns
 * `{ ok, message }`; every branch says something, because a silent no-op reads as a broken mod.
 */
async function placeDeck(seat, name, lists, deckId) {
  var main = lists.main || [];
  var supply = lists.supply || [];
  var resource = lists.resource || [];
  if (main.length + supply.length + resource.length === 0) {
    return { ok: false, message: "That deck is empty." };
  }

  var keys = [];
  var seen = {};
  var all = main.concat(supply).concat(resource);
  for (var i = 0; i < all.length; i += 1) {
    var k = baseCardId(all[i].key);
    if (!seen[k]) {
      seen[k] = true;
      keys.push(k);
    }
  }
  var byKey = await resolveKeys(keys);

  var copies = {};
  var missing = [];
  var mainEntries = expand(main, byKey, copies, missing);
  var supplyEntries = expand(supply, byKey, copies, missing);
  var resourceEntries = expand(resource, byKey, copies, missing);
  if (mainEntries.length + supplyEntries.length + resourceEntries.length === 0) {
    return {
      ok: false,
      message: "None of that deck's cards are in this game's catalogue, so nothing was placed."
    };
  }

  var turnedUp = takeResource(byKey, [resourceEntries, mainEntries, supplyEntries]);
  mainEntries = mainEntries.concat(resourceEntries);
  shuffleInPlace(mainEntries);

  var zones = await zonesForSeat(seat);
  var deckZone = findZone(zones, DECK_ZONE_NAMES);
  var supplyZone = findZone(zones, SUPPLY_ZONE_NAMES);
  var resourceZone = findZone(zones, RESOURCE_ZONE_NAMES);
  var missingZones = [];
  if (!deckZone) { missingZones.push("Deck"); }
  if (supplyEntries.length > 0 && !supplyZone) { missingZones.push("Supply"); }
  if (turnedUp && !resourceZone) { missingZones.push("Resource"); }

  var mainId = spawnPile(seat, name, mainEntries, placementFor(deckZone, 0), PARTITION_MAIN, deckId, false);
  if (mainId) {
    // The local shuffle fixes the order the pile is created with; this is the host's own
    // authoritative shuffle, which the players see happen and the event log records.
    try {
      api.objectAction(mainId, "shuffle");
    } catch (error) {
      api.log("Shuffle refused: " + errorText(error));
    }
  }
  spawnPile(seat, name + " — Supply", supplyEntries, placementFor(supplyZone, 1), PARTITION_SUPPLY, deckId, false);
  if (turnedUp) {
    var resourceRow = byCardId(byKey, turnedUp.base);
    spawnPile(seat, resourceRow.name || "Resource", [turnedUp], placementFor(resourceZone, 2),
      PARTITION_RESOURCE, deckId, true);
  }

  var message = "Loaded “" + name + "” for the " + seatLabel(seat) + ": " + mainEntries.length + " cards";
  if (supplyEntries.length > 0) {
    message += ", " + supplyEntries.length + " in supply";
  }
  message += turnedUp ? ", one resource in play." : ". No resource card was found in it.";
  if (missing.length > 0) {
    message += " " + missing.length + " card name(s) were not in this game's catalogue and were left out ("
      + clip(missing.slice(0, 3).join(", "), 120) + (missing.length > 3 ? ", …" : "") + ").";
  }
  if (missingZones.length > 0) {
    message += " This seat has no " + missingZones.join("/") + " zone, so some piles landed on the side.";
  }
  api.log(message);
  return { ok: true, message: message };
}

/** Fetch a deck-db list by id and place it. */
async function loadDeckDb(seat, deckId) {
  var result = await callDeckById(deckId);
  if (!result.ok) {
    return { ok: false, message: reasonText(result.reason, "No public deck with id " + deckId + ".") };
  }
  var deck = parseDeck(result.data);
  if (!deck) {
    return { ok: false, message: "That deck came back empty or unreadable, so nothing was placed." };
  }
  return placeDeck(seat, deck.name, { main: deck.cards, supply: deck.supply, resource: [] }, null);
}

/** Read one of the HOST'S own saved decks and place it. Host frame, host actor only. */
async function loadOwnSavedDeck(seat, deckId) {
  var deck = await attempt(function () { return api.getDeck(deckId); }, null);
  if (!isObject(deck)) {
    return { ok: false, message: "That deck is no longer available." };
  }
  if (deck.readable !== true) {
    return { ok: false, message: "That deck could not be read, so nothing was placed." };
  }
  return placeDeck(seat, clip(deck.name, 200) || "Deck", parseDeckEntries(deck.entries), deck.id);
}

/* ------------------------------------------------------------------------------------------- */
/* The per-seat bar: "Deck Database" + "Card info", or the nag while a seat has no deck          */
/* ------------------------------------------------------------------------------------------- */

function barId(seat) {
  return "swtcg-bar-" + seat;
}

async function renderBar(seat, hasDeck) {
  var state = hasDeck ? "ok" : "nag";
  if (barState[seat] === state) {
    return;
  }
  barState[seat] = state;
  var root = barId(seat);
  await put({
    id: root,
    type: "layout",
    visibility: { scope: "seat", seats: [seat] },
    presentation: { mode: "screen", anchor: "upper-left", offsetX: 16, offsetY: 16 },
    layout: { direction: "row", gap: 6, align: "center" }
  });
  barSeatByElement[root + "-decks"] = seat;
  barSeatByElement[root + "-cards"] = seat;
  await put({
    id: root + "-decks",
    parentId: root,
    type: "button",
    order: 0,
    props: {
      text: hasDeck ? "Deck Database…" : "Choose your deck to start",
      variant: hasDeck ? "secondary" : "primary",
      onClick: "swtcgOpenDecks"
    }
  });
  await put({
    id: root + "-cards",
    parentId: root,
    type: "button",
    order: 1,
    props: { text: "Card info…", variant: "ghost", onClick: "swtcgOpenCards" }
  });
}

async function dropBar(seat) {
  delete barState[seat];
  await drop(barId(seat));
}

async function refreshBar(seat) {
  if (!seat || !canDraw) {
    return false;
  }
  var has = await seatHasDeck(seat);
  await renderBar(seat, has);
  return has;
}

/** Zone traffic is frequent; collapse it into one re-check per seat per second. */
function scheduleBarRefresh(seat) {
  if (!seat || !isHostFrame) {
    return;
  }
  if (barRefreshTimers[seat]) {
    clearTimeout(barRefreshTimers[seat]);
  }
  barRefreshTimers[seat] = setTimeout(function () {
    delete barRefreshTimers[seat];
    void refreshBar(seat);
  }, 1000);
}

/** Bring the bars in line with which seats are claimed now. */
async function syncSeats() {
  var seats = await claimedSeats();
  var claimed = {};
  for (var i = 0; i < seats.length; i += 1) {
    claimed[seats[i]] = true;
    await refreshBar(seats[i]);
  }
  var drawn = Object.keys(barState);
  for (var j = 0; j < drawn.length; j += 1) {
    if (!claimed[drawn[j]]) {
      await dropBar(drawn[j]);
      var tokens = Object.keys(pickers);
      for (var t = 0; t < tokens.length; t += 1) {
        if (pickers[tokens[t]] && pickers[tokens[t]].seat === drawn[j]) {
          await closePicker(pickers[tokens[t]]);
        }
      }
    }
  }
  return seats;
}

/* ------------------------------------------------------------------------------------------- */
/* Dialog state                                                                                  */
/* ------------------------------------------------------------------------------------------- */

function makePicker(seat, hostOwned, view) {
  var token = "p" + nextToken;
  nextToken += 1;
  var picker = {
    token: token,
    root: "swtcg-" + token,
    seat: seat,
    /** True when the dialog belongs to the host's own user (decides what "My decks" reads). */
    hostOwned: !!hostOwned,
    view: view || "starter",
    status: "",
    busy: false,
    search: "",
    side: "",
    page: 0,
    selected: null,
    pageRows: [],
    drawnRows: 0,
    link: "",
    ownerName: "",
    ownerId: null,
    tournamentId: null,
    cardQuery: "",
    cardCandidates: null,
    cardsDrawn: 0,
    card: null,
    mine: null,
    mineError: "",
    pendingMine: null,
    earlyMine: null,
    /** The peer driving a player's dialog, bound on their first click. */
    ownerPeer: null,
    searchTimer: null,
    mineTimer: null,
    loadingNote: ""
  };
  pickers[token] = picker;
  return picker;
}

function alive(picker) {
  return !!picker && pickers[picker.token] === picker && canDraw;
}

/**
 * Is this interaction from somebody in the dialog's seat?
 *
 * The dialog is only RENDERED for its seat, but a peer can post an interaction for an element it
 * was never shown, so this is checked too. The host's own clicks carry role "host". A player's
 * seat is learned from `onSeatChanged`; a player seated before this script started is unknown
 * to it (no hook fires for pre-existing seats), so the first click on a seat-scoped element
 * teaches it — and a later click claiming a different seat is refused.
 */
function actorAllowed(picker, payload) {
  if (!picker || !payload) {
    return false;
  }
  if (payload.actorRole === "host" || payload.actorRole === "offline") {
    return picker.hostOwned || picker.seat === attemptSync(function () { return api.getMySeat(); }, null);
  }
  if (payload.actorRole === "spectator") {
    return false;
  }
  var actor = text(payload.actorPeerId);
  if (!actor || picker.hostOwned) {
    return false;
  }
  // A dialog belongs to ONE person once they have touched it; nobody else may drive it.
  if (picker.ownerPeer) {
    return picker.ownerPeer === actor;
  }
  var known = seatByPeer[actor];
  if (known && known !== picker.seat) {
    return false;
  }
  seatByPeer[actor] = picker.seat;
  picker.ownerPeer = actor;
  return true;
}

function attemptSync(run, fallback) {
  try {
    return run();
  } catch (error) {
    return fallback;
  }
}

function pickerFor(payload) {
  var picker = pickers[tokenOf(payload && payload.elementId)] || null;
  return actorAllowed(picker, payload) ? picker : null;
}

async function closePicker(picker) {
  if (!picker) {
    return;
  }
  if (picker.searchTimer) {
    clearTimeout(picker.searchTimer);
  }
  if (picker.mineTimer) {
    clearTimeout(picker.mineTimer);
  }
  delete pickers[picker.token];
  await drop(picker.root);
}

/* ------------------------------------------------------------------------------------------- */
/* Rendering — stable ids, so a redraw is in-place updates rather than delete + create           */
/* ------------------------------------------------------------------------------------------- */

async function renderPicker(picker) {
  if (!alive(picker)) {
    return;
  }
  var id = picker.root;
  await put({
    id: id,
    type: "panel",
    // The audience. Children inherit it, so nothing in the dialog is drawn for anyone else.
    visibility: { scope: "seat", seats: [picker.seat] },
    presentation: {
      mode: "modal",
      title: "Deck Database",
      subtitle: seatLabel(picker.seat) + " · decks from swtcg-deckdb.com and your saved decks",
      size: "large",
      dismissible: true
    },
    layout: { direction: "column", gap: 8 },
    props: { onDismiss: "swtcgClose" }
  });
  await put({
    id: id + "-provider",
    parentId: id,
    type: "text",
    order: 0,
    props: { text: provider.text || "Checking swtcg-deckdb.com…", variant: "caption" }
  });
  await put({
    id: id + "-tabs",
    parentId: id,
    type: "layout",
    order: 5,
    layout: { direction: "row", gap: 4, wrap: true }
  });
  for (var i = 0; i < VIEWS.length; i += 1) {
    await put({
      id: id + "-tab-" + VIEWS[i].id,
      parentId: id + "-tabs",
      type: "button",
      order: i,
      props: {
        text: VIEWS[i].label,
        variant: "ghost",
        selected: picker.view === VIEWS[i].id,
        onClick: "swtcgTab"
      }
    });
  }
  await renderBody(picker);
  await put({
    id: id + "-attrib",
    parentId: id,
    type: "text",
    order: 95,
    props: {
      text: plugin.attribution
        || "Decklists from the Star Wars TCG Deck Database (swtcg-deckdb.com), a fan project.",
      variant: "caption"
    }
  });
}

async function renderProviderLine(picker) {
  if (!alive(picker)) {
    return;
  }
  await put({
    id: picker.root + "-provider",
    parentId: picker.root,
    type: "text",
    order: 0,
    props: { text: provider.text || "Checking swtcg-deckdb.com…", variant: "caption" }
  });
}

async function renderTabs(picker) {
  for (var i = 0; i < VIEWS.length; i += 1) {
    await put({
      id: picker.root + "-tab-" + VIEWS[i].id,
      parentId: picker.root + "-tabs",
      type: "button",
      order: i,
      props: {
        text: VIEWS[i].label,
        variant: "ghost",
        selected: picker.view === VIEWS[i].id,
        onClick: "swtcgTab"
      }
    });
  }
}

/** The whole body for the current view. Called on a view change, after the old body is dropped. */
async function renderBody(picker) {
  if (!alive(picker)) {
    return;
  }
  var id = picker.root;
  picker.drawnRows = 0;
  picker.cardsDrawn = 0;
  await put({
    id: id + "-body",
    parentId: id,
    type: "layout",
    order: 20,
    layout: { direction: "column", gap: 8, grow: true }
  });
  await put({
    id: id + "-controls",
    parentId: id + "-body",
    type: "layout",
    order: 0,
    layout: { direction: "column", gap: 6 }
  });
  await renderControls(picker);
  await put({
    id: id + "-list",
    parentId: id + "-body",
    type: "layout",
    order: 10,
    layout: { direction: "column", gap: 4, grow: true, scroll: true, maxHeight: 300 }
  });
  await renderList(picker);
}

async function renderControls(picker) {
  var id = picker.root;
  var c = id + "-controls";
  var view = picker.view;

  if (view === "public" || view === "mine" || view === "tournaments" || view === "player"
    || view === "starter" || view === "cards") {
    if (view !== "cards") {
      await put({
        id: id + "-search",
        parentId: c,
        type: "input",
        order: 0,
        props: {
          value: picker.search,
          placeholder: view === "mine" ? "Search your saved decks"
            : view === "tournaments" ? "Search tournaments by name or format"
            : view === "starter" ? "Search starter decks"
            : "Search by deck name, owner, format or pool",
          onChange: "swtcgSearch"
        }
      });
    }
  }

  if (view === "public") {
    await put({
      id: id + "-sides",
      parentId: c,
      type: "layout",
      order: 1,
      layout: { direction: "row", gap: 4, wrap: true }
    });
    for (var s = 0; s < SIDES.length; s += 1) {
      await put({
        id: id + "-sides-side-" + (SIDES[s].code || "any"),
        parentId: id + "-sides",
        type: "button",
        order: s,
        props: { text: SIDES[s].label, variant: "ghost", selected: picker.side === SIDES[s].code, onClick: "swtcgSide" }
      });
    }
  }

  if (view === "player") {
    var options = await ownerOptions();
    await put({
      id: id + "-owner",
      parentId: c,
      type: "select",
      order: 1,
      props: {
        value: picker.ownerName,
        placeholder: options.length > 0 ? "Choose a player" : "No public decks loaded yet",
        options: options,
        onChange: "swtcgOwner"
      }
    });
  }

  if (view === "tournaments" && picker.tournamentId) {
    await put({
      id: id + "-back",
      parentId: c,
      type: "button",
      order: 2,
      props: { text: "← All tournaments", variant: "secondary", onClick: "swtcgBack" }
    });
  }

  if (view === "link") {
    await put({
      id: id + "-linkhelp",
      parentId: c,
      type: "text",
      order: 0,
      props: { text: "Paste a swtcg-deckdb.com deck link, or just its id (for example nmPcAc).", variant: "body" }
    });
    await put({
      id: id + "-linkinput",
      parentId: c,
      type: "input",
      order: 1,
      props: { value: picker.link, placeholder: "Deck link or id", onChange: "swtcgLink" }
    });
    await put({
      id: id + "-linkgo",
      parentId: c,
      type: "button",
      order: 2,
      props: { text: picker.busy ? "Loading…" : "Load this deck", variant: "primary", disabled: picker.busy, onClick: "swtcgLinkGo" }
    });
  }

  if (view === "cards") {
    await put({
      id: id + "-chelp",
      parentId: c,
      type: "text",
      order: 0,
      props: {
        text: "Pick a face-up card that was just moved on the table, or type a card's exact name.",
        variant: "body"
      }
    });
    await put({
      id: id + "-cquery",
      parentId: c,
      type: "layout",
      order: 1,
      layout: { direction: "row", gap: 6, align: "center" }
    });
    await put({
      id: id + "-cname",
      parentId: id + "-cquery",
      type: "input",
      order: 0,
      props: { value: picker.cardQuery, placeholder: "Exact card name, e.g. Anakin Skywalker (T)", onChange: "swtcgCardName" }
    });
    await put({
      id: id + "-cgo",
      parentId: id + "-cquery",
      type: "button",
      order: 1,
      props: { text: "Look up", variant: "secondary", onClick: "swtcgCardGo" }
    });
    await put({
      id: id + "-cards",
      parentId: c,
      type: "layout",
      order: 2,
      layout: { direction: "row", gap: 4, wrap: true }
    });
  }
}

/** Options for the "By player" select: everyone with a public deck, most decks first. */
async function ownerOptions() {
  var catalogue = cache.publicDecks && cache.publicDecks.ok ? cache.publicDecks.rows : [];
  var counts = {};
  for (var i = 0; i < catalogue.length; i += 1) {
    if (catalogue[i].owner) {
      counts[catalogue[i].owner] = (counts[catalogue[i].owner] || 0) + 1;
    }
  }
  var names = Object.keys(counts);
  names.sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); });
  var options = [];
  for (var n = 0; n < names.length && n < 200; n += 1) {
    options.push({ value: names[n], label: names[n] + " (" + counts[names[n]] + ")" });
  }
  return options;
}

/* ---- the row model ---- */

/**
 * The rows the current view selects, before paging, plus a note when there are none. Pure over
 * the caches and picker state — no reads — so typing can redraw without a request.
 */
function computeRows(picker) {
  var view = picker.view;
  var query = lower(picker.search).trim();
  var rows = [];
  var note = "";

  function matches(hay) {
    return !query || lower(hay).indexOf(query) >= 0;
  }

  function deckRow(d, prefix) {
    var facts = [];
    if (d.side) { facts.push(sideLabel(d.side)); }
    if (d.owner) { facts.push("by " + d.owner); }
    if (d.format) { facts.push(d.format); }
    if (d.pool) { facts.push(d.pool); }
    if (d.cardCount !== null && d.cardCount !== undefined) { facts.push(d.cardCount + " cards"); }
    return {
      kind: "deckdb",
      ref: d.id,
      text: (prefix || "") + d.name,
      facts: facts,
      owner: d.owner,
      ownerId: d.ownerId
    };
  }

  if (view === "starter") {
    var starters = cache.starters;
    if (!starters) {
      note = "Loading starter decks…";
    } else if (!starters.ok) {
      note = reasonText(starters.reason);
    } else {
      for (var s = 0; s < starters.rows.length; s += 1) {
        var st = starters.rows[s];
        if (matches(st.name + " " + sideLabel(st.side))) {
          rows.push({ kind: "starter", ref: s, text: st.name, facts: [sideLabel(st.side), st.total + " cards"].filter(Boolean) });
        }
      }
      note = rows.length === 0 ? "No starter deck matches that search." : "";
    }
  } else if (view === "public") {
    var pub = cache.publicDecks;
    if (!pub) {
      note = "Loading public decks…";
    } else if (!pub.ok) {
      note = reasonText(pub.reason);
    } else {
      for (var p = 0; p < pub.rows.length; p += 1) {
        var d = pub.rows[p];
        if (picker.side && d.side !== picker.side) {
          continue;
        }
        if (matches(d.name + " " + d.owner + " " + d.format + " " + d.pool)) {
          rows.push(deckRow(d));
        }
      }
      note = rows.length === 0 ? "No public deck matches those filters." : "";
    }
  } else if (view === "player") {
    if (picker.ownerId) {
      var ud = cache.userDecks[picker.ownerId];
      if (!ud) {
        note = "Loading decks by " + (picker.ownerName || "this player") + "…";
      } else if (!ud.ok) {
        note = reasonText(ud.reason, "That player has no public decks.");
      } else {
        for (var u = 0; u < ud.value.decks.length; u += 1) {
          if (matches(ud.value.decks[u].name + " " + ud.value.decks[u].format)) {
            rows.push(deckRow(ud.value.decks[u]));
          }
        }
        note = rows.length === 0 ? "No public decks by " + (ud.value.username || picker.ownerName) + "." : "";
      }
    } else if (!picker.ownerName) {
      note = "Choose a player above, or use “More decks by …” on any deck.";
    } else {
      var all = cache.publicDecks && cache.publicDecks.ok ? cache.publicDecks.rows : [];
      for (var o = 0; o < all.length; o += 1) {
        if (all[o].owner === picker.ownerName && matches(all[o].name + " " + all[o].format)) {
          rows.push(deckRow(all[o]));
        }
      }
      note = rows.length === 0 ? "No public decks by " + picker.ownerName + "." : "";
    }
  } else if (view === "tournaments") {
    if (!picker.tournamentId) {
      var ts = cache.tournaments;
      if (!ts) {
        note = "Loading tournaments…";
      } else if (!ts.ok) {
        note = reasonText(ts.reason);
      } else {
        for (var t = 0; t < ts.rows.length; t += 1) {
          var tr = ts.rows[t];
          if (matches(tr.name + " " + tr.format + " " + tr.pool)) {
            rows.push({
              kind: "tournament",
              ref: tr.id,
              text: tr.name,
              facts: [tr.date, tr.status, tr.format, tr.pool].filter(Boolean)
            });
          }
        }
        note = rows.length === 0 ? "No tournament matches that search." : "";
      }
    } else {
      var td = cache.tournamentById[picker.tournamentId];
      if (!td) {
        note = "Loading tournament…";
      } else if (!td.ok) {
        note = reasonText(td.reason, "That tournament is no longer listed.");
      } else {
        var names = {};
        var pubRows = cache.publicDecks && cache.publicDecks.ok ? cache.publicDecks.rows : [];
        for (var n = 0; n < pubRows.length; n += 1) {
          names[pubRows[n].id] = pubRows[n];
        }
        var entrants = td.value.entrants;
        for (var e = 0; e < entrants.length; e += 1) {
          var en = entrants[e];
          for (var k = 0; k < en.deckIds.length; k += 1) {
            var known = names[en.deckIds[k]];
            var place = en.placement !== null ? ordinal(en.placement) + " · " : "";
            var label = place + en.playedBy + " — " + (known ? known.name : "deck " + en.deckIds[k]);
            if (matches(label)) {
              rows.push({
                kind: "deckdb",
                ref: en.deckIds[k],
                text: label,
                facts: known ? [sideLabel(known.side), known.format].filter(Boolean) : [],
                owner: known ? known.owner : "",
                ownerId: null
              });
            }
          }
        }
        note = rows.length === 0 ? "No entrant of " + td.value.name + " has a public deck listed." : "";
      }
    }
  } else if (view === "mine") {
    if (picker.mineError) {
      note = picker.mineError;
    } else if (picker.mine === null) {
      note = "Loading your saved decks…";
    } else {
      for (var m = 0; m < picker.mine.length; m += 1) {
        var md = picker.mine[m];
        var title = md.isPrivate || md.name === null ? "Private deck" : md.name;
        if (!matches(title + " " + md.formatId)) {
          continue;
        }
        rows.push({
          kind: "mine",
          ref: md.id,
          text: title,
          facts: [md.cards + " cards", md.formatId, md.isPrivate ? "private" : "public", md.updated ? "updated " + md.updated : ""].filter(Boolean)
        });
      }
      note = rows.length === 0
        ? "No saved decks for this game. Build or import one on the game's page (you must be signed in)."
        : "";
    }
  } else if (view === "cards") {
    var info = picker.card ? cache.cardInfo[picker.card.cardId] : null;
    if (!picker.card) {
      note = "";
    } else if (!info) {
      note = "Loading decks that play " + picker.card.name + "…";
    } else if (!info.decks) {
      note = reasonText(info.decksReason, "No public deck plays " + picker.card.name + ".");
    } else {
      for (var x = 0; x < info.decks.length; x += 1) {
        rows.push(deckRow(info.decks[x]));
      }
      note = rows.length === 0 ? "No public deck plays " + picker.card.name + " yet." : "";
    }
  }
  return { rows: rows, note: note };
}

/** The list region: rows, the empty note, the selection detail, the pager and the status line. */
async function renderList(picker) {
  if (!alive(picker)) {
    return;
  }
  var id = picker.root;
  if (picker.view === "link") {
    await drawRows(picker, []);
    await drop(id + "-empty");
    await drop(id + "-detail");
    await drop(id + "-pager");
    await renderStatus(picker);
    return;
  }
  if (picker.view === "cards") {
    await renderCardPanel(picker);
  }

  var computed = computeRows(picker);
  var rows = computed.rows;
  var pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (picker.page >= pages) {
    picker.page = pages - 1;
  }
  var start = picker.page * PAGE_SIZE;
  picker.pageRows = rows.slice(start, start + PAGE_SIZE);

  await drawRows(picker, picker.pageRows);
  if (computed.note) {
    await put({
      id: id + "-empty",
      parentId: id + "-list",
      type: "text",
      order: 0,
      props: { text: computed.note, variant: "caption" }
    });
  } else {
    await drop(id + "-empty");
  }
  await renderDetail(picker);
  await renderPager(picker, rows.length, pages, start, picker.pageRows.length);
  await renderStatus(picker);
}

async function drawRows(picker, drawn) {
  var id = picker.root;
  for (var i = 0; i < drawn.length; i += 1) {
    var row = drawn[i];
    var isSelected = !!picker.selected && picker.selected.kind === row.kind && picker.selected.ref === row.ref;
    await put({
      id: id + "-row-" + i,
      parentId: id + "-list",
      type: "button",
      order: i + 1,
      layout: { direction: "row", justify: "start", align: "center" },
      props: {
        text: row.facts && row.facts.length > 0 ? clip(row.text, 90) + "  ·  " + row.facts.join(" · ") : clip(row.text, 120),
        variant: "ghost",
        selected: isSelected,
        disabled: picker.busy,
        onClick: "swtcgRow"
      }
    });
  }
  for (var extra = drawn.length; extra < picker.drawnRows; extra += 1) {
    await drop(id + "-row-" + extra);
  }
  picker.drawnRows = drawn.length;
}

/** What is selected, and what can be done with it. */
async function renderDetail(picker) {
  var id = picker.root;
  var row = picker.selected;
  if (!row) {
    await drop(id + "-detail");
    return;
  }
  await put({
    id: id + "-detail",
    parentId: id + "-body",
    type: "layout",
    order: 20,
    layout: { direction: "column", gap: 4, padding: 6 }
  });
  await put({
    id: id + "-dtitle",
    parentId: id + "-detail",
    type: "text",
    order: 0,
    props: { text: clip(row.text, 160), variant: "subtitle" }
  });
  await put({
    id: id + "-dfacts",
    parentId: id + "-detail",
    type: "text",
    order: 1,
    props: { text: (row.facts || []).join(" · "), variant: "caption" }
  });
  await put({
    id: id + "-dactions",
    parentId: id + "-detail",
    type: "layout",
    order: 2,
    layout: { direction: "row", gap: 6, wrap: true }
  });
  var loadable = row.kind !== "tournament";
  await put({
    id: id + "-load",
    parentId: id + "-dactions",
    type: "button",
    order: 0,
    // `metadata` carries the saved-deck id for a player's own copy, which reads it back on click
    // (the host cannot read another person's library). Public ids only otherwise.
    metadata: row.kind === "mine" ? { kind: "mine", ref: String(row.ref) } : { kind: row.kind },
    props: {
      text: picker.busy ? "Loading…" : loadable ? "Load this deck for the " + seatLabel(picker.seat) : "Show entrants",
      variant: "primary",
      disabled: picker.busy,
      onClick: "swtcgLoad"
    }
  });
  if (row.kind === "deckdb" && row.owner && !(picker.view === "player" && picker.ownerName === row.owner)) {
    await put({
      id: id + "-more",
      parentId: id + "-dactions",
      type: "button",
      order: 1,
      props: { text: "More decks by " + clip(row.owner, 60), variant: "secondary", disabled: picker.busy, onClick: "swtcgMore" }
    });
  } else {
    await drop(id + "-more");
  }
}

async function renderPager(picker, total, pages, start, shown) {
  var id = picker.root;
  if (pages <= 1) {
    await drop(id + "-pager");
    return;
  }
  await put({
    id: id + "-pager",
    parentId: id + "-body",
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

async function renderStatus(picker) {
  var status = picker.status || picker.loadingNote;
  var bad = /^(Could not|That|No |None|The deck database (is busy|refused|plugin))/.test(status);
  await put({
    id: picker.root + "-status",
    parentId: picker.root,
    type: "text",
    order: 90,
    props: { text: status, variant: bad ? "error" : "caption" }
  });
}

/* ---- the Cards view ---- */

async function renderCardPanel(picker) {
  var id = picker.root;
  var candidates = picker.cardCandidates || [];
  for (var i = 0; i < candidates.length; i += 1) {
    var cand = candidates[i];
    await put({
      id: id + "-crow-" + i,
      parentId: id + "-cards",
      type: "button",
      order: i,
      props: {
        text: clip(cand.name, 60) + (cand.set ? " · " + cand.set : ""),
        variant: "ghost",
        selected: !!picker.card && picker.card.cardId === cand.cardId,
        onClick: "swtcgCardPick"
      }
    });
  }
  for (var extra = candidates.length; extra < picker.cardsDrawn; extra += 1) {
    await drop(id + "-crow-" + extra);
  }
  picker.cardsDrawn = candidates.length;

  if (picker.cardCandidates !== null && candidates.length === 0) {
    await put({
      id: id + "-cnone",
      parentId: id + "-cards",
      type: "text",
      order: 0,
      props: { text: "No face-up card has been moved recently. Turn one up or type its name.", variant: "caption" }
    });
  } else {
    await drop(id + "-cnone");
  }

  if (!picker.card) {
    await drop(id + "-cinfo");
    return;
  }
  var card = picker.card;
  var info = cache.cardInfo[card.cardId];
  var rating;
  if (!info) {
    rating = "Loading ratings…";
  } else if (!info.ratings) {
    rating = reasonText(info.ratingsReason, "No rating data for this card.");
  } else if (info.ratings.average === null || info.ratings.count === 0) {
    rating = "Not rated yet on swtcg-deckdb.com.";
  } else {
    rating = "Community rating " + (Math.round(info.ratings.average * 10) / 10) + " / 5 from "
      + info.ratings.count + " rating" + (info.ratings.count === 1 ? "" : "s") + ".";
  }
  var stats = [];
  if (card.type) { stats.push(card.type); }
  if (card.cost !== null) { stats.push("cost " + card.cost); }
  if (card.speed !== null) { stats.push("speed " + card.speed); }
  if (card.power !== null) { stats.push("power " + card.power); }
  if (card.health !== null) { stats.push("health " + card.health); }
  await put({
    id: id + "-cinfo",
    parentId: id + "-controls",
    type: "layout",
    order: 3,
    layout: { direction: "column", gap: 2, padding: 4 }
  });
  await put({
    id: id + "-ctitle",
    parentId: id + "-cinfo",
    type: "text",
    order: 0,
    props: { text: card.name + (card.set ? " (" + card.set + ")" : ""), variant: "subtitle" }
  });
  await put({
    id: id + "-cstats",
    parentId: id + "-cinfo",
    type: "text",
    order: 1,
    props: { text: [card.side ? sideLabel(card.side) : "", stats.join(" · ")].filter(Boolean).join(" · "), variant: "caption" }
  });
  await put({
    id: id + "-crules",
    parentId: id + "-cinfo",
    type: "text",
    order: 2,
    props: { text: clip(card.rules, 400), variant: "body" }
  });
  await put({
    id: id + "-crating",
    parentId: id + "-cinfo",
    type: "text",
    order: 3,
    props: { text: rating + " Decks that play it are listed below.", variant: "caption" }
  });
}

/** A catalogue card id (or name) -> the full row the Cards view shows, or null. */
async function catalogueCard(key) {
  var rows = await attempt(function () { return api.resolveCards([key]); }, []);
  if (!isList(rows) || rows.length === 0 || !isObject(rows[0]) || !isObject(rows[0].data)) {
    return null;
  }
  var d = rows[0].data;
  var cardId = text(d.card_id) || text(rows[0].cardId);
  var name = text(d.name);
  if (!cardId || !name) {
    return null;
  }
  function n(v) { return typeof v === "number" ? v : null; }
  return {
    cardId: cardId,
    name: name,
    set: text(d.set),
    side: text(d.side),
    type: text(d.type),
    rules: text(d.rules_text),
    cost: n(d.cost),
    speed: n(d.speed),
    power: n(d.power),
    health: n(d.health)
  };
}

/**
 * The card a table object shows face up, from the least-privileged read — so only a card every
 * player can already see. A face-down card resolves null: its identity is not ours to read.
 */
async function visibleCardKey(objectId) {
  var object = await attempt(function () { return api.getObject(objectId); }, null);
  if (!isObject(object) || object.faceDown) {
    return null;
  }
  var meta = isObject(object.metadata) ? object.metadata : {};
  if (meta.__redacted) {
    return null;
  }
  if (object.kind === "card") {
    var id = text(meta.cardId) || text(object.label);
    return id && id !== "Card" ? baseCardId(id) : null;
  }
  if (object.kind === "deck") {
    var contents = await attempt(function () { return api.getContainerContents(objectId); }, []);
    var first = isList(contents) ? contents[0] : null;
    if (isObject(first) && first.kind === "card" && first.faceDown === false && text(first.cardId)) {
      return baseCardId(first.cardId);
    }
  }
  return null;
}

async function gatherCardCandidates(picker) {
  var out = [];
  var seen = {};
  var ids = recentObjectIds.slice(0, 12);
  for (var i = 0; i < ids.length && out.length < 8; i += 1) {
    var key = await visibleCardKey(ids[i]);
    if (!key || seen[key]) {
      continue;
    }
    seen[key] = true;
    var card = await catalogueCard(key);
    if (card) {
      out.push(card);
    }
  }
  if (alive(picker)) {
    picker.cardCandidates = out;
  }
}

async function selectCard(picker, card) {
  picker.card = card;
  picker.selected = null;
  picker.page = 0;
  picker.status = "";
  await renderList(picker);
  await loadCardInfo(card);
  if (alive(picker) && picker.card === card) {
    await renderList(picker);
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Data for a view                                                                               */
/* ------------------------------------------------------------------------------------------- */

/** Fetch whatever the current view needs (cached), then redraw its list. */
async function ensureViewData(picker) {
  var view = picker.view;
  if (view === "starter" && !(cache.starters && cache.starters.ok && fresh(cache.starters))) {
    await loadStarters();
  } else if (view === "public" && !(cache.publicDecks && cache.publicDecks.ok && fresh(cache.publicDecks))) {
    await loadPublicDecks();
  } else if (view === "player") {
    if (!cache.publicDecks || !cache.publicDecks.ok) {
      await loadPublicDecks();
      if (alive(picker) && picker.view === "player") {
        // The owner list is built from the public list, so the select needs redrawing.
        await renderControls(picker);
      }
    }
    if (picker.ownerId) {
      await loadUserDecks(picker.ownerId);
    }
  } else if (view === "tournaments") {
    if (picker.tournamentId) {
      if (!cache.publicDecks) {
        await loadPublicDecks();
      }
      await loadTournament(picker.tournamentId);
    } else {
      await loadTournaments();
    }
  } else if (view === "mine") {
    await ensureMine(picker);
  } else if (view === "cards" && picker.cardCandidates === null) {
    await gatherCardCandidates(picker);
  }
  if (alive(picker) && picker.view === view) {
    await renderList(picker);
  }
}

/**
 * "My decks". The host's own dialog reads the host's library here; a player's dialog waits for
 * the player's own copy of this script, which reads THEIR library and sends it up.
 *
 * Private deck NAMES are not drawn, for either. A dialog is a replicated UI element: `visibility`
 * decides who it is rendered for, but every peer's snapshot carries it, so a name drawn here is
 * a name every peer at the table receives. Count, format and date identify a deck well enough.
 */
async function ensureMine(picker) {
  if (picker.mine !== null) {
    return;
  }
  if (picker.hostOwned) {
    var rows = await attempt(function () {
      return api.listDecks({ scope: "mine", search: text(picker.search), limit: 50 });
    }, null);
    if (!alive(picker)) {
      return;
    }
    if (!isList(rows)) {
      picker.mineError = "Could not read your saved decks.";
      return;
    }
    picker.mine = parseMineSummaries(summariesForWire(rows));
    return;
  }
  if (picker.mineTimer) {
    clearTimeout(picker.mineTimer);
  }
  picker.mineTimer = setTimeout(function () {
    picker.mineTimer = null;
    if (alive(picker) && picker.view === "mine" && picker.mine === null && !picker.mineError) {
      picker.mineError = "Your saved decks did not arrive. Check you are signed in, then press My decks again.";
      void renderList(picker);
    }
  }, MINE_WAIT_MS);
}

/** `ModDeckSummary[]` -> the narrow shape that crosses to the host. No private names. */
function summariesForWire(rows) {
  var out = [];
  for (var i = 0; i < rows.length && i < 100; i += 1) {
    var r = rows[i];
    if (!isObject(r) || typeof r.id !== "string") {
      continue;
    }
    var isPrivate = r.visibility !== "public";
    out.push({
      id: r.id,
      name: isPrivate ? null : clip(r.name, 200),
      isPrivate: isPrivate,
      cards: isObject(r.totals) ? intOr(r.totals.cards, 0) : 0,
      formatId: clip(r.formatId, 64),
      updated: text(r.updatedAt).slice(0, 10)
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------- */
/* Opening, switching and loading                                                                */
/* ------------------------------------------------------------------------------------------- */

async function openPicker(seat, hostOwned, view) {
  if (!canDraw || !seat) {
    return null;
  }
  var tokens = Object.keys(pickers);
  for (var i = 0; i < tokens.length; i += 1) {
    if (pickers[tokens[i]] && pickers[tokens[i]].seat === seat) {
      await closePicker(pickers[tokens[i]]);
    }
  }
  // The host's own seat is the host's dialog, however it was opened (a seat hook included).
  var ownSeat = attemptSync(function () { return api.getMySeat(); }, null) === seat;
  var picker = makePicker(seat, hostOwned || ownSeat, view);
  await ensurePluginPresence();
  await renderPicker(picker);
  void (async function () {
    await refreshProviderStatus();
    await renderProviderLine(picker);
    if (alive(picker) && plugin.attribution) {
      await put({
        id: picker.root + "-attrib",
        parentId: picker.root,
        type: "text",
        order: 95,
        props: { text: plugin.attribution, variant: "caption" }
      });
    }
  })();
  await ensureViewData(picker);
  return picker;
}

async function switchView(picker, view) {
  picker.view = view;
  picker.page = 0;
  picker.selected = null;
  picker.status = "";
  picker.search = "";
  if (view === "mine") {
    picker.mine = null;
    picker.mineError = "";
  }
  if (view === "cards") {
    picker.cardCandidates = null;
  }
  await renderTabs(picker);
  await drop(picker.root + "-body");
  await renderBody(picker);
  await ensureViewData(picker);
}

/**
 * Run a load for one dialog. On success the dialog closes and the seat's bar stops nagging; on
 * failure the dialog stays open with the reason, which is the one case with something to read.
 */
async function runLoad(picker, task) {
  if (picker.busy) {
    return;
  }
  picker.busy = true;
  picker.status = "Loading…";
  await renderList(picker);
  var outcome;
  try {
    outcome = await task();
  } catch (error) {
    outcome = { ok: false, message: "That deck could not be loaded." };
  }
  if (!pickers[picker.token]) {
    return;
  }
  picker.busy = false;
  if (outcome && outcome.ok) {
    await closePicker(picker);
    // The pile is spawned this tick and visible to reads a little later.
    setTimeout(function () { void refreshBar(picker.seat); }, 1500);
    return;
  }
  picker.status = outcome && outcome.message ? outcome.message : "That deck could not be loaded.";
  await renderList(picker);
}

function loadSelected(picker, payload) {
  var row = picker.selected;
  if (!row) {
    return;
  }
  if (row.kind === "tournament") {
    picker.tournamentId = String(row.ref);
    picker.selected = null;
    picker.page = 0;
    picker.search = "";
    void (async function () {
      await drop(picker.root + "-body");
      await renderBody(picker);
      await ensureViewData(picker);
    })();
    return;
  }
  if (row.kind === "starter") {
    var starter = cache.starters && cache.starters.ok ? cache.starters.rows[row.ref] : null;
    if (!starter) {
      return;
    }
    void runLoad(picker, function () {
      return placeDeck(picker.seat, starter.name, { main: starter.cards, supply: [], resource: [] }, null);
    });
    return;
  }
  if (row.kind === "deckdb") {
    var deckId = String(row.ref);
    void runLoad(picker, function () { return loadDeckDb(picker.seat, deckId); });
    return;
  }
  if (row.kind === "mine") {
    if (picker.hostOwned && (payload.actorRole === "host" || payload.actorRole === "offline")) {
      var savedId = String(row.ref);
      void runLoad(picker, function () { return loadOwnSavedDeck(picker.seat, savedId); });
      return;
    }
    // A player's own deck: their copy of this script reads it and sends it up (`swtcgMyDeck`).
    picker.pendingMine = String(row.ref);
    if (picker.earlyMine && text(picker.earlyMine.deckId) === picker.pendingMine) {
      var early = picker.earlyMine;
      picker.earlyMine = null;
      acceptMyDeck(picker, early);
      return;
    }
    picker.busy = true;
    picker.status = "Loading your deck…";
    void renderList(picker);
    setTimeout(function () {
      if (alive(picker) && picker.pendingMine === String(row.ref) && picker.busy) {
        picker.busy = false;
        picker.pendingMine = null;
        picker.status = "Your deck did not arrive. Try again.";
        void renderList(picker);
      }
    }, MINE_WAIT_MS);
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Host-side hooks                                                                               */
/* ------------------------------------------------------------------------------------------- */

function registerHostHooks() {
  api.on("swtcgOpenDecks", function (payload) {
    var seat = barSeatByElement[text(payload && payload.elementId)];
    if (!seat || !barActorAllowed(seat, payload)) {
      return;
    }
    void openPicker(seat, isHostActor(payload), "starter");
  });

  api.on("swtcgOpenCards", function (payload) {
    var seat = barSeatByElement[text(payload && payload.elementId)];
    if (!seat || !barActorAllowed(seat, payload)) {
      return;
    }
    void openPicker(seat, isHostActor(payload), "cards");
  });

  api.on("swtcgClose", function (payload) {
    var picker = pickerFor(payload);
    if (picker) {
      void closePicker(picker);
    }
  });

  api.on("swtcgTab", function (payload) {
    var picker = pickerFor(payload);
    var view = argFor(payload && payload.elementId, "tab");
    if (!picker || picker.busy) {
      return;
    }
    for (var i = 0; i < VIEWS.length; i += 1) {
      if (VIEWS[i].id === view) {
        if (view === "player") {
          picker.ownerName = "";
          picker.ownerId = null;
        }
        if (view === "tournaments") {
          picker.tournamentId = null;
        }
        void switchView(picker, view);
        return;
      }
    }
  });

  api.on("swtcgSearch", function (payload) {
    var picker = pickerFor(payload);
    if (!picker) {
      return;
    }
    picker.search = clip(payload.value, 120);
    picker.page = 0;
    if (picker.searchTimer) {
      clearTimeout(picker.searchTimer);
    }
    picker.searchTimer = setTimeout(function () {
      picker.searchTimer = null;
      if (!alive(picker)) {
        return;
      }
      if (picker.view === "mine" && picker.hostOwned) {
        // Saved decks search server-side, so a new term is a new query.
        picker.mine = null;
        void ensureViewData(picker);
        return;
      }
      void renderList(picker);
    }, TYPING_DEBOUNCE_MS);
  });

  api.on("swtcgSide", function (payload) {
    var picker = pickerFor(payload);
    if (!picker) {
      return;
    }
    var code = argFor(payload.elementId, "side");
    picker.side = code === "any" ? "" : code;
    picker.page = 0;
    picker.selected = null;
    void (async function () {
      for (var s = 0; s < SIDES.length; s += 1) {
        await put({
          id: picker.root + "-sides-side-" + (SIDES[s].code || "any"),
          parentId: picker.root + "-sides",
          type: "button",
          order: s,
          props: { text: SIDES[s].label, variant: "ghost", selected: picker.side === SIDES[s].code, onClick: "swtcgSide" }
        });
      }
      await renderList(picker);
    })();
  });

  api.on("swtcgOwner", function (payload) {
    var picker = pickerFor(payload);
    if (!picker) {
      return;
    }
    picker.ownerName = clip(payload.value, 120);
    picker.ownerId = null;
    picker.page = 0;
    picker.selected = null;
    void renderList(picker);
  });

  api.on("swtcgRow", function (payload) {
    var picker = pickerFor(payload);
    if (!picker || picker.busy) {
      return;
    }
    var index = Number(argFor(payload.elementId, "row"));
    var row = picker.pageRows[index];
    if (!row) {
      return;
    }
    picker.selected = row;
    picker.status = "";
    void renderList(picker);
  });

  api.on("swtcgLoad", function (payload) {
    var picker = pickerFor(payload);
    if (!picker || picker.busy) {
      return;
    }
    loadSelected(picker, payload);
  });

  api.on("swtcgMore", function (payload) {
    var picker = pickerFor(payload);
    var row = picker ? picker.selected : null;
    if (!picker || picker.busy || !row || !row.owner) {
      return;
    }
    picker.ownerName = row.owner;
    picker.ownerId = row.ownerId || null;
    void (async function () {
      picker.view = "player";
      picker.page = 0;
      picker.selected = null;
      picker.status = "";
      picker.search = "";
      await renderTabs(picker);
      await drop(picker.root + "-body");
      await renderBody(picker);
      await ensureViewData(picker);
    })();
  });

  api.on("swtcgBack", function (payload) {
    var picker = pickerFor(payload);
    if (!picker || picker.busy) {
      return;
    }
    picker.tournamentId = null;
    picker.selected = null;
    picker.page = 0;
    picker.search = "";
    void (async function () {
      await drop(picker.root + "-body");
      await renderBody(picker);
      await ensureViewData(picker);
    })();
  });

  api.on("swtcgPrev", function (payload) {
    var picker = pickerFor(payload);
    if (!picker || picker.page === 0) {
      return;
    }
    picker.page -= 1;
    void renderList(picker);
  });

  api.on("swtcgNext", function (payload) {
    var picker = pickerFor(payload);
    if (!picker) {
      return;
    }
    picker.page += 1;
    void renderList(picker);
  });

  api.on("swtcgLink", function (payload) {
    var picker = pickerFor(payload);
    if (picker) {
      picker.link = clip(payload.value, 300);
    }
  });

  api.on("swtcgLinkGo", function (payload) {
    var picker = pickerFor(payload);
    if (!picker || picker.busy) {
      return;
    }
    var deckId = normalizeDeckId(picker.link);
    if (!deckId) {
      picker.status = "That does not look like a swtcg-deckdb.com deck link or id.";
      void renderStatus(picker);
      return;
    }
    void (async function () {
      await runLoad(picker, function () { return loadDeckDb(picker.seat, deckId); });
      if (alive(picker)) {
        await renderControls(picker);
      }
    })();
  });

  api.on("swtcgCardName", function (payload) {
    var picker = pickerFor(payload);
    if (picker) {
      picker.cardQuery = clip(payload.value, 200);
    }
  });

  api.on("swtcgCardGo", function (payload) {
    var picker = pickerFor(payload);
    if (!picker || picker.busy) {
      return;
    }
    var name = picker.cardQuery.trim();
    if (!name) {
      return;
    }
    void (async function () {
      var card = await catalogueCard(name);
      if (!alive(picker)) {
        return;
      }
      if (!card) {
        picker.status = "No card named “" + clip(name, 80) + "” in this game's catalogue. Names must match exactly.";
        await renderStatus(picker);
        return;
      }
      await selectCard(picker, card);
    })();
  });

  api.on("swtcgCardPick", function (payload) {
    var picker = pickerFor(payload);
    if (!picker || picker.busy) {
      return;
    }
    var index = Number(argFor(payload.elementId, "crow"));
    var card = (picker.cardCandidates || [])[index];
    if (card) {
      void selectCard(picker, card);
    }
  });

  /** A player's copy answering for its own user. `actorPeerId` is stamped by the host. */
  api.on("onHostMessage", function (message) {
    if (!isObject(message) || !isObject(message.data)) {
      return;
    }
    /** @type {any} Untrusted: every field below is checked before use. */
    var data = message.data;
    var picker = pickers[text(data.token)];
    if (!picker || picker.hostOwned) {
      return;
    }
    // Only the person who is driving this dialog may answer for it — never learned from a
    // message, because a message cannot click anything and so proves no seat.
    if (!picker.ownerPeer || picker.ownerPeer !== message.actorPeerId) {
      return;
    }
    if (message.name === "swtcgMyDecks") {
      if (data.error === true) {
        picker.mineError = "Could not read your saved decks. Check you are signed in.";
      } else {
        picker.mine = parseMineSummaries(data.decks);
        picker.mineError = "";
      }
      if (picker.mineTimer) {
        clearTimeout(picker.mineTimer);
        picker.mineTimer = null;
      }
      if (picker.view === "mine") {
        void renderList(picker);
      }
      return;
    }
    if (message.name === "swtcgMyDeck") {
      var deckId = text(data.deckId);
      if (!deckId || !mineListed(picker, deckId)) {
        return;
      }
      if (deckId !== picker.pendingMine) {
        // The player's copy can answer before the host has handled the same click. Keep it.
        picker.earlyMine = data;
        return;
      }
      acceptMyDeck(picker, data);
    }
  });

  api.on("onSeatChanged", function (payload) {
    if (!isObject(payload) || typeof payload.peerId !== "string") {
      return;
    }
    if (payload.seat) {
      seatByPeer[payload.peerId] = payload.seat;
    } else {
      delete seatByPeer[payload.peerId];
    }
    void (async function () {
      await syncSeats();
      if (!payload.seat) {
        return;
      }
      // Give a lobby-picked deck a moment to land before asking for one.
      setTimeout(function () {
        void (async function () {
          var has = await refreshBar(payload.seat);
          if (!has) {
            await openPicker(payload.seat, false, "starter");
          }
        })();
      }, 2000);
    })();
  });

  api.on("onPeerLeft", function (payload) {
    if (isObject(payload) && typeof payload.peerId === "string") {
      delete seatByPeer[payload.peerId];
    }
    void syncSeats();
  });

  api.on("onZoneEnter", function (payload) {
    if (isObject(payload) && typeof payload.seat === "string") {
      scheduleBarRefresh(payload.seat);
    }
  });

  api.on("onZoneLeave", function (payload) {
    if (isObject(payload) && typeof payload.seat === "string") {
      scheduleBarRefresh(payload.seat);
    }
  });
}

/** Did this player's own copy list this saved deck in the dialog? */
function mineListed(picker, deckId) {
  var rows = picker.mine || [];
  for (var i = 0; i < rows.length; i += 1) {
    if (rows[i].id === deckId) {
      return true;
    }
  }
  return false;
}

/** A player's saved deck arrived from their own copy: validate it and place it. */
function acceptMyDeck(picker, data) {
  var deckId = text(data.deckId);
  picker.pendingMine = null;
  picker.busy = false;
  if (data.error === true) {
    picker.status = "That deck could not be read, so nothing was placed.";
    void renderList(picker);
    return;
  }
  var name = clip(data.name, 200) || "My deck";
  var lists = parseDeckEntries(data.entries);
  void runLoad(picker, function () { return placeDeck(picker.seat, name, lists, deckId); });
}

function isHostActor(payload) {
  return !!payload && (payload.actorRole === "host" || payload.actorRole === "offline");
}

/** Same rule as `actorAllowed`, for the seat bar (which has no picker yet). */
function barActorAllowed(seat, payload) {
  if (!payload || payload.actorRole === "spectator") {
    return false;
  }
  if (isHostActor(payload)) {
    return attemptSync(function () { return api.getMySeat(); }, null) === seat;
  }
  var actor = text(payload.actorPeerId);
  if (!actor) {
    return false;
  }
  if (seatByPeer[actor] && seatByPeer[actor] !== seat) {
    return false;
  }
  seatByPeer[actor] = seat;
  return true;
}

/* ------------------------------------------------------------------------------------------- */
/* Player-side hooks — "My decks" read with the player's own credentials                         */
/* ------------------------------------------------------------------------------------------- */

async function sendMyDecks(token) {
  var rows = await attempt(function () {
    return api.listDecks({ scope: "mine", search: text(localSearch[token]), limit: 50 });
  }, null);
  try {
    if (!isList(rows)) {
      await api.sendToHost("swtcgMyDecks", { token: token, error: true });
      return;
    }
    await api.sendToHost("swtcgMyDecks", { token: token, decks: summariesForWire(rows) });
  } catch (error) {
    api.log("Could not send saved decks to the host: " + errorText(error));
  }
}

async function findUiElement(elementId) {
  var elements = await attempt(function () { return api.listUiElements(); }, []);
  if (!isList(elements)) {
    return null;
  }
  for (var i = 0; i < elements.length; i += 1) {
    if (elements[i] && elements[i].id === elementId) {
      return elements[i];
    }
  }
  return null;
}

function registerPlayerHooks() {
  // This copy sees only its OWN user's clicks (the platform dispatches a player's interaction to
  // that player's frame and to the host's), so everything here is the local person acting.
  api.on("swtcgTab", function (payload) {
    var token = tokenOf(payload && payload.elementId);
    var view = argFor(payload && payload.elementId, "tab");
    if (!token) {
      return;
    }
    localView[token] = view;
    localSearch[token] = "";
    if (view === "mine") {
      void sendMyDecks(token);
    }
  });

  api.on("swtcgSearch", function (payload) {
    var token = tokenOf(payload && payload.elementId);
    if (!token || localView[token] !== "mine") {
      return;
    }
    localSearch[token] = clip(payload.value, 120);
    if (localTimers[token]) {
      clearTimeout(localTimers[token]);
    }
    localTimers[token] = setTimeout(function () {
      delete localTimers[token];
      void sendMyDecks(token);
    }, TYPING_DEBOUNCE_MS);
  });

  api.on("swtcgLoad", function (payload) {
    var token = tokenOf(payload && payload.elementId);
    if (!token || localView[token] !== "mine") {
      return;
    }
    void (async function () {
      var element = await findUiElement(payload.elementId);
      var meta = element && isObject(element.metadata) ? element.metadata : null;
      if (!meta || meta.kind !== "mine" || typeof meta.ref !== "string") {
        return;
      }
      var deck = await attempt(function () { return api.getDeck(meta.ref); }, null);
      try {
        if (!isObject(deck) || deck.readable !== true || !isList(deck.entries)) {
          await api.sendToHost("swtcgMyDeck", { token: token, deckId: meta.ref, error: true });
          return;
        }
        var entries = [];
        for (var i = 0; i < deck.entries.length && i < 500; i += 1) {
          var e = deck.entries[i];
          if (isObject(e)) {
            entries.push({ cardId: text(e.cardId), count: intOr(e.count, 1), partitionId: e.partitionId || null });
          }
        }
        await api.sendToHost("swtcgMyDeck", { token: token, deckId: meta.ref, name: clip(deck.name, 200), entries: entries });
      } catch (error) {
        api.log("Could not send the deck to the host: " + errorText(error));
      }
    })();
  });
}

/* ------------------------------------------------------------------------------------------- */
/* Hooks every copy needs                                                                        */
/* ------------------------------------------------------------------------------------------- */

function registerSharedHooks() {
  // Cheap bookkeeping only — this hook fires for every event-log line. The "Cards" view reads the
  // objects later, when somebody asks.
  api.on("onTableEvent", function (payload) {
    var objectId = payload && payload.event ? payload.event.objectId : null;
    if (typeof objectId !== "string" || !objectId) {
      return;
    }
    var at = recentObjectIds.indexOf(objectId);
    if (at >= 0) {
      recentObjectIds.splice(at, 1);
    }
    recentObjectIds.unshift(objectId);
    if (recentObjectIds.length > 16) {
      recentObjectIds.length = 16;
    }
  });
}

/* ------------------------------------------------------------------------------------------- */
/* Entry point                                                                                   */
/* ------------------------------------------------------------------------------------------- */

exports.setup = async function setup(_api, manifest) {
  if (manifest && typeof manifest.id === "string" && manifest.id) {
    MOD_ID = manifest.id;
  }

  // A variant whose scene script enforces the rules owns the cards. Stay out of its way entirely.
  var variant = attemptSync(function () { return api.getVariant(); }, null);
  if (isObject(variant) && variant.rulesEnforced === true) {
    api.log("Star Wars TCG: the “" + text(variant.id) + "” variant runs its own rules, so the Deck Database is off.");
    return;
  }

  // Which peer is this? A host-only UI write tells us without needing a peer id: on a player or
  // spectator it rejects. Deleting an element that does not exist is harmless on the host.
  try {
    await api.deleteUiElement(LEGACY_NAG_ID);
    isHostFrame = true;
  } catch (error) {
    isHostFrame = false;
    canDraw = false;
  }

  registerSharedHooks();
  if (!isHostFrame) {
    registerPlayerHooks();
    return;
  }
  registerHostHooks();

  var seats = await attempt(function () { return syncSeats(); }, []);
  for (var i = 0; i < seats.length; i += 1) {
    await drop(LEGACY_NAG_ID + "-" + seats[i]);
  }

  // The host never gets a seat hook for itself. Open its own dialog if its seat has no deck once a
  // lobby-picked deck has had a moment to land.
  var mySeat = attemptSync(function () { return api.getMySeat(); }, null);
  if (typeof mySeat === "string" && mySeat) {
    setTimeout(function () {
      void (async function () {
        var has = await refreshBar(mySeat);
        if (!has) {
          await openPicker(mySeat, true, "starter");
        }
      })();
    }, 2000);
  }
};
