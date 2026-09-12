/**
 * HTTP request schema → MCP tool arg shape adapter.
 *
 * Every MCP tool (see src/mcp/server.js) needs an argument shape — an
 * object literal of zod fields that the SDK uses to validate LLM input
 * and generate tool-description JSON for the model.
 *
 * Prior to this adapter, each MCP tool duplicated the shape of the
 * corresponding HTTP request schema inline. That was a drift hazard:
 * a new required field on the HTTP side would silently go unlisted in
 * the MCP surface, and the agent would hit a clean 400 from the backend
 * with no way to introspect the expected shape.
 *
 * `toMcpShape(httpSchema, descriptions?)` bridges the two: it takes a
 * `z.object({...})` that the HTTP route validates body against, and
 * returns the field-map the MCP SDK expects — with `api_key` prepended
 * (agents authenticate via header equivalent) and per-field descriptions
 * overlaid for better LLM tool-arg rendering.
 *
 * Separation of concerns:
 *   - HTTP schema describes **validation**: shapes, nullability, min/max,
 *     enum membership. It is the on-chain gatekeeper — what it rejects,
 *     the user cannot do.
 *   - MCP `describe()` calls describe **semantic intent for the LLM**:
 *     when to use this argument, what values make sense, cross-references
 *     to other tools. Passed via the `descriptions` map so HTTP schemas
 *     stay pure.
 *
 * Usage:
 *
 *   import { ClaimRequestSchema } from '../schemas/actions.js'
 *   import { toMcpShape } from './adapter.js'
 *
 *   server.tool(
 *     'claim_territory',
 *     'Claim a neutral territory ($1). ...',
 *     toMcpShape(ClaimRequestSchema, {
 *       territory_id: 'UUID of the territory to claim',
 *     }),
 *     async ({ api_key, territory_id }) => { ... }
 *   )
 */

import { z } from 'zod'

const DEFAULT_API_KEY_DESCRIPTION = 'Your Crowns API key'

/**
 * Build an MCP-compatible argument shape from an HTTP request schema.
 *
 * @param {z.ZodObject} httpSchema - A `z.object({...})` from src/schemas/*.js
 *   that the HTTP route validates the request body against.
 * @param {Object<string, string>} [descriptions] - Optional per-field
 *   descriptions for the MCP tool's JSON rendering. Keys must match field
 *   names in the HTTP schema. Fields without a description keep the
 *   underlying Zod type's own description (or none if unset).
 * @param {Object} [options]
 * @param {boolean} [options.includeApiKey=true] - Prepend `api_key: z.string()`
 *   to the shape. Set false only for MCP tools that map to endpoints
 *   that don't require authentication (none exist today, but the hook
 *   is there for future public MCP tools).
 * @param {string} [options.apiKeyDescription] - Override the default
 *   `api_key` description if a particular tool wants tighter guidance
 *   (rare — the default is appropriate for all paid-action tools).
 * @param {Object<string, z.ZodTypeAny>} [options.extras] - Additional
 *   fields to merge between `api_key` and the body fields. Primary use
 *   case: URL path / query parameters that the MCP tool exposes as
 *   top-level args but don't appear in the HTTP body schema. Example:
 *   `POST /alliances/:id/invite` accepts `alliance_id` via URL, body
 *   has `to_kingdom_id`; the MCP tool wants both as args.
 *
 * @returns {Object<string, z.ZodTypeAny>} Shape map ready to pass as the
 *   third argument to `server.tool(name, description, shape, handler)`.
 *
 * @throws if `httpSchema` is not a `z.object(...)` — the adapter only
 *   understands object schemas. Unions / primitives / discriminated
 *   unions on the HTTP side need manual MCP arg shapes anyway.
 */
export function toMcpShape(httpSchema, descriptions = {}, options = {}) {
  const {
    includeApiKey = true,
    apiKeyDescription = DEFAULT_API_KEY_DESCRIPTION,
    extras = {},
  } = options

  // Defensive: make sure we got a ZodObject. `.shape` exists on objects;
  // unions / primitives don't have it. Fail loud so misuse surfaces at
  // import time, not at tool-call time.
  if (!httpSchema || typeof httpSchema !== 'object' || !httpSchema.shape) {
    throw new TypeError(
      'toMcpShape: expected a z.object(...) HTTP schema with a `.shape` property. ' +
      'Unions / primitives / discriminated unions need a manual shape.'
    )
  }

  // Order: api_key → extras (URL path/query params) → body fields.
  // Extras sit between because they semantically identify "which resource"
  // before the body "what to do with it" — same convention as the REST URL.
  const shape = includeApiKey
    ? { api_key: z.string().describe(apiKeyDescription) }
    : {}

  for (const [fieldName, fieldSchema] of Object.entries(extras)) {
    shape[fieldName] = fieldSchema
  }

  // Copy each field from the HTTP schema, layering the MCP-specific
  // description on top if provided. We use `.describe()` which returns a
  // new schema with the description set — does not mutate the source.
  for (const [fieldName, fieldSchema] of Object.entries(httpSchema.shape)) {
    const desc = descriptions[fieldName]
    shape[fieldName] = desc ? fieldSchema.describe(desc) : fieldSchema
  }

  // Surface unknown description keys so typos don't silently go unused.
  // A description for a field that doesn't exist in the HTTP schema means
  // the caller probably mistyped the field name — easier to catch here
  // than to wonder why the LLM isn't seeing their guidance.
  const httpKeys = new Set(Object.keys(httpSchema.shape))
  for (const descKey of Object.keys(descriptions)) {
    if (!httpKeys.has(descKey)) {
      throw new Error(
        `toMcpShape: description for "${descKey}" doesn't match any field in the HTTP schema. ` +
        `Known fields: ${[...httpKeys].join(', ') || '(none)'}.`
      )
    }
  }

  return shape
}
