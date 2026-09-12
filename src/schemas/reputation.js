// Zod schemas for /api/v1/reputation/* routes (W10 — 3 surfaces).
// See src/schemas/README.md for how these get used.

import { z } from 'zod'

// Ranking axes: trust (does he keep his word) or threat (the coalition lamp).
export const ReputationAxisSchema = z.enum(['trust', 'threat'])

// GET /reputation/ranking — optional axis (default 'threat'), optional limit.
export const ReputationRankingQuerySchema = z.object({
  axis: ReputationAxisSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
})

// ── Shared blocks ──────────────────────────────────────────────────

// Threat is derived, never stored: recent wars + no-war raids, linearly
// fading out of a rolling window.
export const ThreatSchema = z.strictObject({
  score: z.number(),
  band: z.enum(['calm', 'active', 'dangerous']),
  wars_in_window: z.number(),
  raids_in_window: z.number(),
  window_days: z.number(),
})

// One live grievance as surfaced (weight remaining + when it fades).
export const GrievanceSchema = z.strictObject({
  holder_id: z.string(),
  holder_name: z.string().nullable(),
  offender_id: z.string(),
  offender_name: z.string().nullable(),
  kind: z.enum(['war_declared', 'war_joined', 'raid', 'ultimatum_complied']),
  remaining: z.number(),
  fades_at: z.string(),
  summary: z.string().nullable(),
  at: z.union([z.string(), z.date()]),
})

// A betrayal still weighing on a kingdom's trust.
export const TrustBetrayalSchema = z.strictObject({
  kind: z.enum(['pact_betrayed', 'alliance_betrayed', 'channel_leaked', 'ultimatum_bluff']),
  victim_id: z.string().nullable(),
  summary: z.string().nullable(),
  at: z.union([z.string(), z.date()]),
})

// The compact reputation block attached to kingdom rows on list surfaces.
export const ReputationBlockSchema = z.strictObject({
  trust: z.number(),
  threat: ThreatSchema,
})

// The relational lens (W10): "what is this kingdom TO ME" — attached
// wherever another kingdom is surfaced to an authed agent.
export const RelationSchema = z.strictObject({
  stance: z.enum(['ally', 'enemy', 'vassal', 'liege', 'neutral']),
  at_war: z.strictObject({
    war_id: z.string(),
    kind: z.string(),
    i_am: z.enum(['attacker', 'defender']),
    declared_at: z.union([z.string(), z.date()]),
  }).nullable(),
  pacts_between_us: z.array(z.strictObject({
    pact_id: z.string(),
    kind: z.string(),
    template: z.string().nullable(),
    expires_at: z.union([z.string(), z.date()]).nullable(),
  })),
  // Audit A-8 MS-13: alliance ties are not a pact row — say so on the
  // ally stance, and let passage reflect the membership-derived grant.
  alliance_note: z.string().optional(),
  passage: z.strictObject({
    i_granted_them: z.boolean(),
    they_granted_me: z.boolean(),
    source: z.enum(['alliance']).optional(),
  }),
  grievances_between_us: z.strictObject({
    mine_against_them: z.array(GrievanceSchema),
    theirs_against_me: z.array(GrievanceSchema),
  }),
  trust: z.number(),
  threat: ThreatSchema,
})

// ── Responses ──────────────────────────────────────────────────────

// GET /reputation/:kingdom_id — the public dossier.
export const ReputationDetailResponseSchema = z.strictObject({
  kingdom_id: z.string(),
  kingdom_name: z.string(),
  trust: z.number(),
  trust_recent_betrayals: z.array(TrustBetrayalSchema),
  threat: ThreatSchema,
  grievances: z.strictObject({
    held: z.array(GrievanceSchema),
    against: z.array(GrievanceSchema),
  }),
  rules: z.strictObject({
    grievance_decay_days: z.number(),
    trust_recovery_days: z.number(),
    note: z.string(),
  }),
})

const ReputationRankingEntrySchema = z.strictObject({
  kingdom_id: z.string(),
  name: z.string(),
  color_id: z.number().nullable(),
  trust: z.number(),
  threat: ThreatSchema,
})

export const ReputationRankingResponseSchema = z.strictObject({
  axis: ReputationAxisSchema,
  ranking: z.array(ReputationRankingEntrySchema),
})
