// The rules of the Crowns client, separated from everything external.
//
// There is not a single import here: HTTP, the wallet, files, the clock and
// printing all arrive by injection (the `io` object). That is what lets these
// rules be run by unit tests against a fake fetch - and it is also what makes
// them fit to be the public example client: a reader sees the RULES, not the
// plumbing around them.
//
// ── Why this file exists at all ─────────────────────────────────────
//
// On a rehearsal night with thirty agents, two of them could not get into the
// game on their own. The chain went like this: the agent's own exec timeout
// (60s, and 30s) killed POST /accounts/pay-entry in the middle of settlement
// (an entry takes a median of 7s, but the server's worst case is ~190s) ->
// the answer carrying the api_key was lost -> the repeated call signed a
// FRESH nonce, so the server's cached branch, the one with the recovery hint
// in it, was unreachable -> the agent read 409 "This wallet already has a
// kingdom this tournament" and had no idea what to do -> it hammered
// recover-key without a signature, burning the shared rate limit.
//
// Hence the three rules below:
//   1. the client does not give up before the server does (timeouts with
//      room to spare);
//   2. on "the seat is paid, the key is missing" the client proves the
//      wallet with a signature and fetches the key ITSELF - the agent does
//      not have to think about any of it;
//   3. a second payment is signed ONLY on proof that there is no seat (a 404
//      from recover-key), never "just in case".

// A paid POST door goes through the same settlement as the entry: the server
// gives up on its own at about 190s (180s waiting for the receipt plus nonce
// retries), and nginx cuts the upstream at 240s. A client that gives up
// EARLIER than the server is precisely what produces lost answers - hence
// 250s, "outlive nginx as well". A shorter timeout speeds nothing up: all it
// breeds is 409 "this wallet already has a kingdom".
export const POST_TIMEOUT_MS = 250_000
export const GET_TIMEOUT_MS = 30_000
// The pause before probing after a broken entry: let the settlement and the
// journal write arrive, so the probe sees a finished seat and not "pending".
export const SETTLE_GRACE_MS = 15_000
// 429: waiting a minute or two makes sense. An hour-long window (the wallet
// bucket) must not be waited out - print the body and leave, let a human
// decide.
export const MAX_RATE_LIMIT_WAIT_S = 90
export const MAX_RATE_LIMIT_WAITS = 2
// Signed entry attempts per run - two at the most, and the second one only
// on proof (see joinTheGame).
export const MAX_ENTRY_PAYMENTS = 2
// Retries for the facilitator's transient sweat on ordinary paid doors.
export const TRANSIENT_RETRIES = 4
export const TRANSIENT_PAUSE_MS = 8_000

// A local refusal to pay (our own ceiling, a foreign token, a foreign chain)
// is NOT a lost answer: no money moved, repeating blindly is wrong, and
// signing a second entry is worse still. The plumbing hands it back under a
// status of its own.
export const LOCAL_REFUSAL_STATUS = -1

export const PAY_ENTRY_PATH = '/api/v1/accounts/pay-entry'
export const RECOVER_KEY_PATH = '/api/v1/accounts/recover-key'

/**
 * The game API lives under /api/v1 - bare paths get the prefix, so that
 * copying the server's own hint literally ("GET /map/claimable") still lands
 * on the API instead of on the marketing page.
 */
export function apiPath(rawPath) {
  const p = String(rawPath || '')
  if (p.startsWith('/api/')) return p
  return '/api/v1' + (p.startsWith('/') ? p : '/' + p)
}

/** How long to wait on a 429: the header beats the body, and both may be absent. */
export function retryAfterSeconds(res) {
  const raw = res?.headers?.['retry-after']
  const fromHeader = Number(raw)
  if (raw != null && Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader
  const fromBody = Number(res?.json?.retry_after_seconds)
  if (Number.isFinite(fromBody) && fromBody >= 0) return fromBody
  return null
}

/**
 * There was no answer in substance: a drop, a timeout, a 5xx. The entry may
 * still have ARRIVED.
 *
 * A local refusal to pay does NOT land here: the request never reached the
 * server, the seat is not paid, and a recovery probe would only burn one of
 * the five attempts an hour.
 */
export function answerLost(res) {
  if (res?.status === LOCAL_REFUSAL_STATUS) return false
  return !!res?.timedOut || res?.status === 0 || res?.status >= 500
}

/**
 * One request, with honest waiting on a 429.
 *
 * A 429 comes from two different places: the rate limiter (its body carries
 * `max` and `window_seconds`) and the guard against paying twice for the same
 * target (no `max`). Waiting is right in both cases, and in both the server
 * says how long itself.
 */
async function send(io, req) {
  let waited = 0
  for (;;) {
    const res = await io.request(req)
    if (res.status !== 429) return res
    const after = retryAfterSeconds(res)
    if (after == null || after > MAX_RATE_LIMIT_WAIT_S || waited >= MAX_RATE_LIMIT_WAITS) return res
    waited += 1
    io.log(`rate limited (${res.json?.message || 'no message'}) - waiting ${after}s`)
    await io.sleep(after * 1000)
  }
}

/**
 * Fetch the key of a paid seat by proving the wallet with a signature.
 *
 * The client NEVER composes the string to sign itself - that string is bound
 * to the tournament, and only the server has the right to name it. When the
 * server already named it in the answer we are reacting to
 * (`key_recovery.sign_exactly`), take it from there; otherwise ask first: a
 * POST carrying only wallet_address answers 400 and carries `sign_exactly`.
 */
// We sign ONLY a key-recovery string, and only one with our own address
// inside it: the server is the one that names the string, and without this
// check a foreign or tampered server could ask for a signature over anything
// at all.
const RECOVERY_PREFIX = 'Crowns key recovery:'

function refuseToSign(message) {
  return {
    status: LOCAL_REFUSAL_STATUS,
    json: {
      error: 'this client refused to sign what the server asked for',
      asked_to_sign: String(message).slice(0, 200),
      hint: `a key-recovery message must start with "${RECOVERY_PREFIX}" and name your own wallet. Nothing was signed.`,
    },
    headers: {},
  }
}

/** The recovery probe: `proved` means a wallet signature really did go out. */
async function recoverKey(io, signExactly) {
  let message = signExactly
  if (typeof message !== 'string' || !message) {
    const probe = await send(io, {
      paid: false, method: 'POST', path: RECOVER_KEY_PATH,
      body: { wallet_address: io.walletAddress },
    })
    message = probe.json?.sign_exactly
    // Not a 400-with-the-string: the door is shut (no tournament, a 429,
    // junk in the body) - hand the answer back as it is, the agent will read
    // the reason in words.
    if (typeof message !== 'string' || !message) return probe
  }
  const wallet = String(io.walletAddress || '').toLowerCase()
  if (!message.startsWith(RECOVERY_PREFIX) || (wallet && !message.toLowerCase().includes(wallet))) {
    return refuseToSign(message)
  }
  const signature = await io.signMessage(message)
  const res = await send(io, {
    paid: false, method: 'POST', path: RECOVER_KEY_PATH,
    body: { wallet_address: io.walletAddress, signature },
  })
  if (typeof res.json?.api_key === 'string') io.saveKey(res.json.api_key)
  res.proved = true   // this answer came back to a SIGNED request
  return res
}

/**
 * Entering the game - the one door where a lost answer costs a seat.
 *
 * Recovery is called ONLY while there is no key file yet: every successful
 * recover ROTATES the key, so on a live key it would kill it.
 */
async function joinTheGame({ io, method, path, body }) {
  if (io.hasSavedKey) {
    // The key file beside the wallet may be OLD: a wallet outlives a
    // tournament, a key dies with it. An entry paid on top of an old file
    // returns a NEW key - and that new key used to be dropped silently: the
    // agent paid $50 and then played with a dead key, getting a 401 on every
    // call.
    const res = await send(io, { paid: true, method, path, body })
    if (typeof res.json?.api_key === 'string') io.saveKey(res.json.api_key)
    return res
  }

  let res = await send(io, { paid: true, method, path, body })
  if (res.status === LOCAL_REFUSAL_STATUS) return res
  let payments = 1
  for (;;) {
    // The key arrived - the ordinary, happy case.
    if (typeof res.json?.api_key === 'string') { io.saveKey(res.json.api_key); return res }

    // The server named the recovery door itself: a 200 with api_key: null
    // (the same payment header replayed) or a 409 "this wallet already has a
    // kingdom" (a fresh nonce - the path that actually happened on the
    // rehearsal night).
    const hint = res.json?.key_recovery?.sign_exactly
    if (typeof hint === 'string' && hint) {
      io.log('the entry answer carries no key, but the seat is paid - proving the wallet and recovering the key')
      return await recoverKey(io, hint)
    }

    // There was no answer at all. The entry may have arrived, so money is
    // not re-signed in silence: first prove the wallet, and only the answer
    // "there is no paid seat" (404) gives the right to sign the entry a
    // second time.
    if (!answerLost(res) || payments >= MAX_ENTRY_PAYMENTS) return res
    io.log(`no usable answer from the entry door (status ${res.status}${res.timedOut ? ', timed out' : ''}) `
      + `- waiting ${Math.round(SETTLE_GRACE_MS / 1000)}s, then asking whether the seat is already paid`)
    await io.sleep(SETTLE_GRACE_MS)
    const probe = await recoverKey(io, null)
    if (typeof probe.json?.api_key === 'string') return probe  // the entry arrived, the key is ours
    // A 404 counts as proof of "no seat" ONLY when it came back to a signed
    // request: a bare 404 is also what a closed door and a stranger's host
    // answer, and a second $50 entry must not be signed on that.
    if (probe.status !== 404 || !probe.proved) return probe
    io.log('no paid seat on this wallet - signing the entry once more')
    payments += 1
    res = await send(io, { paid: true, method, path, body })
  }
}

/**
 * A refusal after which the server itself ALLOWS signing again.
 *
 * The server tells the two outcomes apart, and says so in words: "Payment
 * settlement refused: … Sign a fresh payment" (402) means the money did NOT
 * move and the authorization was not used - a fresh signature is legitimate.
 * A 502 "Payment settlement did not complete - outcome will be reconciled. Do
 * not re-sign yet" means exactly the opposite: the payment may have gone out.
 */
const FRESH_PAYMENT_ALLOWED = /sign a fresh payment/i

/**
 * An ordinary door.
 *
 * Repeating a paid move blindly is a SECOND payment: the x402 wrapper signs a
 * new authorization on every attempt. This client used to repeat any 5xx,
 * which meant that on the server's own "outcome unknown, do NOT re-sign" it
 * signed several payments in a row. Now a paid door is repeated ONLY when the
 * server itself said "sign a fresh payment"; a free one is repeated on a 5xx
 * as before.
 */
async function callOrdinary(io, req) {
  const paidMove = req.paid && req.method !== 'GET' && req.method !== 'HEAD'
  let res
  for (let attempt = 1; attempt <= TRANSIENT_RETRIES; attempt++) {
    res = await send(io, req)
    // Repeating a refusal by our own ceiling is pointless: it is
    // deterministic.
    if (res.status === LOCAL_REFUSAL_STATUS) break
    const freshAllowed = FRESH_PAYMENT_ALLOWED.test(res.json?.error || '')
    if (paidMove) {
      // Neither a timeout, nor a 5xx, nor "outcome unknown" grants the
      // right to a second signature. The agent reads the answer and decides
      // for itself - GET /checkin shows whether the move happened or not.
      if (!freshAllowed) break
    } else if (res.status < 500) {
      break
    }
    if (attempt < TRANSIENT_RETRIES) await io.sleep(TRANSIENT_PAUSE_MS)
  }
  // A key arrives from more doors than the entry (a ticket, a manual
  // recovery).
  if (typeof res.json?.api_key === 'string') io.saveKey(res.json.api_key)
  return res
}

/**
 * The single entry point: a call to the game API under every rule above.
 * @returns {Promise<{status: number, json: any}>}
 */
export async function performCall({ method, path, body, io }) {
  const p = apiPath(path)
  const req = { paid: true, method: String(method).toUpperCase(), path: p, body }
  if (p === PAY_ENTRY_PATH) return await joinTheGame({ io, ...req })
  return await callOrdinary(io, req)
}

/**
 * The answer as it gets printed: the raw api_key does not go out.
 *
 * It is saved beside the wallet already, and the whole stdout of this helper
 * ends up in the model's transcript (and with it, at the provider). The
 * doctrine "the key never leaves the machine" would not survive that.
 * operator_key is printed as it is: it is meant for a HUMAN, and a human has
 * to receive it.
 */
export function redactForPrint(json) {
  const SAVED = '<saved beside your wallet - the helper sends it for you>'
  // The key is not only a top-level field: it can be nested, and when the
  // answer did not parse as JSON it sits as text inside `raw`. Mask both.
  const maskText = (text) => String(text).replace(/crowns_(?!op_)[A-Za-z0-9_-]{8,}/g, SAVED)
  const walk = (node, depth) => {
    if (depth > 8 || node == null) return node
    if (typeof node === 'string') return maskText(node)
    if (Array.isArray(node)) return node.map((v) => walk(v, depth + 1))
    if (typeof node !== 'object') return node
    const out = {}
    for (const [k, v] of Object.entries(node)) {
      out[k] = k === 'api_key' && typeof v === 'string' ? SAVED : walk(v, depth + 1)
    }
    return out
  }
  return walk(json, 0)
}
