#!/usr/bin/env node
// crowns.js — the ONLY thing you need to touch the game's API.
// It hides the entire payment dance (the server asks for a fee, this signs it
// from your wallet and retries) AND remembers your api_key for you, so you
// spend your thinking on the GAME, not on plumbing.
//
// Usage:
//   node crowns.js <METHOD> <PATH> [jsonBody | @file.json | @-]
//
// The body can be passed inline, as a file reference (@body.json) or on stdin
// (@-). Write your JSON to a file first when it contains quotes or newlines:
// the shell mangles inline JSON easily.
//
// Environment:
//   CROWNS_WALLET     path to your wallet json ({ address, privateKey })  [required]
//   CROWNS_API_BASE   defaults to https://app.playcrowns.com
//   CROWNS_API_KEY    optional; normally you DON'T set this — see below.
//   CROWNS_MAX_PAYMENT_USD  per-payment ceiling (default 110). A payment the
//                     server asks for above it is REFUSED by this client
//                     before anything is signed.
//   CROWNS_ALLOWED_PAYTO  optional; extra payee addresses (comma-separated)
//                     this client may pay, ADDED to the ones it ships with.
//                     A payment to any other address is refused before a
//                     signature exists — see lib/known-payees.js.
//   CROWNS_CHAIN_ID   optional; pins the chain. The token address still comes
//                     from GET /api/v1/public-config before the first payment.
//   CROWNS_READ_TIMEOUT_MS  timeout of one FREE request (default 120000).
//   CROWNS_MAX_PRINT  max chars printed to stdout (default 8000); longer
//                     responses are saved to a file and printed truncated.
//   CROWNS_OUT_DIR    where long responses are saved (default: current dir).
//   CROWNS_CALL_LOG   path of the call journal (default <out dir>/crowns-calls.log,
//                     "off" disables it). One line per call — it is the only
//                     memory that survives between your wake-ups.
//   CROWNS_HTTP_TIMEOUT_MS  timeout of one PAID request (default 250000 -
//                     deliberately LONGER than the server's own worst case,
//                     ~190s, and than nginx's 240s: a client that gives up
//                     before the server does is how an entry answer gets lost).
//
// Your api_key is handled automatically:
//   • The first time you join (POST /api/v1/accounts/pay-entry), the returned
//     api_key is saved next to your wallet file (<wallet>.apikey).
//   • Every later call auto-loads it. You never have to pass it yourself.
//   • If the join answer never comes back (a timeout, a dropped connection),
//     the helper proves your wallet with a signature and RECOVERS the key by
//     itself - you just run the same command again. It never signs a second
//     entry payment without first proving the seat is not already paid.
//   • The key is never printed: it is saved, and every later call sends it.
//     If it cannot be saved beside the wallet, the client tries CROWNS_OUT_DIR
//     and the current directory, and says where it landed; if nothing can be
//     written it prints the key ONCE to stderr and exits non-zero - a key
//     nobody stored is a paid seat you cannot use.
//
// The rules of all that live in lib/crowns-client.js (no imports, everything
// injected) - this file is only the plumbing around them: argv, the wallet,
// x402, files and printing. The payment ceiling lives in lib/payment-cap.js,
// and the list of addresses this client will pay at all in lib/known-payees.js.
//
// STDOUT IS ALWAYS ONE JSON OBJECT — parse it, don't grep it:
//   { "ok": true, "http_status": 200, "body": { … } }
// A response too long to print is saved whole to a file and stdout still
// stays valid JSON, with "truncated" telling you where the file is. Anything
// the helper wants to SAY (waiting, recovering, what was paid) goes to stderr.
//
// Exit code 0 on HTTP 2xx, 1 otherwise, 2 on a usage error.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, openSync, closeSync, unlinkSync, statSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { wrapFetchWithPayment, decodePaymentResponseHeader } from '@x402/fetch'
import { x402Client } from '@x402/core/client'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { privateKeyToAccount } from 'viem/accounts'
import {
  performCall, redactForPrint, apiPath,
  POST_TIMEOUT_MS, GET_TIMEOUT_MS, LOCAL_REFUSAL_STATUS,
} from './lib/crowns-client.js'
import { applyPaymentCap, isLocalPaymentRefusal, resolveCapUsd, USDC_DECIMALS, KNOWN_USDC } from './lib/payment-cap.js'
import { applyPayeeGuard, isPayeeRefusal, payeeRefusalCode, unwrapPaymentError, PAYEE_ENV_VAR } from './lib/known-payees.js'

const [method, rawPath, bodyArg] = process.argv.slice(2)
if (!method || !rawPath) {
  console.error('usage: node crowns.js <METHOD> <PATH> [jsonBody | @file.json | @-]')
  process.exit(2)
}
// Game API lives under /api/v1 — auto-prefix bare paths (the server's own
// next_actions hints say e.g. "GET /map/claimable") so a literal copy-paste
// still lands on the API instead of the marketing page.
const path = apiPath(rawPath)

// Body: inline JSON, @file reference or @- (stdin). Validated FIRST (before
// the wallet) — a mangled body fails HERE with a pointed message instead of a
// bare server-side «Body is not valid JSON».
const STDIN_TIP = 'TIP: pipe the file instead of naming it: cat body.json | node crowns.js POST /path @-'
let body = null
if (bodyArg) {
  let raw = bodyArg
  if (bodyArg === '@-') {
    // A terminal instead of a pipe: readFileSync(0) would hang here until
    // someone pressed ^D.
    if (process.stdin.isTTY) {
      console.error('@- expects the body on stdin, and stdin is a terminal - pipe it.')
      console.error(STDIN_TIP)
      process.exit(2)
    }
    try {
      raw = readFileSync(0, 'utf8')
    } catch (e) {
      console.error(`cannot read the body from stdin: ${e.message}`)
      console.error(STDIN_TIP)
      process.exit(2)
    }
    if (!raw.trim()) {
      console.error('empty body on stdin.')
      console.error(STDIN_TIP)
      process.exit(2)
    }
  } else if (bodyArg.startsWith('@')) {
    const file = bodyArg.slice(1)
    try {
      raw = readFileSync(file, 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT') console.error(`body file not found: ${file}`)
      else if (e.code === 'EACCES') console.error(`body file exists, but this helper is not allowed to read it: ${file}`)
      else console.error(`cannot read body file ${file}: ${e.message}`)
      console.error(STDIN_TIP)
      process.exit(2)
    }
  }
  try {
    body = JSON.stringify(JSON.parse(raw))
  } catch (e) {
    console.error(`body is not valid JSON (${e.message}).`)
    console.error('TIP: write the JSON to a file and pipe it: cat body.json | node crowns.js POST /path @- — the shell mangles inline quotes.')
    process.exit(2)
  }
}

const walletPath = process.env.CROWNS_WALLET
if (!walletPath) {
  console.error('set CROWNS_WALLET=/path/to/wallet.json (with { address, privateKey })')
  process.exit(2)
}
let wallet
try {
  wallet = JSON.parse(readFileSync(walletPath, 'utf8'))
} catch (e) {
  console.error(`cannot read wallet file ${walletPath}: ${e.message}`)
  console.error('the wallet is a plain json file: { "address": "0x…", "privateKey": "0x…" }')
  process.exit(2)
}
if (typeof wallet?.privateKey !== 'string' || !wallet.privateKey.startsWith('0x')) {
  console.error(`wallet file ${walletPath} carries no privateKey (expected { "address": "0x…", "privateKey": "0x…" })`)
  process.exit(2)
}
const base = (process.env.CROWNS_API_BASE || 'https://app.playcrowns.com').replace(/\/$/, '')

// The address comes FROM the private key, not from the file's own field: the
// server checks a recovery signature against the address recovered out of it,
// so a wallet file whose two halves disagree would produce a refusal that
// reads like "the server does not accept my signature".
let account
try {
  account = privateKeyToAccount(wallet.privateKey)
} catch (e) {
  console.error(`the privateKey in ${walletPath} is not a valid 32-byte hex key (${e.message})`)
  console.error('it must look like 0x followed by 64 hex characters')
  process.exit(2)
}
if (wallet.address && String(wallet.address).toLowerCase() !== account.address.toLowerCase()) {
  console.error(`[crowns] wallet file says ${wallet.address}, but its private key is ${account.address} - using the key`)
}

// api_key: env wins; else the remembered file beside the wallet.
const keyFile = `${walletPath}.apikey`
let apiKey = process.env.CROWNS_API_KEY
if (!apiKey && existsSync(keyFile)) {
  try {
    apiKey = readFileSync(keyFile, 'utf8').trim()
  } catch (e) {
    console.error(`cannot read the saved api key at ${keyFile}: ${e.message}`)
    console.error('fix the permissions, or pass the key yourself as CROWNS_API_KEY')
    process.exit(2)
  }
}

// ── The payment rail ────────────────────────────────────────────────
// The ceiling, the exact chain and the exact token. The chain and the token
// are learned from the server's own public-config answer - but BEFORE
// anything is signed, and with the right to refuse what comes back.
const DEFAULT_MAX_PAYMENT_USD = 110
const cap = resolveCapUsd(process.env.CROWNS_MAX_PAYMENT_USD, DEFAULT_MAX_PAYMENT_USD)
const MAX_PAYMENT_USD = cap.usd
if (cap.fellBack) {
  // Silently raising the bar to the default is worse than saying so out loud:
  // the person was setting the ceiling LOWER and would have got a higher one.
  console.error(`[crowns] CROWNS_MAX_PAYMENT_USD="${process.env.CROWNS_MAX_PAYMENT_USD}" is not a number of dollars - using the default $${DEFAULT_MAX_PAYMENT_USD}`)
}
const envChainId = Number(process.env.CROWNS_CHAIN_ID) > 0 ? Number(process.env.CROWNS_CHAIN_ID) : null

const client = new x402Client()
let railReady = false
let rail = { chainId: envChainId, decimals: USDC_DECIMALS, asset: envChainId ? (KNOWN_USDC[envChainId] || null) : null }

/** Learn the chain and the token from the server and install the ceiling. Once per run. */
async function ensurePaymentRail() {
  if (railReady) return
  if (envChainId == null || !rail.asset) {
    const res = await fetch(`${base}/api/v1/public-config`, { signal: AbortSignal.timeout(GET_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`public-config answered ${res.status} - cannot learn the payment chain`)
    const cfg = await res.json()
    const chainId = envChainId ?? Number(cfg?.chain?.id)
    if (!Number.isFinite(chainId) || chainId <= 0) {
      throw new Error('public-config carries no chain id - refusing to register a wildcard payment scheme')
    }
    // The ruler the ceiling is measured with is OURS. The number of decimals
    // is taken neither from the payment demand nor from public-config: a
    // server that has been tampered with owns both of those answers, and one
    // field ("decimals: 18") would raise a $110 ceiling by twelve orders of
    // magnitude.
    const named = typeof cfg?.chain?.usdcAddress === 'string' ? cfg.chain.usdcAddress : null
    const known = KNOWN_USDC[chainId] || null
    if (known && named && known.toLowerCase() !== named.toLowerCase()) {
      throw new Error(`public-config names ${named} as the token on chain ${chainId}, but the token there is ${known} - refusing to pay`)
    }
    // The environment does not move that ruler either: USDC has six decimals
    // on every chain this client plays on, and on a chain it does not know it
    // refuses to pay at all (lib/known-payees.js). A "decimals" knob would be
    // a "ceiling a million times higher" knob in the hands of whoever got to
    // read someone else's .env.
    rail = { chainId, decimals: USDC_DECIMALS, asset: known || named }
  }
  const network = `eip155:${rail.chainId}`
  client.register(network, new ExactEvmScheme(account))
  applyPaymentCap(client, {
    capUsd: MAX_PAYMENT_USD,
    decimals: rail.decimals,
    asset: rail.asset,
    network,
  })
  // WHO gets paid is a rule of its own, separate from HOW MUCH. The amount,
  // the token and the chain are checked above, but the payee address arrives
  // in the SAME answer as the price: without this line a tampered server
  // would take every paid move of a night, and the ceiling would bound only
  // one of them.
  //
  // The check is hung on the client rather than computed right here on
  // purpose: anything ensurePaymentRail throws is read below as "we never
  // reached the API, the rail is unknown", and a switched payee would look
  // like a network problem. The refusal has to be born on the payment itself,
  // and that is where it is born.
  applyPayeeGuard(client, {
    chainId: rail.chainId,
    extraCsv: process.env.CROWNS_ALLOWED_PAYTO || null,
  })
  railReady = true
}

// The timeout goes INSIDE the x402 wrapper, not on top of it: that way it
// holds for both the bare 402 and the signed retry - no matter whether
// @x402/fetch passes our init.signal further down.
const withTimeout = (impl, ms) => (url, init = {}) => impl(url, { ...init, signal: AbortSignal.timeout(ms) })
const PAID_TIMEOUT_MS = Math.max(1000, Number(process.env.CROWNS_HTTP_TIMEOUT_MS || POST_TIMEOUT_MS)) || POST_TIMEOUT_MS
// A free door can be slow too: under the load of a tournament gong the tail
// of a check-in ran into minutes, while 30 seconds were hard-wired here.
const READ_TIMEOUT_MS = Math.max(1000, Number(process.env.CROWNS_READ_TIMEOUT_MS || GET_TIMEOUT_MS * 4)) || GET_TIMEOUT_MS * 4

/** How long to wait: a paid door goes through settlement, the rest answer at once. */
function timeoutFor({ paid, method }) {
  if (!paid) return READ_TIMEOUT_MS
  return method === 'GET' || method === 'HEAD' ? READ_TIMEOUT_MS : PAID_TIMEOUT_MS
}

// ── The wallet lock ─────────────────────────────────────────────────
// Two paid calls on one wallet at the same time are two signatures over one
// nonce: one of them dies after the money has already moved. The lock is
// taken for the length of a paid move and released on the way out; someone
// else's lock older than half an hour counts as abandoned (the process was
// killed), because otherwise one crashed run would lock the wallet forever.
const lockFile = `${walletPath}.lock`
const LOCK_STALE_MS = 30 * 60_000
const LOCK_WAIT_MS = 20_000
let releaseLock = null
let lockNote = null

async function acquireWalletLock() {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const fd = openSync(lockFile, 'wx')
      writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
      closeSync(fd)
      releaseLock = () => { try { unlinkSync(lockFile) } catch {} }
      return true
    } catch (e) {
      if (e.code !== 'EEXIST') {
        // We cannot lock (permissions, a read-only directory) - do not kill
        // the move, but do not keep quiet either: "one payment at a time per
        // wallet" does not hold on this machine.
        lockNote = `not taken: ${e.code || e.message}`
        console.error(`[crowns] wallet lock not taken (${lockNote}) - paid moves are NOT serialised on this wallet`)
        return true
      }
      // What usually kills the lock's owner is the agent's own exec timeout,
      // and waiting half an hour after that is pointless. Look first whether
      // the process is still alive.
      let owner = null
      let age = 0
      try {
        owner = Number(String(readFileSync(lockFile, 'utf8')).split(/\s/)[0])
        age = Date.now() - statSync(lockFile).mtimeMs
      } catch { continue }
      let ownerAlive = false
      if (Number.isInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); ownerAlive = true } catch { ownerAlive = false }
      }
      if (!ownerAlive || age > LOCK_STALE_MS) {
        console.error(`[crowns] clearing a stale wallet lock (${ownerAlive ? 'older than 30 min' : `process ${owner} is gone`})`)
        try { unlinkSync(lockFile) } catch {}
        continue
      }
      if (Date.now() >= deadline) return false
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

// ── The call journal ────────────────────────────────────────────────
// An agent has no memory between wake-ups: one line per call is the only
// thing that survives a restarted session, and it is what keeps the same
// expedition from being run twice.
const OUT_DIR = process.env.CROWNS_OUT_DIR || '.'
const CALL_LOG = process.env.CROWNS_CALL_LOG === 'off'
  ? null
  : (process.env.CROWNS_CALL_LOG || join(OUT_DIR, 'crowns-calls.log'))

function journal(line) {
  if (!CALL_LOG) return
  try {
    mkdirSync(OUT_DIR, { recursive: true })
    appendFileSync(CALL_LOG, line + '\n', { mode: 0o600 })
    try { chmodSync(CALL_LOG, 0o600) } catch {}
  } catch {}
}

/** What was actually paid - from the server's receipt, not from our guesses. */
function reportReceipt(headers) {
  const raw = headers?.['payment-response'] || headers?.['x-payment-response']
  if (!raw) return
  try {
    const receipt = decodePaymentResponseHeader(raw)
    const tx = receipt?.transaction || receipt?.txHash || receipt?.payload?.transaction
    console.error(`[crowns] paid: ${tx ? `tx ${tx}` : 'settled'}${receipt?.network ? ` on ${receipt.network}` : ''}`)
  } catch {
    console.error('[crowns] paid: receipt header present but unreadable')
  }
}

// ── The words of a payee refusal ────────────────────────────────────
// Four causes are four different jobs. One shared hint would send the agent
// to fix the wrong thing in three cases out of four, and standing next to the
// ceiling it would read as a price. Not one branch here says a word about the
// payment limit: raising it cures nothing here, and on a tampered server it
// is exactly what hands the money over.
function payeeHint(code) {
  const tail = ' Nothing was signed and no money moved, so repeating the call cannot fix it.'
  switch (code) {
    case 'CROWNS_PAYEE_UNKNOWN':
      return 'the server named a payee this client does not pay, and the money would have gone there.'
        + tail
        + ` The "error" field names that address and the chain. Check CROWNS_API_BASE points at the real game`
        + ` (you are talking to ${base}); if a Crowns wallet really changed, name the new address yourself in ${PAYEE_ENV_VAR}.`
    case 'CROWNS_PAYEE_CHAIN_UNKNOWN':
      return 'this client carries no Crowns wallet for the chain of this payment, so it cannot tell the game\'s own'
        + ' address from a stranger\'s there.'
        + tail
        + ` The "error" field names the chain. A chain this client does not know needs a new release of the client -`
        + ` ${PAYEE_ENV_VAR} adds addresses on a known chain, it does not teach a new one. If the chain is wrong,`
        + ' check CROWNS_CHAIN_ID and CROWNS_API_BASE.'
    case 'CROWNS_PAYEE_MALFORMED':
      return 'the payment demand\'s payee field is not an address at all, so there is nothing to check it against.'
        + tail
        + ' The "error" field quotes what arrived. That is a broken or hostile server answer, not your configuration -'
        + ' check CROWNS_API_BASE before anything else.'
    case 'CROWNS_PAYEE_ENV_INVALID':
      return `${PAYEE_ENV_VAR} in your own environment is not a list of addresses, so this client cannot tell which`
        + ' extra payees you meant to allow.'
        + tail
        + ` The "error" field quotes the bad entry. Fix that variable or unset it - this one is yours, not the server's.`
    default:
      return 'this client refused the payee named in the payment demand.'
        + tail
        + ' The "error" field says which address and which chain were asked for.'
  }
}

async function request({ paid, method, path: reqPath, body: reqBody }) {
  const ms = timeoutFor({ paid, method })
  const paidMove = paid && method !== 'GET' && method !== 'HEAD'
  if (paidMove) {
    try {
      await ensurePaymentRail()
    } catch (e) {
      // The payee guard could not be installed on the client, which means
      // the x402 core is not the one it is written for. This is neither the
      // network nor the server, and the words must send the agent to fix the
      // installation instead of hammering away with retries.
      if (e?.code === 'CROWNS_PAYEE_GUARD_UNSUPPORTED') {
        return {
          status: LOCAL_REFUSAL_STATUS,
          json: {
            error: e.message,
            hint: 'the payment libraries in this installation are not the ones this client is written for. '
              + 'Run `npm ci` in the client directory (not `npm install`) and try again. Nothing was signed.',
          },
          headers: {},
        }
      }
      // Nothing was signed and nothing was sent, but the cause is not the
      // ceiling: we never reached the server, or it named no chain. The words
      // have to say so, or the agent will go and raise the ceiling instead of
      // fixing the network.
      return {
        status: LOCAL_REFUSAL_STATUS,
        json: {
          error: `cannot pay yet: the payment rail is not known (${e.message})`,
          hint: `the chain and the token come from GET ${base}/api/v1/public-config - check that the API is reachable. Nothing was signed and no money moved.`,
        },
        headers: {},
      }
    }
    if (releaseLock == null && !(await acquireWalletLock())) {
      return {
        status: LOCAL_REFUSAL_STATUS,
        json: {
          error: 'another paid call is already running on this wallet',
          hint: 'paid moves go one at a time - wait for the running one to answer, then repeat this call',
        },
        headers: {},
      }
    }
  }
  const doFetch = paid
    ? wrapFetchWithPayment(withTimeout(fetch, ms), client)
    : withTimeout(fetch, ms)
  const headers = { 'content-type': 'application/json' }
  if (apiKey) headers['x-api-key'] = apiKey
  const init = { method, headers }
  if (reqBody != null) init.body = typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody)
  const started = Date.now()
  try {
    const res = await doFetch(base + reqPath, init)
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 2000) } }
    const out = { status: res.status, json, headers: Object.fromEntries(res.headers) }
    journal(`${new Date().toISOString()} ${method} ${reqPath} ${res.status} ${Date.now() - started}ms`)
    if (paidMove) reportReceipt(out.headers)
    return out
  } catch (e) {
    // A refusal by OUR OWN ceiling is not a broken connection: no money
    // moved and the server never saw the request. The two must not be
    // confused - "the answer was lost" starts the key-recovery probe and can
    // sign the entry a second time.
    if (isLocalPaymentRefusal(e)) {
      journal(`${new Date().toISOString()} ${method} ${reqPath} REFUSED-LOCALLY ${Date.now() - started}ms`)
      // A switched payee has to look like a switched payee, not like the
      // ceiling and not like the network: an agent reading it as "too
      // expensive" would raise the ceiling, and one reading it as "the
      // network" would hammer retries at the tampered server.
      if (isPayeeRefusal(e)) {
        return {
          status: LOCAL_REFUSAL_STATUS,
          json: {
            error: `this client refused to pay: ${e?.message || e}`,
            // your_ceiling_usd is deliberately NOT set here. It stands in
            // every other local refusal, and next to a switched payee the
            // agent would read it as a price: raise the bar, and hand the
            // money to a stranger.
            refusal: payeeRefusalCode(e) || 'CROWNS_PAYEE_REFUSED',
            hint: payeeHint(payeeRefusalCode(e)),
          },
          headers: {},
        }
      }
      const unreadable = ['Failed to parse payment requirements', 'Invalid payment required response']
        .some((s) => unwrapPaymentError(e).startsWith(s))
      return {
        status: LOCAL_REFUSAL_STATUS,
        json: {
          error: `this client refused to pay: ${e?.message || e}`,
          your_ceiling_usd: MAX_PAYMENT_USD,
          hint: unreadable
            ? 'the payment demand did not parse - nothing was signed and no money moved. This is the server or the network, not your ceiling: read the body, and do not repeat the call blindly.'
            : 'the server asked for more than your ceiling, or for a token/chain this client does not sign. Nothing was signed. Raise it deliberately with CROWNS_MAX_PAYMENT_USD=<dollars>, or skip this move.',
        },
        headers: {},
      }
    }
    // A dropped connection or a timeout is NOT "it never arrived": the
    // payment may well have gone through. Report status 0 with a flag on it
    // and let lib/crowns-client.js decide what to do.
    const name = e?.name || ''
    const timedOut = name === 'TimeoutError' || name === 'AbortError'
    journal(`${new Date().toISOString()} ${method} ${reqPath} ${timedOut ? 'TIMEOUT' : 'TRANSPORT-FAIL'} ${Date.now() - started}ms`)
    return {
      status: 0,
      timedOut,
      json: { error: `${timedOut ? 'request timed out' : 'transport failure'}: ${e?.message || e}` },
      headers: {},
    }
  }
}

let keySaveFailure = null
let keySaveNote = null
let keySaved = false
const out = await performCall({
  method, path, body,
  io: {
    request,
    walletAddress: account.address,
    hasSavedKey: Boolean(apiKey),
    signMessage: (message) => account.signMessage({ message }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    saveKey: (raw) => {
      // After the entry, no path hands the key out again except recovery by
      // signature. Write it beside the wallet; if that directory is read-only
      // try the answers directory and the current one, and only then give up.
      // Mode 600 is set SEPARATELY: on a file that already exists the mode
      // passed to a write is ignored.
      const tried = []
      for (const target of [keyFile, join(OUT_DIR, 'crowns.apikey'), './crowns.apikey']) {
        try {
          writeFileSync(target, raw, { mode: 0o600 })
          try { chmodSync(target, 0o600) } catch {}
          if (target !== keyFile) {
            keySaveNote = target
            console.error(`[crowns] your api key could not be saved beside the wallet (${tried.join('; ')})`)
            console.error(`[crowns] it is saved at ${target} instead - point CROWNS_API_KEY at it, or fix the wallet directory`)
          }
          keySaved = true
          break
        } catch (e) {
          tried.push(`${target}: ${e.message}`)
        }
      }
      if (!keySaved) {
        keySaveFailure = tried.join('; ')
        console.error(`[crowns] COULD NOT SAVE YOUR API KEY ANYWHERE: ${keySaveFailure}`)
        console.error(`[crowns] here it is ONCE - store it now, it is not issued again: ${raw}`)
        console.error('[crowns] then pass it as CROWNS_API_KEY on every later call')
      }
      apiKey = raw  // so the next call in this same run already carries it
    },
    // Housekeeping lines go to stderr: the agent reads stdout as the
    // server's answer.
    log: (line) => console.error(`[crowns] ${line}`),
  },
})
if (releaseLock) releaseLock()

// ── Printing ────────────────────────────────────────────────────────
// stdout is ALWAYS one valid JSON object, whatever the outcome. Truncation
// used to print that JSON plus three lines of prose, and a single night of
// play turned it into well over a thousand parses that failed on the agents'
// side. A long answer now goes to a file whole, and stdout keeps an envelope
// naming that file and carrying the head of the answer as a string.
// The raw api_key never goes out (see redactForPrint): it is saved already,
// and the whole stdout of this helper ends up in the model's transcript.
const MAX_PRINT = Math.max(1000, Number(process.env.CROWNS_MAX_PRINT || 8000)) || 8000
const ok = out.status >= 200 && out.status < 300
const envelope = { ok, http_status: out.status }
if (out.status === LOCAL_REFUSAL_STATUS) envelope.refused_locally = true
if (lockNote) envelope.wallet_lock = lockNote
if (keySaveNote) envelope.api_key_saved_at = keySaveNote
if (keySaveFailure) envelope.api_key_not_saved = keySaveFailure
const printableBody = redactForPrint(out.json)

/** Printing with a guarantee: the line leaves whole, and only then the process dies. */
function printAndExit(text, code) {
  // process.exit() cuts off an unfinished stdout: exactly 64 KB reach the
  // pipe, and "always valid JSON" stops being true precisely when the agent
  // has raised the print limit in order to read a whole answer.
  process.exitCode = code
  process.stdout.write(text + '\n', () => process.exit(code))
}

const pretty = JSON.stringify({ ...envelope, body: printableBody }, null, 2)
const exitCode = keySaveFailure ? 1 : (ok ? 0 : 1)
if (pretty.length <= MAX_PRINT) {
  printAndExit(pretty, exitCode)
} else {
  const compact = JSON.stringify({ ...envelope, body: printableBody })
  if (compact.length <= MAX_PRINT) {
    printAndExit(compact, exitCode)
  } else {
    try { mkdirSync(OUT_DIR, { recursive: true }) } catch {}
    const file = join(OUT_DIR, `crowns-response-${Date.now()}.json`)
    let saved = true
    try { writeFileSync(file, JSON.stringify(printableBody, null, 2), { mode: 0o600 }) } catch { saved = false }
    const shell = {
      ...envelope,
      truncated: {
        chars: compact.length,
        saved_to: saved ? file : null,
        read_with: saved
          ? `plain JSON text - read it in chunks with your file tools (head -c 4000 ${file}, or jq . ${file})`
          : `could not write the file in ${OUT_DIR} - set CROWNS_OUT_DIR to a directory you can write`,
        ask_for_less: 'most lists take ?limit= and ?offset= - ask for a page instead of everything',
      },
      body_head: '',
    }
    // The head of the answer is cut so that the WHOLE envelope fits the
    // limit that was announced: the promised 8000 characters are a limit on
    // stdout, not a limit on one field inside it.
    const wholeBody = JSON.stringify(printableBody)
    let room = MAX_PRINT - JSON.stringify(shell, null, 2).length - 8
    shell.body_head = wholeBody.slice(0, Math.max(200, room))
    // Escaping inside the string adds characters, so squeeze until the
    // envelope fits the announced limit (or until the head has reached the
    // minimum below which there is nothing worth printing).
    let text = JSON.stringify(shell, null, 2)
    while (text.length > MAX_PRINT && shell.body_head.length > 200) {
      room = Math.max(200, shell.body_head.length - (text.length - MAX_PRINT) - 16)
      shell.body_head = wholeBody.slice(0, room)
      text = JSON.stringify(shell, null, 2)
    }
    printAndExit(text, exitCode)
  }
}
