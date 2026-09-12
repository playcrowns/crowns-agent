// Zod schemas for /api/v1/alliances/* routes.
// See src/schemas/README.md for how these get used.
//
// Alliances have the widest mutation surface in the game (13 routes).
// Request schemas are defined for every body-bearing endpoint here —
// response schemas are only defined for smoke-covered routes; the
// others can be promoted to strict when smoke coverage expands.

import { z } from 'zod'
import { UuidLoose } from './common.js'

// ── Enums ──────────────────────────────────────────────────────────

// Member roles (W8-5 governance): founder + flexible officers + members.
export const AllianceRoleSchema = z.enum([
  'founder',
  'officer',
  'member',
])

// Promotable roles — POST /:id/promote only allows these (can't promote
// to founder; leadership transfer happens implicitly via /leave).
export const PromotableRoleSchema = z.enum([
  'officer',
  'member',
])

// ── POST /alliances — create ───────────────────────────────────────
//
// Route still sanitizeStrict's the name (throws on violations), so
// Zod enforces shape + we keep the sanitizer for content safety.
// join_fee defaults to 0 when omitted (route's destructure does this).
// F3 (audit 2026-08-22): length caps live in the schema, so an over-long field is refused
// BEFORE any money moves (400 VALIDATION_ERROR) and the sanitizer no longer cuts it silently.
// The numbers are MAX_LENGTHS in src/game/sanitizer.js (the text-field-caps unit keeps them equal).
export const CreateAllianceRequestSchema = z.object({
  name: z.string().min(1, 'Alliance name required').max(80, 'Alliance name is capped at 80 characters'),
  terms: z.string().max(1000, 'Alliance terms are capped at 1000 characters').optional(),
  join_fee: z.number().nonnegative().optional(),
})

// On-chain paid response shape (the x402 envelope of x402PayOrRespond).
export const CreateAllianceResponseSchema = z.strictObject({
  success: z.literal(true),
  action_id: z.string(),
  action_type: z.literal('alliance_form').optional(),
  tx_hash: z.string(),
  distribute_tx_hash: z.string().nullable().optional(),
  cached: z.boolean(),
  message: z.string(),
})

// ── POST /alliances/:id/invite ─────────────────────────────────────
//
// Response is a plain success message — strict single-branch.
export const InviteRequestSchema = z.object({
  to_kingdom_id: UuidLoose,
  message: z.string().max(1000, 'Alliance message is capped at 1000 characters').optional(),
})

export const InviteResponseSchema = z.looseObject({
  success: z.literal(true),
  message: z.string(),
}) // may include declaration id / nested fields

// ── POST /alliances/:id/accept ─────────────────────────────────────
//
// No body. Response is either paid (chargeAndExecute on non-zero fee)
// or free.
const AllianceAcceptPaidSchema = z.strictObject({
  success: z.literal(true),
  action_id: z.string(),
  // The x402 envelope carries the action_type literal (optional for
  // historical per-user-rail rows that omitted it).
  action_type: z.literal('alliance_join').optional(),
  tx_hash: z.string(),
  distribute_tx_hash: z.string().nullable().optional(),
  cached: z.boolean(),
  message: z.string(),
})

const AllianceAcceptFreeSchema = z.strictObject({
  success: z.literal(true),
  message: z.string(),
})

export const AcceptAllianceResponseSchema = z.union([
  AllianceAcceptPaidSchema,
  AllianceAcceptFreeSchema,
])

// ── POST /alliances/:id/decline ────────────────────────────────────
// No body. Minimal response.

// ── POST /alliances/:id/promote ────────────────────────────────────

export const PromoteRequestSchema = z.object({
  kingdom_id: UuidLoose,
  role: PromotableRoleSchema,
})

// ── POST /alliances/:id/kick (W8-5 — kick-vote died into direct kick) ──

export const KickRequestSchema = z.object({
  kingdom_id: UuidLoose,
})

// 410 farewell for the dead kick-vote route.
export const KickVoteResponseSchema = z.strictObject({
  error: z.string(),
  use_instead: z.string().optional(),
})

// ── PATCH /alliances/:id ──────────────────────────────────────────
//
// At least one of terms / join_fee must be present — the route enforces
// "nothing to update" semantics, schema is permissive.
export const UpdateAllianceRequestSchema = z.object({
  terms: z.string().max(1000, 'Alliance charter is capped at 1000 characters').optional(),     // legacy alias for charter
  charter: z.string().max(1000, 'Alliance charter is capped at 1000 characters').optional(),   // the alliance's public identity text (W8-5)
  join_fee: z.number().nonnegative().optional(),
})

// ── POST /alliances/leave ──────────────────────────────────────────
// No body. Minimal response — message varies by whether founder
// transferred leadership or disbanded.
export const LeaveAllianceResponseSchema = z.strictObject({
  success: z.literal(true),
  message: z.string(),
})

// ── POST /alliances/:id/request-join ───────────────────────────────

export const RequestJoinRequestSchema = z.object({
  message: z.string().max(1000, 'Alliance message is capped at 1000 characters').optional(),
})

// ── POST /alliances/:id/accept-request ─────────────────────────────

export const AcceptRequestRequestSchema = z.object({
  kingdom_id: UuidLoose,
})

// ── POST /alliances/:id/reject-request ─────────────────────────────

export const RejectRequestRequestSchema = z.object({
  kingdom_id: UuidLoose,
  message: z.string().max(1000, 'Alliance message is capped at 1000 characters').optional(),
})

// ── Responses ──────────────────────────────────────────────────────
//
// Routes outside the original "#5 tier 5 shipped" set land here. Inner
// shapes stay loose where the row set is a join/aggregate that grew
// organically; strict where the handler's return statement is a small
// fixed bag of echoed fields.

// Alliance member summary row used on both /:id and / listings. Loose
// because `territory_count` comes out as string (pg COUNT), while other
// columns are already typed.
const AllianceMemberRowSchema = z.looseObject({
  kingdom_id: z.string(),
  name: z.string().optional(),
  kingdom_name: z.string().optional(),
})

// GET /alliances — listing with members grouped per alliance.
const AllianceListEntrySchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  members: z.array(AllianceMemberRowSchema),
})

export const AllianceListResponseSchema = z.strictObject({
  alliances: z.array(AllianceListEntrySchema),
})

// GET /alliances/:id — SELECT *. Loose because `a.*` pulls an
// organically-grown column set; strict on the members array.
export const AllianceDetailResponseSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  members: z.array(AllianceMemberRowSchema),
})

// POST /alliances/:id/decline — minimal ack.
export const DeclineAllianceResponseSchema = z.strictObject({
  success: z.literal(true),
  message: z.string(),
})

// POST /alliances/:id/promote — minimal ack.
export const PromoteResponseSchema = z.strictObject({
  success: z.literal(true),
  message: z.string(),
})

// POST /alliances/:id/kick — direct kick (W8-5; the kick-vote union died
// with the quorum machinery).
export const KickResponseSchema = z.strictObject({
  success: z.literal(true),
  message: z.string(),
})

// PATCH /alliances/:id — minimal ack.
export const UpdateAllianceResponseSchema = z.strictObject({
  success: z.literal(true),
  message: z.string(),
})

// POST /alliances/:id/request-join — ack with human-readable message.
export const RequestJoinResponseSchema = z.strictObject({
  success: z.literal(true),
  message: z.string(),
})

// POST /alliances/:id/accept-request — ack; follow-up state lives in
// events table, not the response.
export const AcceptRequestResponseSchema = z.strictObject({
  success: z.literal(true),
  message: z.string(),
})

// POST /alliances/:id/reject-request — ack.
export const RejectRequestResponseSchema = z.strictObject({
  success: z.literal(true),
  message: z.string(),
})

// GET /alliances/:id/requests — pending join-request list. Loose inner
// because the declaration row pulls fields the alliance page may extend
// later (e.g. kingdom reputation, agent name).
export const AllianceRequestsResponseSchema = z.strictObject({
  requests: z.array(z.looseObject({ id: z.string() })),
  count: z.number(),
})
