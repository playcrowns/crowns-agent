// The client's payment ceiling - the barrier between "the server named a sum"
// and "the wallet signed it". WHO gets paid is a separate rule: it lives next
// door (./known-payees.js) and is borrowed here only as a refusal marker.
// Neither the network nor the wallet is present: a ready-made x402 client is
// passed in, which is what lets both rules be checked by unit tests.
//
// ── Why this is a file of its own, not two lines in the plumbing ────
//
// The "ceiling in the constructor" shape (`new x402Client({ spendControls })`)
// works in NO version of the core: the constructor takes not a config but a
// requirement-selecting function. On @x402/core 2.14 such a client dies on
// the very first payment ("this.paymentRequirementsSelector is not a
// function"); on 2.25 it silently loses the ceiling and runs into the core's
// own $1 default - which means a $50 entry is refused. Both were established
// by running them, not by reading the docs.
//
// One single shape works on 2.14, 2.20 and 2.25 alike: a policy filters the
// demands BEFORE the choice (`registerPolicy`), and on cores that carry their
// own spendControls the core's limit is raised to ours - otherwise its $1
// default kills the entry before our policy ever runs.

import { PAYEE_REFUSAL_MARKER, PAYMENT_PAYLOAD_WRAPPER, unwrapPaymentError } from './known-payees.js'

// What we know about the token OURSELVES. The ruler the ceiling is measured
// with must not be taken from the server's answer - neither from the 402
// demand nor from public-config: under the threat model "the server is
// tampered with, or the API address is a stranger's" the attacker owns both
// answers, and "decimals: 18" raises a $110 ceiling by twelve orders of
// magnitude. USDC has six decimals on every network we play on; the address
// is checked per chain, and a chain we do not know is simply never counted as
// confirmed.
export const USDC_DECIMALS = 6
export const KNOWN_USDC = {
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',   // Base
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',  // Base Sepolia
}

// The validity window of a signed authorization. The server sets 300s; a
// demand asking for an authorization good for a day is one we do not sign:
// such a signature lives on and waits for its hour.
export const MAX_AUTHORIZATION_SECONDS = 900

/** Dollars into the token's atomic units (USDC has six decimals). */
export function toAtomic(usd, decimals) {
  const d = Number.isInteger(decimals) && decimals >= 0 ? decimals : 6
  return BigInt(Math.round(Number(usd) * 10 ** d))
}

/**
 * The ceiling from the environment: a positive finite number, else the default.
 *
 * Junk ("50 USD", "a hundred", "1e21") must NOT silently raise the bar to a
 * default above the one a person meant to set: return the default and say so
 * out loud (the shouting is the caller's job, here there is only a flag).
 */
export function resolveCapUsd(raw, defaultUsd) {
  if (raw == null || raw === '') return { usd: defaultUsd, fellBack: false }
  const usd = Number(raw)
  if (!Number.isFinite(usd) || usd <= 0) return { usd: defaultUsd, fellBack: true }
  if (/[eE]/.test(String(usd))) return { usd: defaultUsd, fellBack: true }
  return { usd, fellBack: false }
}

/**
 * The policy: let through only those demands we agree to sign.
 *
 * The amount is the `amount` field in version two of the protocol and
 * `maxAmountRequired` in version one (we speak the second, but a client may
 * meet both). Beyond the amount, the token and the chain are checked too: a
 * compromised server would otherwise turn a testnet agent into a payer on any
 * chain, in any token.
 */
export function paymentCapPolicy({ capUsd, decimals = 6, asset = null, network = null }) {
  const cap = toAtomic(capUsd, decimals)
  return (_version, accepts) => (accepts || []).filter((r) => {
    const raw = r?.amount ?? r?.maxAmountRequired
    // The price is an UNSIGNED integer in atomic units. BigInt accepts both
    // "-5" and "0x10": a negative price would slip under any ceiling, and a
    // hexadecimal one would mean something other than what it reads as. What
    // did not parse as a decimal integer, we do not pay.
    if (typeof raw !== 'string' && typeof raw !== 'number') return false
    const text = String(raw).trim()
    if (!/^\d+$/.test(text)) return false
    let value
    try { value = BigInt(text) } catch { return false }
    if (value > cap) return false
    if (asset && String(r?.asset || '').toLowerCase() !== String(asset).toLowerCase()) return false
    if (network && String(r?.network || '') !== String(network)) return false
    // The server decides how long the signature stays good - and with no
    // bound it would decide on a day. A signed authorization lies there
    // waiting to be executed for the whole of that time.
    const seconds = Number(r?.maxTimeoutSeconds)
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_AUTHORIZATION_SECONDS) return false
    return true
  })
}

/**
 * Install the ceiling on a client of any version.
 * @returns {{cap: bigint}} what exactly was installed - for printing in a refusal
 */
export function applyPaymentCap(client, { capUsd, decimals = 6, asset = null, network = null }) {
  const policy = paymentCapPolicy({ capUsd, decimals, asset, network })
  if (typeof client.registerPolicy === 'function') {
    client.registerPolicy(policy)
  } else {
    // A core without policies: wrap the requirement selector - every version
    // has one.
    const inner = client.paymentRequirementsSelector
    client.paymentRequirementsSelector = (version, accepts) => {
      const kept = policy(version, accepts)
      if (!kept.length) throw new Error('All payment requirements were filtered out by policies')
      return typeof inner === 'function' ? inner(version, kept) : kept[0]
    }
  }
  // Out of several surviving demands the core takes the FIRST - that is, the
  // one the server put first. We take the cheapest: choosing the price is our
  // business, not the server's.
  const pickCheapest = (_version, accepts) => {
    const list = (accepts || []).slice()
    list.sort((a, b) => {
      const av = BigInt(String(a?.amount ?? a?.maxAmountRequired ?? '0'))
      const bv = BigInt(String(b?.amount ?? b?.maxAmountRequired ?? '0'))
      return av < bv ? -1 : av > bv ? 1 : 0
    })
    return list[0]
  }
  client.paymentRequirementsSelector = typeof client.registerPolicy === 'function'
    ? pickCheapest
    : ((version, accepts) => pickCheapest(version, policy(version, accepts)))

  // Cores 2.23+ carry a ceiling of their own, defaulting to $1 - raise it to ours.
  if (typeof client.setSpendControls === 'function') {
    client.setSpendControls({ maxAmountPerPayment: `$${capUsd}` })
  }
  return { cap: toAtomic(capUsd, decimals) }
}

// Message openings, each of which means one and the same thing: no signed
// request went out to the network. OPENINGS only - a substring search will
// not do. The @x402/core, finding no scheme for a demand, puts a
// `JSON.stringify` of the server's entire accepts array into the text of its
// own error; a tampered server could then drop a word from this list into any
// field of its own and repaint someone else's error as our refusal - and "we
// refused it ourselves" means "the money certainly did not move".
//
// The first line is the @x402/fetch wrapper around everything
// createPaymentPayload threw: it stands at position zero and covers ANY cause
// inside it (our ceiling, our payee, the core's own spend control on 2.23+)
// without relying on that cause's words. A live payment always goes through
// this wrapper; the bare strings below are for unit tests that call the core
// directly.
const LOCAL_REFUSAL_STARTS = [
  PAYMENT_PAYLOAD_WRAPPER,
  PAYEE_REFUSAL_MARKER,
  'Failed to parse payment requirements',
  'Invalid payment required response',
  'All payment requirements were filtered out by policies',
  'No client registered for x402 version',
  'No client registered for scheme',
  'No network/scheme registered',
]

/**
 * A refusal from OUR side (not the server's and not the network's), read off
 * the text of the exception.
 *
 * An unreadable bill belongs here too: "could not parse the requirements"
 * means we signed nothing, no money moved, and the cure is not a blind retry.
 *
 * And so does a refusal by PAYEE (./known-payees.js). Letting that one slip
 * past this list would hand it to the plumbing as a lost answer - and a lost
 * answer on the entry door starts the probe and a second $50 signature.
 */
export function isLocalPaymentRefusal(err) {
  const raw = String(err?.message ?? err ?? '')
  const inner = unwrapPaymentError(err)
  return LOCAL_REFUSAL_STARTS.some((s) => raw.startsWith(s) || inner.startsWith(s))
}
