// Common Zod building blocks shared across endpoint schemas.
// Keep small — split when it stops being obvious what's shared.

import { z } from 'zod'

// pg NUMERIC columns arrive as strings by default (no global type parser
// is configured in src/db/client.js). Some response paths `parseFloat`
// them (e.g. kingdom.total_earned → number), others hand them through raw
// (e.g. transactions[].amount → string). Accept both until a later
// session normalises — tracked in tech_debt_backlog.md under the coming
// "numeric-string normalisation" item.
export const NumberOrNumericString = z.union([
  z.number(),
  z.string().regex(/^-?\d+(\.\d+)?$/, 'numeric string'),
])

// Timestamps travel in two shapes at different points in the response
// lifecycle:
//
//   - Before `JSON.stringify` (what the Phase 2 `preSerialization` hook
//     sees): pg driver returns TIMESTAMPTZ columns as native JS `Date`
//     objects by default. Handlers that pass these straight into the
//     response body — e.g. `season[0].started_at` — thus hold Date
//     instances until Fastify serialises them.
//
//   - After serialisation (what smoke-e2e + any HTTP consumer sees):
//     Date objects round-trip through JSON as ISO-8601 strings.
//
// Schema must accept both so the same `IsoTimestamp` definition works
// from both validation vantage points. Using a union rather than
// `z.coerce.string()` preserves the exact runtime shape — smoke sees
// strings, middleware sees Date, neither gets coerced in place.
export const IsoTimestamp = z.union([z.string(), z.date()])

// Kingdom / territory / polygon id shapes are UUIDs in the DB but our
// routes often accept polygon-id aliases ("t_1234"). We don't lock these
// down at the schema level yet — tracked as a follow-up.
export const UuidLoose = z.string().min(1)

// ── Payload-key aliases (S0 fix, 2026-07-12) ─────────────────────────
// S0 traces: every fleet burned paid turns guessing key names — checkin
// vocabulary vs action payloads diverged (`building` vs `building_type`,
// `polygon_id` vs `territory_id`, `army` vs `committed_army`, `content`/
// `note` vs `text`, `race_id` vs `event_id`); k15 (llama-3.3) retried all
// five building types 25+ times off a misleading validation error.
//
// Fix has two layers sharing ONE dictionary:
//  1. withPayloadAliases(schema, map) — the schema silently accepts the
//     alias key and renames it to the canonical one (no round-trip lost;
//     docs keep teaching canonical names). Canonical key present → alias
//     is dropped, never overrides.
//  2. The global error handler (src/index.js) calls payloadKeyHints() below
//     to append "you sent 'X' — this API calls that field 'Y'" when
//     validation still fails — the safety net for schemas we didn't wrap.
export function withPayloadAliases(schema, aliases, { wrapScalar = [] } = {}) {
  // `wrapScalar` names the spellings of a field that is a LIST. A door whose
  // field is a list is addressed by agents the way every other door is
  // addressed — with one id — so a bare id is WRAPPED rather than refused.
  //
  // Every name given here is resolved to the CANONICAL field and the wrap is
  // applied there, which covers both halves at once: the synonyms (renamed
  // into it one line above) and the canonical spelling itself. The canonical
  // one was the hole until 12.09.2026 — the only spelling the guide teaches
  // was the only one that still answered "participant_ids: expected array,
  // received string; participant_ids: Too big: expected string to have <=9
  // characters", and the second half of that refusal is a lie: it is the
  // ARRAY's own .max(9) printed against a string.
  const listFields = new Set(wrapScalar.map((name) => aliases[name] || name).filter(Boolean))
  const wrapped = z.preprocess((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const out = { ...value }
    for (const [alias, canonical] of Object.entries(aliases)) {
      if (!(alias in out)) continue
      if (!(canonical in out)) out[canonical] = out[alias]
      delete out[alias] // leftover alias must not trip strictObject
    }
    for (const field of listFields) {
      const v = out[field]
      if (v !== undefined && v !== null && !Array.isArray(v)) out[field] = [v]
    }
    return out
  }, schema)
  // toMcpShape (src/mcp/adapter.js) introspects `.shape` to mirror HTTP
  // schemas into MCP tool inputs — preprocess wrappers don't expose it,
  // so carry the inner object's shape across (canonical fields only:
  // MCP tools teach canonical names, aliases are HTTP-side forgiveness).
  wrapped.shape = schema.shape
  // The error handler reads this back (payloadKeyHints below): a key this
  // schema ALREADY accepts was never the reason the call failed, so the
  // hint about it must stay silent. Without this the hint lied: run #43 gave
  // 38 refusals "you sent 'army'…" on assaults where army was already accepted.
  wrapped.payloadAliases = aliases
  return wrapped
}

// ── Honest 400 hints (run #43, 2026-09-11) ───────────────────────────
//
// alias key → canonical field names, BEST FIRST. One word means different
// fields at different doors: `content` is the statement's `text` and the
// letter's `body`, so a single flat map could only ever be right at one of
// them (it named `text` on /operator/inbox, where no such field exists).
// The door's own schema decides which candidate is real — see
// payloadKeyHints().
export const PAYLOAD_KEY_HINT_CANDIDATES = {
  building: ['building_type'],
  polygon_id: ['territory_id'],
  territory: ['territory_id'],
  army: ['committed_army'],
  troops: ['committed_army'],
  content: ['text', 'body'],
  note: ['text', 'body'],
  race_id: ['event_id'],
  treasure_id: ['event_id'],
  // The clusters of the 30-kingdom night run (docs/run-43/harness.md): each
  // one of them cost an agent a paid move.
  message: ['body', 'text'],
  members: ['participant_ids'],
  member_ids: ['participant_ids'],
  channel_name: ['participant_ids'],
  recipients: ['participant_ids'],
  with_kingdom_id: ['target_kingdom_id', 'defender_kingdom_id'],
  to_kingdom_id: ['target_kingdom_id', 'participant_ids', 'defender_kingdom_id'],
  // `defender_kingdom_id` (POST /war/declare) was known to `with_kingdom_id`
  // and to nothing else, so the two spellings agents actually reach for at
  // that door — kingdom_id, to_kingdom_id — answered a bare "Unrecognized
  // key" and never named the field that was wanted (12.09.2026).
  kingdom_id: ['target_kingdom_id', 'participant_ids', 'defender_kingdom_id'],
  doctrine: ['text'],
  reserve: ['reserve_army'],
  reserves: ['reserve_army'],
  battle_plan: ['plan'],
  casus_belli: ['war_goal'],
}

// Legacy flat view of the table above (first candidate wins). Kept because
// it is the shape older callers and test/unit/payload-aliases.test.js read.
export const PAYLOAD_KEY_HINTS = Object.fromEntries(
  Object.entries(PAYLOAD_KEY_HINT_CANDIDATES).map(([alias, [first]]) => [alias, first])
)

/**
 * The field names a door actually has, or null when the schema cannot be
 * introspected (union / custom preprocess). z.object, z.strictObject and
 * withPayloadAliases all expose `.shape`.
 */
export function doorFieldNames(schema) {
  const shape = schema?.shape
  if (!shape || typeof shape !== 'object') return null
  return new Set(Object.keys(shape))
}

/** Alias map the door already accepts (set by withPayloadAliases). */
export function acceptedAliasesOf(schema) {
  return schema?.payloadAliases && typeof schema.payloadAliases === 'object' ? schema.payloadAliases : {}
}

/**
 * The closed set of values a field accepts, or null. Unwraps
 * .optional()/.nullable()/.default() so `z.enum([...]).optional()` answers
 * too.
 *
 * This is how the agent-facing catalog and the guide quote a closed set:
 * they read it off the very schema that refuses the call, so the three can
 * never drift. Checked 2026-09-11 against run #43, whose write-up reported
 * a `last_6h` window on GET /events/chronicle — the engine has only ever had
 * `last_8h`, and zod's own refusal already prints the true list.
 */
export function allowedValuesFor(schema, field) {
  let node = schema?.shape?.[field]
  for (let depth = 0; node && depth < 5; depth++) {
    if (Array.isArray(node.options)) return node.options.filter((o) => typeof o === 'string' || typeof o === 'number')
    node = typeof node.unwrap === 'function' ? node.unwrap() : null
  }
  return null
}

/**
 * Split one validation report into the two signals the key hint reads.
 * Both come off the SAME entries the 400 text is rendered from, so the
 * hint can never describe a different failure than the one printed.
 *
 *   failedFields — top-level field names that actually failed
 *                  (instancePath '/committed_army' → 'committed_army');
 *   rejectedKeys — keys a STRICT door refused by name (zod code
 *                  'unrecognized_keys'). These carry no instancePath of
 *                  their own, so reading paths alone left both sets empty
 *                  and the hint went silent on exactly the doors that have
 *                  no synonyms: a live assault carrying `battle_plan`
 *                  answered `Unrecognized key: "battle_plan"` and nothing
 *                  else, never naming `plan` (12.09.2026).
 *
 * Accepts both entry shapes: fastify-type-provider-zod carries the zod
 * issue's own fields under `params`, a raw ZodError issue at the top level.
 */
export function validationFieldSignals(validation) {
  const failedFields = new Set()
  const rejectedKeys = new Set()
  for (const entry of validation || []) {
    const first = (entry?.instancePath || '').replace(/^\//, '').split('/').filter(Boolean)[0]
    if (first) failedFields.add(first)
    const keys = entry?.params?.keys ?? entry?.keys
    if (Array.isArray(keys)) for (const k of keys) rejectedKeys.add(String(k))
  }
  return { failedFields, rejectedKeys }
}

/**
 * Say "you sent X, this API calls that field Y" ONLY when that is true.
 *
 * Three conditions, all required, because each one was violated live:
 *   1. the door does not have the key you sent (kingdom_id IS the field on
 *      /alliances/:id/promote — never rename it there);
 *   2. the door's own schema did not already accept the key as an alias
 *      (an accepted synonym means the key was NOT why the call failed).
 *      An accepted synonym is not always silence, though: when the field it
 *      renames INTO is the one that failed, the refusal names a field the
 *      agent never wrote (`{"army":"800"}` on an assault → "committed_army:
 *      expected number, received string"). Then the two names are tied
 *      together and the agent is told the VALUE is what broke — see the
 *      second loop below. Before 12.09.2026 this case was mute, which made
 *      half the `army` pile QUIETER than it had been before the rewrite;
 *   3. the canonical field is absent from the body AND either it is one of
 *      the fields that ACTUALLY failed, or the door refused the key you
 *      sent by name. The second half matters only on strict doors: there
 *      the canonical field is often OPTIONAL, so it never "fails" — the
 *      whole failure IS the wrong name, and without this the hint stayed
 *      mute precisely where the agent had no synonym to fall back on.
 *      (A value that arrived under an accepted alias and then failed on its
 *      CONTENT is a value problem, not a name problem — condition 2.)
 *
 * @param {object}   body            the raw request body
 * @param {Set|null} doorFields      the door's own field names (null = unknown)
 * @param {object}   acceptedAliases alias→canonical the door already takes
 * @param {Iterable} failedFields    top-level field names from the zod error
 * @param {Iterable} rejectedKeys    keys the door refused by name
 * @returns {string[]} one sentence per canonical field
 */
export function payloadKeyHints({ body, doorFields = null, acceptedAliases = {}, failedFields = null, rejectedKeys = null }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return []
  const failed = new Set(failedFields || [])
  const rejected = new Set(rejectedKeys || [])
  if (failed.size === 0 && rejected.size === 0) return []
  const sent = Object.keys(body)
  const byCanonical = new Map()
  // Synonym ACCEPTED, value rejected: the refusal above names the canonical
  // field, which the agent never typed. Say both names and point at the
  // value, so nobody goes hunting for a spelling that was already right.
  // Silent when the canonical name is also in the body — then the value that
  // failed is the one the agent wrote under the canonical name, and the
  // synonym had nothing to do with it.
  const renamedByCanonical = new Map()
  for (const key of sent) {
    if (doorFields?.has(key)) continue
    const accepted = acceptedAliases[key]
    if (accepted) {
      if (failed.has(accepted) && !(accepted in body)) {
        // Grouped by canonical for the same reason the name hints are: two
        // synonyms of one field in one body get one sentence, not two
        // (only one of them ever reached the schema).
        if (!renamedByCanonical.has(accepted)) renamedByCanonical.set(accepted, [])
        renamedByCanonical.get(accepted).push(key)
      }
      continue
    }
    const candidates = PAYLOAD_KEY_HINT_CANDIDATES[key]
    if (!candidates) continue
    const refusedByName = rejected.has(key)
    const canonical = candidates.find(
      (c) => (failed.has(c) || refusedByName) && !(c in body) && (doorFields ? doorFields.has(c) : true)
    )
    if (!canonical) continue
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, [])
    byCanonical.get(canonical).push(key)
  }
  const hints = []
  for (const [canonical, keys] of byCanonical) {
    hints.push(`you sent ${keys.map((k) => `'${k}'`).join(' and ')} - this API calls that field '${canonical}'`)
  }
  for (const [canonical, keys] of renamedByCanonical) {
    hints.push(
      `you sent ${keys.map((k) => `'${k}'`).join(' and ')} - this API calls that field '${canonical}' `
      + 'and took your spelling, so what was refused is the VALUE you put in it, not the name'
    )
  }
  if (hints.length === 0 && doorFields && !sent.some((k) => doorFields.has(k))) {
    // The whole body arrived one level down: {"pact": {...}}. Part of the 35
    // wrong-target refusals on /pacts in run #43 were this, and a
    // field-by-field message can never see it: every field is "missing".
    for (const key of sent) {
      const inner = body[key]
      if (!inner || typeof inner !== 'object' || Array.isArray(inner)) continue
      const known = Object.keys(inner).filter((k) => doorFields.has(k)).slice(0, 4)
      if (known.length === 0) continue
      hints.push(`you nested the body inside '${key}' - this API reads ${known.map((k) => `'${k}'`).join(', ')} at the top level`)
      break
    }
  }
  return hints
}
