# Star Wars TCG — the deck gate

`scripts/main.js` asks each seated player for a deck, and puts the one they choose where it
belongs. This is what it expects and how to check it.

## Requires

- DiceyTable with `api.listSeatZones`, `api.listDecks` / `api.getDeck` and `api.sendToHost`
  (shipped 2026-08-27). The manifest declares `read-world`, `read-decks` and `host-message`
  alongside the rest; an older client refuses the mod at publish rather than half-running it.
- The `community.swtcg-deckdb` plugin selected on the room, for the deck-database tab. Everything
  else works without it.

## The zones

Placement reads the seat's own zones by their **authored name** on the seat template:

| Zone | Holds | Facing |
|---|---|---|
| `Deck` | The shuffled main deck, face down. | The zone's own yaw, so it faces its seat. |
| `Supply` | The supply pile, face down. | Same. |
| `Resource` | One resource card, **face up**. | Same. |

They already exist on the template and both seats are linked to it, so moving, rotating or
rescaling a seat in Edit Mode moves the piles with it — nothing here is a coordinate.

Rename a box and rename `ZONE_DECK` / `ZONE_SUPPLY` / `ZONE_RESOURCE` at the head of the script;
those three constants are the only place the layout is named. A seat missing one still loads: the
pieces land on a shelf to the side and the activity log says which zone was missing, because a
pile silently dropped at the origin reads as a broken mod.

## The two halves

The script runs on every peer and the halves do different jobs, because the platform gives them
different powers:

- **The host draws and spawns.** `setUiElement` and `createObject` are refused on anyone else.
- **Each player reads its own library.** `listDecks` / `getDeck` read with the credentials of the
  peer that calls them — so **only your own copy of the script can see your private decks**, and
  the host's copy cannot.

`api.sendToHost` joins them. A player's copy reads its own shelf and sends the rows up; the host
draws them; when a row is clicked the player's copy reads that deck and sends the **list**, and
the host places it. The host loading its own deck takes the same path with no wire hop.

**This is why "My decks" is safe to show to everyone now.** The rows in a player's dialog were
read by that player's peer. Nothing the host reads is ever drawn into somebody else's dialog.

Identity is never taken from a message: `onHostMessage` carries `actorPeerId`, stamped by the host
from the data channel, and the seat used for placement comes from this script's own record of the
seat hooks. A payload claiming a seat is ignored.

## Where a deck comes from

1. **My decks** — your DiceyTable decks for this game, private ones included.
2. **Community decks** — every public DiceyTable deck for this game.
3. **Deck database** — public lists on swtcg-deckdb.com, searchable by name, filterable by side.
4. **Paste a link** — a deck id or a full `/deck/<id>` permalink.

## The gate

A player who takes a seat gets a dismissible dialog and a pinned **"Choose your deck to start"**
button that stays until that seat has a deck. Dismissing costs nothing; the button keeps asking.
Once a deck is placed the button relaxes to "Load another deck".

A reload does not re-ask: the check reads the TABLE for a pile stamped with that seat, not this
session's memory.

## The resource card

One card whose catalogue `type` is `Resource` is turned face up in the resource zone, looked for
in the deck's `resource` partition, then the main deck, then the supply. It is **removed** from
the pile it came from, so the same card is never on the table twice. A deck with no resource still
loads and says so.

## Card art

Piles carry `metadata.cardSource` — a provenance slice naming this game as the card source —
and the PLATFORM resolves the faces from `data/cardSchema.json` and
`assets/cards/swtcg.cards.json`. That is what supplies:

- the mod's own card back (`assets/textures/card-back.webp`) instead of the built-in one,
- one packed sprite sheet per pile rather than a texture per card,
- and the per-card rotation this game needs, because it prints Battle, Mission, Equipment,
  Location, Resource and Event **landscape** and Character, Ground and Space **portrait**.

Resolution matches on the catalogue key (`card_id`) and nothing else, so the script rewrites
every entry to that key before spawning. It has to: a DiceyTable deck stores `card_id`, and the
deck-db plugin hands back card NAMES. `api.resolveCards` accepts either and returns the row,
which is where the two are joined.

A card this catalogue does not know keeps the id it came with, renders blank, and is counted in
the load message — a stale decklist should say so rather than quietly shrink.

An earlier version attached a `faceUrls` map of art URLs instead. It worked and looked wrong:
that path renders each URL as a whole texture at a fixed rotation, so every landscape card was
stretched onto portrait stock, and it carries no card back at all.

### The zone is what turns, not the card

A Resource is printed **landscape**, so it has to lie across. The script does **not** turn it —
the **Resource zone** carries `rotationY: 90` in the seat template, and the card inherits that.

That is not a style choice, it is the only thing that works. An `area` zone with an arrange mode
re-lays its contents on every membership change and sets each piece's yaw to the **zone's**
facing, so a card cannot keep an orientation of its own:

```ts
const facing = seatFacingYawDegrees(zone.position, zone.rotationY);
const rotation = faceKeepingEulerAngles(object.entity.up.y, facing);
```

An earlier version of this script added 90° at spawn instead. It never once took effect — the
card was turned back within a frame, with nothing logged. Measured on a live table: spawned at
270°, read back at 180°, identical to the deck and supply piles.

**So: to change how the resource lies, rotate the zone in Edit Mode.** Adding a turn in the
script as well would double it on any zone with arrange off, and would give you two places to
look when it came out wrong.

The related platform rule, worth knowing before reaching for `rotationQuarter`: the table keeps
every card on **portrait stock** and ignores that field there deliberately, because a landscape
outline would advertise a face-down card's type — which in this game is real information.

## Checking a change

```bash
node tools/deck-gate-harness.mjs
```

Stands up a host and a player, wires `sendToHost` between them the way the platform does — identity
stamped by the receiver, never from the payload — and fans each UI interaction to the actor and the
host. No browser, no table, no network. It covers the gate, the placement and orientation for both
seats, the resource fallback chain, the host-only draw rule, a forged seat in a payload, a
spectator, an unreadable deck, and the missing-zone degradation.
