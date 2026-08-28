// Drive the deck gate the way the platform does — TWO peers, one script.
//
// Run from this repo's root:  node tools/deck-gate-harness.mjs
//
// The script runs on every peer and the halves do different jobs, so a one-peer harness would
// miss the interesting half. This one stands up a host and a player, wires `sendToHost` between
// them the way `App.tsx` does (identity stamped by the RECEIVER, never from the payload), and
// fans a UI interaction out to the actor AND the host, which is what the platform now does.
//
// No browser, no table, no network.

import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../scripts/main.js", import.meta.url), "utf8");

/** The mod's own catalogue rows the script resolves against. */
const CATALOGUE = {
  "Anakin Skywalker": { name: "Anakin Skywalker", type: "Character", art: "https://x/a.png" },
  Coruscant: { name: "Coruscant", type: "Location", art: "https://x/c.png" },
  "Tatooine Resource": { name: "Tatooine Resource", type: "Resource", art: "https://x/r.png" },
  "Supply Resource": { name: "Supply Resource", type: "Resource", art: "https://x/s.png" },
  Blaster: { name: "Blaster", type: "Equipment", art: "https://x/b.png" }
};

function zone(seat, name, x, z, rotationY) {
  return {
    seat,
    id: `seat-zone-${seat}-zone-${name}`,
    templateZoneId: `zone-${name}`,
    name,
    type: "area",
    position: { x, y: 1.57, z },
    size: { x: 0.276, z: 0.365 },
    rotationY,
    tagFilter: []
  };
}

// The real template, materialised for both seats: red faces 180, blue faces 0.
const ZONES = [
  zone("red", "Deck", 1.39, -3.5, 180),
  zone("red", "Supply", -1.4, -3.5, 180),
  zone("red", "Resource", -1.83, -3.5, 180),
  zone("blue", "Deck", 1.39, 3.5, 0),
  zone("blue", "Supply", -1.4, 3.5, 0),
  zone("blue", "Resource", -1.83, 3.5, 0)
];

/**
 * One peer running the script.
 *
 * `isHost` decides only what the platform refuses, exactly as it does live: a player's
 * `setUiElement` / `createObject` / `objectAction` throw, and everything else works.
 */
function makePeer(name, options) {
  const calls = { ui: [], deleted: [], created: [], actions: [], logs: [], sent: [] };
  const hooks = {};
  const table = options.table;

  const api = {
    log: (m) => calls.logs.push(m),
    getMySeat: () => options.seat ?? null,
    on: (event, handler) => { (hooks[event] ||= []).push(handler); },
    setUiElement: async (el) => {
      if (!options.isHost) throw new Error("Host only.");
      calls.ui.push(el);
      return el;
    },
    deleteUiElement: async (id) => {
      if (!options.isHost) throw new Error("Host only.");
      calls.deleted.push(id);
      return true;
    },
    createObject: (o) => {
      if (!options.isHost) throw new Error("Host only.");
      calls.created.push(o);
      table.objects.push(o);
    },
    objectAction: (id, action) => {
      if (!options.isHost) throw new Error("Host only.");
      calls.actions.push({ id, action });
    },
    listObjects: async () => table.objects.filter((o) => o.kind === "deck"),
    listSeatZones: async (seat) => ZONES.filter((z) => !seat || z.seat === seat),
    resolveCards: async (ids) => ids.filter((id) => CATALOGUE[id]).map((id) => ({ cardId: id, data: CATALOGUE[id] })),
    // THE POINT: each peer reads its OWN library.
    listDecks: async (q) => (options.decks ?? []).filter((d) => q.scope === "mine" || d.visibility === "public"),
    getDeck: async (id) => (options.deckRecords ?? {})[id] ?? null,
    callPlugin: async (_pluginId, fn, params) =>
      (options.plugin ?? (() => ({ ok: false, reason: "unavailable" })))(fn, params),
    sendToHost: async (msgName, data) => {
      calls.sent.push({ name: msgName, data });
      // The transport. `actorPeerId` is stamped by the RECEIVER from the channel — the payload
      // has no field for it and the sender cannot supply one.
      table.deliverToHost({
        name: msgName,
        data: JSON.parse(JSON.stringify(data ?? null)),
        actorPeerId: options.peerId,
        actorRole: options.isHost ? "host" : "player",
        at: "2026-08-27T00:00:00.000Z"
      });
    }
  };

  const peer = { name, api, calls, hooks, options };
  table.peers.push(peer);
  return peer;
}

function makeTable() {
  const table = {
    objects: [],
    peers: [],
    deliverToHost(payload) {
      const host = table.peers.find((p) => p.options.isHost);
      for (const h of host?.hooks.onHostMessage ?? []) h(payload);
    },
    /** A UI interaction: dispatched to the ACTOR's own peer AND to the host, as the platform does. */
    async click(actor, elementId, extra = {}) {
      const payload = {
        modId: "star-wars-tcg",
        elementId,
        widgetType: "button",
        interaction: "click",
        hook: null,
        actorPeerId: actor.options.peerId,
        actorRole: actor.options.isHost ? "host" : "player",
        at: "2026-08-27T00:00:00.000Z",
        ...extra
      };
      const hookName = extra.hookName ?? hookFor(elementId);
      const targets = actor.options.isHost ? [actor] : [actor, table.peers.find((p) => p.options.isHost)];
      for (const target of targets) {
        for (const h of target?.hooks[hookName] ?? []) await h(payload);
      }
      await tick();
    },
    async seat(actor, seatId) {
      actor.options.seat = seatId;
      for (const peer of table.peers) {
        for (const h of peer.hooks.onSeatChanged ?? []) await h({ peerId: actor.options.peerId, seat: seatId });
      }
      await tick();
    }
  };
  return table;
}

/** Which custom hook an element id fires, mirroring the props this script sets. */
function hookFor(elementId) {
  if (elementId.includes("-tab-")) return "swtcgTab";
  if (elementId.includes("-row-")) return "swtcgPickDeck";
  if (elementId.includes("-side-")) return "swtcgSide";
  if (elementId === "swtcg-nag") return "swtcgOpen";
  return "swtcgUnknown";
}

const tick = async () => { for (let i = 0; i < 800; i += 1) await Promise.resolve(); };

function run(peer) {
  const exports = {};
  // eslint-disable-next-line no-new-func
  new Function("api", "exports", "module", SRC)(peer.api, exports, { exports });
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** The root element id of the dialog the host drew FOR this peer (or for its own seat). */
function dialogRootFor(host, peer) {
  const modals = host.calls.ui.filter((e) => e.presentation?.mode === "modal");
  for (let i = modals.length - 1; i >= 0; i -= 1) {
    const v = modals[i].visibility ?? {};
    const mine = v.scope === "players"
      ? (v.peerIds ?? []).includes(peer.options.peerId)
      : v.scope === "seat" && (v.seats ?? []).includes(peer.options.seat);
    if (mine) return modals[i].id;
  }
  return null;
}

/** The row elements of ONE dialog, newest write per element id. */
function rowsOf(host, root) {
  const byId = new Map();
  for (const el of host.calls.ui) {
    if (el.id?.startsWith(root + "-row-")) byId.set(el.id, el);
  }
  return [...byId.values()];
}

function statusOf(host, root) {
  return host.calls.ui.filter((e) => e.id === root + "-status").pop();
}

function deckRecord(id, name, entries, visibility = "private") {
  return {
    id, name, readable: true, visibility, username: "matt", formatId: null, description: "",
    thumbnailCardId: null, updatedAt: "2026-08-27T00:00:00Z",
    totals: { cards: entries.length, distinctCards: entries.length }, entries
  };
}

const HOST_DECK = deckRecord("host-uuid-1111", "Host's Secret Deck", [
  { cardId: "Coruscant", count: 2, partitionId: "main" }
]);
const PLAYER_DECK = deckRecord("player-uuid-2222", "Shadow Collective", [
  { cardId: "Anakin Skywalker", count: 2, partitionId: null },
  { cardId: "Coruscant", count: 1, partitionId: "main" },
  { cardId: "Tatooine Resource", count: 1, partitionId: "resource" },
  { cardId: "Blaster", count: 3, partitionId: "supply" }
]);

/** A host and a player, both seated, both booted. */
async function stand(up = {}) {
  const table = makeTable();
  const host = makePeer("host", {
    isHost: true, peerId: "peer-host", seat: "red", table,
    decks: [{ ...HOST_DECK, entries: undefined }],
    deckRecords: { [HOST_DECK.id]: HOST_DECK },
    ...(up.host ?? {})
  });
  const player = makePeer("player", {
    isHost: false, peerId: "peer-player", seat: null, table,
    decks: [{ ...PLAYER_DECK, entries: undefined }],
    deckRecords: { [PLAYER_DECK.id]: PLAYER_DECK },
    ...(up.player ?? {})
  });
  run(host);
  run(player);
  await tick();
  return { table, host, player };
}

/* ------------------------------------------------------------------ */
console.log("\n1. only the host draws");
{
  const { host, player } = await stand();
  check("host drew a nag button", host.calls.ui.some((e) => e.id === "swtcg-nag"));
  check("host opened its own picker", host.calls.ui.some((e) => e.presentation?.mode === "modal"));
  check("player drew nothing", player.calls.ui.length === 0, player.calls.ui.length);
  check("player spawned nothing", player.calls.created.length === 0);
}

/* ------------------------------------------------------------------ */
console.log("\n2. each peer reports ITS OWN library, and the host never lists another's");
{
  const { table, host, player } = await stand();
  await table.seat(player, "blue");
  check("the player sent its own decks up", player.calls.sent.some((m) => m.name === "swtcg-decks"), player.calls.sent);
  const reported = player.calls.sent.find((m) => m.name === "swtcg-decks");
  check("and they are the PLAYER's decks", reported?.data.rows[0]?.name === "Shadow Collective", reported?.data.rows);
  check("the host did not send its own over the wire", !host.calls.sent.some((m) => m.data.rows?.[0]?.name === "Shadow Collective"));
}

/* ------------------------------------------------------------------ */
console.log("\n3. a player's dialog shows the PLAYER's decks, never the host's");
{
  const { table, host, player } = await stand();
  await table.seat(player, "blue");
  const root = dialogRootFor(host, player);
  const rows = rowsOf(host, root).map((e) => e.props.text);
  check("a row for the player's deck appears", rows.some((t) => t.includes("Shadow Collective")), rows);
  // 🔴 The dialog aimed at the player must never list a deck the HOST read.
  check("the host's private deck does NOT appear", !rows.some((t) => t.includes("Host's Secret Deck")), rows);

  // The element id carries the deck id, which is how both peers resolve the same row.
  const row = rowsOf(host, root)[0];
  check("the row's element id carries the deck id", row?.id.includes(PLAYER_DECK.id), row?.id);
}

/* ------------------------------------------------------------------ */
console.log("\n4. a player picks; the player reads; the host places");
{
  const { table, host, player } = await stand();
  await table.seat(player, "blue");
  const row = rowsOf(host, dialogRootFor(host, player))[0];
  await table.click(player, row.id);

  check("the player sent the LIST up", player.calls.sent.some((m) => m.name === "swtcg-load"), player.calls.sent.map((m) => m.name));
  const sent = player.calls.sent.find((m) => m.name === "swtcg-load");
  check("the list is the deck's entries", sent?.data.entries.length === 4, sent?.data.entries);
  check("the player spawned nothing itself", player.calls.created.length === 0);

  const piles = host.calls.created.filter((o) => o.kind === "deck");
  const cards = host.calls.created.filter((o) => o.kind === "card");
  check("the host spawned the two piles", piles.length === 2, piles.map((p) => p.label));
  check("and one resource", cards.length === 1, cards.length);

  const main = piles.find((p) => !p.label.includes("Supply"));
  const supply = piles.find((p) => p.label.includes("Supply"));
  check("main went to BLUE's deck zone", main?.position.x === 1.39 && main?.position.z === 3.5, main?.position);
  check("main faces the blue seat", main?.rotation.y === 0, main?.rotation);
  check("supply went to BLUE's supply zone", supply?.position.x === -1.4, supply?.position);
  check("the resource went to BLUE's resource zone", cards[0]?.position.x === -1.83, cards[0]?.position);
  check("piles are face down", main?.faceDown === true && supply?.faceDown === true);
  check("the resource is face up", cards[0]?.faceDown === false);
  check("the resource is the Resource-typed card", cards[0]?.label === "Tatooine Resource", cards[0]?.label);
  check("the resource is not also in the deck",
    !main.metadata.cards.some((c) => c.cardId.startsWith("Tatooine")),
    main.metadata.cards.map((c) => c.cardId));
  check("main holds 3 cards", main?.stackCount === 3, main?.stackCount);
  check("the host shuffled it", host.calls.actions.some((a) => a.action === "shuffle"), host.calls.actions);
  check("the pile is stamped with the PLAYER's seat", main?.metadata.swtcgSeat === "blue", main?.metadata.swtcgSeat);
  check("art rides along", !!main?.metadata.faceUrls["Anakin Skywalker"]);
}

/* ------------------------------------------------------------------ */
console.log("\n5. the host loading its OWN deck takes the same path");
{
  const { table, host } = await stand();
  const row = rowsOf(host, dialogRootFor(host, host))[0];
  check("the host's own dialog lists the host's own decks", row?.props.text.includes("Host's Secret Deck"), row?.props.text);
  await table.click(host, row.id);
  const piles = host.calls.created.filter((o) => o.kind === "deck");
  check("it spawned into RED's deck zone", piles[0]?.position.x === 1.39 && piles[0]?.position.z === -3.5, piles[0]?.position);
  check("facing the red seat", piles[0]?.rotation.y === 180, piles[0]?.rotation);
  check("nothing crossed the wire", host.calls.sent.every((m) => m.name !== "swtcg-load"), host.calls.sent.map((m) => m.name));
}

/* ------------------------------------------------------------------ */
console.log("\n6. a forged seat in the payload is ignored");
{
  const { table, host, player } = await stand();
  await table.seat(player, "blue");
  host.calls.created.length = 0;

  // A hostile peer sends a load naming the RED seat. The host must place it at the seat it
  // recorded for that peer, which is blue.
  table.deliverToHost({
    name: "swtcg-load",
    data: { name: "Griefer", readable: true, seat: "red", entries: [{ cardId: "Coruscant", count: 1, partitionId: "main" }] },
    actorPeerId: "peer-player",
    actorRole: "player",
    at: "2026-08-27T00:00:00.000Z"
  });
  await tick();
  const pile = host.calls.created.find((o) => o.kind === "deck");
  check("placed at the sender's REAL seat", pile?.metadata.swtcgSeat === "blue", pile?.metadata.swtcgSeat);
  check("not at the seat it claimed", pile?.position.z === 3.5, pile?.position);
}

/* ------------------------------------------------------------------ */
console.log("\n7. a message from an unseated peer places nothing");
{
  const { table, host } = await stand();
  host.calls.created.length = 0;
  table.deliverToHost({
    name: "swtcg-load",
    data: { name: "Nobody", readable: true, entries: [{ cardId: "Coruscant", count: 1, partitionId: "main" }] },
    actorPeerId: "peer-ghost",
    actorRole: "player",
    at: "2026-08-27T00:00:00.000Z"
  });
  await tick();
  check("nothing spawned", host.calls.created.length === 0, host.calls.created.map((o) => o.label));
}

/* ------------------------------------------------------------------ */
console.log("\n8. a spectator is refused");
{
  const { table, host } = await stand();
  host.calls.created.length = 0;
  table.deliverToHost({
    name: "swtcg-load",
    data: { name: "Watcher", readable: true, entries: [{ cardId: "Coruscant", count: 1, partitionId: "main" }] },
    actorPeerId: "peer-player",
    actorRole: "spectator",
    at: "2026-08-27T00:00:00.000Z"
  });
  await tick();
  check("nothing spawned", host.calls.created.length === 0);
}

/* ------------------------------------------------------------------ */
console.log("\n9. an unreadable deck places nothing and says so");
{
  const broken = { ...deckRecord("broken-uuid", "Broken", []), readable: false };
  const { table, host, player } = await stand({
    player: { decks: [{ ...broken, entries: undefined }], deckRecords: { "broken-uuid": broken } }
  });
  await table.seat(player, "blue");
  const root = dialogRootFor(host, player);
  await table.click(player, rowsOf(host, root)[0].id);
  check("nothing spawned", host.calls.created.length === 0, host.calls.created.map((o) => o.label));
  check("the dialog says why", /could not be read/.test(statusOf(host, root)?.props.text ?? ""),
    statusOf(host, root)?.props.text);
}

/* ------------------------------------------------------------------ */
console.log("\n10. the deck database tab still works, host-side");
{
  const { table, host } = await stand({
    host: {
      plugin: (fn) => fn === "publicDecks"
        ? { ok: true, data: [{ id: "129", name: "Duchess", side: "L", owner_username: "bob", card_count: 60 }] }
        : { ok: true, data: { name: "Duchess", cards: [{ name: "Coruscant", count: 2 }], supply: [{ name: "Blaster", count: 1 }] } }
    }
  });
  const hostRoot = dialogRootFor(host, host);
  await table.click(host, hostRoot + "-tab-browse");
  const row = rowsOf(host, hostRoot).find((e) => e.id.includes("-row-deckdb-"));
  check("a deck-db row is drawn", !!row, host.calls.ui.filter((e) => e.id?.includes("-row-")).map((e) => e.id));
  await table.click(host, row.id);
  const piles = host.calls.created.filter((o) => o.kind === "deck");
  check("it imports", piles.length === 2, piles.map((p) => p.label));
  check("into the red deck zone", piles[0]?.position.x === 1.39, piles[0]?.position);
}

/* ------------------------------------------------------------------ */
console.log("\n11. a seat with a deck is not gated again");
{
  const table = makeTable();
  table.objects.push({ id: "d", kind: "deck", metadata: { swtcgSeat: "red" } });
  const host = makePeer("host", { isHost: true, peerId: "peer-host", seat: "red", table, decks: [], deckRecords: {} });
  run(host);
  await tick();
  check("no picker opened", !host.calls.ui.some((e) => e.presentation?.mode === "modal"));
  const nag = host.calls.ui.find((e) => e.id === "swtcg-nag");
  check("the nag relaxes", nag?.props.text === "Load another deck", nag?.props.text);
}

/* ------------------------------------------------------------------ */
console.log("\n12. a seat with no zones still loads, and names what is missing");
{
  const { table, host, player } = await stand();
  await table.seat(player, "blue");
  const kept = ZONES.splice(0, ZONES.length);
  await table.click(player, rowsOf(host, dialogRootFor(host, player))[0].id);
  check("the piles still spawn", host.calls.created.length > 0);
  check("the log names all three zones",
    host.calls.logs.some((l) => l.includes("Deck") && l.includes("Supply") && l.includes("Resource")),
    host.calls.logs);
  ZONES.push(...kept);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
