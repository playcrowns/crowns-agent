// Zod schemas for /api/v1/market/* routes (W7 marketplace).
// See src/schemas/README.md for how these get used.
//
// The marketplace trades STRUCTURED deliverables the system executes or
// verifies — the deliverable payload's field-level shape is validated by
// validateDeliverableShape (market-deliverables.js) with config-driven
// bounds; here we gate the envelope.

import { z } from 'zod'
import {
  IsoTimestamp,
  NumberOrNumericString,
  UuidLoose,
} from './common.js'

// ── Enums ──────────────────────────────────────────────────────────

// Kept in step with ORDER_TYPES in market-deliverables (a test checks both
// sides: a schema passing a type with no executor answers 500 instead of 400).
export const MarketOrderTypeSchema = z.enum(['territory', 'passage', 'information', 'bounty', 'mercenaries'])

export const MarketOrderStatusSchema = z.enum(['open', 'filled', 'cancelled', 'expired'])

// ── POST /market/create ────────────────────────────────────────────
//
// deliverable per type (field-level checks live in market-deliverables):
//   territory   { polygon_id }
//   passage     { duration_hours }
//   information {}
//   bounty      { kind, target_kingdom_id, min_committed_army }
// note: optional free text (flavor, NOT enforced). price: config-capped.
export const CreateMarketOrderRequestSchema = z.object({
  order_type: MarketOrderTypeSchema,
  deliverable: z.record(z.string(), z.unknown()).optional().default({}),
  note: z.string().max(500).optional(),
  // 2 decimals (G-3/M23): below a cent x402 prints "$0.00", and refunding the
  // escrow is paid out of our own gas. The price floor
  // (config.game.market.minPriceUsd) is checked by the route - the schemas stay
  // a closed set that pulls in no config (they ship publicly, scripts/export-mcp-public.mjs).
  price: z.number().positive().transform((v) => Math.round(v * 100) / 100),
  expires_in_hours: z.number().int().positive().optional(),
  // A17 (B4): optional targeted listing — kingdom UUID or exact name;
  // only that kingdom may buy. Sell types only (a bounty is claimed by
  // deed and stays open to all).
  addressed_to: z.string().min(1).max(80).optional(),
})

export const CreateMarketOrderResponseSchema = z.strictObject({
  success: z.literal(true),
  order_id: UuidLoose,
  order_type: MarketOrderTypeSchema,
  price: NumberOrNumericString,
  expires_at: IsoTimestamp,
  message: z.string(),
  // A17: present when the listing is addressed to one kingdom
  addressed_to: z.string().optional(),
  // bounty escrow-at-create extras
  escrowed: z.literal(true).optional(),
  tx_hash: z.string().optional(),
  idempotent: z.literal(true).optional(),
})

// ── POST /market/buy ───────────────────────────────────────────────

export const BuyMarketOrderRequestSchema = z.object({
  order_id: UuidLoose,
})

export const BuyMarketOrderResponseSchema = z.strictObject({
  success: z.literal(true),
  order_id: UuidLoose,
  order_type: MarketOrderTypeSchema,
  status: z.literal('filled'),
  price: NumberOrNumericString,
  // The execution record: territory transfer / passage grant /
  // information snapshot — what the buyer actually got.
  delivered: z.record(z.string(), z.unknown()),
  message: z.string(),
  tx_hash: z.string().optional(),
  idempotent: z.literal(true).optional(),
})

// ── POST /market/claim ─────────────────────────────────────────────

export const ClaimMarketOrderRequestSchema = z.object({
  order_id: UuidLoose,
})

export const ClaimMarketOrderResponseSchema = z.strictObject({
  success: z.literal(true),
  order_id: UuidLoose,
  status: z.literal('filled'),
  payout: NumberOrNumericString,
  payout_tx_hash: z.string().nullable(),
  evidence: z.record(z.string(), z.unknown()),
  message: z.string(),
})

// ── POST /market/cancel ────────────────────────────────────────────

export const CancelMarketOrderRequestSchema = z.object({
  order_id: UuidLoose,
})

export const CancelMarketOrderResponseSchema = z.strictObject({
  success: z.literal(true),
  order_id: UuidLoose,
  status: z.literal('cancelled'),
  message: z.string(),
  refund_tx_hash: z.string().optional(),
})

// ── GET /market ────────────────────────────────────────────────────

export const MarketBrowseQuerySchema = z.object({
  order_type: MarketOrderTypeSchema.optional(),
  // Paging (2026-09-03): limit defaults to 50, ceiling 200; cursor =
  // next_cursor of the previous page (created_at of its last order).
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(64).optional(),
  // ?framed=false strips [USER_CONTENT_*] markers from `note`.
  framed: z.enum(['true', 'false']).optional(),
})

const MarketBrowseRowSchema = z.looseObject({
  id: UuidLoose,
  order_type: MarketOrderTypeSchema,
  status: z.literal('open'),
  deliverable: z.record(z.string(), z.unknown()),
})

export const MarketBrowseResponseSchema = z.strictObject({
  open_orders: z.number(),
  // Paging (2026-09-03): whether orders older than this page exist and
  // where the next one starts (?cursor=next_cursor).
  has_more: z.boolean(),
  next_cursor: IsoTimestamp.nullable(),
  // Season-wide kind × status tallies (7a694bd0): rows are capped, the
  // register books' counters must not be.
  totals: z.array(z.strictObject({
    order_type: z.string(),
    status: z.string(),
    n: z.number().int().nonnegative(),
  })),
  orders: z.array(MarketBrowseRowSchema),
  hint: z.string(),
})

// ── GET /market/my ─────────────────────────────────────────────────

const MyMarketOrderRowSchema = z.looseObject({
  id: UuidLoose,
  order_type: MarketOrderTypeSchema,
  status: MarketOrderStatusSchema,
  my_role: z.enum(['creator', 'counterparty']),
})

export const MyMarketOrdersResponseSchema = z.strictObject({
  kingdom_id: UuidLoose,
  total: z.number(),
  orders: z.array(MyMarketOrderRowSchema),
})

// ── GET /market/history ────────────────────────────────────────────

const MarketHistoryRowSchema = z.looseObject({
  id: UuidLoose,
  order_type: MarketOrderTypeSchema,
  status: z.literal('filled'),
})

export const MarketHistoryResponseSchema = z.strictObject({
  deals: z.array(MarketHistoryRowSchema),
  // Paging (2026-09-03): cursor = filled_at of the page's last deal.
  has_more: z.boolean(),
  next_cursor: IsoTimestamp.nullable(),
})

// ── OLD /trade/* — 410 Gone (W7) ───────────────────────────────────
//
// Same precedent as AttackGoneResponseSchema: the farewell note carries
// pointers to the new surface, and drift is drift even on a farewell.
export const TradeGoneResponseSchema = z.strictObject({
  error: z.string(),
  how_the_market_works_now: z.array(z.string()),
})
