#!/usr/bin/env node
/**
 * Crowns MCP Server
 *
 * Wraps the REST API as MCP tools for Claude/OpenClaw agents.
 * Each tool maps to a REST endpoint via internal HTTP calls.
 *
 * Usage:
 *   node src/mcp/server.js
 *
 * Agent connects via stdio transport (OpenClaw skill config).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// x402 payment stack — answers HTTP 402 challenges by signing an
// EIP-3009 authorization with the agent's OWN wallet key (see
// CROWNS_WALLET_KEY below). Identity and money are separate things:
// the api_key says WHO you are, the wallet is WHAT PAYS.
import { wrapFetchWithPayment } from '@x402/fetch'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { privateKeyToAccount } from 'viem/accounts'

import { toMcpShape } from './adapter.js'
import { buildPaymentClient, resolveMaxPaymentUsd, isCeilingRefusal } from './payment-client.js'
import { applyPayeeGuard, isPayeeRefusal } from './known-payees.js'

// HTTP request schemas — reused as MCP tool arg shapes via toMcpShape.
// Drift-prevention: if an HTTP validator adds/removes a field, the MCP
// surface updates automatically. See src/mcp/adapter.js for details.
import {
  BuildRequestSchema,
  ClaimRequestSchema,
  DemolishRequestSchema,
  ExpeditionRequestSchema,
  MegaClaimRequestSchema,
  PlaceBuildingRequestSchema,
  RestartRequestSchema,
} from '../schemas/actions.js'
import {
  AcceptRequestRequestSchema,
  CreateAllianceRequestSchema,
  InviteRequestSchema,
  KickRequestSchema,
  PromoteRequestSchema,
  RejectRequestRequestSchema,
  RequestJoinRequestSchema,
} from '../schemas/alliances.js'
import {
  AcceptOfferRequestSchema,
  AssaultRequestSchema,
  DeclareWarRequestSchema,
  DoctrineRequestSchema,
  JoinWarRequestSchema,
  RaidRequestSchema,
  RecruitOfferRequestSchema,
  RelocateCapitalRequestSchema,
  RepairRequestSchema,
  WarDefenseRequestSchema,
} from '../schemas/war.js'
import {
  CreateMarketOrderRequestSchema,
  BuyMarketOrderRequestSchema,
  ClaimMarketOrderRequestSchema,
  CancelMarketOrderRequestSchema,
} from '../schemas/market.js'
import {
  RegisterRequestSchema,
  ChangeColorRequestSchema,
  SettingsRequestSchema,
  SpendingLimitRequestSchema,
} from '../schemas/agents.js'
import { ChronicleQuerySchema } from '../schemas/events.js'
import { SendToOperatorRequestSchema } from '../schemas/operator.js'
import { FeedbackRequestSchema } from '../schemas/feedback.js'
import {
  readStoredKey, storedKeyPath, saveKey, forgetKey, maskAgentKey,
  saveOperatorKey, storedOperatorKeyPath, readStoredOperatorKeyEntries, forgetOperatorKeyFile,
  readLegacyCwdKey, forgetLegacyCwdKey,
} from './key-store.js'

// One host for the machine door (LAUNCH-LIST 2.1.8): the API, the socket and
// the cabinet live on app.playcrowns.com; the pages a human reads live on
// playcrowns.com. The default used to be localhost:3000, so an outside
// operator who installed our public MCP knocked on their own machine instead.
const API_BASE = process.env.CROWNS_API_URL || 'https://app.playcrowns.com'

// ── Wallet (x402 rail) ──────────────────────────────────────
// CROWNS_WALLET_KEY: the agent's own EVM private key (0x…), set in the
// MCP server's environment by the operator — NEVER passed as a tool
// argument (tool args end up in transcripts and logs; env stays local).
// When set, every paid endpoint's 402 challenge is answered
// automatically: sign the exact USDC amount → retry → the tool returns
// the final game response. Without it, paid tools surface the raw 402
// challenge with a hint. The wallet needs USDC on Base, no ETH —
// payments are gasless signatures.
const WALLET_KEY = process.env.CROWNS_WALLET_KEY || null
let payFetch = fetch
let walletAddress = null
// The signer lives at module scope, not inside the block below: recovering a
// lost entry answer needs it to sign a plain message (see recoverApiKey), and a
// signer visible only to the payment wrapper left that path impossible.
let signerAccount = null
if (WALLET_KEY) {
  let account
  try {
    account = privateKeyToAccount(WALLET_KEY)
  } catch (e) {
    console.error(`CROWNS_WALLET_KEY is not a valid 32-byte hex private key (${e.message}); it must be 0x + 64 hex characters`)
    process.exit(2)
  }
  walletAddress = account.address
  signerAccount = account
  // Per-payment ceiling — see src/mcp/payment-client.js for the whole truth.
  // Short version: `new x402Client({ spendControls })` exists in NO version of
  // the core (the constructor expects a selector function), and the previous
  // build dropped the very first paid call - the door paid nothing at all.
  // The ceiling is held by the client POLICY (present in every version); on
  // @x402/core >= 2.23 the core's own spend control is raised as well, whose
  // default of one dollar would otherwise cut the entry before our policy did.
  // CROWNS_MAX_PAYMENT_USD tightens the bar to the operator's budget; the
  // default (110) comes from game facts: entry 50 + deal ceiling 100.
  const maxPaymentUsd = resolveMaxPaymentUsd(process.env.CROWNS_MAX_PAYMENT_USD)
  // What we know about the asset is filled in from public-config before the
  // first payment. Decimals are NOT taken from the requirement: precision
  // named by the same answer that names the price cannot bound that price.
  const assetInfo = { decimals: 6, address: null }
  const client = buildPaymentClient({ maxPaymentUsd, assetInfo })
  // Narrow payment scheme (pilot P-3): 'eip155:*' would sign a payment on
  // ANY chain the server names in its 402, so a compromised server would
  // turn a test-network agent into a live-network payer. We register the
  // EXACT chain: CROWNS_CHAIN_ID from the environment, otherwise the chain
  // that GET /api/v1/public-config names itself (lazily, before the first
  // payment; free calls keep working with no route to the API at all).
  const envChainId = Number(process.env.CROWNS_CHAIN_ID) > 0
    ? Number(process.env.CROWNS_CHAIN_ID)
    : null
  let schemeReady = envChainId != null
  if (envChainId != null) client.register(`eip155:${envChainId}`, new ExactEvmScheme(account))
  // WHO the money goes to is a rule of its own, apart from how much. The
  // payee address arrives in the SAME answer as the price, and until now
  // nobody checked it: a swapped server (or a foreign CROWNS_API_URL) would
  // take EVERY paid move of the night, while a ceiling bounds one payment.
  // This object is re-read on every payment: the chain is learned lazily, in
  // ensurePaymentScheme below, and while it is unknown there are no known
  // payees - refusing in that state is the correct answer.
  const payeeInfo = { chainId: envChainId, extraCsv: process.env.CROWNS_ALLOWED_PAYTO || null }
  // The guard REFUSES to install on an x402 core it was not written for, and
  // that refusal used to be thrown from module top level - killing the door
  // before the stdio transport ever came up. The agent then saw "the server
  // did not start", and the text telling its operator what to fix reached no
  // model at all. Free tools do not pay anybody, so they stay alive; the
  // refusal is handed out on the PAID move instead, with the same words, the
  // same honest 402 and the same retry:false as every other local refusal.
  let payeeGuardFailure = null
  try {
    applyPayeeGuard(client, payeeInfo)
  } catch (err) {
    payeeGuardFailure = err
    console.error(
      `${err.message} Free tools keep working; every paid move is refused until this is fixed.`
    )
  }
  async function ensurePaymentScheme() {
    if (schemeReady) return
    const res = await fetch(`${API_BASE}/api/v1/public-config`)
    if (!res.ok) throw new Error(`public-config answered ${res.status} - cannot learn the payment chain`)
    const cfg = await res.json()
    const chainId = Number(cfg?.chain?.id)
    if (!Number.isFinite(chainId) || chainId <= 0) {
      throw new Error('public-config carries no chain id - refusing to register a wildcard payment scheme')
    }
    // Decimals are not taken from the server at all (USDC is six everywhere);
    // the token address is checked against what we know ourselves - a swapped
    // public-config would raise the ceiling as surely as a swapped requirement.
    const named = typeof cfg?.chain?.usdcAddress === 'string' ? cfg.chain.usdcAddress : null
    const pinned = typeof process.env.CROWNS_USDC_ADDRESS === 'string' && process.env.CROWNS_USDC_ADDRESS.startsWith('0x')
      ? process.env.CROWNS_USDC_ADDRESS
      : null
    if (pinned && named && pinned.toLowerCase() !== named.toLowerCase()) {
      throw new Error(`public-config names ${named} as the token, but CROWNS_USDC_ADDRESS pins ${pinned} - refusing to pay`)
    }
    assetInfo.address = pinned || named
    payeeInfo.chainId = chainId
    client.register(`eip155:${chainId}`, new ExactEvmScheme(account))
    schemeReady = true
  }
  const wrappedFetch = wrapFetchWithPayment(markPaymentSigned(fetch), client)
  payFetch = async (...args) => {
    // The payee check never got installed: nobody would verify who the money
    // goes to, so nothing may be signed. The work is done below, out of this
    // function's way - see payWithoutGuard.
    if (payeeGuardFailure) return payWithoutGuard(...args)
    try {
      await ensurePaymentScheme()
    } catch (err) {
      // The payment scheme was not learned - a paid call will say why, and
      // free calls go through plain fetch (401/402 without a signature).
      return fetch(...args)
    }
    try {
      return await wrappedFetch(...args)
    } catch (err) {
      // A refusal by OUR ceiling or by OUR payee list is not a transport
      // failure. Without this branch api() would hand it to the agent as
      // "Crowns API unreachable ... retry: true", and the agent would beat the
      // wall with retries - with a swapped payee, against the swapped server.
      // We answer an honest 402 with no retry: no money moved, no change.
      //
      // Whether a refusal is OURS is decided by ANCHORS AT THE START OF THE
      // TEXT (isCeilingRefusal / isPayeeRefusal), the same ones the example
      // client uses. A bare includes is forgeable here: @x402/core, finding no
      // scheme for a requirement, puts JSON.stringify of the WHOLE server
      // accepts array into its error text - a swapped server hiding our mark
      // in any field would sell a core error as ours, handing the agent a
      // false reason and killing a retry that was genuinely needed.
      if (isCeilingRefusal(err) || isPayeeRefusal(err)) {
        return new Response(
          JSON.stringify({ error: err.message, retry: false }),
          { status: 402, headers: { 'Content-Type': 'application/json' } }
        )
      }
      throw err
    }
  }
  // The door with no payee check on it. The plain fetch keeps every FREE tool
  // alive - reading the world costs nothing and signs nothing. A door that
  // wants money answers 402, and that is the ONE answer we replace with our
  // own words: the agent must send its operator to fix the installation, not
  // retry. The same shape as every other local refusal - status 402,
  // retry:false - because nothing was signed and nothing moved.
  //
  // It lives here, below payFetch, rather than inline inside it: the refusal
  // branch of payFetch is lifted out of this file BY TEXT and executed by
  // test/unit/mcp-door-refusal-anchor.test.js, which finds it as the first
  // `return new Response(` of the file. An earlier one would quietly aim that
  // guard at the wrong branch and stop guarding the anchors at all.
  async function payWithoutGuard(...args) {
    const res = await fetch(...args)
    if (res.status !== 402) return res
    return new Response(
      JSON.stringify({
        error: payeeGuardFailure.message,
        hint: 'the payment libraries in this installation are not the ones this server is written for. '
          + 'Reinstall them with `npm ci` (not `npm install`) and restart the MCP server. Nothing was '
          + 'signed and no money moved. Free tools keep working meanwhile.',
        retry: false,
      }),
      { status: 402, headers: { 'Content-Type': 'application/json' } }
    )
  }
}

// ── HTTP helper ─────────────────────────────────────────────
// Wraps fetch + JSON parse so every agent-facing tool handler gets a predictable
// `{ status, data }` shape no matter what. Previously a fetch failure (API down,
// TCP reset, DNS fail, cloudflare 502 with HTML body, empty-body 504) would
// bubble up as raw NodeJS stack traces through the MCP transport, which agents
// have no way to reason about. Now every failure becomes `{ status: <n>, data:
// { error: 'Crowns API unreachable: <reason>', retry: true } }` and the agent
// can decide whether to retry based on the shape.
//
// Except after a SIGNED payment (review of wave 1 recheck, 13.09, C9). A paid
// move can wait in the operator wallet's queue longer than nginx holds the
// request, and the model then read `retry: true` on an HTML 504: it called
// build again, the first build had landed meanwhile, the second call quoted
// the next tier and paid for it - one intent, two charges (a bounty: two
// escrows). A request that carried a payment signature is marked on the way
// out, and a lost answer to it says "do not repeat - read your check-in".

/** Mark a response or error that answered a request carrying a payment signature. */
function markPaymentSigned(impl) {
  return async (input, init) => {
    const signed = typeof input?.headers?.has === 'function'
      && (input.headers.has('PAYMENT-SIGNATURE') || input.headers.has('X-PAYMENT'))
    // The signature's own validBefore decides when a lost answer is final (round 3).
    const validBefore = signed ? signedValidBefore(input.headers.get('PAYMENT-SIGNATURE') || input.headers.get('X-PAYMENT')) : null
    try {
      const res = await impl(input, init)
      if (signed && res && typeof res === 'object') {
        try { res.paymentSigned = true; res.paymentValidBefore = validBefore } catch { /* a frozen response stays unmarked */ }
      }
      return res
    } catch (err) {
      if (signed && err && typeof err === 'object') {
        try { err.paymentSigned = true; err.paymentValidBefore = validBefore } catch { /* same */ }
      }
      throw err
    }
  }
}

/** validBefore (unix seconds) of the authorization inside a payment header, or null. */
function signedValidBefore(header) {
  try {
    const v = Number(JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'))?.payload?.authorization?.validBefore)
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

// The server's own wait before an unknown outcome is read again
// (src/lib/payment-ledger.js: RECONCILE_STALE_MS 120 s + RECONCILE_LOOP_MS 60 s).
const LOST_PAID_ANSWER_WAIT_S = 180
// When a lost paid answer is decided for good (review of wave 1 recheck, rounds
// 2-3, 13.09, C9) - counted from the SIGNED authorization, the way the server
// counts it: validBefore, plus the slack after which the ledger buries an unused
// one (120 s), plus one reconciler pass (180 s). Round 2 counted 600 s from the
// start of the call: the quote is signed after that start, and a quote with a
// longer window (up to the 900 s this door signs) is decided minutes after the
// door called it final. Without a readable signature the door assumes that
// longest window. A unit test pins these against the server's config.
const SETTLE_EXPIRY_SLACK_S = 120
const LOST_PAID_ANSWER_FALLBACK_S = 900 + SETTLE_EXPIRY_SLACK_S + LOST_PAID_ANSWER_WAIT_S
const ENTRY_PATH = '/api/v1/accounts/pay-entry'

function lostPaidAnswer(error, { startedAt = Date.now(), path = '', validBefore = null } = {}) {
  const finalMs = Number.isFinite(validBefore) && validBefore > 0
    ? Math.max(Date.now(), validBefore * 1000 + SETTLE_EXPIRY_SLACK_S * 1000) + LOST_PAID_ANSWER_WAIT_S * 1000
    : Math.max(Date.now(), startedAt + LOST_PAID_ANSWER_FALLBACK_S * 1000)
  const outcomeFinalBy = new Date(finalMs).toISOString()
  // Only the entry may be repeated after a wait: it refuses a second charge while
  // its payment is open. Every other paid door quotes afresh and signs again.
  if (path === ENTRY_PATH) {
    return {
      error,
      retry: false,
      payment_outcome: 'unknown',
      sign_new_payment: false,
      retry_after_seconds: LOST_PAID_ANSWER_WAIT_S,
      outcome_final_by: outcomeFinalBy,
      door_note: 'This entry had signed its payment when the answer was lost. Wait retry_after_seconds, then call pay_entry once more: it never charges twice.',
    }
  }
  return {
    error,
    retry: false,
    payment_outcome: 'unknown',
    sign_new_payment: false,
    outcome_final_by: outcomeFinalBy,
    door_note: 'This call had signed a payment when its answer was lost, so the payment may have gone through and the move may already be yours. '
      + 'Do NOT call this tool again before outcome_final_by - a new call signs a NEW payment. Read check_in in a few minutes: '
      + 'a payment still being decided is listed under payments_in_flight, and a move missing from check_in before outcome_final_by is NOT proof it failed. '
      + 'After outcome_final_by read check_in once more: a payment still listed there was charged and is being applied or refunded - do not repeat '
      + '(one listed with will_not_apply: true never applies - its refund is already sent, and a new move is a new payment); '
      + 'a move neither applied nor listed did not happen, and any money it took comes back to your wallet by itself.',
  }
}

async function api(method, path, callOpts = {}) {
  const startedAt = Date.now()
  const { apiKey, body } = callOpts
  const headers = { 'Content-Type': 'application/json' }
  // The door remembers the key (src/mcp/key-store.js). The substitution is
  // deliberately narrow: it happens only when the CALLER asked for a key at all
  // (`apiKey` present among the options) and did not supply one. Six tools -
  // pay_entry, tournament_results, get_reputation, get_buildings_info,
  // browse_market, get_colors - never pass `apiKey`, so they stay keyless:
  // sending a key there would move them from the address rate bucket into the
  // key bucket and, for pay_entry, would carry a dead tournament's key into a
  // fresh entry. Eight more tools take the key OPTIONALLY and answer more
  // through their own player's eyes once they have it; that change is named out
  // loud in the guide and in MCP.md, not slipped in.
  // An old wallet-less ./crowns.apikey is adopted only once the game names its wallet as ours.
  const adoption = ('apiKey' in callOpts && !apiKey) ? await adoptLegacyCwdKey() : null
  const key = apiKey || ('apiKey' in callOpts ? readStoredKey(walletAddress) : null)
  if (key) headers['X-Api-Key'] = key

  const opts = { method, headers }
  if (body && method !== 'GET') opts.body = JSON.stringify(body)

  let res
  try {
    res = await payFetch(`${API_BASE}${path}`, opts)
  } catch (err) {
    // Transport-level failures: TCP reset, DNS fail, timeout, refused connection.
    // fetch() rejects rather than returning a Response.
    if (err?.paymentSigned) {
      return { status: 503, data: lostPaidAnswer(`Crowns API unreachable after this call signed a payment: ${err.message}`, { startedAt, path, validBefore: err.paymentValidBefore }) }
    }
    return {
      status: 503,
      data: { error: `Crowns API unreachable: ${err.message}`, retry: true },
    }
  }

  let data
  try {
    data = await res.json()
  } catch (err) {
    // Non-JSON response (nginx 502 HTML, empty body on 504, cloudflare error
    // page). Preserve the HTTP status so agents can distinguish between "API
    // rejected my request with a known status but unparseable body" and "API
    // is flat-out unreachable".
    if (res.paymentSigned) {
      return {
        status: res.status || 502,
        data: lostPaidAnswer(`Crowns API returned non-JSON body (${res.status}) after this call signed a payment: ${err.message}`, { startedAt, path, validBefore: res.paymentValidBefore }),
      }
    }
    return {
      status: res.status || 502,
      data: {
        error: `Crowns API returned non-JSON body (${res.status}): ${err.message}`,
        retry: res.status >= 500 || res.status === 429,
      },
    }
  }

  // A 402 reaching this point means the payment wrapper did NOT answer
  // the challenge — no wallet key configured (or the wallet refused).
  // Surface what the agent's operator must fix instead of a bare
  // challenge blob the agent can't act on.
  if (res.status === 402 && !WALLET_KEY) {
    return {
      status: 402,
      data: {
        ...data,
        hint: 'This action costs USDC and is paid by YOUR wallet over the x402 protocol. ' +
              'Your operator must set CROWNS_WALLET_KEY (the wallet private key) in the MCP ' +
              'server environment and fund the wallet with USDC on Base. No ETH needed.',
      },
    }
  }
  // A key this door remembered can die without anyone touching it: the key is
  // bound to one tournament and the next transition revokes it
  // (src/api/middleware/auth.js). Replaying a dead key every turn looks like a
  // broken account, so the file goes and the answer says what to do. Only a
  // STORED key is forgotten - a key the agent passed by hand is its own.
  if (res.status === 401 && !apiKey && key && /revoked|invalid api key/i.test(JSON.stringify(data || {}))) {
    const gone = forgetKey(walletAddress)
    // The human's file beside it is CHECKED, not dropped with the agent key:
    // recovery rotates only the agent key, so a dead agent key can sit next
    // to a live operator key. A transition kills both - and then the old
    // copy must not wait here to be handed over as the human's key.
    const op = await savedOperatorKeyState()
    const opLine = op.state === 'dead'
      ? ` The human's cabinet key saved beside it (${op.path}) no longer opens the cabinet either and has been removed; the next entry answer brings a fresh one.`
      : ''
    return {
      status: 401,
      data: {
        ...data,
        door_note: (gone.length
          ? `The key this door had saved (${gone.join(', ')}) no longer works and has been removed. `
            + 'If a new tournament is open, call pay_entry once: it pays the entry and saves the new key here.'
          : 'The key this door used no longer works. If a new tournament is open, call pay_entry once.')
          + ' If this wallet already paid the entry of the open tournament, pay_entry does not charge again - it collects this seat\'s key.' + opLine,
      },
    }
  }
  // An old ./crowns.apikey the game could not be asked about yet: this call went
  // out without it, and a bare "Missing X-Api-Key" must not read as "there is no
  // key" (review of wave 1 recheck, round 3).
  if (res.status === 401 && !key && adoption && adoption.settled === false) {
    return {
      status: 401,
      data: {
        ...data,
        door_note: `A key file from an older door is on this machine (${adoption.path}), but the game could not be asked just now whether it belongs to this wallet `
          + `(${adoption.status ? `HTTP ${adoption.status}` : 'no answer'}), so this call went out without a key. Nothing was charged. Call again in a minute; do not pay the entry again.`,
      },
    }
  }
  return { status: res.status, data }
}

// ── Recovering a lost entry answer ──────────────────────────
//
// The hole this closes. The entry answer is the ONLY place the api_key is ever
// revealed, and MCP hosts time a tool call out after 60 seconds by default while
// a paid call here can honestly take minutes. So the common failure is not "the
// payment failed" but "the payment settled and the answer never arrived": money
// gone, seat paid, key lost. The server has a door for exactly this - prove the
// wallet with a signed message and the key is re-issued - but this door had no
// way to walk through it.
//
// The rules below are copied deliberately from the example client, where they
// were worked out the hard way:
//   - recover ONLY when nothing is saved. Every successful recovery ROTATES the
//     key, so recovering over a working key destroys the working one.
//   - sign ONLY a string the SERVER named, that begins with the recovery prefix
//     and carries our own address. Never compose it, never sign what a server
//     hands over unexamined: a signature captured for one protocol must not
//     work in another.
//   - never pay a second entry here. pay_entry is an explicit act of the agent;
//     a door that pays again "to get a better answer" spends $50 on a refusal.
const RECOVERY_PREFIX = 'Crowns key recovery:'

// The human's key (13.09, C9 recon, operator cabinet). Every answer that
// carries operator_key also leaves a copy in a file beside the agent key
// (key-store.js), and the text says where - so the key outlives the one
// answer it arrives in. The raw operator key is NOT masked for the model:
// the agent is the courier to the human (ENTRY_NEXT tells it to hand the key
// over), and a watching key re-minted by the wallet at any time is cheap to
// replace if the transcript leaks. The agent key stays masked as before.
const CABINET_URL = `${API_BASE.replace(/\/$/, '')}/map`

function operatorKeyNote(operatorKey) {
  if (typeof operatorKey !== 'string' || !operatorKey) return null
  const op = saveOperatorKey(operatorKey, walletAddress)
  return op.saved
    ? `The operator_key in this answer is for your HUMAN operator: it opens their cabinet at ${CABINET_URL} - hand it to them. `
      + `A copy is saved at ${op.path} (mode 0600) on this machine, so it does not depend on this conversation. `
      + 'If they lose it, the kingdom\'s wallet re-mints it at any time (POST /api/v1/accounts/operator-key), and that kills every earlier copy.'
    : `The operator_key in this answer is for your HUMAN operator: it opens their cabinet at ${CABINET_URL}. `
      + `This door COULD NOT SAVE a copy of it (tried: ${op.tried.join(' | ')}), so this answer is the only one - hand it to them now. `
      + 'If it is lost, the kingdom\'s wallet re-mints it (POST /api/v1/accounts/operator-key).'
}

/**
 * Does the operator key file on this machine still open the cabinet?
 *
 * Review of wave 1b (13.09, C9 recon). A `.operatorkey` file outlives its
 * tournament: the transition kills both keys of the pair, but only the agent
 * file is dropped on the 401. Recovery then named the old copy to the model
 * as "the human's key - hand it over", and the model had no way to tell a live
 * copy from a dead one. One read-only GET with that key settles it: a 401 is
 * the server's own word that the key is gone (an earlier tournament, or a
 * newer mint), and only then is the file removed. No answer means "unknown",
 * and the file stays.
 *
 * Review of wave 1 recheck (13.09, C9): every copy is checked on its own and
 * only the refused one is removed (a dead copy under CROWNS_KEY_FILE used to
 * take a live one in $HOME down with it), and a key that opens ANOTHER
 * wallet's cabinet - `./crowns.operatorkey` in a shared working directory - is
 * 'foreign', never 'alive'.
 *
 * @returns {Promise<{path: string|null, state: 'none'|'alive'|'dead'|'unknown'|'foreign'}>}
 */
async function savedOperatorKeyState() {
  const path = storedOperatorKeyPath(walletAddress)
  if (!path) return { path: null, state: 'none' }
  const copies = readStoredOperatorKeyEntries(walletAddress)
  if (!copies.length) return { path, state: 'unknown' }
  let dead = null
  let foreign = null
  for (const copy of copies) {
    // The operator key reads everything the agent reads; /wallet is one of the
    // doors the cabinet itself opens with it. An explicit apiKey keeps api()
    // from swapping in the stored agent key.
    const probe = await api('GET', '/api/v1/wallet', { apiKey: copy.key })
    if (keyRefusedByGame(probe)) {
      forgetOperatorKeyFile(copy.path)
      dead = dead || copy.path
      continue
    }
    // A 401 that does not name the key (the pre-launch gate) says nothing about it.
    if (probe.status === 401 || probe.status >= 500 || probe.status === 429 || !probe.status) return { path: copy.path, state: 'unknown' }
    const owner = probe.data?.wallet_address
    if (walletAddress && typeof owner === 'string' && owner.toLowerCase() !== String(walletAddress).toLowerCase()) {
      foreign = foreign || copy.path
      continue
    }
    return { path: copy.path, state: 'alive' }
  }
  return foreign ? { path: foreign, state: 'foreign' } : { path: dead, state: 'dead' }
}

// ── The saved agent key, judged by the game ─────────────────
//
// The working-directory file older doors wrote WITHOUT a wallet in its name
// (./crowns.apikey). Review of wave 1 recheck, round 2 (13.09, C9): two agents
// in one container with a read-only HOME share a working directory; B's entry
// wrote B's key there, and A's door read it as its own - every tool of A played
// B's kingdom, and A's recovery was refused over "a working key". New keys go
// under the wallet's own name (key-store.js); the old file is adopted once, and
// only when GET /api/v1/wallet names THIS wallet. Another wallet's key is never
// sent and never deleted.
/**
 * The game refused the KEY itself - the same rule as the example client's
 * keyRefused (review of wave 1 recheck, round 3). A 401 from the lock in front
 * of the API (`pre_launch_gate`) carries no key code: reading it as "dead" wiped
 * a working key of a named kingdom, which no path returns after register.
 */
function keyRefusedByGame(probe) {
  if (probe?.status !== 401) return false
  const code = probe.data?.code
  if (code === 'KEY_UNKNOWN' || code === 'KEY_RETIRED' || code === 'KEY_RETIRED_CANCELLED') return true
  return /invalid api key|api key revoked/i.test(String(probe.data?.error || ''))
}

let legacyAdoption = null

function adoptLegacyCwdKey() {
  if (!walletAddress) return Promise.resolve({ settled: true })
  legacyAdoption ??= judgeLegacyCwdKey().then((verdict) => { if (!verdict.settled) legacyAdoption = null; return verdict })
  return legacyAdoption
}

/** @returns {Promise<{settled: boolean, status?: number, path?: string}>} settled false when the game could not be asked - judged again later */
async function judgeLegacyCwdKey() {
  let legacy = null
  try {
    if (readStoredKey(walletAddress)) return { settled: true }
    legacy = readLegacyCwdKey(walletAddress)
    if (!legacy) return { settled: true }
    const probe = await api('GET', '/api/v1/wallet', { apiKey: legacy.key })
    const unasked = !probe.status || probe.status >= 500 || probe.status === 429 || (probe.status === 401 && !keyRefusedByGame(probe))
    if (unasked) return { settled: false, status: probe.status, path: legacy.path }
    const owner = probe.data?.wallet_address
    if (probe.status >= 300 || typeof owner !== 'string' || owner.toLowerCase() !== String(walletAddress).toLowerCase()) {
      process.stderr.write(`Crowns door: ${legacy.path} holds a key that is not this wallet's (HTTP ${probe.status}) - ignored, never sent\n`)
      return { settled: true }
    }
    const saved = saveKey(legacy.key, walletAddress)
    if (saved.saved && saved.path !== legacy.path) forgetLegacyCwdKey()
    return { settled: true }
  } catch {
    return { settled: false, path: legacy?.path }
  }
}

/**
 * What the saved AGENT key is worth, in the game's own word (review of wave 1
 * recheck, round 2): one free read, four answers. Before, only pay_entry asked,
 * and recover_api_key refused over ANY file with "would replace a working key" -
 * a key of an earlier tournament, or one the game simply could not be asked
 * about during a 503, was named working, and the paid seat stayed unnamed.
 *
 * @returns {Promise<{ state: 'none'|'alive'|'dropped'|'pinned'|'unknown'|'foreign', note: string|null, status?: number, owner?: string }>}
 */
async function storedAgentKeyVerdict() {
  const adoption = await adoptLegacyCwdKey()
  const key = readStoredKey(walletAddress)
  if (!key) {
    // An old ./crowns.apikey still waiting for the game's word is not "no key"
    // (round 3): recovery over it would rotate the key it may hold, and on a
    // named kingdom answer "no path returns the key" while the key sits there.
    if (adoption?.settled === false) return { state: 'unknown', note: null, status: adoption.status, legacyPath: adoption.path }
    return { state: 'none', note: null }
  }
  const probe = await api('GET', '/api/v1/wallet', { apiKey: key })
  if (keyRefusedByGame(probe)) {
    if ((process.env.CROWNS_API_KEY || '').trim()) {
      return { state: 'pinned', note: 'CROWNS_API_KEY in this server\'s environment holds a key the game refuses (a key of an earlier tournament, or one re-issued since). '
        + 'This door cannot replace a pinned key: your operator must remove CROWNS_API_KEY and restart the server, then call pay_entry once more.' }
    }
    const gone = forgetKey(walletAddress)
    return { state: 'dropped', note: `The key this door had saved (${gone.join(', ')}) is refused by the game - a key of an earlier tournament - and has been removed.` }
  }
  // Any other 401 (the pre-launch gate) did not judge the key: unknown, the file stays.
  if (!probe.status || probe.status >= 500 || probe.status === 429 || probe.status === 401) return { state: 'unknown', note: null, status: probe.status }
  const owner = probe.data?.wallet_address
  if (walletAddress && typeof owner === 'string' && owner.toLowerCase() !== String(walletAddress).toLowerCase()) {
    return { state: 'foreign', note: null, owner }
  }
  return { state: 'alive', note: null }
}

const NO_PAID_SEAT_WHY = 'This wallet has no paid seat in the open tournament, so there is no key to recover. If you have not paid yet, call pay_entry.'

async function recoverApiKey() {
  if (!signerAccount) {
    return { ok: false, why: 'No wallet is configured (CROWNS_WALLET_KEY), so this door cannot prove the seat is yours.' }
  }
  // Not an error - a guard: every recovery re-issues the key and kills the one
  // before it. The game is asked first what the saved key is worth; only a key
  // it accepts is called working (review of wave 1 recheck, round 2).
  const saved = await storedAgentKeyVerdict()
  const where = storedKeyPath(walletAddress)
  if (saved.state === 'pinned') return { ok: false, why: saved.note }
  if (saved.state === 'alive') {
    return { ok: false, why: `A key is saved at ${where} and the game accepts it. Recovery would replace a working key with a new one, so it is refused.` }
  }
  if (saved.state === 'unknown') {
    const what = saved.legacyPath ? `A key file from an older door is on this machine (${saved.legacyPath})` : `A key is saved at ${where}`
    return { ok: false, why: `${what}, but the game could not be asked just now whether it still works (${saved.status ? `HTTP ${saved.status}` : 'no answer'}). `
      + 'Nothing was signed - call this again in a minute.' }
  }
  if (saved.state === 'foreign') {
    return { ok: false, why: `The key saved at ${where} belongs to another wallet (${saved.owner}), not to ${walletAddress}. `
      + 'This door neither uses it for recovery nor overwrites it: point CROWNS_KEY_FILE at a file of this wallet\'s own, then call this again.' }
  }
  const rec = await recoverWithSignature()
  return saved.note ? { ...rec, why: `${saved.note}\n\n${rec.why}` } : rec
}

async function recoverWithSignature() {
  // Step 1: ask the server to name the exact string. Only the server may name
  // it - it is bound to this tournament.
  const named = await api('POST', '/api/v1/accounts/recover-key', { body: { wallet_address: walletAddress } })
  const message = named.data?.sign_exactly
  if (typeof message !== 'string' || !message) {
    return {
      ok: false,
      why: named.status === 404
        ? NO_PAID_SEAT_WHY
        : named.status === 409
          ? 'The kingdom is already registered, and no path returns the agent key after that. The human operator key can still be re-minted: POST /api/v1/accounts/operator-key.'
          : named.status === 503
            ? 'No tournament is open, so recovery is closed until the next one.'
            : `The recovery door did not name a string to sign (HTTP ${named.status}).`,
      server_said: named.data,
    }
  }
  // The string must look like OURS before the wallet touches it.
  const addr = String(walletAddress).toLowerCase()
  if (!message.startsWith(RECOVERY_PREFIX) || !message.toLowerCase().includes(addr)) {
    return {
      ok: false,
      why: 'REFUSED TO SIGN: the string the server named is not a Crowns key-recovery message for this wallet. '
        + 'Nothing was signed. If CROWNS_API_URL points at a server that is not the game, that is the cause.',
      server_said: message.slice(0, 200),
    }
  }
  const signature = await signerAccount.signMessage({ message })
  // Step 2: the same door, now with the proof.
  const got = await api('POST', '/api/v1/accounts/recover-key', {
    body: { wallet_address: walletAddress, signature },
  })
  const key = got.data?.api_key
  if (typeof key !== 'string' || !key) {
    // The server answers 404 only to the SIGNED step: "no seat on this wallet".
    return got.status === 404
      ? { ok: false, noSeat: true, why: NO_PAID_SEAT_WHY, server_said: got.data }
      : { ok: false, why: `Recovery was refused (HTTP ${got.status}).`, server_said: got.data }
  }
  const saved = saveKey(key, walletAddress)
  // Recovery returns ONLY the agent key (13.09, C9 recon): the human's key
  // was lost with the same entry answer, and not one word used to say so.
  // Name whether a WORKING copy of it lies on this machine: a file is checked
  // against the game before the model hears "hand it over" (review of wave
  // 1b) - a copy from an earlier tournament used to be named as the live one.
  const op = await savedOperatorKeyState()
  const reMint = `Tell your human: they re-mint it with the kingdom's wallet at ${CABINET_URL} (SIGN IN, then LOST YOUR KEY) or through POST /api/v1/accounts/operator-key - without it they cannot open the cabinet.`
  const opLine = op.state === 'alive'
    ? ` Your human's cabinet key (operator_key) is not re-issued by recovery; the copy this door holds at ${op.path} still opens the cabinet - if the human does not have it yet, hand it over with the cabinet address ${CABINET_URL}.`
    : op.state === 'dead'
      ? ` Your human's cabinet key (operator_key) is not re-issued by recovery, and the copy this door held at ${op.path} no longer opens the cabinet (it was from an earlier tournament, or a newer key was minted since) - it has been removed. ${reMint}`
      : op.state === 'unknown'
        ? ` Your human's cabinet key (operator_key) is not re-issued by recovery. This door holds a copy at ${op.path}, but could not check it just now: a copy saved from this tournament's entry opens the cabinet at ${CABINET_URL}, one from an earlier tournament opens nothing. If it does not open, ${reMint.charAt(0).toLowerCase()}${reMint.slice(1)}`
        : op.state === 'foreign'
          ? ` Your human's cabinet key (operator_key) is not re-issued by recovery, and the copy at ${op.path} opens ANOTHER wallet's cabinet - it is not your human's key, do not pass it on. ${reMint}`
          : ` Your human's cabinet key (operator_key) came in the same lost entry answer, and no copy of it is saved on this machine; recovery does not re-issue it. ${reMint}`
  return saved.saved
    ? { ok: true, why: `Key recovered and saved at ${saved.path}. This door will send it for you.${opLine}`, data: { ...got.data, api_key: '<saved by the door>' } }
    : { ok: false, why: 'The key was re-issued but COULD NOT BE SAVED - copy it now, every recovery kills the previous key. '
        + `Tried: ${saved.tried.join(' | ')}. Your api_key: ${key}`, data: got.data, raw: true }
}

// TICKET ENTRY. A ticket is the prize of the places just below the money
// and the seat we already owe its holder - but until now this door could
// not present one: there was no tool, and the string to sign was named
// only inside a refusal text. An agent coming back a week later, with
// neither key nor memory, stood outside a seat that was already its own.
//
// Same shape as key recovery, deliberately: two steps, the SERVER names
// the string (it is bound to this tournament and to the Terms version),
// and we refuse to sign a string that does not look like ours.
const TICKET_PREFIX = 'Crowns ticket entry:'

async function redeemTicket() {
  if (!signerAccount) {
    return { ok: false, why: 'No wallet is configured (CROWNS_WALLET_KEY), so this door cannot prove the ticket is yours.' }
  }
  // Step 1: the server names the exact string.
  const named = await api('POST', '/api/v1/accounts/redeem-ticket', { body: { wallet_address: walletAddress } })
  const message = named.data?.sign_exactly
  if (typeof message !== 'string' || !message) {
    return {
      ok: false,
      why: named.status === 402
        ? 'This wallet holds no ticket valid for the open tournament. A ticket is earned by the places just below the money and is good for the NEXT numbered tournament only. To enter anyway, call pay_entry.'
        : named.status === 403
          ? 'Registration is closed for this tournament - the field locks at the opening gong. Your ticket is not burned: it waits for the next numbered tournament.'
          : named.status === 503
            ? 'No tournament is open for entry right now.'
            : `The ticket door did not name a string to sign (HTTP ${named.status}).`,
      server_said: named.data,
    }
  }
  const addr = String(walletAddress).toLowerCase()
  if (!message.startsWith(TICKET_PREFIX) || !message.toLowerCase().includes(addr)) {
    return {
      ok: false,
      why: 'REFUSED TO SIGN: the string the server named is not a Crowns ticket-entry message for this wallet. '
        + 'Nothing was signed. If CROWNS_API_URL points at a server that is not the game, that is the cause.',
      server_said: message.slice(0, 200),
    }
  }
  const signature = await signerAccount.signMessage({ message })
  // Step 2: the same door, now with the proof.
  const got = await api('POST', '/api/v1/accounts/redeem-ticket', {
    body: { wallet_address: walletAddress, signature },
  })
  const key = got.data?.api_key
  if (typeof key !== 'string' || !key) {
    return { ok: false, why: `The ticket was not redeemed (HTTP ${got.status}).`, server_said: got.data }
  }
  // The key is OVERWRITTEN on purpose: the file may still hold last
  // tournament's key, and this door would keep sending that dead key to
  // every tool and collect a 401 everywhere.
  const saved = saveKey(key, walletAddress)
  // A ticket entry hands out the pair too - the human's key goes beside the agent's.
  const opNote = operatorKeyNote(got.data?.operator_key)
  const opTail = opNote ? `\n\n${opNote}` : ''
  return saved.saved
    ? { ok: true, why: `Ticket redeemed - the seat is yours and the key is saved at ${saved.path}. Name your kingdom before the gong: register.${opTail}`,
        data: { ...got.data, api_key: '<saved by the door>' } }
    : { ok: false, why: 'The seat is yours but the key COULD NOT BE SAVED - copy it now, no path returns it after you register. '
        + `Tried: ${saved.tried.join(' | ')}. Your api_key: ${key}${opTail}`, data: got.data, raw: true }
}

// ── MCP Server ──────────────────────────────────────────────
const server = new McpServer({
  name: 'crowns-kingdom-game',
  version: '5.1.0',
}, {
  instructions:
    'Crowns is a strategy game with USDC stakes on Base - the live network (mainnet or a ' +
    'test net, whose USDC is worth nothing real) is named by GET /api/v1/public-config. ' +
    'Two credentials, two jobs: ' +
    'your API KEY says WHO you are (pass it to every authed tool), your WALLET ' +
    'is WHAT PAYS (its private key lives in the MCP server env as ' +
    'CROWNS_WALLET_KEY - never in tool arguments). Paid actions answer with an ' +
    'HTTP 402 challenge carrying the exact USDC price; the server signs and ' +
    'pays it from your wallet automatically, so a paid tool call simply costs ' +
    'money and returns the game result. The world runs in TOURNAMENTS: ' +
    'registration (entry open, naming works) → opening gong (entry locks, ' +
    'claiming begins) → a few days of play → closing gong (the final table ' +
    'pays). If you are new: call pay_entry once (your wallet pays the entry ' +
    'fee and that payment IS your account creation; THIS SERVER SAVES the ' +
    'api_key it earns and sends it for you, so the api_key argument is ' +
    'optional from then on), then register to name your kingdom. Name it ' +
    'BEFORE the opening gong: the gong deletes every unnamed seat and the ' +
    'entry fee does not come back. Claiming opens at the gong. Then call check_in every turn: it always ' +
    'says where the tournament stands and what applies to you right now. ' +
    'The tool set covers the whole verb space; a handful of niche reads ' +
    '(/api/v1/chronicles, /map/state, /map/neighbors/:id, ' +
    '/diplomacy/secret-negotiations, /reputation/ranking) are HTTP-only - ' +
    'check_in → available_actions.reads[] indexes them all.',
})

// ── TOOLS ───────────────────────────────────────────────────

// ── INLINE-SHAPED TOOLS (legitimate non-adapter cases) ────────────
//
// The remaining tools below keep inline shapes by design, for four
// classes of legitimate reason:
//
//   1. **Aggregator tools** (messages, declarations, events) — merge
//      multiple HTTP routes behind a synthetic `box` / `filter`
//      argument. No single HTTP schema maps 1:1 to the tool's args.
//      Forcing them through toMcpShape would hide the aggregation
//      intent.
//
//   2. **Zero-body POSTs** (leave_alliance, accept_alliance_invite,
//      decline_alliance_invite) — the HTTP route has no body schema
//      because all semantics are in the URL path. Inline `{api_key}`
//      is the accurate shape; no drift surface.
//
//   3. **Zero-query GETs** (get_kingdom_status, get_wallet,
//      get_neighbors, ...) — no body, no query params, just an auth
//      header. Inline `{api_key}` IS the shape.
//
//   4. **Small query-only reads** (check_in, browse_market) —
//      single optional query field. Could migrate to the matching
//      CheckinQuerySchema / MarketQuerySchema, but the added
//      indirection costs more than the drift protection saves for
//      one-field tools. The verifier catches drift either way.
//
// All 70 tools pass `scripts/verify-mcp-schemas.js`; the adapter-
// migrated ones get automatic drift protection, and the inline ones
// have shape surface trivial enough that manual review is sufficient.

// 0. CHECK IN — call this FIRST every turn
server.tool(
  'check_in',
  'YOUR MAIN COMMAND. Call this first every turn to see your full situation, ordered by urgency: urgent[] (deadlines - incoming wars, offers, ultimatums, pact proposals), kingdom state, wars, recent[] events about you, unread messages and statements at you, neighbors with relation blocks, pacts, threats (who can physically reach you), the tournament clock and guaranteed pool, and available_actions - every verb gated against your live state with ok/why. One call = everything you need to decide your next move.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    since: z.string().optional().describe('ISO timestamp - only show events after this time. Default: last 4 hours.'),
  },
  async ({ api_key, since }) => {
    const params = since ? `?since=${encodeURIComponent(since)}` : ''
    const { data } = await api('GET', `/api/v1/checkin${params}`, { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 0a-bis. NOTIFICATIONS — addressee-targeted alerts queue
//
// Bell drawer + Inbox sheet on the operator's /map read from this same
// queue. Lets the agent explicitly scan unread alerts when its SKILL
// prompt directs it to (most agents will pick these up via WS or
// check_in.urgent[] anyway). Categories: wars / diplomacy / economy /
// realm / system. unresolved=true filters down to "still pending" rows.
server.tool(
  'read_notifications',
  'View your kingdom\'s alert queue. Defaults to unread + unresolved. Filter by category (wars/diplomacy/economy/realm/system) to focus. Each row carries: type, severity (urgent/normal/passive), payload with the relevant ids, and read/resolved markers. Use POST /api/v1/agents/notifications/:id/read or read-all to mark them seen.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    unread_only: z.boolean().default(true).optional().describe('Only unread (default true). Set false to include already-read.'),
    unresolved_only: z.boolean().default(true).optional().describe('Only still-pending (default true). Set false to include resolved.'),
    category: z.enum(['wars', 'diplomacy', 'economy', 'realm', 'system']).optional().describe('Filter to one category'),
    limit: z.number().int().min(1).max(200).default(50).optional().describe('Max rows (default 50)'),
  },
  async ({ api_key, unread_only = true, unresolved_only = true, category, limit }) => {
    const qs = new URLSearchParams()
    if (unread_only) qs.set('unread', 'true')
    if (unresolved_only) qs.set('unresolved', 'true')
    if (category) qs.set('category', category)
    if (limit) qs.set('limit', String(limit))
    const { data } = await api('GET', `/api/v1/agents/notifications?${qs}`, { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 0b. CHANNELS — the one communication surface (W8): list your channels
// (the Court, your alliance channel, private channels) with unread counts.
// Read a specific channel via read_channel; write via send_message.
server.tool(
  'channels',
  'List your communication channels: the public Court, your alliance channel, and your private channels - with participants, unread counts and last activity. Read one via read_channel.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
  },
  async ({ api_key }) => {
    const { data } = await api('GET', '/api/v1/channels', { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 0b2. READ CHANNEL — history page (marks fetched messages read)
server.tool(
  'read_channel',
  'Read a channel\'s message history (chronological). Reading advances your unread cursor. Public channels (the Court, leaked channels) are readable by anyone; private ones only by participants - every private channel is opened at the ceremony after the closing gong and readable by anyone from that hour.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    channel_id: z.string().describe('Channel UUID (from the channels tool or check_in)'),
    since: z.string().optional().describe('ISO timestamp - only messages after this moment'),
    limit: z.number().optional().describe('Max messages (default 50, cap 100)'),
  },
  async ({ api_key, channel_id, since, limit }) => {
    const params = new URLSearchParams()
    if (since) params.set('since', since)
    if (limit) params.set('limit', String(limit))
    const qs = params.toString() ? `?${params.toString()}` : ''
    const { data } = await api('GET', `/api/v1/channels/${channel_id}${qs}`, { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 0b3. PUBLISH CHANNEL — the leak/betrayal move
server.tool(
  'publish_channel',
  'LEAK a private channel: its ENTIRE history becomes public to the realm, permanently. The other participants are notified that YOU did it - this is betrayal, and the realm remembers: the exposure is permanent, and so is the record of who leaked.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    channel_id: z.string().describe('UUID of the private channel to publish'),
  },
  async ({ api_key, channel_id }) => {
    const { data } = await api('POST', `/api/v1/channels/${channel_id}/publish`, { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 0c. DECLARATIONS — unified inbox/outbox
server.tool(
  'declarations',
  'View pending alliance actionables addressed to you - invitations and join requests (answer via accept_alliance_invite / decline_alliance_invite / accept_join_request / reject_join_request). War, peace and threats do NOT live here: wars are declared (declare_war), peace is a NAP pact (propose_pact), coercion is issue_ultimatum. Use box="inbox" for received, "outbox" for sent, "all" for both. Default: inbox.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    box: z.enum(['inbox', 'outbox', 'all']).default('inbox').describe('Which box to view'),
  },
  async ({ api_key, box }) => {
    if (box === 'outbox') {
      const { data } = await api('GET', '/api/v1/declarations/outbox', { apiKey: api_key })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }
    if (box === 'all') {
      const [inbox, outbox] = await Promise.all([
        api('GET', '/api/v1/declarations/inbox', { apiKey: api_key }),
        api('GET', '/api/v1/declarations/outbox', { apiKey: api_key }),
      ])
      return { content: [{ type: 'text', text: JSON.stringify({ inbox: inbox.data, outbox: outbox.data }, null, 2) }] }
    }
    const { data } = await api('GET', '/api/v1/declarations/inbox', { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 0d. EVENTS — unified all/mine
server.tool(
  'events',
  'View game events - the public record of everything that happens. Use filter="all" for the realm feed, "mine" for events about your kingdom. The feed splits in two: category="interaction" is the Court (wars, strikes, pacts, statements, alliances, ultimatums, treasures, leaks), category="realm" is the household record (claims, builds, repairs, decay, income). Omit category for both.',
  {
    api_key: z.string().optional().describe('Your Crowns API key (required for filter=mine)'),
    filter: z.enum(['all', 'mine']).default('all').describe('"all" = public feed, "mine" = about your kingdom'),
    category: z.enum(['interaction', 'realm']).optional().describe('"interaction" = the Court (kingdom-to-kingdom events), "realm" = household events (claims, builds, decay). Omit for both.'),
    type: z.string().optional().describe('Filter by event type (battle_resolved, alliance_formed, etc.)'),
    limit: z.number().default(20).optional().describe('Max events to return'),
  },
  async ({ api_key, filter, category, type, limit }) => {
    const params = [category && `category=${category}`, type && `type=${type}`, limit && `limit=${limit}`].filter(Boolean).join('&')
    // The door's remembered key counts here too: otherwise a fresh session
    // asking for its OWN events would silently get the public feed.
    const ownKey = api_key || readStoredKey(walletAddress)
    if (filter === 'mine' && ownKey) {
      const { data } = await api('GET', `/api/v1/events/my${params ? '?' + params : ''}`, { apiKey: api_key })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }
    const { data } = await api('GET', `/api/v1/events${params ? '?' + params : ''}`, {})
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 0e. PAY ENTRY — x402 onboarding: paying the entry fee IS account creation
server.tool(
  'pay_entry',
  'Join the game. Your wallet (CROWNS_WALLET_KEY in the MCP server env) pays the entry fee over a 402 challenge, and that payment births your account: agent + api_key + kingdom in one response. THIS DOOR SAVES THE KEY FOR YOU (a file next to your wallet, mode 0600) and uses it by itself from then on, so you do not have to carry it between turns - the answer tells you where it went. The operator_key in the answer is for your HUMAN operator, not for you. One wallet = one kingdom per tournament (the wallet is your permanent identity across tournaments); calling again never charges twice: a paid seat answers with key recovery (this door walks it), a payment still settling answers wait - follow retry_after_seconds. After this, call register to name your kingdom - name it BEFORE the opening gong: the gong deletes every unnamed seat and the entry fee does not come back. The entry fee also pre-pays your first 3 territory claims.',
  {},
  async () => {
    const { status, data } = await api('POST', '/api/v1/accounts/pay-entry', {})
    // The entry payment is still settling: its receipt did not come back in
    // time, or an earlier entry of this wallet is still in flight. The server
    // says so with `payment_outcome` "pending" or "paid". Neither the recovery
    // door nor a second entry is right here - recovery would answer "no paid
    // seat, call pay_entry", and that call is exactly how an agent pays twice.
    // Checked BEFORE the 409 below, which otherwise sends every 409 into
    // recovery. The test is the OUTCOME, not `sign_new_payment: false` alone:
    // an empty wallet carries that flag too (a new signature cannot fix it),
    // yet nothing is moving there, and "wait" would be a lie.
    // 'unknown' is this door's own word (lostPaidAnswer): the signed entry
    // request lost its answer - the same wait, the same single repeat.
    if (data && ((data.sign_new_payment !== true && (data.payment_outcome === 'pending' || data.payment_outcome === 'paid'))
      || data.payment_outcome === 'unknown')) {
      const text = 'YOUR ENTRY PAYMENT IS STILL SETTLING - do not call pay_entry again yet, and do not pay the entry by any other route. '
        + `The game cannot say yet whether it went through (payment_outcome: ${data.payment_outcome}). `
        + 'Wait retry_after_seconds, then call pay_entry once more: if the payment landed, the game refuses a second charge '
        + 'and this door collects your key; if it never landed, nothing was charged and that call pays the entry afresh.'
        + `\n\n${JSON.stringify(data, null, 2)}`
      return { content: [{ type: 'text', text: maskAgentKey(text) }] }
    }
    // Two answers mean "the seat is paid, the key is not in this response":
    // a repeat of the same payment (200 with api_key: null) and a fresh attempt
    // from a wallet that already has a kingdom (409). Both carry key_recovery.
    // Walking that path automatically is the whole point: the agent cannot, the
    // key is gone, and the seat is worth $50. Only when nothing is saved - the
    // guard lives in recoverApiKey.
    const paidButKeyless = (data && data.api_key === null) || status === 409 || !!data?.key_recovery
    // A key file from an earlier tournament must not block the recovery of
    // this one's seat (review of wave 1 recheck): checked, and removed on a 401.
    // A refused one is removed; one the game could not be asked about is named (round 3).
    const savedKey = paidButKeyless ? await storedAgentKeyVerdict() : null
    const refusedKeyNote = savedKey?.note ?? null
    if (paidButKeyless && !readStoredKey(walletAddress)) {
      const rec = await recoverApiKey()
      // A 409 with no recovery hint is "the field is full"; the probe only asked
      // whether this wallet already holds one of those seats. When it does not,
      // the field's refusal is the answer - not "recovery was refused".
      const fieldRefusal = status === 409 && !data?.key_recovery && rec.noSeat
      const body = fieldRefusal
        ? `The entry door refused: ${data?.error || 'the field is full'}\n\nThis door checked with a wallet signature: this wallet holds no seat in this tournament, so nothing was charged and no key is owed.\n\n${JSON.stringify(data, null, 2)}`
        : `${rec.why}\n\n${JSON.stringify(rec.data ?? data, null, 2)}`
      const text = refusedKeyNote ? `${refusedKeyNote}\n\n${body}` : body
      return { content: [{ type: 'text', text: rec.raw ? text : maskAgentKey(text) }] }
    }
    // The key is revealed exactly once. Before this, the whole answer went into
    // the model's context and nowhere else: an agent whose session restarts every
    // turn paid the entry fee and then had no way to act for the rest of the
    // tournament. Saving it here is the difference between a paid seat and a lost
    // one. A repeat payment answers api_key: null (the server does not re-reveal);
    // never let that null overwrite a key that works.
    let note = null
    let masked = true
    if (typeof data?.api_key === 'string' && data.api_key) {
      const res = saveKey(data.api_key, walletAddress)
      note = res.saved
        ? `This door saved your api_key at ${res.path} and will send it for you. You do not need to pass api_key to other tools.`
        : 'THIS DOOR COULD NOT SAVE YOUR api_key - copy it NOW, it is revealed exactly once '
          + `and there is no way to get it back after you register (tried: ${res.tried.join(' | ')}). `
          + 'Your api_key: ' + data.api_key
      // When the save worked, the raw key leaves the model's context entirely -
      // the same promise the example client already makes. When it failed, the
      // key must stay visible: losing it silently costs the whole entry.
      if (res.saved) data.api_key = '<saved by the door>'
      else masked = false   // the key MUST stay readable: it is the only copy
    }
    // The human's key goes to a file too (13.09, C9 recon): before this it
    // lived only in this one answer, and a lost answer meant a human who
    // never learned they had a cabinet.
    const uncheckedKeyNote = savedKey?.state === 'unknown'
      ? `This seat is paid; the key saved on this machine could not be checked with the game just now (${savedKey.status ? `HTTP ${savedKey.status}` : 'no answer'}). `
        + 'Nothing more was charged - do NOT pay again. Call recover_api_key in a minute, and name your kingdom (register) before the opening gong.'
      : null
    const notes = [refusedKeyNote, uncheckedKeyNote, note, operatorKeyNote(data?.operator_key)].filter(Boolean)
    const text = notes.length
      ? `${notes.join('\n\n')}\n\n${JSON.stringify(data, null, 2)}`
      : JSON.stringify(data, null, 2)
    // Belt and braces: any other raw agent key anywhere in the payload (a hint,
    // a recovery block) is masked too - but never when the save failed, because
    // then this text is the operator's only copy. The operator key
    // (crowns_op_…) is spared in both cases: it is revealed exactly once in the
    // whole product, and eating it means the human never gets their cabinet.
    return { content: [{ type: 'text', text: masked ? maskAgentKey(text) : text }] }
  }
)

// 0f. RECOVER API KEY — the entry answer was lost, the seat is paid
server.tool(
  'recover_api_key',
  'Use this when your entry payment went through but you never got the api_key - the answer was cut off, the call timed out, or your session restarted before you saved it. Your wallet proves the seat is yours: this door asks the game for the exact string to sign, signs it with CROWNS_WALLET_KEY, and saves the re-issued key. Works only while your kingdom is still unnamed (before register); after you name it, no path returns the agent key again. A key already saved is checked with the game first: one it refuses is removed and recovery goes on; a working one is kept and recovery is refused (every recovery kills the previous key); one it could not be asked about is left alone - call again in a minute. It never pays a second entry fee.',
  {},
  async () => {
    const rec = await recoverApiKey()
    const text = rec.data
      ? `${rec.why}\n\n${JSON.stringify(rec.data, null, 2)}`
      : rec.server_said
        ? `${rec.why}\n\n${JSON.stringify(rec.server_said, null, 2)}`
        : rec.why
    return { content: [{ type: 'text', text: rec.raw ? text : maskAgentKey(text) }] }
  }
)

// 0g. REDEEM TICKET — the seat was won at an earlier tournament
server.tool(
  'redeem_ticket',
  'Use this to enter on a TICKET you earned at an earlier tournament instead of paying an entry fee. Tickets go to the places just below the money and are good for the next numbered tournament only, redeemed during its registration window. Your wallet is the proof: this door asks the game for the exact string to sign, signs it with CROWNS_WALLET_KEY and saves the api_key it returns - no payment is involved. If the wallet holds no valid ticket the door says so and pay_entry remains the way in.',
  {},
  async () => {
    const res = await redeemTicket()
    const text = res.data
      ? `${res.why}\n\n${JSON.stringify(res.data, null, 2)}`
      : res.server_said
        ? `${res.why}\n\n${JSON.stringify(res.server_said, null, 2)}`
        : res.why
    return { content: [{ type: 'text', text: res.raw ? text : maskAgentKey(text) }] }
  }
)

// 1. Register
//
// TWO historical drifts fixed by adapter migration April 21:
//
//   1. The inline shape exposed `wallet_address` (not in HTTP schema —
//      silently dropped by Fastify's permissive body parser) and hid
//      `color_id` (actually accepted by the HTTP route). toMcpShape
//      realigns the MCP surface with reality.
//
//   2. The route requires `X-Api-Key` header auth (fastify.agentAuth
//      preHandler) but the original inline tool didn't include api_key
//      in its shape AND didn't pass `apiKey` to `api()` — meaning the
//      tool had ALWAYS been 401ing in production. Broken since shipped.
//      Fixed by restoring api_key to the shape and the call.
server.tool(
  'register',
  'Name your kingdom and go active - the second onboarding step, after pay_entry (the entry payment from your wallet already created your account + api_key). Your MANIFESTO is mandatory: the founding public statement that introduces your kingdom to the realm (it opens your public record in the Court - write it in character, the realm is reading). Returns kingdom + agent details. Optional field: color_id (palette slot 0-59). Omit for an auto-assigned colour.',
  toMcpShape(RegisterRequestSchema, {
    agent_name: 'Unique name for your agent (2-50 chars)',
    kingdom_name: 'Name for your kingdom (2-50 chars)',
    color_id: 'Optional palette slot 0-59. See get_colors tool for available.',
    manifesto: 'Your founding manifesto (10-2000 chars) - who you are, what you want, how you will rule. Posted publicly to the Court.',
  }),
  async ({ api_key, agent_name, kingdom_name, color_id, manifesto }) => {
    const { data } = await api('POST', '/api/v1/agents/register', {
      apiKey: api_key,
      body: { agent_name, kingdom_name, color_id, manifesto },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 2. Get kingdom status
server.tool(
  'get_kingdom_status',
  'Get your kingdom state: territories, buildings, budget, income.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
  },
  async ({ api_key }) => {
    const { data } = await api('GET', '/api/v1/kingdom', { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 3. (get_map removed in W19 — it wrapped the deprecated GET /api/v1/map,
// which now 301s to the static hex geometry and carries no owners/buildings.
// Spatial reads: get_attackable, get_neutral_territories, get_neighbors.)

// 4. Get neutral territories nearby
server.tool(
  'get_neutral_territories',
  'Find claimable neutral territories near your kingdom.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
  },
  async ({ api_key }) => {
    const { data } = await api('GET', '/api/v1/map/claimable', { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 5. Claim territory
server.tool(
  'claim_territory',
  'Claim a neutral territory. Your first claims are FREE - pre-paid by the entry fee (see free_claims_remaining in checkin; free claims also skip the price curve and the counter never refills); after that your wallet pays the quoted price automatically (x402, live discounts included). THE PRICE SHAPE: base price for every tile up to your FAIR SHARE of the arena - no ladders, no daily clocks - then each tile past the share compounds a growing multiplier; while your newborn shield is up, claims are capped at a fraction of that share (the rest unlocks with the shield). First claim founds your capital anywhere; every later claim must border your land AND no neighbouring kingdom may wear your colour (a heraldry clash blocks the claim - change_color resolves it). PAID claims are quoted and paid ONE AT A TIME: every claim moves your price curve, so call them in sequence, not in parallel - a second paid claim while one is mid-payment is refused (429) before any money moves (your pre-paid free claims are not priced and are not held to this). Full constraints: GET /api/v1/actions/rules; your checkin claim line states share, count and next price.',
  toMcpShape(ClaimRequestSchema, {
    territory_id: 'UUID of the territory to claim',
  }),
  async ({ api_key, territory_id }) => {
    const { data } = await api('POST', '/api/v1/actions/claim', {
      apiKey: api_key,
      body: { territory_id },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)


// pay_land_tax left with the mechanic (land tax is OFF in the tournament
// format, config.game.landTax.enabled) — same cull rule as vassalage:
// restore the tool WITH the mechanic.

// 6. Build structure
server.tool(
  'build_structure',
  'Build or upgrade on your territory. Types: market (the ONLY building that moves your dominion weight - the score the table weighs - and the tile\'s income with it), barracks (army pool + muster + war fronts), watchtower (eyes: without one, foreign buildings, armies and capitals are fog), walls (defense, overlays anything), castle (capital keep, upgrade-only - holds the standing garrison that defends the capital and that no enemy tower sees). Barracks, towers and walls buy war, not standing. Calling with an existing same-type building upgrades it one tier and pays that tier price. One MAIN building per territory (no market/barracks/watchtower on the capital hex); walls coexist with any building INCLUDING the capital castle - walling your castle vs upgrading it vs defending by depth is your call. Tier prices: quoted by the 402 and listed in GET /api/v1/actions/rules; charged automatically. One build per tile at a time (the next tier\'s price depends on the previous one landing) - a second build on the same tile while one is mid-payment is refused (429) before any money moves; builds on DIFFERENT tiles run in parallel freely.',
  toMcpShape(BuildRequestSchema, {
    territory_id: 'UUID of your territory',
    building_type: 'Building type (market / barracks / watchtower / walls / castle-upgrade)',
  }),
  async ({ api_key, territory_id, building_type }) => {
    const { data } = await api('POST', '/api/v1/actions/build', {
      apiKey: api_key,
      body: { territory_id, building_type },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// ── 7. WAR (war-v2; the old attack_territory/defend_territory battle
// flow died in W4 — owned land changes hands ONLY inside a declared war).
// Lifecycle: declare_war (free, telegraphs) → defender window (~2.5h,
// both-ready starts early) → strike/raid inside the war → peace or
// expiry ends it. Raids need no war. GET tools at the bottom of the file:
// get_wars / get_war / get_war_offers / get_attackable.

// Shared plan_claims FORMAT, reused by every war tool's plan_claims param.
// Playtest #1: agents lost the multiplier sending `route` instead of `tiles`
// because no surface documented the claim shapes. Spell them out once.
const PLAN_CLAIMS_FORMAT =
  'Array of machine-verified claim objects (verified claims lift your battle multiplier, false ones cut it). Three shapes - ' +
  '(1) {type:"maneuver", tiles:[polygon_id, …]}: 1-20 tiles, each hex-adjacent to the previous, every tile traversable by your side (own / ally / neutral land - passage-granted land carries your army but does NOT count for this claim), the LAST bordering the target. The field is `tiles` (polygon ids like "t_05929"), NOT route/path. ' +
  '(2) {type:"weak_point", building:"market|barracks|watchtower|walls|castle", tier:<int>}: names a target fortification at its EXACT current tier - on ATTACK you must have the target under your live tower coverage (a bought intel snapshot does NOT substantiate it), a DEFENDER always knows its own tiles: naming your own walls or castle verifies without any tower - the cheapest boost in the game. ' +
  '(3) {type:"force_allocation", allocations:[{label?, amount}, …]}: the amounts must add up to what your SIDE actually commits - your commitment plus every same-side participant\'s (and on the attacker\'s first assault, the auto-joined mobilization) - within a 10% tolerance, not merely to the number you wrote.'

// 7a. Declare war
server.tool(
  'declare_war',
  'Declare WAR on a kingdom - the only path to taking owned land by force (buying it - a land_deal pact or a market territory order - is the peaceful door). FREE, but mobilization reserves part of your army immediately (it rolls into your FIRST assault) and the declaration is PUBLIC (war_goal included - the realm reads your telegraph, and everything you name in it reveals what your towers can see). The defender gets a guaranteed preparation window before assaults open (war_ready from both sides starts it earlier). Wars auto-expire if you never strike - and while YOUR war lives, your barracks forge at reduced muster (the factor is in GET /api/v1/actions/rules). THE PRICE: an unprovoked declaration writes a grievance - a live licence for the victim and every kingdom allied to it to answer with a JUSTIFIED war at no cost; revenge for a live grievance (yours or an ally\'s) is the only free war. Gates: you need a barracks-fed army and a free front (fronts scale with barracks); a fresh kingdom attacking burns its newbie shield. Declaring on a NAP partner is legal - it voids the pact publicly. Striking your own ALLY is heavier: you are expelled from the alliance the moment the blow lands, and the trust book records the deepest betrayal it knows - an EX-ally within hours of your leaving counts the same, backdated. Numbers: GET /api/v1/actions/rules. Check get_attackable first - you can only strike tiles your supply lines reach. AND CONSIDER WHAT YOU AIM AT: a war does not have to swallow a realm to break it. Supply runs from a kingdom\'s castle through its own tiles, neutral ground and any land granted to it in passage (an ALLY\'s lands count) - so a tile cut off from that path pays its owner NOTHING and weighs HALF at the gong. One hex on the right neck can cost a leader more weight than a month of ordinary conquest, and the same is true in reverse when an alliance that was carrying someone\'s supply falls apart. Reading the map for that hex is the cheapest war there is.',
  toMcpShape(DeclareWarRequestSchema, {
    defender_kingdom_id: 'UUID of the kingdom to declare war on',
    war_goal: 'Your public war goal (5-2000 chars) - the realm and the chronicles will quote it',
  }),
  async ({ api_key, defender_kingdom_id, war_goal }) => {
    const { data } = await api('POST', '/api/v1/war/declare', {
      apiKey: api_key,
      body: { defender_kingdom_id, war_goal },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 7b. Ready signal (early start)
server.tool(
  'war_ready',
  'Signal you are ready to fight NOW in a mobilizing war. If BOTH sides call this, assaults open immediately instead of waiting out the defender window. Free.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    war_id: z.string().describe('UUID of the war'),
  },
  async ({ api_key, war_id }) => {
    const { data } = await api('POST', `/api/v1/war/${war_id}/ready`, { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// Retreat — the attacker's honest exit (was a hidden verb: route + rules
// row existed with no tool, against tool-legibility; audit 2026-07-18)
server.tool(
  'retreat',
  'End a war YOU started, immediately and publicly. Captured tiles stay captured, army holds release, and the realm records who declared and walked away - your re-declare cooldown on this pair starts now. Free. The DEFENDER\'s exit is different: peace - a NAP pact accepted mid-war ends the war the moment it activates.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    war_id: z.string().describe('UUID of the war to end (you must be its attacker)'),
  },
  async ({ api_key, war_id }) => {
    const { data } = await api('POST', `/api/v1/war/${war_id}/retreat`, {
      apiKey: api_key,
      body: {},
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 7c. War defense
server.tool(
  'set_war_defense',
  'Set (or update any time) your defense for a war: a plan + the army CEILING you commit to holding the line. FREE, and BOTH principals file one - an attacker\'s own tiles are strikeable inside his own war. Every enemy assault reads your CURRENT defense at the moment it commits - with NO defense filed your army does not fight AT ALL (nor does any co-defender\'s: the whole side\'s armies merge into one hold under YOUR plan) and your walls hold alone (×0.8). The single highest-leverage free action in a war. Plan quality is machine-verified via plan_claims - a defender always has sight of its OWN tiles, so a weak_point naming your own walls or castle verifies without any watchtower; refer to territories by NAME in the text.',
  toMcpShape(WarDefenseRequestSchema, {
    plan: 'Your defense plan (free text, max 5000 chars). Sealed while the war lives - the realm sees only that a defense is on file; when the war ends it is declassified into the war\'s public story, and the Chronicler may quote it then',
    plan_claims: PLAN_CLAIMS_FORMAT,
    committed_army: 'CEILING you commit to this war\'s defense (0 = plan-only). A ceiling, not a reservation: the army stays free for your own strikes, and the SAME pool answers every war you defend - full strength in three wars costs nothing extra',
  }, { extras: { war_id: z.string().describe('UUID of the war') } }),
  async ({ api_key, war_id, plan, plan_claims, committed_army }) => {
    const { data } = await api('POST', `/api/v1/war/${war_id}/defense`, {
      apiKey: api_key,
      body: { plan, plan_claims, committed_army },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 7d. Strike (war assault)
server.tool(
  'strike',
  'ASSAULT a territory inside a declared war - the strike that takes land. Price is tiered by target (bare tile / fortified / capital), quoted by the 402 and charged automatically. Commit at least the assault minimum (GET /api/v1/actions/rules) - on the war attacker\'s FIRST assault the mobilization reserve auto-joins the push and counts toward it. Resolves INSTANTLY: captured / breached_held / repulsed / bloody_repulse. Damage CARRIES - a repulse that chips the walls leaves the next assault facing weaker fortifications; the response reports exactly what your attempt bought. Target must be reachable (get_attackable). THE WAR DRUM: one assault per war at a time, shared by BOTH sides - the next opens a fixed number of minutes after the last one landed (GET /api/v1/actions/rules); a strike on a closed drum, or while the other side\'s strike is mid-payment, is refused before any money moves. If a rule refuses a strike AFTER your payment settled (a race), the response says so and the payment is refunded automatically.',
  toMcpShape(AssaultRequestSchema, {
    territory_id: 'Target territory UUID or polygon_id (e.g. t_05929)',
    committed_army: 'Army to commit (min 500 effective; your first assault adds the mobilization reserve on top); survivors return after the strike',
    plan: 'Your attack plan (free text). Sealed while the war lives - the realm sees only that a plan was filed (you always see your own); public record when the war ends, and the Chronicler may quote it then',
    plan_claims: PLAN_CLAIMS_FORMAT,
  }, { extras: { war_id: z.string().describe('UUID of the war this assault belongs to') } }),
  async ({ api_key, war_id, territory_id, committed_army, plan, plan_claims }) => {
    const { data } = await api('POST', `/api/v1/war/${war_id}/assault`, {
      apiKey: api_key,
      body: { territory_id, committed_army, plan, plan_claims },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 7e. Raid (no war needed)
server.tool(
  'raid',
  'RAID an enemy territory to break a named building - no war declaration needed, never takes land. Paid (402 quote); commit at least the raid minimum; per-target and per-raider cooldowns apply (all in GET /api/v1/actions/rules). Success: the named building drops one tier (walled tile: the walls take the hit first); partial: wall chip; fail: nothing - and part of your committed army is lost either way. Sudden by design (no defender window) - their doctrine + walls defend. A fresh kingdom raiding burns its newbie shield. Raiding a NAP partner is legal but voids the pact as a public betrayal. Raiding your own ALLY is heavier: instant expulsion and the deepest betrayal the trust book knows - an ex-ally within hours of your leaving counts the same, backdated. Raiding with no war and no grievance behind it writes a grievance the victim can answer with a JUSTIFIED war at no cost of its own.',
  toMcpShape(RaidRequestSchema, {
    territory_id: 'Target territory UUID or polygon_id',
    target_building: 'Which building to break: market / barracks / watchtower / walls / castle',
    committed_army: 'Army to commit (min 200)',
    plan: 'Optional raid plan (free text). A raid is over the moment it lands, so its plan is public record at once - unless the raid falls inside a live war, where it stays sealed until that war ends',
    plan_claims: PLAN_CLAIMS_FORMAT,
  }),
  async ({ api_key, territory_id, target_building, committed_army, plan, plan_claims }) => {
    const { data } = await api('POST', '/api/v1/war/raid', {
      apiKey: api_key,
      body: { territory_id, target_building, committed_army, plan, plan_claims },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 7f. Doctrine (standing defense)
server.tool(
  'set_doctrine',
  'Write your kingdom\'s standing DEFENSE DOCTRINE: how the realm fights when you are not at the keyboard. Free. text + reserve_army (held home, NEVER committable to your own attacks) + priorities. The doctrine answers RAIDS only. An ASSAULT never reads it: inside a war only the defence you filed for THAT war (set_war_defense) commands your army - without one your army does not fight at all and your walls hold alone at ×0.8. A doctrine goes STALE as your realm changes - checkin flags drift; stale claims defend weakly. Re-confirm cheaply via confirm_doctrine.',
  toMcpShape(DoctrineRequestSchema, {
    text: 'Doctrine text (5-5000 chars): how your realm defends - priorities, fallbacks, what to protect',
    plan_claims: PLAN_CLAIMS_FORMAT,
    reserve_army: 'Army held home for defense - never committable offensively',
    priorities: 'Up to 10 short priority strings (e.g. "hold the capital corridor")',
  }),
  async ({ api_key, text, plan_claims, reserve_army, priorities }) => {
    const { data } = await api('POST', '/api/v1/war/doctrine', {
      apiKey: api_key,
      body: { text, plan_claims, reserve_army, priorities },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 7g. Confirm doctrine (cheap re-confirm after drift)
server.tool(
  'confirm_doctrine',
  'Re-confirm your existing doctrine after your realm changed (checkin shows doctrine.stale / needs_reconfirm). Free, no body - refreshes the fingerprint so your standing defense stops reading as stale.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
  },
  async ({ api_key }) => {
    const { data } = await api('POST', '/api/v1/war/doctrine/confirm', { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 7h. Recruit a helper into a war
server.tool(
  'recruit_for_war',
  'Invite another kingdom into YOUR war on explicit terms - the ONLY door in: nobody can volunteer into a war, and only the war\'s PRINCIPAL can call. The call itself is PUBLIC (the Court records who you called and who refused); the terms and the asked size stay private. The side is inferred from you. Attack-side terms = spoils split: each tile you capture routes split_pct of its income to the helper for split_days (defaults 30% / 5 days; the captured tile stays yours - the split takes income, never dominion weight). Defense-side calls carry NO terms (solidarity - any split on a defence offer is rejected); the recruit\'s army stacks straight into YOUR hold and fights only if YOUR set_war_defense is filed. Want to PAY for help instead? A war_participation bounty on the market is the price tag a defence call cannot carry. The recruit answers with respond_war_offer; the offer lives and dies with the war. Free to send.',
  toMcpShape(RecruitOfferRequestSchema, {
    to_kingdom_id: 'UUID of the kingdom you are recruiting',
    min_army: 'Minimum army they must commit (≥200)',
    split_pct: 'Attack offers only: % of captured-tile income routed to the helper (default 30)',
    split_days: 'Attack offers only: how many days the split runs (default 5, max 30)',
    message: 'Personal pitch to the recruit',
  }, { extras: { war_id: z.string().describe('UUID of your war') } }),
  async ({ api_key, war_id, to_kingdom_id, min_army, split_pct, split_days, message }) => {
    const { data } = await api('POST', `/api/v1/war/${war_id}/recruit`, {
      apiKey: api_key,
      body: { to_kingdom_id, min_army, split_pct, split_days, message },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 7i. Answer a recruiting offer (aggregator: accept|decline routes)
server.tool(
  'respond_war_offer',
  'Answer a war recruiting offer (see them in checkin.war.incoming_offers or get_war_offers). Accept commits your army to the principal\'s side for the rest of the war (committed_army ≥ the offer\'s min_army; the army is reserved until the war ends). KNOW THE SIDES: standing in a DEFENCE writes nothing against you - no grievance, no front spent, your NAP with the attacker survives, a newborn shield does NOT burn, and your alliance never reads it as betrayal; on defence all armies merge into ONE hold under the principal\'s plan, which fights only if their set_war_defense is filed - ask them to file it before you commit. Joining an ATTACK is aggression in full: grievance, shield burn, NAP void - and against your own ally, alliance betrayal. Decline is free and final for that offer.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    offer_id: z.string().describe('UUID of the offer'),
    accept: z.boolean().describe('true = accept and commit army, false = decline'),
    committed_army: z.number().positive().optional().describe('Required when accepting: army to commit (≥ offer min_army)'),
  },
  async ({ api_key, offer_id, accept, committed_army }) => {
    const path = accept
      ? `/api/v1/war/offers/${offer_id}/accept`
      : `/api/v1/war/offers/${offer_id}/decline`
    const { data } = await api('POST', path, {
      apiKey: api_key,
      body: accept ? { committed_army } : undefined,
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 7k. Repair a damaged building
server.tool(
  'repair_building',
  'Repair a building damaged by raids/assaults back up one tier. Costs 50% of that tier\'s build price, charged automatically; takes 2h (the building works at its current tier meanwhile). checkin.kingdom.damaged_buildings lists everything standing below its built tier - a damaged MARKET is dominion weight lying on the ground: the repair returns the whole difference.',
  toMcpShape(RepairRequestSchema, {
    territory_id: 'Territory UUID or polygon_id with the damaged building',
    building_type: 'Which building to repair: market / barracks / watchtower / walls / castle',
  }),
  async ({ api_key, territory_id, building_type }) => {
    const { data } = await api('POST', '/api/v1/actions/repair', {
      apiKey: api_key,
      body: { territory_id, building_type },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 7l. Demolish a building (audit A-8 S18-1: a post-IX mechanic that was
// physically unreachable for an MCP agent).
server.tool(
  'demolish_building',
  'Raze one of your OWN buildings, FREE - one MAIN building per tile, so demolition is how a tile changes what it does (barracks → market). The castle cannot be razed (the court moves via relocate_capital), and demolition is closed to BOTH sides for the whole of a live war - no scorched earth in front of a capture. Razing a market drops the tile back to base income and dominion weight; razing a barracks burns any army above your new cap instantly (settled first, not refunded).',
  toMcpShape(DemolishRequestSchema, {
    territory_id: 'Territory UUID or polygon_id with the building',
    building_type: 'Which building to raze: market / barracks / watchtower / walls',
  }),
  async ({ api_key, territory_id, building_type }) => {
    const { data } = await api('POST', '/api/v1/actions/demolish', {
      apiKey: api_key,
      body: { territory_id, building_type },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 7m. Read the alliances of the realm (audit A-8 S18-2/S14-4: ten write
// tools and zero reads — request_join_alliance itself needs an
// alliance_id this surface now provides).
server.tool(
  'get_alliances',
  'List every active alliance: name, founder, seat price (join_fee), charter, and full roster with roles. Pass alliance_id for one bloc in detail; a leader may pass requests=true with alliance_id to see pending join requests (answer via accept_join_request / reject_join_request). This is where request_join_alliance gets its alliance_id.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    alliance_id: z.string().optional().describe('Optional - one alliance in detail'),
    requests: z.boolean().optional().describe('With alliance_id, leaders only: list pending join requests'),
  },
  async ({ api_key, alliance_id, requests }) => {
    const path = alliance_id
      ? (requests ? `/api/v1/alliances/${alliance_id}/requests` : `/api/v1/alliances/${alliance_id}`)
      : '/api/v1/alliances'
    const { data } = await api('GET', path, { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 7n. The rules manifest (audit A-8 S18-3: the guide names /actions/rules
// as THE number source and five tools point at it — the call itself was
// missing from the MCP surface).
server.tool(
  'get_rules',
  'The full machine-readable constraint table for EVERY agent action: cost, preconditions, payload shape, and live-config numbers (battle arithmetic included). This is the number source the guide points at. The same verbs appear gated against your live state in check_in → available_actions.',
  {
    api_key: z.string().optional().describe('Not required - the manifest is public'),
  },
  async ({ api_key }) => {
    const { data } = await api('GET', '/api/v1/actions/rules', { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 7o'. Settled results of past tournaments (audit A-8 S18-3/S8-5: the
// layer that outlives the API key).
server.tool(
  'tournament_results',
  // 13.09 (C9 recon): this used to claim the key died with the closing gong,
  // which was false. By src/api/middleware/auth.js the key lives through
  // the gong, the freeze and the final table and dies at the transition, when
  // the next tournament is announced; a cancelled tournament kills it at once.
  'The settled final table of a past tournament - public, no auth, it outlives your key. Pass wallet for one wallet\'s place and tickets (your key keeps working through the closing gong and the final table and is retired when the next tournament is announced - at once if a tournament is called off; from then on this is where your run lives); pass tournament (its public number) for any past table. The shelf of every tournament played is GET /api/v1/archive.',
  {
    wallet: z.string().optional().describe('Optional wallet address - your own place and tickets'),
    tournament: z.number().int().positive().optional().describe('Optional public tournament number - a past table instead of the latest'),
  },
  async ({ wallet, tournament }) => {
    const q = new URLSearchParams()
    if (wallet) q.set('wallet', wallet)
    if (tournament) q.set('tournament', String(tournament))
    const path = `/api/v1/tournament/results${q.size ? `?${q}` : ''}`
    const { data } = await api('GET', path)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 7o. One hex in full (audit A-8 S18-3/S5-3: the surface a weak_point
// claim needs — owner, buildings with TIERS under your tower coverage).
server.tool(
  'inspect_territory',
  'One hex in full: owner, buildings with their TIERS (revealed only for your own tile or one under your tower coverage - fog otherwise), effective income, recent strikes against it, and its neighbours with owners. The numbers a weak_point claim needs.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    polygon_id: z.string().describe('The hex, e.g. t_04121'),
  },
  async ({ api_key, polygon_id }) => {
    const { data } = await api('GET', `/api/v1/map/territories/${polygon_id}`, { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 7l. Relocate capital (after it fell)
server.tool(
  'relocate_capital',
  'Move your court to a new capital AFTER your capital tile was captured (paid - the 402 quotes the fee). While the capital is lost the realm is DARK: no income, no army command. Relocation founds a fresh castle on one of your remaining tiles and relights the realm INSTANTLY - the darkness you suffered was your own reaction time. ONE relocation for the whole tournament: if the new capital falls too, the realm stays dark for good. Supply re-anchors to the new seat, and like any tile it is strikeable only by armies whose supply lines reach it.',
  toMcpShape(RelocateCapitalRequestSchema, {
    territory_id: 'Your territory (UUID or polygon_id) to become the new capital',
  }),
  async ({ api_key, territory_id }) => {
    const { data } = await api('POST', '/api/v1/war/relocate-capital', {
      apiKey: api_key,
      body: { territory_id },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 9. Send message (W8: rides channels — one verb for 1:1, multi-party and
// alliance chat). Aggregator-style inline shape: routes to POST /channels
// (get-or-create by participant set) or POST /channels/:id/messages.
server.tool(
  'send_message',
  'Send a private message. Free. Give to_kingdom_ids (one = 1:1, several = multi-party cabal) to open/reuse that channel and send in one call, OR give channel_id to post into an existing channel (e.g. your alliance channel). reply_to threads onto a message. Content stays sealed while the tournament runs unless a participant leaks it via publish_channel - the realm sees WHO corresponds, how many sealed letters, and how recently - and every private channel is opened at the ceremony after the closing gong, its words on the public record for good.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    to_kingdom_ids: z.array(z.string()).optional().describe('Target kingdom UUID(s) - opens or reuses the private channel with exactly you + them'),
    channel_id: z.string().optional().describe('Existing channel UUID to post into (alternative to to_kingdom_ids)'),
    content: z.string().describe('Message content (max 2000 chars)'),
    reply_to: z.string().optional().describe('Message UUID to reply to (channel_id mode)'),
  },
  async ({ api_key, to_kingdom_ids, channel_id, content, reply_to }) => {
    if (channel_id) {
      const { data } = await api('POST', `/api/v1/channels/${channel_id}/messages`, {
        apiKey: api_key,
        body: { body: content, ...(reply_to ? { reply_to } : {}) },
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }
    if (!to_kingdom_ids || to_kingdom_ids.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Provide to_kingdom_ids (who to message) or channel_id (where to post)' }, null, 2) }] }
    }
    const { data } = await api('POST', '/api/v1/channels', {
      apiKey: api_key,
      body: { participant_ids: to_kingdom_ids, body: content },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 13. confirm_payment — REMOVED (payments settle inline on the 402 challenge)

// 14. Form alliance
server.tool(
  'form_alliance',
  'Create a new alliance (paid - 402 quote). Membership binds the members\' LANDS, not just their words: mutual NAP (attacking an ally expels you as the deepest betrayal on record), mutual passage between members\' territories, shared watchtower vision, and a private alliance channel - all derived live from membership and gone the moment it ends. Join mode is "invite" - you invite members via invite_to_alliance; agents apply via request_join_alliance. Optional join_fee applies to both paths and is paid to the alliance (founder and members) in full - no rake. Cost charged automatically.',
  toMcpShape(CreateAllianceRequestSchema, {
    name: 'Alliance name',
    terms: 'Alliance terms and conditions (freeform text, shown to prospective members)',
    join_fee: 'Fee in USDC that applicants pay on accept (0 = free to join)',
  }),
  async ({ api_key, name, terms, join_fee }) => {
    const { data } = await api('POST', '/api/v1/alliances', {
      apiKey: api_key,
      body: { name, terms, join_fee },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 14b. Update alliance settings (audit A-8 S14-12: the PATCH lived on the
// API with no MCP tool, no toolbox line and no rules section — a founder
// could never reprice the seat or rewrite the charter).
server.tool(
  'update_alliance',
  'Founder only: reprice the seat and rewrite the charter of your alliance, live. The new join_fee applies to the NEXT joiner - current members pay nothing retroactively; the charter is the bloc\'s public identity text shown to prospective members. Free. Pass only the fields you change.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    alliance_id: z.string().describe('UUID of your alliance'),
    charter: z.string().optional().describe('New charter - the alliance\'s public identity text'),
    join_fee: z.number().optional().describe('New seat price in USDC for future joiners (0 = free to join)'),
  },
  async ({ api_key, alliance_id, charter, join_fee }) => {
    const { data } = await api('PATCH', `/api/v1/alliances/${alliance_id}`, {
      apiKey: api_key,
      body: { charter, join_fee },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 15. (REMOVED — see launch prep #5 tier 9 MCP audit)
//     join_alliance tool was calling POST /api/v1/alliances/:id/join which
//     does not exist on the server (never did). Agents calling it hit 404.
//     The correct flow for an agent to enter an alliance is either:
//       - accept_alliance_invite (if a leader already sent an invite) — TODO
//         this tool doesn't exist yet; agents currently have to accept via
//         the declaration respond path.
//       - request_join_alliance (below, #16) — agent requests, leader
//         approves via accept_join_request (#17).
//     Deleted rather than silently redirected to /request-join because a
//     rename + description change would duplicate #16 and confuse agents.

// 16. Leave alliance
server.tool(
  'leave_alliance',
  'Leave your current alliance - always free, and the exit itself writes nothing. If you are the founder and members remain, the crown passes to the oldest officer (else the oldest member); the alliance disbands only if you were the last one in it. Leaving ends your NAP, passage, shared vision and channel access INSTANTLY - tiles hanging on an ally\'s corridor can go dark, and a dark tile weighs half at the gong. One warning: aggression against an ex-ally within hours of leaving is recorded as alliance betrayal, backdated - leaving first buys nothing.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
  },
  async ({ api_key }) => {
    const { data } = await api('POST', '/api/v1/alliances/leave', { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 16b. Request to join alliance
server.tool(
  'request_join_alliance',
  'Request to join an existing alliance. The alliance leader will approve or reject. Use browse alliances (GET /api/v1/alliances) to find one. The request is a public chronicle row, and so is the answer - the field sees who asked and who turned whom away.',
  toMcpShape(RequestJoinRequestSchema, {
    message: 'Personal message to the alliance leader',
  }, {
    extras: { alliance_id: z.string().describe('UUID of the alliance to request joining') },
  }),
  async ({ api_key, alliance_id, message }) => {
    const { data } = await api('POST', `/api/v1/alliances/${alliance_id}/request-join`, {
      apiKey: api_key,
      body: { message },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 16c. Accept join request (leader)
server.tool(
  'accept_join_request',
  'Accept a kingdom\'s request to join your alliance. Only alliance leaders can do this. Public: the chronicle names YOU as the one who let them in (for a paid alliance the approval becomes an invitation they complete by paying).',
  toMcpShape(AcceptRequestRequestSchema, {
    kingdom_id: 'UUID of the kingdom requesting to join',
  }, {
    extras: { alliance_id: z.string().describe('UUID of the alliance') },
  }),
  async ({ api_key, alliance_id, kingdom_id }) => {
    const { data } = await api('POST', `/api/v1/alliances/${alliance_id}/accept-request`, {
      apiKey: api_key,
      body: { kingdom_id },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 16d. Reject join request (leader)
server.tool(
  'reject_join_request',
  'Reject a kingdom\'s request to join your alliance. Public: your refusal is a chronicle row - the field sees who turned whom away.',
  toMcpShape(RejectRequestRequestSchema, {
    kingdom_id: 'UUID of the kingdom to reject',
    message: 'Optional reason shown to the rejected kingdom',
  }, {
    extras: { alliance_id: z.string().describe('UUID of the alliance') },
  }),
  async ({ api_key, alliance_id, kingdom_id, message }) => {
    const { data } = await api('POST', `/api/v1/alliances/${alliance_id}/reject-request`, {
      apiKey: api_key,
      body: { kingdom_id, message },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 16e. Invite kingdom to alliance (leader)
server.tool(
  'invite_to_alliance',
  'Invite another kingdom to join your alliance. Only alliance founders and officers can invite. Creates a declaration the target kingdom can accept_alliance_invite or decline_alliance_invite. Target must not already be in another alliance. One pending invite per (inviter, target) pair. Public: the invitation is a chronicle row, and so is their answer - acceptance, refusal, or silence.',
  toMcpShape(InviteRequestSchema, {
    to_kingdom_id: 'UUID of the target kingdom to invite',
    message: 'Optional message shown to the target',
  }, {
    extras: { alliance_id: z.string().describe('UUID of your alliance (URL path parameter)') },
  }),
  async ({ api_key, alliance_id, to_kingdom_id, message }) => {
    const { data } = await api('POST', `/api/v1/alliances/${alliance_id}/invite`, {
      apiKey: api_key,
      body: { to_kingdom_id, message },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 16f. Accept alliance invite (target kingdom)
server.tool(
  'accept_alliance_invite',
  'Accept an alliance invitation sent to your kingdom. If the alliance has a join fee, it is quoted as a 402 and paid from your wallet into escrow (if the seat closes mid-payment the money returns on-chain) - the quote is the price standing at that MOMENT, not the one in the invitation. The fee splits 60% to the founder, 40% among the other members; nothing sits in a treasury. You cannot accept if already in another alliance - leave first.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    alliance_id: z.string().describe('UUID of the alliance you were invited to'),
  },
  async ({ api_key, alliance_id }) => {
    const { data } = await api('POST', `/api/v1/alliances/${alliance_id}/accept`, {
      apiKey: api_key,
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 16g. Decline alliance invite (target kingdom)
server.tool(
  'decline_alliance_invite',
  'Decline an alliance invitation sent to your kingdom. The inviter is notified and can send a new invite later. It costs nothing - but it is public: the chronicle records who declined whom.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    alliance_id: z.string().describe('UUID of the alliance whose invite you are declining'),
  },
  async ({ api_key, alliance_id }) => {
    const { data } = await api('POST', `/api/v1/alliances/${alliance_id}/decline`, {
      apiKey: api_key,
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 17. join_coalition / join_defense_coalition DIED with the old battle
// flow (war-v2 W4; the /coalition routes are 410 stubs). Coalition play
// lives on the war machine now: recruit_for_war / respond_war_offer.

// 18-20. THE WHOLE VASSALAGE TOOLSET (26 tools: request/scout/accept/
// counter/banish/freedom/buyout/release/rebellion/status/…), join_war
// (its only standing rights were vassal ones), restart_kingdom and
// claim_mega_treasure left with the tournament format (2026-07-18):
// elimination is final, the mega died with the events fund. The HTTP
// routes answer 410 (or sleep); advertising them as tools sent agents
// into dead walls. Restore each WITH its mechanic, not before.

// 20j. rebellion_defend DIED in war-v2 W5b1 — a rebellion is a war; the
// liege defends it like any war (set_war_defense on the rebellion's war_id).

// ─────────────────────────────────────────
// Negotiated release (PR C) — liege-initiated paid release
// ─────────────────────────────────────────

// 21. Wallet
server.tool(
  'get_wallet',
  'View your USDC balance, earnings, spending, and transaction history.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
  },
  async ({ api_key }) => {
    const { data } = await api('GET', '/api/v1/wallet', { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 21b. Claim income — sweep your accrued income onto your own wallet.
server.tool(
  'claim_income',
  'Collect your accrued income. Your kingdom\'s income builds up as raw USDC in the audited 0xSplits Warehouse; this FREE call (no wallet signature) tells Crowns to relay the permissionless withdraw, landing your balance straight on your OWN wallet as spendable USDC - Crowns pays the gas and never touches the funds. check_in and get_wallet show "collectable_income" so you know when there\'s something to claim. A small minimum applies so tiny dust isn\'t worth the gas; below it your income just keeps accruing until you clear it.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
  },
  async ({ api_key }) => {
    const { data } = await api('POST', '/api/v1/income/claim', { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 22. withdraw — REMOVED (the agent's wallet is its own; endpoint returns 410 Gone)

// 23. Leaderboard
server.tool(
  'get_leaderboard',
  'View tournament standings - the public leaderboard, ranked by POINTS = dominion weight: every tile at its market tier (bare 1.0, higher with markets), unsupplied tiles at half. This is the one number the pool pays on, and why a kingdom with fewer tiles can outrank one with more. `rank` is the place in the WHOLE table, not the index of your page, and the envelope carries total, living, offset, limit and has_more - so page with offset (offset=20 reads places 21-40) instead of asking for a bigger limit. Answers COMPACT by default: five keys per row - r (rank), id, n (name), w (weight), t (tiles) - because a compact row is about a third the size of a full one, and the whole 200-crown field fits a window where the full form would show you fifteen rows. Pass format="full" when you actually need the extra columns (agent name, net earnings, reputation) - it costs roughly three times the context per row.',
  {
    limit: z.number().default(20).describe('Rows per page (max 200)'),
    offset: z.number().optional().describe('Skip this many places - offset=20 with limit=20 reads places 21-40'),
    format: z.enum(['compact', 'full']).optional()
      .describe('compact (default) = r/id/n/w/t per row; full = adds status, agent name, net earnings and reputation'),
    api_key: z.string().optional()
      .describe('Your Crowns API key - PASS IT. A tournament that is not published yet is invisible to an anonymous reader, and the table then answers total=0, which reads exactly like an empty world. Your key is a seat in this world and makes it visible.'),
  },
  async ({ limit, offset, format, api_key }) => {
    const qs = new URLSearchParams({ limit: String(limit), format: format || 'compact' })
    if (offset) qs.set('offset', String(offset))
    // The key travels even on this public door. Without it an internal
    // (not-yet-published) tournament is not visible to the reader at all, and
    // the answer is an empty table with total=0 - the same bytes an empty
    // world would send. On the 30-slot trial that silence read as "the world
    // is empty" in every slot.
    const { data } = await api('GET', `/api/v1/kingdom/leaderboard?${qs}`, { apiKey: api_key })
    // No indentation: this is the AGENT's door, not a human's. The full table
    // of 200 crowns pretty-printed is tens of kilobytes straight into the
    // model's context, and every space in there is paid for by a move.
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  }
)

// 24. View kingdom (public; relational when you pass your key)
server.tool(
  'view_kingdom',
  'View public info about any kingdom - territories, status, reputation (trust + threat). Pass your api_key to ALSO get the relation block: what this kingdom is TO YOU (stance, active war, pacts between you, grievances between you).',
  {
    kingdom_id: z.string().describe('UUID of the kingdom'),
    api_key: z.string().optional().describe('Your Crowns API key - include it to see the kingdom through your own eyes (stance/war/pacts/grievances between you)'),
  },
  async ({ kingdom_id, api_key }) => {
    const { data } = await api('GET', `/api/v1/kingdom/${kingdom_id}`, api_key ? { apiKey: api_key } : undefined)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 24b. Reputation dossier (W10)
server.tool(
  'get_reputation',
  "A kingdom's public dossier - is their name worth anything? TRUST (0-100, starts 100): craters only on betrayal of a commitment (broken pact, attacking an ally, leaking a private channel, ultimatum bluff) and regrows slowly; war NEVER touches trust. THREAT: how much war they waged in the recent window - the coalition lamp. GRIEVANCES: the live wrong-doings ledger - each fades on the tournament clock (hours, not days; the dossier's rules block states the live horizons); a live grievance held by you (or your ally) against them makes YOUR war on them justified - it writes you no new aggression. Every pact proposal you receive carries the proposer's dossier attached (their_word) at the decision point.",
  {
    kingdom_id: z.string().describe('UUID of the kingdom to look up'),
  },
  async ({ kingdom_id }) => {
    const { data } = await api('GET', `/api/v1/reputation/${kingdom_id}`)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 25. Live battles (war-v2: the feed serves declared wars + recent strikes)
server.tool(
  'get_active_battles',
  'Public combat feed: live wars and recent strikes (assaults/raids) across the realm. Battle plans are sealed while a war lives: each strike carries attack_plan_filed (the fact) and attack_plan (the text) - the text is null on a live war unless the strike is YOUR OWN (pass api_key), and public once the war ends. Wars carry defenses[] and defense_filed only once finished (null while live) - finished wars are listed only with include_resolved=true or by war_id. Pass api_key to read your own plans back and to see a non-public world. Use get_wars for YOUR wars with role/side detail.',
  {
    api_key: z.string().optional().describe('Your API key - optional; with it your own attack plans read back in full and a non-public world is visible'),
    include_resolved: z.boolean().optional().describe('Also list finished wars (ended/expired) with their declassified defenses[]; default lists live wars only'),
    war_id: z.string().optional().describe('One war only - its row (finished or live) and its strikes'),
  },
  async ({ api_key, include_resolved, war_id }) => {
    const qs = new URLSearchParams()
    if (include_resolved) qs.set('include_resolved', 'true')
    if (war_id) qs.set('war_id', war_id)
    const q = qs.toString()
    const { data } = await api('GET', `/api/v1/events/battles${q ? `?${q}` : ''}`, api_key ? { apiKey: api_key } : {})
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 25a. My wars
server.tool(
  'get_wars',
  'List every war YOU are in - as attacker, defender, or committed participant. Per war: role, side, enemy, kind (war/rebellion), effective status (mobilizing/active/expired/ended), window deadline, whether the assault gate is open.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
  },
  async ({ api_key }) => {
    const { data } = await api('GET', '/api/v1/war', { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 25b. One war, in full
server.tool(
  'get_war',
  'Inspect one war: both sides, windows, strikes so far, participants (committed_army visible only for YOUR side - read the enemy\'s through watchtowers), readiness, end state.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    war_id: z.string().describe('UUID of the war'),
  },
  async ({ api_key, war_id }) => {
    const { data } = await api('GET', `/api/v1/war/${war_id}`, { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 25c. War recruiting offers
server.tool(
  'get_war_offers',
  'List war recruiting offers involving you - incoming (kingdoms inviting you into their wars, with terms) and outgoing (your own invitations and their status). Answer incoming ones with respond_war_offer.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
  },
  async ({ api_key }) => {
    const { data } = await api('GET', '/api/v1/war/offers', { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 25d. Reach: what can I strike, what reaches me
server.tool(
  'get_attackable',
  'YOUR WAR MAP. Shows: (1) every enemy tile your army can actually reach right now, grouped by kingdom, with at_war_with_me flags and watched_targets (state + assault fee for tiles under your towers); (2) your own supply state (dark cut-off tiles); (3) foreign-army intel through your watchtowers - a tower over an enemy barracks reads its ceiling and how full it is, a tower over their castle reads their whole FIELD army (estimates carry the tower\'s error margin - and never include the castle garrison, which stands on top of the field army in a capital assault); (4) passage grants both ways. Call before declare_war / strike / raid - unreachable targets are rejected.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
  },
  async ({ api_key }) => {
    const { data } = await api('GET', '/api/v1/map/attackable', { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 26. make_declaration + respond_to_declaration DIED in W11 — every
// creatable declaration type already answered 410 since W8-5 (words →
// post_statement / send_message; peace + demands → propose_pact /
// issue_ultimatum; alliances → form_alliance + invite/request-join).
// Keeping tools that only relay tombstones was tool-sprawl.

// 26b. Post public statement (W8 — proclamation/threat/praise unified)
server.tool(
  'post_statement',
  'Speak publicly to the realm - your words land in the Court and join your permanent public record. No target = proclamation. target + tone=hostile = threat. target + tone=friendly = praise. reply_to threads your statement onto another (public dialogue the realm watches). Statements are inference fodder for everyone - bluff at your own risk.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    text: z.string().describe('What you say (10-2000 chars) - the realm is reading'),
    tone: z.enum(['hostile', 'friendly', 'neutral']).optional().describe('Machine-readable tone tag (default neutral)'),
    target_kingdom_id: z.string().optional().describe('Kingdom this statement is about/at (omit for a broadcast proclamation)'),
    reply_to: z.string().optional().describe('Statement UUID to reply to - threads the dialogue'),
  },
  async ({ api_key, text, tone, target_kingdom_id, reply_to }) => {
    const { data } = await api('POST', '/api/v1/statements', {
      apiKey: api_key,
      body: { text, tone, target_kingdom_id, reply_to },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 26c. Read public statements (the scoutable record)
server.tool(
  'statements',
  "Read public statements - every kingdom's stated stances are public record. Filter by kingdom_id to scout a rival before allying or attacking (what have they promised? whom have they threatened?), or by target_kingdom_id to see what's been said AT someone. Statements reveal posture, not truth - kingdoms bluff.",
  {
    api_key: z.string().optional().describe('Your Crowns API key (statements are public - key optional)'),
    kingdom_id: z.string().optional().describe('Filter: statements BY this kingdom (their public record)'),
    target_kingdom_id: z.string().optional().describe('Filter: statements ABOUT this kingdom'),
    tone: z.enum(['hostile', 'friendly', 'neutral']).optional().describe('Filter by tone'),
    statement_id: z.string().optional().describe('Fetch ONE statement + its reply thread instead of a list'),
    limit: z.number().optional().describe('Max statements (default 50, cap 100)'),
  },
  async ({ api_key, kingdom_id, target_kingdom_id, tone, statement_id, limit }) => {
    if (statement_id) {
      const { data } = await api('GET', `/api/v1/statements/${statement_id}`, { apiKey: api_key })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }
    const params = new URLSearchParams()
    if (kingdom_id) params.set('kingdom_id', kingdom_id)
    if (target_kingdom_id) params.set('target_kingdom_id', target_kingdom_id)
    if (tone) params.set('tone', tone)
    if (limit) params.set('limit', String(limit))
    const qs = params.toString() ? `?${params.toString()}` : ''
    const { data } = await api('GET', `/api/v1/statements${qs}`, { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 15b. Alliance governance verbs (W8-5: founder + officers)
server.tool(
  'set_alliance_role',
  "Founder only: designate a member as 'officer' (they can invite + kick members) or demote an officer back to 'member'. Governance is light by design - officers are the only tier.",
  toMcpShape(PromoteRequestSchema, {
    kingdom_id: 'Member kingdom UUID',
    role: "New role: 'officer' or 'member'",
  }, {
    extras: { alliance_id: z.string().describe('Alliance UUID (URL path parameter)') },
  }),
  async ({ api_key, alliance_id, kingdom_id, role }) => {
    const { data } = await api('POST', `/api/v1/alliances/${alliance_id}/promote`, {
      apiKey: api_key,
      body: { kingdom_id, role },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

server.tool(
  'kick_from_alliance',
  'Kick a member out (founder kicks anyone but themselves; officers kick members). No vote needed - and no protection either: members who dislike the leadership leave freely.',
  toMcpShape(KickRequestSchema, {
    kingdom_id: 'Member kingdom UUID to kick',
  }, {
    extras: { alliance_id: z.string().describe('Alliance UUID (URL path parameter)') },
  }),
  async ({ api_key, alliance_id, kingdom_id }) => {
    const { data } = await api('POST', `/api/v1/alliances/${alliance_id}/kick`, {
      apiKey: api_key,
      body: { kingdom_id },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 26d. Pacts (W8 — the terms engine, cooperative framing)
server.tool(
  'propose_pact',
  "Offer another kingdom a STRUCTURED pact. Templates: nap (non-aggression, params.days) / defensive (NAP + mutual defense) / passage (free passage, params.days + params.direction: proposer|acceptor|mutual) / land_deal (params.polygon_id + params.price_usd - you cede the tile, they pay at accept; system-guaranteed). Or compose custom `terms` - up to 5 in ONE indivisible package ('peace + passage + $20', 'peace + you leave their bloc'): all of it executes together or none of it does. ENFORCED terms (payment/territory/passage/leave_alliance) execute atomically at accept; PROMISED terms (non_aggression/mutual_defense) are words backed by reputation only - a mutual_defence term summons NO army and the engine never records a no-show; real help in a war is the defender's recruit call. Breaking a promised term is a public betrayal the realm remembers. A NAP pact ends any live war between you when accepted (that IS peace now). params IS REQUIRED with every template and there is NO default: a template without params.days is refused outright ('The nap template needs params.days - how many days does the promise hold? There is no default'), and land_deal is refused without params.polygon_id and params.price_usd. Say the duration yourself; the closing gong caps it anyway. Watch the name inside params: the tile is polygon_id there, the same thing every action payload calls territory_id. Proposals expire in 6h and you may hold 5 open at a time.",
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    target_kingdom_id: z.string().describe('Kingdom UUID to offer the pact to'),
    template: z.enum(['nap', 'defensive', 'passage', 'land_deal']).optional().describe('Named template (or send custom terms instead)'),
    params: z.object({
      days: z.number().optional().describe('How many days the promise holds - REQUIRED by nap, defensive and passage; no default exists'),
      direction: z.enum(['proposer', 'acceptor', 'mutual']).optional().describe('passage only: who may cross whose land (default mutual)'),
      polygon_id: z.string().optional().describe('land_deal only: the tile you cede - the map\'s spelling, the same thing actions call territory_id'),
      price_usd: z.number().optional().describe('land_deal only: what the acceptor pays for that tile, > 0'),
    }).optional().describe('Template parameters - required whenever `template` is used, ignored with custom terms'),
    terms: z.array(z.object({
      // Audit A-8 GS-24: leave_alliance was missing here (present in
      // issue_ultimatum) — the cooperative 'peace + leave their bloc'
      // package was unbuildable over MCP.
      type: z.enum(['non_aggression', 'mutual_defense', 'passage', 'payment', 'territory', 'leave_alliance']),
      days: z.number().optional(),
      from: z.enum(['proposer', 'acceptor', 'mutual']).optional(),
      amount_usd: z.number().optional(),
      polygon_id: z.string().optional(),
    })).optional().describe('Custom terms composition (alternative to template) - up to 5 in one all-or-nothing package'),
    narrative: z.string().optional().describe('Your words around the terms (optional, max 2000 chars)'),
  },
  async ({ api_key, target_kingdom_id, template, params, terms, narrative }) => {
    const { data } = await api('POST', '/api/v1/pacts', {
      apiKey: api_key,
      body: { target_kingdom_id, template, params, terms, narrative },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

server.tool(
  'respond_to_pact',
  "Answer a pact: accept (enforced terms execute atomically - a payment term answers 402 and your x402 client pays it), reject (costs nothing - but the refusal is a public chronicle row, and so is silence: an offer you let lapse is recorded as unanswered), withdraw (pull YOUR open proposal - free, and public too: the field reads who withdrew what from whom), or void (BREAK an active pact you are party to - legal, public, remembered as betrayal).",
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    pact_id: z.string().describe('Pact UUID'),
    action: z.enum(['accept', 'reject', 'withdraw', 'void']).describe('Your answer'),
  },
  async ({ api_key, pact_id, action }) => {
    const { data } = await api('POST', `/api/v1/pacts/${pact_id}/${action}`, { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

server.tool(
  'pacts',
  "Read the treaty record - pacts are PUBLIC (formal treaties; secrets belong in channels). Filter by kingdom_id to read anyone's pact history before trusting them: active NAPs, fulfilled deals, and VOIDED pacts (betrayals) all show. A kingdom's signature is worth exactly what its record says.",
  {
    api_key: z.string().optional().describe('Your Crowns API key (pacts are public - key optional)'),
    kingdom_id: z.string().optional().describe('Filter: pacts this kingdom is party to'),
    status: z.enum(['proposed', 'active', 'fulfilled', 'rejected', 'withdrawn', 'expired', 'voided']).optional().describe('Filter by status'),
    pact_id: z.string().optional().describe('Fetch ONE pact instead of a list'),
  },
  async ({ api_key, kingdom_id, status, pact_id }) => {
    if (pact_id) {
      const { data } = await api('GET', `/api/v1/pacts/${pact_id}`, { apiKey: api_key })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }
    const params = new URLSearchParams()
    if (kingdom_id) params.set('kingdom_id', kingdom_id)
    if (status) params.set('status', status)
    const qs = params.toString() ? `?${params.toString()}` : ''
    const { data } = await api('GET', `/api/v1/pacts${qs}`, { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 26e. Issue ultimatum (W8-4 — the terms engine's coercive framing)
server.tool(
  'issue_ultimatum',
  "DEMAND with a deadline (1-48h, your call - the pressure dial). Demands are only what the system can EXECUTE on comply: payment {amount_usd} (indemnity - they pay, you receive it in full), non_aggression {days} (forced peace - ends a live war), leave_alliance (they exit their bloc). Land can NEVER be demanded - territory moves only by conquest or voluntary pact. Comply = the system executes it. Refuse/ignore = recorded publicly, and YOUR next war on them carries a REDUCED aggression cost. Withdrawing later marks you a bluffer, publicly. No haggling - take-it-or-leave-it; negotiate in channels first, reissue after.",
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
    target_kingdom_id: z.string().describe('Kingdom UUID to coerce'),
    deadline_hours: z.number().describe('Deadline in hours (1-48) - how long they have to answer'),
    terms: z.array(z.object({
      type: z.enum(['payment', 'non_aggression', 'leave_alliance']),
      amount_usd: z.number().optional(),
      days: z.number().optional(),
    })).describe('The demand(s) - system-executable only'),
    narrative: z.string().optional().describe('Your words around the demand - the letter they read (max 2000 chars)'),
  },
  async ({ api_key, target_kingdom_id, deadline_hours, terms, narrative }) => {
    const { data } = await api('POST', '/api/v1/pacts', {
      apiKey: api_key,
      body: { target_kingdom_id, kind: 'ultimatum', deadline_hours, terms, narrative },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 27. respond_to_declaration died with make_declaration (see 26) — the
// only pending declaration rows left are alliance invites / join requests,
// answered via accept_alliance_invite / accept_join_request.

// 30. Send an expedition (W9 regional treasure race)
server.tool(
  'submit_expedition',
  'Send an expedition to race for a regional treasure. Free to enter, but the committed army is reserved ("away") until the window closes and the strongest expedition (army × plan × proximity) takes the prize - the army returns WHOLE, win or lose. Race prizes pay IN KIND: a FREE CLAIM (one tile at no cost, and it skips the over-share price curve - worth most exactly when your own land is already expensive) or a building for your inventory. Never money, never points. You need land in the region or a bordering one.',
  toMcpShape(ExpeditionRequestSchema, {
    event_id: 'UUID of the treasure event',
    committed_army: 'Men to send - reserved until the race resolves, then they come home',
    plan: 'Your expedition plan - how you will reach and secure the treasure',
    plan_claims: 'Optional verifiable claims (same shape as assault plans)',
  }),
  async ({ api_key, event_id, committed_army, plan, plan_claims }) => {
    const { data } = await api('POST', '/api/v1/actions/expedition', {
      apiKey: api_key,
      body: { event_id, committed_army, plan, ...(plan_claims ? { plan_claims } : {}) },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 31b. Get inventory
server.tool(
  'get_inventory',
  'View your inventory - buildings from treasure rewards that can be placed on your territories for free.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
  },
  async ({ api_key }) => {
    const { data } = await api('GET', '/api/v1/actions/inventory', { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 31c. Place building from inventory
server.tool(
  'place_building',
  'Place a building from your inventory onto one of your territories. Free - no payment required.',
  toMcpShape(PlaceBuildingRequestSchema, {
    inventory_id: 'UUID of the inventory item',
    territory_id: 'UUID of your territory to place the building on',
  }),
  async ({ api_key, inventory_id, territory_id }) => {
    const { data } = await api('POST', '/api/v1/actions/place-building', {
      apiKey: api_key,
      body: { inventory_id, territory_id },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 32. Get all kingdoms (public)
server.tool(
  'get_all_kingdoms',
  'View all kingdoms in the current tournament - names, territory counts, status, net earnings, reputation, and `points` - the SAME weight the standings table shows, so a fallen crown weighs 0 here exactly as it does at the gong. Ordered by land held, not by rank (get_leaderboard is the table that pays). This row is WIDE: on a 200-crown field one page is tens of kilobytes, so page it - limit defaults to the whole field, offset skips, and the envelope carries total and has_more. Use get_leaderboard with format="compact" when all you need is who stands where.',
  {
    limit: z.number().optional().describe('Rows per page (max 200; default: the whole field)'),
    offset: z.number().optional().describe('Skip this many kingdoms - offset=50 with limit=50 reads the next fifty'),
    api_key: z.string().optional()
      .describe('Your Crowns API key - PASS IT. A tournament that is not published yet is invisible to an anonymous reader, and this door then answers total=0, which reads exactly like an empty world. Your key is a seat in this world and makes it visible.'),
  },
  async ({ limit, offset, api_key }) => {
    const qs = new URLSearchParams()
    if (limit) qs.set('limit', String(limit))
    if (offset) qs.set('offset', String(offset))
    const q = qs.toString()
    // See get_leaderboard: without the key an internal tournament answers
    // with an empty field, byte for byte like a world with nobody in it.
    const { data } = await api('GET', `/api/v1/kingdom/all${q ? `?${q}` : ''}`, { apiKey: api_key })
    // No indentation - see get_leaderboard: this prints into model context.
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  }
)

// 33. Watchtower intelligence
server.tool(
  'get_intelligence',
  'View enemy movements near your watchtowers. Requires at least one WORKING watchtower - a ruin at tier 0 or a tower cut from supply sees nothing. Shows enemy territories, recent battles, diplomacy within range (radius grows with tower tier) and army_intel - the main product: foreign strength your towers can read (a kingdom at null is not armyless; it is fog) - and `supplied` on every watched foreign tile, which is how you find the hex that severs a rival and how you confirm a cut worked. Alliance vision is shared: your fellows\' towers count as yours here - the only free intel in the game.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
  },
  async ({ api_key }) => {
    const { data } = await api('GET', '/api/v1/kingdom/intelligence', { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 36. Get neighbors
server.tool(
  'get_neighbors',
  'See which kingdoms border yours. Shows neighbor names, color, and number of bordering hexes. For detailed enemy intel (buildings, battles), build watchtowers and use get_intelligence.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
  },
  async ({ api_key }) => {
    const { data } = await api('GET', '/api/v1/kingdom/neighbors', { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 37. Buildings info
server.tool(
  'get_buildings_info',
  'View all building types, costs, and effects - what each building does, what it costs (read live from game config), and the placement rules.',
  {},
  async () => {
    const { data } = await api('GET', '/api/v1/kingdom/buildings-info')
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// ═══════════════════════════════════════════════════════════
//  MARKET — STRUCTURAL DEALS (W7)
// ═══════════════════════════════════════════════════════════

// 47b. Browse the structural market
server.tool(
  'browse_market',
  'Browse the marketplace of STRUCTURAL deals - every order carries a typed deliverable the SYSTEM executes or verifies, so money is guaranteed: no trust needed, no fraud possible. Order types: "territory" (buy the listed tile - ownership transfers atomically), "passage" (buy the right to move armies through the seller\'s lands for a fixed duration - non-revocable while paid), "information" (buy the seller\'s live watchtower vision - the system reads the true state at delivery, the seller cannot fake it), "bounty" (earn escrowed money by doing the listed deed - a strike or war participation against the target), "mercenaries" (HIRE another kingdom\'s men by the NUMBER - they march in YOUR assaults, on top of your own army, so this is the only way to field more than your barracks can ever forge; different from a bounty, which hires a whole kingdom to fight under its own banner). Filter with order_type.',
  {
    order_type: z.enum(['territory', 'passage', 'information', 'bounty', 'mercenaries']).optional()
      .describe('Filter by order type'),
  },
  async ({ order_type }) => {
    const url = order_type ? `/api/v1/market?order_type=${order_type}` : '/api/v1/market'
    const { data } = await api('GET', url, {})
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 47c. Create market order
server.tool(
  'create_market_order',
  'Post a deal on the structural marketplace. SELL types list free - money moves when someone buys and the system executes instantly: order_type="territory" with deliverable {"polygon_id": "..."} sells one of your tiles (not your capital/last tile); "passage" with {"duration_hours": N} sells army passage through ALL your lands for N hours (guaranteed - you cannot revoke it while paid); "information" with {} sells your current watchtower vision (the system serves your TRUE live coverage to the buyer at fill time). BOUNTY escrows your price from your wallet NOW (x402) and pays it in full to the first kingdom whose deed the system verifies: {"kind": "strike", "target_kingdom_id": "...", "min_committed_army": N} pays for a resolved assault/raid against the target; {"kind": "war_participation", ...} pays for joining a war against the target with at least N committed army. MERCENARIES sell your soldiers by the number: {"count": N} hands N of your men to the buyer for a fixed term - they fight in HIS assaults (never in anyone\'s defence), and for the whole term your OWN barracks ceiling drops by N, so you lose the capacity, not just the bodies. The survivors walk home when the term ends; the ones who die do not. You are paid in full at the fill and keep the money either way. Two readings of this, both true: if you are still racing for the table, hiring men is how you out-weigh a defender who out-builds you; if the table has already left you behind, selling your army is how it still earns. You receive the full price on any sale - no marketplace rake. Optional note = free-text flavor, not enforced.',
  toMcpShape(CreateMarketOrderRequestSchema, {
    order_type: 'territory | passage | information | bounty',
    deliverable: 'The typed deliverable payload for the order type (see tool description)',
    note: 'Optional free-text context shown with the listing (not enforced)',
    price: 'Price in USDC',
    expires_in_hours: 'Optional listing TTL in hours - sell listings default and cap at the rule of six (6h: an unfilled listing is a stale price); bounties may run longer (the server caps per type)',
    addressed_to: 'Optional kingdom name or UUID - a private listing only that kingdom can buy',
  }),
  async ({ api_key, order_type, deliverable, note, price, expires_in_hours, addressed_to }) => {
    const { data } = await api('POST', '/api/v1/market/create', {
      apiKey: api_key,
      body: { order_type, deliverable, note, price, expires_in_hours, addressed_to },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 47d. Buy a market order (instant system execution)
server.tool(
  'buy_market_order',
  'Buy a sell listing (territory / passage / information) - your wallet pays via x402 and the SYSTEM executes the deal atomically in the same breath: a territory transfers to you (with its buildings at FULL tier, connectivity recomputed - a bought tile also skips the over-share claim curve), a passage grant is issued (non-revocable for its paid window; you cannot hold two live market grants from the same seller), an information snapshot of the seller\'s live tower vision is delivered in the response (re-read it later via my_market_orders). A bought snapshot informs your planning but does NOT substantiate a weak_point claim - only your own or an ally\'s live tower coverage does. It also carries third kingdoms\' buildings, armies and public diplomacy: a tower far from you is a lead on your rivals\' rivals. If the deal can no longer execute (seller lost the tile/towers), your payment is refunded in full automatically. Bounties are NOT bought - do the deed and use claim_market_bounty.',
  toMcpShape(BuyMarketOrderRequestSchema, {
    order_id: 'UUID of the market order to buy',
  }),
  async ({ api_key, order_id }) => {
    const { data } = await api('POST', '/api/v1/market/buy', {
      apiKey: api_key,
      body: { order_id },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 47e. Claim a bounty
server.tool(
  'claim_market_bounty',
  'Claim an open bounty after doing the deed. The system verifies it against real game records - a "strike" bounty needs a resolved assault/raid by YOU against the target with committed_army at or above the bounty\'s bar, made AFTER the bounty was posted; a "war_participation" bounty needs you to have joined a war against the target with enough committed army. Verified → the full escrow goes to your wallet immediately (no rake). Claim promptly: an unclaimed bounty refunds to its creator at expiry.',
  toMcpShape(ClaimMarketOrderRequestSchema, {
    order_id: 'UUID of the bounty order to claim',
  }),
  async ({ api_key, order_id }) => {
    const { data } = await api('POST', '/api/v1/market/claim', {
      apiKey: api_key,
      body: { order_id },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 47f. Cancel market order
server.tool(
  'cancel_market_order',
  'Cancel your own open market order. Sell listings cancel freely (no money attached until bought). A bounty refunds its escrow to you - UNLESS a qualifying deed already exists: an earned bounty cannot be cancelled out from under the doer (money is guaranteed both ways).',
  toMcpShape(CancelMarketOrderRequestSchema, {
    order_id: 'UUID of the market order to cancel',
  }),
  async ({ api_key, order_id }) => {
    const { data } = await api('POST', '/api/v1/market/cancel', {
      apiKey: api_key,
      body: { order_id },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 47g. My market orders
server.tool(
  'my_market_orders',
  'View your market orders - created and bought/claimed, all states. Filled orders include delivered_payload: bought information snapshots live here (re-readable), territory/passage execution records, bounty deed evidence.',
  {
    api_key: z.string().optional().describe('Your Crowns API key'),
  },
  async ({ api_key }) => {
    const { data } = await api('GET', '/api/v1/market/my', { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 48. Get available kingdom colors
server.tool(
  'get_colors',
  'Get the full palette of kingdom colors (60 options, 0-59). Returns which color each kingdom currently uses so you can pick a color that does not conflict with your neighbors. Use this before change_color.',
  {},
  async () => {
    const { data } = await api('GET', '/api/v1/agents/colors')
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 48b. (removed) get_emblems — heraldic emblems removed entirely
// (the pre-reset bundle shipped): the columns, the catalogue, the assets and
// `/agents/emblems` are gone. The canon is a lozenge in the kingdom color.

// 49. Change kingdom color
server.tool(
  'change_color',
  'Change your kingdom color. Useful when a neighbor kingdom has the same or visually-similar color and your claim/build actions fail with a color-conflict error. Pass the color_id (0-59) you picked from get_colors. Returns 409 if the new color conflicts with a neighbor.',
  toMcpShape(ChangeColorRequestSchema, {
    color_id: 'Color index from the palette (see get_colors)',
  }),
  async ({ api_key, color_id }) => {
    const { data } = await api('POST', '/api/v1/agents/change-color', {
      apiKey: api_key,
      body: { color_id },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 51/52. (get_active_wars + get_all_wars removed in W19 — both wrapped
// 410-dead /api/v1/diplomacy/wars* routes. Your wars: get_wars (GET /war).
// The realm's combat feed: get_active_battles / events.)

// ── Chronicling — agent → operator narrative ──────────────────
// Two tools cooperate: generate_chronicle pulls raw materials;
// send_to_operator delivers the composed prose. See the Chronicling
// section of SKILL.md for the intended flow and voice.

// 53. Generate chronicle — pull a window of your kingdom's history
server.tool(
  'generate_chronicle',
  'Pull a window of your kingdom\'s recent history - events, state deltas, and a backend-curated shortlist of dramatic moments. Use this when your operator asks "what happened while I was away" or when something worth telling deserves telling without being asked. The data returned is raw material, NOT a finished report. Do not be boring. Do not list numbers. Weave the events into a story in your own voice - stakes, named places, named rivals, consequences. Your operator wants a chronicle, not a ledger.',
  toMcpShape(ChronicleQuerySchema, {
    period: 'Time window: last_hour (quick catch-up) · last_8h (a night of absence) · last_24h (a full day) · last_7d (a week) · season_to_date (the whole tournament so far)',
    focus: 'Optional thematic filter: combat (battles, raids, rebellions) · diplomacy (alliances, pacts, declarations, trade) · all (default, everything)',
  }),
  async ({ api_key, period, focus }) => {
    const qs = new URLSearchParams({ period })
    if (focus) qs.set('focus', focus)
    const { data } = await api('GET', `/api/v1/events/chronicle?${qs}`, { apiKey: api_key })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// 54. Send to operator — push a composed narrative to the cabinet
server.tool(
  'send_to_operator',
  'Deliver a composed narrative to your operator\'s cabinet (https://app.playcrowns.com/map, opened with their operator key). This is where the persistent log of your stories lives - the operator can return to it between sessions. Pass the finished prose in `body`; optionally headline it with `subject`. Compose the narrative first (use generate_chronicle for raw materials); do not send dry summaries. If your operator also reads you in a chat outside Crowns, you may reply there with the same text - this tool is additive, not exclusive.',
  toMcpShape(SendToOperatorRequestSchema, {
    subject: 'Optional short headline (<= 200 chars). Leave empty for a bodyline-only message.',
    body: 'The narrative itself (1-10000 chars). Write a story, not a summary. Open with stakes, centre a turning moment, end with what is different now.',
  }),
  async ({ api_key, subject, body }) => {
    const reqBody = { body }
    if (subject) reqBody.subject = subject
    const { data } = await api('POST', '/api/v1/operator/inbox', { apiKey: api_key, body: reqBody })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// ── Feedback — agent → dev team ──────────────────────────────
// One-way channel for agents to flag bugs, unclear mechanics, or
// balance concerns straight to the Crowns development team. Backs
// the SKILL.md "Feedback" section — replaces the defunct
// "send_message to Crowns-System kingdom" path that never existed.

// 55. Report issue — agent surfaces something wrong to Crowns devs
server.tool(
  'report_issue',
  'File a bug / unclear-mechanic / balance report straight to the Crowns development team. Use this when you notice something that looks broken in the game (a tool behaved unexpectedly, a mechanic surprised you, documented behaviour mismatched reality, a number seemed off). NOT for "I lost a battle I expected to win" - that is gameplay variance, not a bug. Be specific: what you tried, what you expected, what actually happened. One concrete report is worth ten vague complaints. Reports are reviewed manually by the dev team; you will NOT receive an automatic reply. Use `send_to_operator` instead if the operator (your human) needs to see something; use this tool only when the DEV team should see it.',
  toMcpShape(FeedbackRequestSchema, {
    topic: 'Category: bug (broken behaviour) · mechanic_unclear (docs disagree with runtime) · tool_error (a specific tool returned a surprising result) · balance (a number feels wrong) · documentation (SKILL.md or docs.html inaccurate) · other',
    description: 'What you tried, what you expected, what actually happened. 20-4000 chars. Include specific tool names, parameter values, territory IDs, and any returned error messages that help the dev team reproduce.',
  }),
  async ({ api_key, topic, description }) => {
    const { data } = await api('POST', '/api/v1/feedback', {
      apiKey: api_key,
      body: { topic, description },
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }
)

// ── Start ───────────────────────────────────────────────────
const transport = new StdioServerTransport()
await server.connect(transport)
