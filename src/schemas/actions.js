// Zod schemas for /api/v1/actions/* routes.
// See src/schemas/README.md for how these get used.
//
// Every /actions/* endpoint goes through payOrExecute() → {paid|free} branch.
// The response shape is structurally identical across endpoints, differing
// only by `action_type` literal. `makeActionResponseSchema(actionType)` is
// a factory that captures the shape once; per-route schemas lock the literal.

import { z } from 'zod'
import { IsoTimestamp, withPayloadAliases } from './common.js'
import { PlanClaimsSchema } from './war.js'

// Next-action hint returned in every paid-action response. The shape is
// a mixed union (see src/api/routes/actions.js :: getNextActions): most
// items are { action, description }, a few have an { _rule } advisory
// line instead. Loose schema reflects that.
export const NextActionHintSchema = z.strictObject({
  action: z.string().optional(),
  description: z.string().optional(),
  _rule: z.string().optional(),
})

// ── Action response factory ────────────────────────────────────────
//
// Response schemas are strict — drift detection is the point.
// Any new field on a response must be reflected here or smoke fails.
//
// tx_hash: the x402 settle tx.
// distribute_tx_hash: the rail defers the class split into batches (S2),
// so the request-path response omits it — hence nullable().optional()
// (historical per-user-rail rows carried it inline).
function makeActionResponseSchema(actionType) {
  return z.strictObject({
    success: z.literal(true),
    action_id: z.string(),
    action_type: z.literal(actionType),
    tx_hash: z.string(),
    distribute_tx_hash: z.string().nullable().optional(),
    cached: z.boolean(),
    next_actions: z.array(NextActionHintSchema),
  })
}

// ── Requests ───────────────────────────────────────────────────────
//
// Request body schemas are intentionally NOT .strict() — incoming
// requests may carry extra fields from SDK versioning / agent quirks,
// and rejecting them at the gate is too aggressive. We validate the
// fields we care about and drop the rest.

// POST /actions/claim — accepts UUID or polygon_id alias ("t_1234").
// S0 key aliases: agents kept sending `polygon_id:` as the KEY (checkin
// vocabulary) — accepted and renamed, no round-trip lost.
// The tile is NOT optional and there is no "pick one for me" mode: 30 of the
// night's refusals in run #43 were bodies `{}` and `{"auto":true}`, and the
// answer — "territory_id: Invalid input: expected string, received undefined"
// — never said where a tile comes from. The agent that wrote auto:true was
// asking exactly that question, so the required-message answers it by name.
const CLAIM_TILE_REQUIRED =
  'territory_id is required - name the tile yourself, there is no auto-pick. '
  + 'GET /api/v1/map/claimable lists every tile you can claim right now, each with its polygon id '
  + '(e.g. "t_04121"), free_neighbors and rivals_within_6; send one of those ids as territory_id.'

export const ClaimRequestSchema = withPayloadAliases(z.object({
  territory_id: z.string({
    error: (issue) => (issue.input === undefined ? CLAIM_TILE_REQUIRED : undefined),
  }).min(1, CLAIM_TILE_REQUIRED),
}), { polygon_id: 'territory_id', territory: 'territory_id' })

// POST /actions/build — war-v2 W2: ONE endpoint builds tier 1 OR upgrades
// the existing same-type building by one tier (price = that tier's price;
// the slot/tier rules live in src/game/buildings.js planBuildOrUpgrade).
// `castle` IS in the enum but only as an UPGRADE request: a fresh castle
// can never be built (auto-founded on the first claim) — the catalog
// refuses it with an agent-readable error.
export const BuildRequestSchema = withPayloadAliases(z.object({
  territory_id: z.string().min(1),
  building_type: z.enum(['market', 'barracks', 'watchtower', 'walls', 'castle']),
}), { building: 'building_type', type: 'building_type', polygon_id: 'territory_id', territory: 'territory_id' })

// POST /actions/demolish — demolition (rule A-7, added after tournament IX):
// raze your OWN building for FREE, freeing the tile for a rebuild. Castle
// excluded (it anchors the realm — supply and garrison; the court moves via
// relocate-capital). Closed to both sides of an active war (no scorched earth).
export const DemolishRequestSchema = withPayloadAliases(z.object({
  territory_id: z.string().min(1),
  building_type: z.enum(['market', 'barracks', 'watchtower', 'walls']),
}), { building: 'building_type', type: 'building_type', polygon_id: 'territory_id', territory: 'territory_id' })

// POST /actions/attack — every war needs a private battle plan (min 50
// chars, scored for specificity/contingency/coherence by battle-engine)
// and a PUBLIC declaration (min 20 chars) posted to The Court. The
// optional `confirm_alliance_break` flag is required on a second call
// when attacker + defender share an active alliance — first call warns
// with a 409, second call with the flag proceeds and breaks the
// alliance. Route's manual `if (!territory_id / plan / declaration)`
// length + presence checks become dead code after schema attach.
export const RestartRequestSchema = z.object({
  territory_id: z.string().min(1),
})

// POST /actions/expedition — W9 regional treasure race entry. FREE (the
// committed army is the stake: reserved through the war machinery, away
// for the window, back lossless at resolve). `event_id` is the UUID of
// the treasure_spawned event; plan_claims verify like assault plans.
export const ExpeditionRequestSchema = withPayloadAliases(z.object({
  event_id: z.string().min(1),
  committed_army: z.number().positive(),
  plan: z.string().min(50, 'Expedition plan required (min 50 chars)').max(3000, 'Expedition plan is capped at 3000 characters'),
  plan_claims: PlanClaimsSchema.optional(),
}), { race_id: 'event_id', treasure_id: 'event_id', army: 'committed_army', troops: 'committed_army' })

// POST /actions/mega-claim — W9-3 dragon's hoard. A claim is a PAID
// action (amount = the stake_usd published on the mega event, standard
// rail), public and irrevocable; the body only names the hoard.
export const MegaClaimRequestSchema = withPayloadAliases(z.object({
  event_id: z.string().min(1),
}), { race_id: 'event_id', treasure_id: 'event_id', mega_id: 'event_id' })

export const PlaceBuildingRequestSchema = z.object({
  inventory_id: z.string().min(1),
  territory_id: z.string().min(1),
})

// ── Responses ──────────────────────────────────────────────────────

// A16 (W20, visibility pass B2): every claim response carries the price
// fact — how much land you hold vs your fair share, what the NEXT tile costs,
// and the rule (locked after tournament IX as A-1: base price up to the share,
// the compounding curve only over it). The agent's own helper auto-pays the
// 402, so the price fact must ride the response, not only the challenge.
const ClaimPricingSchema = z.strictObject({
  // The curve's ordinal — claims MADE this season, never the land currently
  // held: a lifetime counter that land sold or lost never rewinds (in the response since 3381fc9f).
  claims_made: z.number().int().nonnegative(),
  territories_held: z.number().int().nonnegative(),
  fair_share: z.number().int().positive(),
  next_claim_price: z.number(),
  rule: z.string(),
})

// Claim has TWO response shapes: the paid one (settle tx hashes)
// and the free one (war-v2 starting realm: the first 3 claims are pre-paid
// by the $25 entry and bypass the payment rail entirely — no tx hashes,
// counter echo instead). Discriminated by the `free_claim` literal.
export const FreeClaimResponseSchema = z.strictObject({
  success: z.literal(true),
  action_id: z.string(),
  action_type: z.literal('claim_territory'),
  free_claim: z.literal(true),
  free_claims_remaining: z.number().int().nonnegative(),
  // playtest #1 (A6): the first free claim founds the capital + castle and
  // surfaces it here. Only present on that first claim.
  capital: z.literal(true).optional(),
  castle_founded: z.boolean().optional(),
  castle_tier: z.number().optional(),
  capital_note: z.string().optional(),
  claim_pricing: ClaimPricingSchema.optional(),
  next_actions: z.array(NextActionHintSchema),
})

export const ClaimResponseSchema = z.union([
  makeActionResponseSchema('claim_territory').extend({
    claim_pricing: ClaimPricingSchema.optional(),
  }),
  FreeClaimResponseSchema,
])
// Build surfaces its executor result (playtest #1 A7: WHAT was built + effect)
// via includeResult: true, so it can't reuse the bare action schema. `result`
// is absent on a cached replay (no actionResult), hence optional.
export const BuildResponseSchema = z.strictObject({
  success: z.literal(true),
  action_id: z.string(),
  action_type: z.literal('build_structure'),
  tx_hash: z.string(),
  distribute_tx_hash: z.string().nullable().optional(),
  cached: z.boolean(),
  result: z.looseObject({
    success: z.literal(true),
    building: z.looseObject({ type: z.string(), tier: z.number() }),
    building_type: z.string(),
    polygon_id: z.string(),
    tier: z.number(),
    action: z.string(),
    effect: z.string(),
  }).optional(),
  next_actions: z.array(NextActionHintSchema),
})
// POST /actions/attack — 410 Gone (war-v2 W4): replaced by the war state
// machine (/war/declare + /war/:id/assault + /war/raid).
export const AttackGoneResponseSchema = z.strictObject({
  error: z.string(),
  how_war_works_now: z.array(z.string()),
})
export const RestartResponseSchema = makeActionResponseSchema('restart')

// PvE endpoints don't route through payOrExecute so they have their own
// tiny response shapes — no tx hashes, no action_id, no next_actions.

export const ExpeditionResponseSchema = z.strictObject({
  success: z.literal(true),
  entry_id: z.string(),
  region_id: z.number(),
  region_name: z.string(),
  tier: z.enum(['in', 'neighbor']),
  proximity: z.number(),
  committed_army: z.number(),
  army_away_until: z.string(),
  participants: z.number(),
})

export const PlaceBuildingResponseSchema = z.strictObject({
  success: z.literal(true),
  building_type: z.string(),
  territory_id: z.string(),
  polygon_id: z.string(),
  message: z.string(),
})

// GET /actions/rules — the machine-readable constraint table for EVERY
// agent action (actionRules() in src/game/action-catalog.js). The numbers
// are read LIVE from config, so a numbers pass constantly reshapes the
// nested `actions` bag and the cost/precondition strings inside it. Locking
// the full per-action shape here would make every config tweak a schema
// churn for zero drift-detection value — so this is deliberately loose:
// we pin only the two top-level framing keys the endpoint always emits and
// the presence of the `actions` bag, and let its contents float.
export const ActionRulesResponseSchema = z.looseObject({
  _hint: z.string(),
  payment_model: z.string(),
  actions: z.looseObject({}),
})

// POST /actions/mega-claim — W9-3 dragon's hoard, a PAID action routed
// through payOrExecute with includeResult:true (identical envelope to
// build/repair: the executor result rides along). We validate ONLY the
// 200 success envelope — the registry convention for paid actions
// (claim/build/assault) is to model the success shape and leave the 402
// challenge + deterministic 400/404 rejects to the rail. `result` is
// absent on a cached replay (no actionResult), hence optional.
export const MegaClaimResponseSchema = z.strictObject({
  success: z.literal(true),
  action_id: z.string(),
  action_type: z.literal('mega_claim'),
  tx_hash: z.string(),
  distribute_tx_hash: z.string().nullable().optional(),
  cached: z.boolean(),
  result: z.looseObject({}).optional(),
  next_actions: z.array(NextActionHintSchema),
})

// GET /actions/inventory — list of unused inventory items. `source` can
// be null for items granted without a provenance tag.
export const InventoryItemSchema = z.strictObject({
  id: z.string(),
  item_type: z.string(),
  source: z.string().nullable(),
  obtained_at: IsoTimestamp,
})

export const InventoryListResponseSchema = z.strictObject({
  inventory: z.array(InventoryItemSchema),
  count: z.number(),
})

// POST /actions/pay-land-tax (S1 finmodel) — the payOrExecute envelope
// with includeResult (executor returns the remaining debt; absent on a
// cached replay) + the land_tax extraField the route adds.
export const PayLandTaxResponseSchema = makeActionResponseSchema('land_tax').extend({
  result: z.looseObject({
    remaining_debt: z.number(),
  }).optional(),
  land_tax: z.strictObject({
    paid_usd: z.number(),
    note: z.string(),
  }),
})
