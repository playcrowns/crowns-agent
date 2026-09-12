// Zod schemas for /api/v1/feedback/* routes.
// Backs the agent-authored bug/UX report channel (April 21 session).
// Replaces the stale SKILL.md promise of "send a send_message to the
// Crowns-System kingdom" — that kingdom never existed. This is the
// explicit dedicated surface.

import { z } from 'zod'
import { IsoTimestamp } from './common.js'

// The enum of topics an agent can file a report against. Narrow on
// purpose — if an agent's concern doesn't fit one of these buckets,
// they get more signal by sending to their operator via
// `send_to_operator` instead (their operator can relay). The dev-side
// reader (Dima) filters by topic when triaging batches.
//
// Keep this list curated. Expanding it requires both the agent and
// reader to understand what each means — add discipline not tempted
// by edge cases that land in `other`.
export const FEEDBACK_TOPICS = ['bug', 'mechanic_unclear', 'tool_error', 'balance', 'documentation', 'other']

// POST /feedback — agent files a report.
//
// `topic` is enum-constrained so the triage UI can bucket. `description`
// is the meat — what's wrong, what they tried, what they expected vs
// saw. Capped at 4000 chars so we don't accept arbitrary payload dumps
// but prose with example responses fits.
export const FeedbackRequestSchema = z.object({
  topic: z.enum(FEEDBACK_TOPICS),
  description: z.string().min(20).max(4000),
})

// GET /feedback/my — agent reads their own previously-submitted reports
// (e.g. to avoid submitting a duplicate, or to confirm something reached
// the dev team). No auth-scope surprise: agent only sees their own.
export const FeedbackMyQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
})

// ── Responses ──────────────────────────────────────────────────────

// POST /feedback — returns 201 on success. `status` comes back from the
// DB INSERT RETURNING clause with the table default 'open' — locking to
// a literal here would break if we later widen the enum (triaged/closed/etc
// on write), so string.
export const FeedbackCreateResponseSchema = z.strictObject({
  success: z.literal(true),
  id: z.string(),
  topic: z.enum(FEEDBACK_TOPICS),
  status: z.string(),
  created_at: IsoTimestamp,
  message: z.string(),
})

// GET /feedback/my — wrapped descriptions go through `wrapUserContent`
// so they're returned as strings with USER_CONTENT markers. `triage_notes`
// is a dev-only field; null for un-triaged reports, string once a human
// writes back.
export const FeedbackReportEntrySchema = z.strictObject({
  id: z.string(),
  topic: z.enum(FEEDBACK_TOPICS),
  description: z.string(),
  status: z.string(),
  triage_notes: z.string().nullable(),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp,
})

export const FeedbackMyResponseSchema = z.strictObject({
  reports: z.array(FeedbackReportEntrySchema),
})
