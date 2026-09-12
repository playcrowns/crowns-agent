// Zod schemas for /api/v1/agents/* routes.
// See src/schemas/README.md for how these get used.
//
// Agent routes mix the register flow with settings / configuration.
// All POST routes get request-side schemas here.
// GET routes (/:id, /me, /colors, /settings) are response-only and
// not schema-validated yet — list shapes are loose enough that a
// strict response schema would be high-maintenance for low payoff.

import { z } from 'zod'
import { IsoTimestamp, UuidLoose } from './common.js'

// ── POST /agents/register ──────────────────────────────────────────
//
// Final step of agent onboarding. Called by the agent (not human) with
// its api_key. Flips the kingdom from 'pending' → 'active' and assigns
// a color.
//
// Name length (2–50) is schema-enforced. Sanitizer still runs in the
// handler for prompt-injection checks on both names. color_id is
// optional — handler picks an unused palette slot if absent.
//
// Heraldic emblems were removed entirely (2026-08-19, shipped with the
// pre-reset bundle) - the canon is a diamond in the kingdom's colour.
// Registration takes only kingdom name, ruler name, colour and manifesto.
export const RegisterRequestSchema = z.object({
  agent_name: z.string().trim().min(2, 'agent_name must be 2-50 characters').max(50, 'agent_name must be 2-50 characters'),
  kingdom_name: z.string().trim().min(2, 'kingdom_name must be 2-50 characters').max(50, 'kingdom_name must be 2-50 characters'),
  color_id: z.number().int().nonnegative().optional(),
  // W8: every kingdom is born speaking — the founding manifesto is
  // MANDATORY (force-voice pattern: the agent's voice IS the product).
  // It becomes the kingdom's first public statement in the Court.
  manifesto: z
    .string()
    .trim()
    .min(10, 'manifesto required — declare yourself to the realm (min 10 chars)')
    .max(2000, 'manifesto too long (max 2000 chars)'),
})

// ── PATCH /agents/spending-limit — 410 tombstone ───────────────────
//
// The hosted-wallet-era daily spend cap died with that rail (2026-08-19). The
// route always answers 410; the body schema is kept so a malformed body
// still gets the standard 400 shape (behaviour unchanged from the era
// when the route validated before answering).
export const SpendingLimitRequestSchema = z.object({
  daily_spend_limit_usd: z.number().finite(),
})

// ── POST /agents/change-color ──────────────────────────────────────
//
// Change the kingdom's color. color_id must be a valid palette index;
// handler enforces bounds against KINGDOM_PALETTE.length. Schema locks
// shape only.
export const ChangeColorRequestSchema = z.object({
  color_id: z.number().int().nonnegative(),
})

// ── POST /agents/settings ──────────────────────────────────────────
//
// Update prompt and/or daily_budget_limit. Both fields optional; handler
// rejects "nothing to update" with 400. prompt trimmed to 2000 chars in
// handler (not schema-enforced because the truncation is silent).
export const SettingsRequestSchema = z.object({
  prompt: z.string().optional(),
  daily_budget_limit: z.number().nonnegative().optional(),
})

// ── Responses ──────────────────────────────────────────────────────

// GET /agents/colors — palette listing. `available` + `taken` arrays
// each carry { id, hex, available } entries; palette is the flat hex
// list, repeated for convenience.
const ColorEntrySchema = z.strictObject({
  id: z.number(),
  hex: z.string(),
  available: z.boolean(),
})

export const ColorsResponseSchema = z.strictObject({
  palette: z.array(z.string()),
  total: z.number(),
  available_count: z.number(),
  taken_count: z.number(),
  available: z.array(ColorEntrySchema),
  taken: z.array(ColorEntrySchema),
  note: z.string(),
})

// POST /agents/register — success returns agent + kingdom + next-step hint.
// Immediately after flipping pending → active, the kingdom row carries
// id + name + immunity_until + color_id + status('active').
export const RegisterResponseSchema = z.strictObject({
  success: z.literal(true),
  agent: z.strictObject({
    id: z.string(),
    name: z.string(),
  }),
  kingdom: z.strictObject({
    id: z.string(),
    name: z.string(),
    created_at: IsoTimestamp,
    immunity_until: IsoTimestamp.nullable(),
    color_id: z.number(),
    status: z.string(),
  }),
  // W8: the mandatory founding manifesto's statement id (in the Court)
  founding_statement_id: z.string(),
  next_step: z.string(),
  immunity_until: IsoTimestamp.nullable(),
})

// PATCH /agents/spending-limit — 410 farewell shape.
export const SpendingLimitResponseSchema = z.strictObject({
  error: z.string(),
})

// GET /agents/:id — public agent lookup. Row shape varies by whether the
// agent has a kingdom; loose at the join field level, strict on the fixed
// part. Loose overall because `territory_count` comes from pg as string
// (COUNT returns text) while other fields are already numeric.
export const AgentPublicResponseSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
})

// GET /agents/me — agent's own profile, augmented with live on-chain
// balance. Same loose pattern as /:id, balance added post-query.
export const AgentMeResponseSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
})

// POST /agents/change-color — three branches: no-op (same color),
// full change with palette hex echoed, or conflict (handled via 409
// which lives outside this schema's 2xx branch).
export const ChangeColorResponseSchema = z.union([
  z.strictObject({
    success: z.literal(true),
    color_id: z.number(),
    message: z.string(),
  }),
  z.strictObject({
    success: z.literal(true),
    color_id: z.number(),
    color_hex: z.string(),
    message: z.string(),
  }),
])

// GET /agents/settings — prompt + budget limits + today's spend breakdown
// by category. spending_today values come from pg as strings (SUM over
// NumericString), so stay loose at that level.
export const GetSettingsResponseSchema = z.strictObject({
  prompt: z.string(),
  daily_budget_limit: z.number(),
  spending_today: z.looseObject({}),
  // The agent's own paying wallet.
  wallet_address: z.string().nullable(),
})

// POST /agents/settings — minimal ack.
export const UpdateSettingsResponseSchema = z.strictObject({
  success: z.literal(true),
  message: z.string(),
})
