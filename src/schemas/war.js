// Zod schemas for /api/v1/war/* (war-v2 W4) + the repair action.
// See src/schemas/README.md for conventions (strict responses, request
// schemas attached to routes, registry entry in routes.js per endpoint).

import { z } from 'zod'
import { IsoTimestamp, NumberOrNumericString, UuidLoose, withPayloadAliases } from './common.js'

// S0 key aliases: `army:` for `committed_army:` (checkin vocabulary) and
// `polygon_id:` for `territory_id:` — accepted and renamed at the gate.
const ARMY_ALIASES = { army: 'committed_army', troops: 'committed_army' }
const TILE_ALIASES = { polygon_id: 'territory_id', territory: 'territory_id' }

// ── Shared pieces ──────────────────────────────────────────────────

// A machine-verifiable plan claim. The battle engine owns SEMANTIC
// validation (unknown types verify false and cost the penalty) — the
// schema only bounds size so a hostile payload can't balloon the
// snapshot JSONB. Catalog today: maneuver / weak_point / force_allocation.
export const PlanClaimSchema = z.object({
  type: z.string().min(1).max(40),
}).passthrough()

export const PlanClaimsSchema = z.array(PlanClaimSchema).max(10)

const PlanVerificationSchema = z.strictObject({
  multiplier: z.number(),
  verified: z.number(),
  rejected: z.array(z.strictObject({
    claim: z.string().optional(),
    reason: z.string(),
  })),
})

// ★ The carried-damage report (Dima's invariant 2026-06-10): every assault
// response says what the attempt bought, so an agent never reads a repulse
// as "nothing happened".
const FortificationReportSchema = z.strictObject({
  walls: z.strictObject({ before: z.number(), after: z.number() }),
  castle: z.strictObject({ before: z.number(), after: z.number() }),
  message: z.string(),
})

const WarRowSchema = z.strictObject({
  id: z.string(),
  season_id: z.string(),
  attacker_id: z.string(),
  defender_id: z.string(),
  war_goal: z.string(),
  kind: z.enum(['war', 'rebellion']),
  status: z.enum(['mobilizing', 'active', 'expired', 'ended']),
  declared_at: IsoTimestamp,
  window_until: IsoTimestamp,
  attacker_ready_at: IsoTimestamp.nullable(),
  defender_ready_at: IsoTimestamp.nullable(),
  last_attacker_strike_at: IsoTimestamp.nullable(),
  ended_at: IsoTimestamp.nullable(),
  end_reason: z.string().nullable(),
  mobilization_reserved: NumberOrNumericString,
  // W5b2: continuation of an existing sphere conflict (reduced aggression
  // cost — priced by W10, recorded at declare).
  sphere_continuation: z.boolean(),
  // W10 ladder verdict, computed once at declare: justified (revenge for
  // a live grievance — the only free war) / reduced / full. Nullable for
  // pre-W10 rows.
  aggression_class: z.enum(['justified', 'reduced', 'full']).nullable(),
  // Scoring wave 3 (20260716_001) also wrote attacker/defender_power here -
  // the strengths frozen at declaration. Seam 22 (2026-08-20): pulled out of
  // the responses (stripWarInternals), they stay internal telemetry in the DB.
})

// W5b2: a recruiting offer row (war_offers). terms stays loose — it's a
// JSONB negotiated object ({split_pct, split_days} today, W7 adds cash).
const WarOfferRowSchema = z.strictObject({
  id: z.string(),
  war_id: z.string(),
  from_kingdom_id: z.string(),
  to_kingdom_id: z.string(),
  side: z.enum(['attacker', 'defender']),
  min_army: NumberOrNumericString,
  terms: z.any().nullable(),
  message: z.string().nullable(),
  status: z.enum(['pending', 'accepted', 'declined', 'expired']),
  created_at: IsoTimestamp,
  responded_at: IsoTimestamp.nullable(),
})

const WarParticipantRowSchema = z.strictObject({
  war_id: z.string(),
  kingdom_id: z.string(),
  side: z.enum(['attacker', 'defender']),
  committed_army: NumberOrNumericString,
  source: z.enum(['ally', 'mercenary', 'vassal', 'liege']),
  terms: z.any().nullable(),
  joined_at: IsoTimestamp,
})

// ── Requests ───────────────────────────────────────────────────────

// target_kingdom_id alias (audit 2026-07-18): half the diplomacy API
// (statements, pacts, ultimatums) says target_kingdom_id — agents carry
// the habit here. Accept it instead of teaching a 400.
export const DeclareWarRequestSchema = withPayloadAliases(z.strictObject({
  defender_kingdom_id: UuidLoose,
  war_goal: z.string().min(5).max(2000, 'War goal is capped at 2000 characters'),
}), { target_kingdom_id: 'defender_kingdom_id' })

export const RecruitOfferRequestSchema = z.strictObject({
  to_kingdom_id: UuidLoose,
  min_army: z.number().positive(),
  // Attack-side spoils terms; omitted fields take the config interim
  // defaults (30% / 5 days). Defense offers must omit both (solidarity).
  split_pct: z.number().positive().max(100).optional(),
  split_days: z.number().int().positive().optional(),
  message: z.string().max(1000, 'War offer message is capped at 1000 characters').optional(),
})

export const OfferIdParamsSchema = z.strictObject({
  id: UuidLoose,
})

export const AcceptOfferRequestSchema = withPayloadAliases(z.strictObject({
  committed_army: z.number().positive(),
}), ARMY_ALIASES)

export const JoinWarRequestSchema = withPayloadAliases(z.strictObject({
  side: z.enum(['attacker', 'defender']),
  committed_army: z.number().positive(),
}), ARMY_ALIASES)

export const WarIdParamsSchema = z.strictObject({
  id: UuidLoose,
})

export const WarDefenseRequestSchema = withPayloadAliases(z.strictObject({
  plan: z.string().max(3000, 'Battle plan is capped at 3000 characters').optional(),
  plan_claims: PlanClaimsSchema.optional(),
  committed_army: z.number().min(0),
}), ARMY_ALIASES)

export const AssaultRequestSchema = withPayloadAliases(z.strictObject({
  territory_id: z.string().min(1),       // UUID or polygon_id
  committed_army: z.number().positive(),
  plan: z.string().max(3000, 'Battle plan is capped at 3000 characters').optional(),
  plan_claims: PlanClaimsSchema.optional(),
}), { ...ARMY_ALIASES, ...TILE_ALIASES })

export const RaidRequestSchema = withPayloadAliases(z.strictObject({
  territory_id: z.string().min(1),
  target_building: z.enum(['market', 'barracks', 'watchtower', 'walls', 'castle']),
  committed_army: z.number().positive(),
  plan: z.string().max(3000, 'Battle plan is capped at 3000 characters').optional(),
  plan_claims: PlanClaimsSchema.optional(),
}), { ...ARMY_ALIASES, ...TILE_ALIASES, building: 'target_building', building_type: 'target_building' })

export const DoctrineRequestSchema = z.strictObject({
  text: z.string().min(5).max(3000, 'Defense doctrine is capped at 3000 characters'),
  plan_claims: PlanClaimsSchema.optional(),
  reserve_army: z.number().min(0),
  priorities: z.array(z.string().max(60)).max(10).optional(),
})

// Repair takes the same two fields as build and demolish, and now the same
// synonyms: it was the ONE tile door with no `polygon_id` alias, so the
// spelling the map itself prints was a plain refusal here and accepted one
// call earlier (2026-09-12). Synonyms go where the neighbours have them.
export const RepairRequestSchema = withPayloadAliases(z.strictObject({
  territory_id: z.string().min(1),
  building_type: z.enum(['market', 'barracks', 'watchtower', 'walls', 'castle']),
}), { ...TILE_ALIASES, building: 'building_type', type: 'building_type' })

export const RelocateCapitalRequestSchema = z.strictObject({
  territory_id: z.string().min(1),
})

// ── Responses ──────────────────────────────────────────────────────

export const DeclareWarResponseSchema = z.strictObject({
  success: z.literal(true),
  war: WarRowSchema,
  immunity_burned: z.boolean(),
  message: z.string(),
})

// Retreat (tournament format): the attacker's honest exit.
export const WarRetreatResponseSchema = z.strictObject({
  success: z.literal(true),
  war_id: z.string(),
  ended: z.literal(true),
  reason: z.literal('retreated'),
  note: z.string(),
})

export const WarReadyResponseSchema = z.strictObject({
  success: z.literal(true),
  war: WarRowSchema,
  gate: z.strictObject({
    open: z.boolean(),
    opensAt: IsoTimestamp.nullable(),
    reason: z.string().nullable(),
  }),
  // waiting vs open, said in words (2026-07-18).
  message: z.string(),
})

export const WarDefenseResponseSchema = z.strictObject({
  success: z.literal(true),
  defense: z.strictObject({
    war_id: z.string(),
    kingdom_id: z.string(),
    plan: z.string().nullable(),
    plan_claims: z.any().nullable(),
    committed_army: NumberOrNumericString,
    updated_at: IsoTimestamp,
  }),
  note: z.string(),
})

// Paid strike responses: the chargeAndExecute envelope + the synchronous
// battle outcome (actionResult threaded through payments-onchain).
export const AssaultResponseSchema = z.strictObject({
  success: z.literal(true),
  action_id: z.string(),
  action_type: z.literal('war_assault'),
  tx_hash: z.string(),
  distribute_tx_hash: z.string().nullable().optional(),
  cached: z.boolean(),
  result: z.strictObject({
    success: z.literal(true),
    strike_id: z.string(),
    kind: z.literal('assault'),
    outcome: z.enum(['captured', 'breached_held', 'repulsed', 'bloody_repulse']),
    captured: z.boolean(),
    capital_fallen: z.boolean(),
    enemy_eliminated: z.boolean(),
    r: z.number(),
    push: z.number(),
    hold: z.number(),
    your_losses: z.number(),
    enemy_losses: z.number(),
    army_returned: z.number(),
    // Variant (a): present on the war attacker's FIRST assault — the
    // declaration hold that auto-joined the push (effective = committed +
    // this), with the plain-language note keeping the declare-copy promise.
    mobilization_joined: z.number().optional(),
    note: z.string().optional(),
    plan_verification: PlanVerificationSchema,
    // Audit A-8 S4-2 (835f791f): the engine always counted encirclement —
    // the striker sees what the geometry bought.
    encirclement: z.strictObject({
      sides: z.number().int().min(0).max(6),
      multiplier: z.number(),
    }),
    fortifications: FortificationReportSchema,
    polygon_id: z.string(),
    // W5b2: present when the capture created spoils splits — the attacker
    // sees the income dilution it negotiated, per captured tile.
    spoils: z.array(z.strictObject({
      kingdom_id: z.string(),
      share_pct: z.number(),
      ends_at: IsoTimestamp,
    })).optional(),
    // §8 (W5b1): present ONLY when this assault was a rebellion's decisive
    // first strike — the verdict rides back in the same response.
    rebellion: z.strictObject({
      resolved: z.literal(true),
      outcome: z.enum(['vassal_freed', 'rebellion_crushed']),
      rebellion_cooldown_until: IsoTimestamp.optional(),
      tribute_bump_until: IsoTimestamp.optional(),
    }).optional(),
  }),
})

export const RaidResponseSchema = z.strictObject({
  success: z.literal(true),
  action_id: z.string(),
  action_type: z.literal('raid'),
  tx_hash: z.string(),
  distribute_tx_hash: z.string().nullable().optional(),
  cached: z.boolean(),
  result: z.strictObject({
    success: z.literal(true),
    strike_id: z.string(),
    kind: z.literal('raid'),
    outcome: z.enum(['success', 'partial', 'fail']),
    target_building: z.string(),
    r: z.number(),
    your_losses: z.number(),
    enemy_losses: z.number(),
    army_returned: z.number(),
    damage: z.any(),
    no_casus_warning: z.string().optional(),
    plan_verification: PlanVerificationSchema,
    polygon_id: z.string(),
  }),
})

export const RepairResponseSchema = z.strictObject({
  success: z.literal(true),
  action_id: z.string(),
  action_type: z.literal('repair_building'),
  tx_hash: z.string(),
  distribute_tx_hash: z.string().nullable().optional(),
  cached: z.boolean(),
  result: z.strictObject({
    success: z.literal(true),
    building_type: z.string(),
    from_tier: z.number(),
    to_tier: z.number(),
    completes_at: IsoTimestamp,
    cost: z.number(),
    note: z.string(),
  }),
  // payOrExecute appends navigation hints to every /actions/* response
  next_actions: z.array(z.object({
    action: z.string().optional(),
    description: z.string().optional(),
    _rule: z.string().optional(),
  })),
})

// POST /actions/demolish — free (no 402), the executor result rides flat.
// Schema added by the 2026-07-29 lint pass (the route ran schemaless since afdcb7e0).
export const DemolishResponseSchema = z.strictObject({
  success: z.literal(true),
  action_id: z.string(),
  action_type: z.literal('demolish_building'),
  demolished: z.literal(true),
  territory_id: z.string(),
  polygon_id: z.string(),
  building_type: z.string(),
  tier: z.number(),
  note: z.string(),
  next_actions: z.array(z.object({
    action: z.string().optional(),
    description: z.string().optional(),
    _rule: z.string().optional(),
  })),
})

export const RelocateCapitalResponseSchema = z.strictObject({
  success: z.literal(true),
  action_id: z.string(),
  action_type: z.literal('relocate_capital'),
  tx_hash: z.string(),
  distribute_tx_hash: z.string().nullable().optional(),
  cached: z.boolean(),
  result: z.strictObject({
    success: z.literal(true),
    new_capital_polygon_id: z.string(),
    dark_until: IsoTimestamp,
    cost: z.number(),
    note: z.string(),
  }),
})

export const DoctrineResponseSchema = z.strictObject({
  success: z.literal(true),
  doctrine: z.strictObject({
    kingdom_id: z.string(),
    season_id: z.string(),
    text: z.string(),
    plan_claims: z.any().nullable(),
    reserve_army: NumberOrNumericString,
    priorities: z.any().nullable(),
    state_fingerprint: z.any(),
    updated_at: IsoTimestamp,
    confirmed_at: IsoTimestamp,
  }),
  fingerprint: z.any(),
  note: z.string(),
})

export const RecruitOfferResponseSchema = z.strictObject({
  success: z.literal(true),
  offer: WarOfferRowSchema,
  message: z.string(),
})

// One schema for accept and decline: participant is null on decline.
export const OfferRespondResponseSchema = z.strictObject({
  success: z.literal(true),
  offer: WarOfferRowSchema,
  participant: WarParticipantRowSchema.nullable(),
  message: z.string(),
})

export const JoinWarResponseSchema = z.strictObject({
  success: z.literal(true),
  participant: WarParticipantRowSchema,
  source: z.enum(['vassal', 'liege']),
  message: z.string(),
})

const WarOfferListItemSchema = z.strictObject({
  ...WarOfferRowSchema.shape,
  from_name: z.string(),
  to_name: z.string(),
  war: z.strictObject({
    id: z.string(),
    kind: z.enum(['war', 'rebellion']),
    status: z.enum(['mobilizing', 'active', 'expired', 'ended']),
    war_goal: z.string(),
    attacker_id: z.string(),
    attacker_name: z.string(),
    defender_id: z.string(),
    defender_name: z.string(),
    window_until: IsoTimestamp,
  }),
})

export const WarOffersListResponseSchema = z.strictObject({
  success: z.literal(true),
  incoming: z.array(WarOfferListItemSchema),
  outgoing: z.array(WarOfferListItemSchema),
})

// War-view participant: committed_army is intel — visible only to the SAME
// side (the enemy reads armies through watchtowers, not free in a view).
const WarViewParticipantSchema = z.strictObject({
  kingdom_id: z.string(),
  kingdom_name: z.string(),
  side: z.enum(['attacker', 'defender']),
  source: z.enum(['ally', 'mercenary', 'vassal', 'liege']),
  joined_at: IsoTimestamp,
  committed_army: NumberOrNumericString.nullable(),
})

const StrikeSummarySchema = z.strictObject({
  id: z.string(),
  kind: z.string(),
  attacker_id: z.string(),
  defender_id: z.string().nullable(),
  polygon_id: z.string().nullable(),
  territory_name: z.string().nullable(),
  target_building: z.string().nullable(),
  outcome: z.string(),
  captured: z.boolean(),
  attacker_losses: NumberOrNumericString,
  defender_losses: NumberOrNumericString,
  // Strike memory (2026-09-03, "tier snapshot"): the target's wall/castle tiers at the
  // minute of the strike and after it - to the assault's principals (for a raid, to the
  // tile's owner), null to everyone else; a row older than the snapshots is null for all.
  // Without it a strict schema would break the paid smoke test (skeptic 2026-09-04).
  fortifications: z.strictObject({
    before: z.strictObject({ walls: z.number(), castle: z.number() }),
    after: z.strictObject({ walls: z.number(), castle: z.number() }),
  }).nullable(),
  created_at: IsoTimestamp,
})

export const WarViewResponseSchema = z.strictObject({
  success: z.literal(true),
  war: WarRowSchema,
  effective_status: z.enum(['mobilizing', 'active', 'expired', 'ended']),
  gate: z.strictObject({
    open: z.boolean(),
    opensAt: IsoTimestamp.nullable(),
    reason: z.string().nullable(),
  }),
  attacker_name: z.string(),
  defender_name: z.string(),
  my_defense: z.strictObject({
    plan: z.string().nullable(),
    plan_claims: z.any().nullable(),
    committed_army: NumberOrNumericString,
    updated_at: IsoTimestamp,
  }).nullable(),
  // Declassified at war's end (Dima 2026-07-13): the defense plan joins
  // the public chronicle once the war is ended/expired; null on live wars.
  declassified_defense: z.strictObject({
    plan: z.string(),
    kingdom_id: UuidLoose,
    kingdom_name: z.string(),
  }).nullable(),
  // 2026-09-03 ("plans are symmetric"): every filed defense of a finished war —
  // both principals may file one; the singular above is its first row
  // (kept for older readers). Empty on a live war.
  declassified_defenses: z.array(z.strictObject({
    plan: z.string(),
    kingdom_id: UuidLoose,
    kingdom_name: z.string(),
  })),
  // The FACT "the defender's defense is on file": true/false for a party
  // to the war (either side) and for anyone once the war is over; null
  // for a third kingdom while the war lives (S14: no map of safe targets).
  defense_filed: z.boolean().nullable(),
  // W5b2: who fights here besides the principals (committed_army gated to
  // the viewer's own side), and — for a principal — their pending offers.
  participants: z.array(WarViewParticipantSchema),
  my_pending_offers: z.array(z.strictObject({
    ...WarOfferRowSchema.shape,
    to_name: z.string(),
  })).nullable(),
  strikes: z.array(StrikeSummarySchema),
})

export const WarListResponseSchema = z.strictObject({
  success: z.literal(true),
  wars: z.array(z.strictObject({
    id: z.string(),
    // W5b2: 'participant' = I committed army into someone else's war;
    // `side` is MY side in all three roles.
    role: z.enum(['attacker', 'defender', 'participant']),
    side: z.enum(['attacker', 'defender']),
    enemy_id: z.string(),
    enemy_name: z.string(),
    kind: z.enum(['war', 'rebellion']),
    status: z.enum(['mobilizing', 'active', 'expired', 'ended']),
    war_goal: z.string(),
    declared_at: IsoTimestamp,
    window_until: IsoTimestamp,
    gate_open: z.boolean(),
    last_attacker_strike_at: IsoTimestamp.nullable(),
    ended_at: IsoTimestamp.nullable(),
    end_reason: z.string().nullable(),
  })),
})
