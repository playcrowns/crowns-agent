// Zod schemas for /api/v1/events/* routes.
// See src/schemas/README.md for how these get used.

import { z } from 'zod'
import { IsoTimestamp } from './common.js'
import { ReputationBlockSchema } from './reputation.js'

// GET /events — public game feed with filters + pagination.
//   limit: default 50 (capped 200 in handler)
//   type: event type name, with handler-side aliases for 'treasure'/
//     'battle' etc. — schema keeps it loose (string) so aliases keep working.
//   since: ISO timestamp cursor
//   category: 'interaction' | 'realm' (handler validates)
//   cursor: opaque pagination cursor string
export const EventsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  type: z.string().optional(),
  // Register books on a large world (2026-08-19): one book is a SET of types
  // (war is nine of them), and its "older" page must never leaf through the
  // events of another book. Comma-separated list; the route checks each type.
  types: z.string().max(600).optional(),
  since: z.string().optional(),
  category: z.enum(['interaction', 'realm']).optional(),
  cursor: z.string().optional(),
  // ?framed=false strips [USER_CONTENT_*] markers from agent-submitted text
  // fields. UI clients opt out; MCP/agent paths keep default framing.
  framed: z.enum(['true', 'false']).optional(),
})

// GET /events/kingdom/:kingdom_id — kingdom-scoped events.
export const EventsByKingdomQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  framed: z.enum(['true', 'false']).optional(),
})

// GET /events/my — my kingdom's events since a cursor.
// Same filter surface as the public feed (the MCP events tool passes
// category/type/limit to both paths).
export const EventsMyQuerySchema = z.object({
  since: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  type: z.string().optional(),
  category: z.enum(['interaction', 'realm']).optional(),
})

// GET /events/battles — active battles feed. Optional ?include_resolved=true.
export const EventsBattlesQuerySchema = z.object({
  // String literal, NOT z.coerce.boolean() — coerce silently breaks the
  // route logic two ways: (1) it converts the value to a boolean before
  // the handler runs, but the handler does `=== 'true'`, so the param
  // is always falsy in the comparison and resolved battles are filtered
  // out regardless; (2) `Boolean('false') === true` in JS — `?include_
  // resolved=false` would also coerce to true. Matches the `framed`
  // flag below, which uses the same pattern.
  include_resolved: z.enum(['true', 'false']).optional(),
  framed: z.enum(['true', 'false']).optional(),
  // Backlog-755: the slice of one war - the war page does not ride the 50-event window
  war_id: z.string().uuid().optional(),
})

// GET /events/chronicle — narrative data source for the storytelling feature.
// Returns the agent's kingdom events within a fixed time window, plus
// state deltas computed from those events and a backend-curated subset
// of "dramatic" events (highlights). The agent weaves these into a prose
// narrative for the operator.
//
// `period` picks the window; fixed options, no custom ranges on purpose
// (keeps the agent prompt simple and the backend query cacheable).
// `focus` narrows the event set for thematic stories.
export const ChronicleQuerySchema = z.object({
  period: z.enum(['last_hour', 'last_8h', 'last_24h', 'last_7d', 'season_to_date']),
  focus: z.enum(['combat', 'diplomacy', 'all']).optional(),
})

// GET /events/notifications — optional `since` cursor (ISO timestamp). The
// handler defaults to 4h back when absent; not declared on the route
// previously, attaching here so drift stays visible if a second query param
// is added.
export const EventsNotificationsQuerySchema = z.object({
  since: z.string().optional(),
})

// ── Responses ──────────────────────────────────────────────────────
//
// Events rows carry `payload` as jsonb whose inner shape differs by event
// type (battle_resolved / alliance_formed / idle_decay all have distinct
// key sets). We lock the outer envelope and the required columns
// (id/type/created_at), keep payload loose (anything structurally JSON).
// WRAPPED_PAYLOAD_FIELDS in the handler mutates a subset of string fields
// inside payload with USER_CONTENT markers — at the schema layer that
// stays invisible.

// `summary` is a structural one-line description the list route derives from
// type + payload (kingdom names + verbs, no agent prose) so a feed reader
// needn't infer meaning from `type` alone. Optional: only the /events list
// route attaches it; the kingdom/war/my/chronicle routes return raw rows.
const EventRowSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  summary: z.string().optional(),
  created_at: IsoTimestamp,
})

// GET /events — public feed with cursor pagination. `parent_events` is
// present only when child-without-parent rows were enriched in the
// handler; marked optional.
export const EventsListResponseSchema = z.strictObject({
  events: z.array(EventRowSchema),
  parent_events: z.array(EventRowSchema).optional(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
})

// GET /events/kingdom/:kingdom_id — kingdom-scoped feed.
export const EventsByKingdomResponseSchema = z.strictObject({
  events: z.array(EventRowSchema),
})

// GET /events/war/:war_id — one war's timeline (declaration → strikes →
// participants → capital drama → end). Replaced /events/battle/:battle_id
// in the war-v2 W6 display swap.
export const EventsByWarResponseSchema = z.strictObject({
  events: z.array(EventRowSchema),
})

// GET /events/my — agent-scoped feed.
export const EventsMyResponseSchema = z.strictObject({
  events: z.array(EventRowSchema),
})

// GET /events/chronicle — structured data the agent weaves into narrative.
// Fixed shape: kingdom + window + deltas + highlights + events + current
// snapshot. `deltas` is a fixed counter bag.
const ChronicleDeltasSchema = z.strictObject({
  territories_gained: z.number(),
  territories_lost: z.number(),
  battles_won: z.number(),
  battles_lost: z.number(),
  buildings_built: z.number(),
  alliances_formed: z.number(),
  alliances_joined: z.number(),
  alliances_broken: z.number(),
  vassal_events: z.number(),
  treasure_wins: z.number(),
  raids_suffered: z.number(),
  declarations_made: z.number(),
})

// Money on a public surface is ONE net figure (decided 2026-08-09, 43f8352b):
// the route serves net_usd out of the ledgers, while bare earned/spent stay
// with the owner alone on /wallet. The schema lagged the route from 2026-04-21
// on and reddened schema.warn on every call (night of 2026-09-09, run #43):
// three issues - two "required" on dead total_* and "unrecognized" on net_usd.
const ChronicleCurrentStateSchema = z.strictObject({
  territories_count: z.number(),
  season_points: z.number(),
  net_usd: z.number(),
  reputation: ReputationBlockSchema,
})

export const ChronicleResponseSchema = z.strictObject({
  period: z.enum(['last_hour', 'last_8h', 'last_24h', 'last_7d', 'season_to_date']),
  focus: z.enum(['combat', 'diplomacy', 'all']),
  window: z.strictObject({
    start: IsoTimestamp,
    end: IsoTimestamp,
  }),
  kingdom: z.strictObject({
    id: z.string(),
    name: z.string(),
    status: z.string(),
  }),
  current_state: ChronicleCurrentStateSchema,
  deltas: ChronicleDeltasSchema,
  highlights: z.array(EventRowSchema),
  events: z.array(EventRowSchema),
})

// GET /events/notifications — large aggregated alert shape. Loose inner
// rows (each array has its own column set) + strict envelope.
export const EventsNotificationsResponseSchema = z.strictObject({
  urgent: z.boolean(),
  total_notifications: z.number(),
  since: IsoTimestamp,
  incoming_wars: z.array(z.looseObject({ war_id: z.string() })),
  strike_results: z.array(z.looseObject({ strike_id: z.string() })),
  unread_messages: z.array(z.looseObject({ id: z.string() })),
  pending_declarations: z.array(z.looseObject({ id: z.string() })),
  pve_events: z.array(EventRowSchema),
  nearby_treasures: z.array(EventRowSchema),
  message: z.string(),
})

// GET /events/battles — public combat feed (war-v2 W6 display swap):
// declared wars + recent strikes. Battle plans are sealed while a war
// lives (03.09): strikes carry attack_plan_filed always and attack_plan
// only on a finished war (or to its author); wars carry defenses[] and
// defense_filed only once finished (null while live). war_goal and every
// plan text are framed for LLM consumption.
export const EventsBattlesResponseSchema = z.strictObject({
  wars: z.array(z.looseObject({ id: z.string() })),
  strikes: z.array(z.looseObject({ id: z.string() })),
})

// GET /api/v1/events/counts — season-wide tallies by type (the register books
// count their counters off these: lists of rows are capped, counters are not).
// season=null on an empty DB; the dictionary keys are event types and raid
// outcomes, which is why this is a record and not a strictObject.
export const EventCountsResponseSchema = z.object({
  season: z.number().nullable(),
  types: z.record(z.string(), z.number()),
  raid_outcomes: z.record(z.string(), z.number()),
})

// GET /api/v1/events/pulse — the world's pulse with nobody named (quiet hour,
// decision 6b of 2026-08-18): numbers only, no names and no places — the fog
// stays untouched. The schema was added by the 2026-08-19 triage: the route had
// shipped in `39fb8950` without one (the verifier failed "declared but NOT in the registry").
export const EventsPulseResponseSchema = z.strictObject({
  season: z.number().nullable(),
  window: z.string(),
  tiles_claimed: z.number(),
  structures_raised: z.number(),
  structures_improved: z.number(),
  structures_razed: z.number(),
  repairs_started: z.number(),
  // War in the pulse (THIS DAY, 2026-09-03): the same bare numbers, no names, no places
  wars_declared: z.number(),
  assaults_landed: z.number(),
  tiles_taken: z.number(),
  pacts_sealed: z.number(),
})
