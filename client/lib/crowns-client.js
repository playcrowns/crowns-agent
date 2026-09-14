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
// And one more, learned later: 4. while the server says the money may still
// be moving (`sign_new_payment: false`), nothing is signed at all.

// The timeout ladder, bottom to top. Each rung must outlast the one below it,
// or an answer gets cut off while the payment underneath it still lands:
//   the server's own wait for the chain's receipt ....... 180s
//   the game's proxy (nginx) holding a paid request ...... 240s  <- PROXY_READ_TIMEOUT_MS
//   this client waiting for a paid answer ................ 250s  <- POST_TIMEOUT_MS
//   the signed payment authorization staying valid ....... 300s  (the server's quote)
// A paid door can also wait in the operator wallet's queue before its
// settlement starts, so "the server gives up at 180s" is not a promise - the
// proxy's 240s is the real ceiling of an answer. A client that gives up
// EARLIER than that is precisely what produces lost answers, and a shorter
// timeout speeds nothing up: all it breeds is 409 "this wallet already has a
// kingdom". The order is pinned by a unit test in the game's repository.
export const PROXY_READ_TIMEOUT_MS = 240_000
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
// When a paid move whose answer was lost is decided for good - counted from
// the SIGNED authorization, the way the game counts it: its validBefore, the
// slack after which an unused one is buried (120s), one reconciler pass
// (180s). Counting ten minutes from "now" was early whenever the quote asked
// for a longer window. Without a readable signature the client assumes the
// longest window it ever signs (900s). A unit test in the game's repository
// pins these against the server's own numbers.
export const SETTLE_EXPIRY_SLACK_S = 120
export const RECONCILE_WAIT_S = 180
export const LOST_ANSWER_FINAL_S = 900 + SETTLE_EXPIRY_SLACK_S + RECONCILE_WAIT_S

/** validBefore (unix seconds) of the authorization inside a PAYMENT-SIGNATURE header, or null. */
export function signedValidBeforeOf(header) {
  if (!header) return null
  try {
    const v = Number(JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'))?.payload?.authorization?.validBefore)
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

/** The moment a lost paid answer is decided for good (ISO). */
export function lostAnswerFinalBy(res, now = Date.now()) {
  const vb = Number(res?.signedValidBefore)
  const ms = Number.isFinite(vb) && vb > 0
    ? Math.max(now, vb * 1000 + SETTLE_EXPIRY_SLACK_S * 1000) + RECONCILE_WAIT_S * 1000
    : now + LOST_ANSWER_FINAL_S * 1000
  return new Date(ms).toISOString()
}
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
export const REDEEM_TICKET_PATH = '/api/v1/accounts/redeem-ticket'
export const OPERATOR_KEY_PATH = '/api/v1/accounts/operator-key'

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
// The ticket string is its own protocol: a signature captured for one must
// never work in the other, so the prefix is checked separately.
const TICKET_PREFIX = 'Crowns ticket entry:'
// The human's cabinet key has a string of its own too: a signature captured
// for recovery or a ticket must never mint it, and the other way round.
const OPERATOR_KEY_PREFIX = 'Crowns operator key:'

/**
 * The operator key - the HUMAN's key to the cabinet - goes to a file of its
 * own beside the agent key (13.09, C9 recon). Before, the client only
 * printed it: an answer nobody read meant a human who never learned they had
 * a cabinet and watched the whole tournament blind. It is still printed as
 * well - the agent is the courier who hands it over.
 */
function keepOperatorKey(io, json) {
  if (typeof json?.operator_key === 'string' && typeof io.saveOperatorKey === 'function') {
    io.saveOperatorKey(json.operator_key)
  }
}

function refuseToSign(message, prefix = RECOVERY_PREFIX) {
  return {
    status: LOCAL_REFUSAL_STATUS,
    json: {
      error: 'this client refused to sign what the server asked for',
      asked_to_sign: String(message).slice(0, 200),
      hint: `the message must start with "${prefix}" and name your own wallet. Nothing was signed.`,
    },
    headers: {},
  }
}

/**
 * Entering on a TICKET won at an earlier tournament: no payment at all,
 * the wallet signature is the whole proof. Two steps, exactly like
 * recovery - the server names the string, because it is bound to this
 * tournament and to the Terms version the seat accepts.
 */
async function redeemTicket(io, body) {
  const probe = await send(io, {
    paid: false, method: 'POST', path: REDEEM_TICKET_PATH,
    body: { wallet_address: io.walletAddress },
  })
  const message = probe.json?.sign_exactly
  // No string named: no valid ticket, closed registration, a 429. The
  // answer carries the reason in words - hand it back as it is.
  if (typeof message !== 'string' || !message) return probe
  const wallet = String(io.walletAddress || '').toLowerCase()
  if (!message.startsWith(TICKET_PREFIX) || (wallet && !message.toLowerCase().includes(wallet))) {
    return refuseToSign(message, TICKET_PREFIX)
  }
  const signature = await io.signMessage(message)
  const res = await send(io, {
    paid: false, method: 'POST', path: REDEEM_TICKET_PATH,
    body: { ...(body && typeof body === 'object' ? body : {}), wallet_address: io.walletAddress, signature },
  })
  // The key file may still hold last tournament's key - overwrite it.
  if (typeof res.json?.api_key === 'string') io.saveKey(res.json.api_key)
  keepOperatorKey(io, res.json)
  res.proved = true
  return res
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
 * Re-mint the HUMAN's cabinet key with a wallet signature (13.09, C9 recon).
 *
 * The cabinet's gate says "sign the exact message with any wallet tool", and
 * a person without such a tool was stuck: the only signing in this client
 * served recovery and tickets. This is that tool:
 * `node crowns.js POST /accounts/operator-key`, beside the wallet file.
 * Whoever drives this client can run it - the agent included - and a mint
 * kills the copy open in the human's cabinet. A flag would be no lock (the
 * agent passes any flag it reads about), so the rule lives in words: the
 * agent guide says to mint only when the human asks, or when nobody holds a
 * working copy. The MCP door has no such tool, so a model there cannot rotate
 * the human's key at all.
 *
 * Same two steps as recovery and the ticket: the server names the string
 * (bound to the tournament), we sign it only if it starts with our prefix and
 * names our own wallet, and the fresh key goes to its file. Minting kills
 * every earlier operator key, the one open in a cabinet included.
 */
async function mintOperatorKey(io) {
  const probe = await send(io, {
    paid: false, method: 'POST', path: OPERATOR_KEY_PATH,
    body: { wallet_address: io.walletAddress },
  })
  const message = probe.json?.sign_exactly
  // No string named: no seat on this wallet, no tournament, a 429 - the
  // answer carries the reason in words.
  if (typeof message !== 'string' || !message) return probe
  const wallet = String(io.walletAddress || '').toLowerCase()
  if (!message.startsWith(OPERATOR_KEY_PREFIX) || (wallet && !message.toLowerCase().includes(wallet))) {
    return refuseToSign(message, OPERATOR_KEY_PREFIX)
  }
  const signature = await io.signMessage(message)
  const res = await send(io, {
    paid: false, method: 'POST', path: OPERATOR_KEY_PATH,
    body: { wallet_address: io.walletAddress, signature },
  })
  keepOperatorKey(io, res.json)
  res.proved = true
  return res
}

// A free read that takes the agent key: the game's own word on whether the
// saved key still lives.
export const KEY_CHECK_PATH = '/api/v1/wallet'

/** The game refused the key itself: unknown to it (an earlier tournament) or retired. */
export function keyRefused(res) {
  if (res?.status !== 401) return false
  const code = res.json?.code
  if (code === 'KEY_UNKNOWN' || code === 'KEY_RETIRED' || code === 'KEY_RETIRED_CANCELLED') return true
  return /invalid api key|api key revoked/i.test(String(res.json?.error || ''))
}

/**
 * What is the saved key worth? One free read answers it, three ways:
 *   'dead'    - a 401 on the key itself; the saved copy is set aside (io.forgetKey);
 *   'alive'   - the game answered in substance (2xx, 404, 409);
 *   'unknown' - nothing was said about the key: a drop, a timeout, a 5xx, a 429.
 * 'unknown' is not 'alive' (review of wave 1 recheck, round 2): an hour before
 * the gong thirty agents behind one NAT fill the address bucket, the check got
 * a 429, and the manual recovery answered "the game did not refuse your key" -
 * the agent read that as "the key works", and the paid seat burned unnamed.
 */
async function savedKeyState(io) {
  const check = await send(io, { paid: false, method: 'GET', path: KEY_CHECK_PATH })
  if (keyRefused(check)) {
    io.forgetKey?.()
    return { state: 'dead', res: check }
  }
  const s = check.status
  if ((s >= 200 && s < 300) || s === 404 || s === 409) return { state: 'alive', res: check }
  return { state: 'unknown', res: check }
}

const statusWords = (res) => `HTTP ${res?.status}${res?.timedOut ? ', timed out' : ''}`

/** An entry answer after which the seat may be paid while the key is not in hand. */
function seatMayBeKeyless(res) {
  return typeof res.json?.key_recovery?.sign_exactly === 'string'
    || (res.status === 409 && !paymentStillSettling(res))
    || answerLost(res)
}

/**
 * Entering the game - the one door where a lost answer costs a seat.
 *
 * Recovery is called ONLY while no working key is saved: every successful
 * recover ROTATES the key, so on a live key it would kill it.
 */
async function joinTheGame({ io, method, path, body }) {
  let res = await send(io, { paid: true, method, path, body })
  if (res.status === LOCAL_REFUSAL_STATUS) return res
  if (io.hasSavedKey) {
    // The key file beside the wallet may be OLD: a wallet outlives a
    // tournament, a key dies with it. An entry paid on top of an old file
    // returns a NEW key - and that new key used to be dropped silently: the
    // agent paid $50 and then played with a dead key, getting a 401 on every
    // call.
    if (typeof res.json?.api_key === 'string') {
      io.saveKey(res.json.api_key)
      keepOperatorKey(io, res.json)
      return res
    }
    // No key in the answer, and one is saved. A live saved key means this is
    // the agent's own seat: nothing to do. But the saved key may be last
    // tournament's while THIS entry's answer was lost - and this branch used to
    // hand back "already has a kingdom" with the recovery hint unread: the paid
    // seat stayed unnamed and burned at the gong. The game is asked first.
    const saved = seatMayBeKeyless(res) ? await savedKeyState(io) : null
    if (saved?.state !== 'dead') {
      if (saved?.state === 'unknown') {
        io.log(`could not check whether the saved api key still works (${statusWords(saved.res)}) - nothing more was signed; `
          + 'if this seat\'s key is missing, run node crowns.js POST /accounts/recover-key in a minute')
      }
      keepOperatorKey(io, res.json)
      return res
    }
    io.log('the saved api key is refused by the game (a key of an earlier tournament) and was set aside - collecting the key of this seat')
  }

  let payments = 1
  for (;;) {
    // The key arrived - the ordinary, happy case.
    if (typeof res.json?.api_key === 'string') { io.saveKey(res.json.api_key); keepOperatorKey(io, res.json); return res }

    // The server named the recovery door itself: a 200 with api_key: null
    // (the same payment header replayed) or a 409 "this wallet already has a
    // kingdom" (a fresh nonce - the path that actually happened on the
    // rehearsal night).
    const hint = res.json?.key_recovery?.sign_exactly
    if (typeof hint === 'string' && hint) {
      io.log('the entry answer carries no key, but the seat is paid - proving the wallet and recovering the key')
      return await recoverKey(io, hint)
    }

    // The entry payment is still settling (its receipt did not come back in
    // time, or an earlier entry of this wallet is still in flight). The seat
    // may already be paid, so neither a recovery probe ("no seat yet - pay")
    // nor a second entry is right: hand the answer to the agent, which runs
    // the same command again after `retry_after_seconds`.
    if (paymentStillSettling(res)) {
      io.log(`the entry payment is still settling (${res.json.payment_outcome}) - nothing more is signed; `
        + 'run the same command again later')
      return res
    }

    // A 409 that names neither the recovery door nor a payment state: "the
    // field is full". The server checks the seats before it knows the wallet,
    // so on the last seats this is ALSO what a paid entry of this wallet hears
    // once its seat exists - after an answer that said "still settling". One
    // signed probe tells the two apart, and it moves no money: a key comes
    // back only for a seat this wallet already holds.
    if (res.status === 409) {
      io.log('the entry door refused with 409 and no recovery hint - checking whether this wallet already holds a seat')
      const probe = await recoverKey(io, null)
      if (typeof probe.json?.api_key === 'string' || probe.status === LOCAL_REFUSAL_STATUS) return probe
      // The seat is ours and already named: that answer is the truth, not "full".
      if (probe.proved && probe.status === 409) return probe
      return res
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
 * Words were not enough. The server used to answer "Payment settlement
 * refused: … Sign a fresh payment" also when its wait for the chain's receipt
 * broke AFTER the payment had been broadcast - and this client, reading those
 * words, signed a NEW payment while the first one was still landing: the agent
 * paid twice, and nobody's ledger said so. So every settlement answer now
 * carries two fields, and the client reads only the fields:
 *   payment_outcome   'not_paid' | 'pending' | 'paid' | 'refund_pending' | 'refunded'
 *   sign_new_payment  true ONLY when a fresh signature is legitimate and can help
 * An answer without them (an older server, a proxy's error page, a timeout) is
 * never permission to sign again.
 */
export function freshPaymentAllowed(res) {
  return res?.json?.sign_new_payment === true
}

/**
 * The server says the money may still be moving: nothing may be signed until it settles.
 *
 * Judged by the OUTCOME, not by the ban on signing alone: an empty wallet also
 * answers `sign_new_payment: false` (a new signature cannot fix it), yet
 * nothing moves there - reading it as "still settling" told the agent to wait
 * for money that never left instead of topping up the wallet.
 */
export function paymentStillSettling(res) {
  const outcome = res?.json?.payment_outcome
  return res?.json?.sign_new_payment !== true && (outcome === 'pending' || outcome === 'paid')
}

/**
 * An ordinary door.
 *
 * Repeating a paid move blindly is a SECOND payment: the x402 wrapper signs a
 * new authorization on every attempt. This client used to repeat any 5xx,
 * which meant that on the server's own "outcome unknown, do NOT re-sign" it
 * signed several payments in a row. Now a paid door is repeated ONLY when the
 * server's answer says `sign_new_payment: true`; a free one is repeated on a
 * 5xx as before.
 */
async function callOrdinary(io, req) {
  const paidMove = req.paid && req.method !== 'GET' && req.method !== 'HEAD'
  let res
  for (let attempt = 1; attempt <= TRANSIENT_RETRIES; attempt++) {
    res = await send(io, req)
    // Repeating a refusal by our own ceiling is pointless: it is
    // deterministic.
    if (res.status === LOCAL_REFUSAL_STATUS) break
    if (paidMove) {
      // Neither a timeout, nor a 5xx, nor "outcome unknown" grants the
      // right to a second signature. The agent reads the answer and decides
      // for itself - GET /checkin shows whether the move happened or not.
      if (!freshPaymentAllowed(res)) break
    } else if (res.status < 500) {
      break
    }
    if (attempt < TRANSIENT_RETRIES) await io.sleep(TRANSIENT_PAUSE_MS)
  }
  // The payment may still land: a repeat of THIS command is a bare call, the
  // server quotes it afresh, and this client signs that quote - a second
  // payment (a bounty: a second escrow). The answer says so in words; the log
  // line says it where the agent looks first.
  if (paidMove && paymentStillSettling(res)) {
    io.log(`this payment is still settling (${res.json.payment_outcome}) - do NOT run this command again, a repeat signs a second payment; `
      + `read GET /checkin after ${res.json.retry_after_seconds ?? 180}s`
      + (res.json.outcome_final_by ? ` - until ${res.json.outcome_final_by} a move missing from check-in is not proof it failed` : ''))
  } else if (paidMove && answerLost(res) && !res.json?.payment_outcome) {
    // No answer in substance (a drop, a timeout, a proxy's error page): the
    // payment may have been signed and may still land (review of wave 1
    // recheck, round 2). Its outcome can take LOST_ANSWER_FINAL_S to settle,
    // and a check-in read earlier that does not show the move is no verdict.
    io.log(`this paid move lost its answer (${statusWords(res)}) - it may have signed a payment that still lands. `
      + `Do NOT run this command again before ${lostAnswerFinalBy(res)}: a repeat signs a second payment. `
      + 'GET /checkin lists a payment still being decided under payments_in_flight; a move missing from check-in before then is not proof it failed. '
      + 'After then, a payment still listed there was charged and is being applied or refunded; a move neither applied nor listed did not happen')
  }
  // A saved key the game refuses is set aside, so the next entry can collect a live one.
  if (io.hasSavedKey && keyRefused(res)) {
    io.forgetKey?.()
    io.log('the saved api key is refused by the game (401) and was set aside. A seat paid in this tournament and not named yet: '
      + 'node crowns.js POST /accounts/recover-key')
  }
  // A key arrives from more doors than the entry (a ticket, a manual
  // recovery).
  if (typeof res.json?.api_key === 'string') io.saveKey(res.json.api_key)
  keepOperatorKey(io, res.json)
  return res
}

/**
 * Key recovery by hand: `node crowns.js POST /accounts/recover-key`.
 *
 * Recheck of wave 1 (C9): this path went out as an ordinary unsigned call, the
 * door answered 400 with the string to sign, and the agent had nothing to sign
 * it with. Same guard as the entry: never over a key the game still accepts.
 */
async function recoverByHand(io) {
  const saved = io.hasSavedKey ? await savedKeyState(io) : null
  if (saved?.state === 'alive') {
    return {
      status: LOCAL_REFUSAL_STATUS,
      json: {
        error: 'an api key is saved and the game accepts it - this client does not recover over it',
        hint: 'every recovery re-issues the key and kills the one before it. Nothing was signed. '
          + 'A saved key the game refuses (401) is set aside by this client on its own; run this again then.',
      },
      headers: {},
    }
  }
  if (saved?.state === 'unknown') {
    const after = retryAfterSeconds(saved.res)
    return {
      status: LOCAL_REFUSAL_STATUS,
      json: {
        error: `could not check the saved api key (${statusWords(saved.res)}) - this client does not recover over a key it could not check`,
        hint: 'Nothing was signed. Run this again in a minute: a key the game refuses (401) is set aside and the recovery goes on.',
        ...(after != null ? { retry_after_seconds: after } : {}),
      },
      headers: {},
    }
  }
  return await recoverKey(io, null)
}

/**
 * The single entry point: a call to the game API under every rule above.
 * @returns {Promise<{status: number, json: any}>}
 */
export async function performCall({ method, path, body, io }) {
  const p = apiPath(path)
  const req = { paid: true, method: String(method).toUpperCase(), path: p, body }
  if (p === PAY_ENTRY_PATH) return await joinTheGame({ io, ...req })
  if (p === REDEEM_TICKET_PATH) return await redeemTicket(io, body)
  if (p === RECOVER_KEY_PATH && req.method === 'POST') return await recoverByHand(io)
  // Only a POST mints: a stray GET must not rotate the human's live key.
  if (p === OPERATOR_KEY_PATH && req.method === 'POST') return await mintOperatorKey(io)
  return await callOrdinary(io, req)
}

/**
 * The answer as it gets printed: the raw api_key does not go out.
 *
 * It is saved beside the wallet already, and the whole stdout of this helper
 * ends up in the model's transcript (and with it, at the provider). The
 * doctrine "the key never leaves the machine" would not survive that.
 * operator_key is printed as it is: it is meant for a HUMAN, the agent is
 * the one who hands it over, and it cannot play. A copy of it is also saved
 * beside the wallet (<wallet>.operatorkey), so the human does not depend on
 * this one printout.
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
