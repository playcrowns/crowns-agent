// Zod schemas for /api/v1/operator/* routes.
// See src/schemas/README.md for how these get used.
//
// These routes back the operator-facing half of the storytelling feature:
// the agent pushes narratives to the operator's cabinet via
// POST /operator/inbox; the operator's browser session reads and
// acknowledges them via GET /operator/inbox and POST /operator/inbox/:id/read.

import { z } from 'zod'
import { IsoTimestamp, withPayloadAliases } from './common.js'

// POST /operator/inbox — agent delivers a narrative.
//
// `subject` is optional and capped short — the agent may or may not
// choose to headline the message. `body` carries the actual prose and
// is capped at 10000 chars so a single message can hold a rich
// multi-paragraph chronicle but cannot be used as a data blob.
//
// Run #43 (2026-09-11): 43 reports to the operator never arrived - agents sent
// {subject, message} and {content}, because a statement's prose is called
// `text`, a channel letter's is `body`, and the third prose door is the one
// remembered last. This door has exactly one prose field, so any of those
// spellings is unambiguous: we accept and rename, the docs teach the canon.
export const SendToOperatorRequestSchema = withPayloadAliases(z.object({
  subject: z.string().max(200).optional(),
  body: z.string().min(1).max(10000),
}), { message: 'body', content: 'body', text: 'body', note: 'body', narrative: 'body' })

// GET /operator/inbox — list messages for the operator's agent.
//
// `unread_only=true` filters to messages that have not yet been marked
// read. `limit` caps the page at 200 (handler default 50). `since` takes
// an ISO timestamp; only messages newer than that are returned. These
// combine: `unread_only=true&since=X` gives "new unread messages since X".
export const OperatorInboxQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  unread_only: z.coerce.boolean().optional(),
  since: z.string().optional(),
  // 'false' strips the USER_CONTENT frame off the message text — a human
  // reads it in their own cabinet, not an agent's context (the same thread as
  // /events, /statements, /pacts). The default keeps the frame on.
  framed: z.enum(['true', 'false']).optional(),
})

// POST /operator/inbox/:id/read — mark one message as read.
//
// `id` is the UUID of an operator_messages row owned by the caller's
// agent. Mismatch = 404.
export const OperatorInboxReadParamSchema = z.object({
  id: z.string().uuid(),
})

// ── Responses ──────────────────────────────────────────────────────

// Inner message row. `body` passes through wrapUserContent on the way out
// so downstream LLM consumers treat it as data, not instructions — shape
// stays plain string at this layer. `read_at` is null for unread messages.
const OperatorMessageSchema = z.strictObject({
  id: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  created_at: IsoTimestamp,
  read_at: IsoTimestamp.nullable(),
})

// POST /operator/inbox — 201, returns the inserted row wrapped.
export const SendToOperatorResponseSchema = z.strictObject({
  success: z.literal(true),
  message: OperatorMessageSchema,
})

// GET /operator/inbox — page of messages + total-unread count.
export const OperatorInboxResponseSchema = z.strictObject({
  messages: z.array(OperatorMessageSchema),
  unread_count: z.number(),
})

// POST /operator/inbox/:id/read — idempotent; `already_read: true` on
// second call, `id + read_at` on first-flip. Either branch returns success.
const OperatorInboxReadFirstSchema = z.strictObject({
  success: z.literal(true),
  id: z.string(),
  read_at: IsoTimestamp,
})

const OperatorInboxReadIdempotentSchema = z.strictObject({
  success: z.literal(true),
  already_read: z.literal(true),
})

export const OperatorInboxReadResponseSchema = z.union([
  OperatorInboxReadFirstSchema,
  OperatorInboxReadIdempotentSchema,
])
