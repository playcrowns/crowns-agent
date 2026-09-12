/**
 * The payment ceiling of the public MCP door (x402).
 *
 * What is true about the library, established by running it on @x402/core
 * 2.14.0 rather than by reading the docs:
 *   - `new x402Client({ spendControls: … })` EXISTS IN NO version. The
 *     constructor takes not a config but a requirement-selector function, so
 *     the config object lands in the selector field and the VERY FIRST paid
 *     call dies with "this.paymentRequirementsSelector is not a function".
 *     The door then paid nothing at all - neither $2 nor $50.
 *   - What holds the ceiling is a POLICY: `client.registerPolicy(...)` exists
 *     in every version and cuts off demands above our bar BEFORE a signature.
 *   - On @x402/core >= 2.23 the core gained a spend control of ITS OWN,
 *     defaulting to $1 - below a tournament entry. It cuts the payment
 *     EARLIER than our policies, so wherever that method exists we also raise
 *     it to our own bar (`setSpendControls`); on 2.14 there is no method and
 *     nothing to raise.
 *
 * A module of its own rather than lines inside server.js, for one reason:
 * server.js raises the stdio transport on its last line, so a test importing
 * it would hang. The test builds its client with THIS function - the same one
 * the server builds with.
 *
 * ONLY "HOW MUCH" LIVES HERE. "To whom" is a second rule in a second module:
 * ./known-payees.js checks payTo against the list of our own addresses and
 * refuses to sign for a stranger. server.js hangs both checks on one client
 * (buildPaymentClient -> applyPayeeGuard); a ceiling without a payee check
 * would bound one payment, while a tampered server would take them all.
 */
import { x402Client } from '@x402/core/client'
import { convertToTokenAmount } from '@x402/core/utils'

// The default bar, taken from the facts of the game itself: the two largest
// single payments are the tournament entry (50) and the cap on a deal in the
// market / in a pact / for a seat in an alliance (100). 110 covers every
// legitimate call with room to spare. CROWNS_MAX_PAYMENT_USD squeezes it down
// to the operator's own budget.
export const DEFAULT_MAX_PAYMENT_USD = 110

// USDC has 6 decimals on our chain. This is a DEFAULT, not a law: the caller
// may pass in what it learned about the asset instead.
const DEFAULT_ASSET_DECIMALS = 6

// THE RULER THE CEILING IS MEASURED WITH IS OURS. The number of decimals is
// taken neither from the 402 demand nor from public-config: under the threat
// model "the server is tampered with, or CROWNS_API_URL points at a
// stranger's host" the attacker owns both answers, and a single field
// ("decimals: 18") would raise a $110 ceiling by twelve orders of magnitude.
// USDC has six decimals everywhere we play. The operator can pin the token
// address as well (CROWNS_USDC_ADDRESS) - then a foreign token is not signed
// for at all; otherwise the address comes from public-config and is a weak
// check only.

// The validity window of a signed authorization: the server sets 300s. A
// demand asking for an authorization good for a day is one we do not sign.
const MAX_AUTHORIZATION_SECONDS = 900

// The marker of a refusal by the ceiling. It has to be text: @x402/fetch
// rebuilds a policy's exception into its own `new Error('Failed to create
// payment payload: …')` and loses both `code` and `cause` - the only way left
// to recognise our own refusal is by the message.
export const PAYMENT_CEILING_MARKER = 'Payment refused by your own ceiling'

// The @x402/fetch wrapper around everything createPaymentPayload threw: our
// marker may legitimately stand only behind it, or at the very start of the
// text.
const PAYLOAD_WRAPPER = 'Failed to create payment payload: '

/**
 * Is this our own refusal BY THE CEILING - judged by the start of the text,
 * never by a substring.
 *
 * A bare `includes` here can be forged: the @x402/core, finding no scheme for
 * a demand, puts a `JSON.stringify` of the server's whole accepts array into
 * the text of its own error. A tampered server could put our marker into any
 * field of its own and pass someone else's error off as our refusal - and the
 * agent would read a foreign cause as its own bar.
 */
export function isCeilingRefusal(err) {
  const raw = String(err?.message ?? err ?? '')
  const inner = raw.startsWith(PAYLOAD_WRAPPER) ? raw.slice(PAYLOAD_WRAPPER.length) : raw
  return inner.startsWith(PAYMENT_CEILING_MARKER)
}

/** The ceiling from the environment: a positive finite number, else the default. */
export function resolveMaxPaymentUsd(raw) {
  const usd = Number(raw)
  if (!Number.isFinite(usd) || usd <= 0) return DEFAULT_MAX_PAYMENT_USD
  // String(1e21) = '1e+21' - the library's converter does not take an
  // exponent, and a ceiling of a sextillion dollars is no ceiling anyway.
  if (/[eE]/.test(String(usd))) return DEFAULT_MAX_PAYMENT_USD
  return usd
}

/**
 * The price of a demand, in the asset's atomic units.
 * x402 v2 calls the field `amount`, v1 calls it `maxAmountRequired`; read
 * both. Anything that does not read as an unsigned integer returns null - such
 * a demand is not signed for (a price you did not read is a price you do not
 * pay).
 */
function requirementAmount(req) {
  const raw = req?.amount ?? req?.maxAmountRequired
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) return null
  return BigInt(text)
}

// The asset's number of decimals is NOT taken from the demand: precision
// would then be set by the very answer that names the price, so "decimals: 18"
// would turn a $110 ceiling into one many orders of magnitude higher. The
// decimals and the token address come from what WE know: GET
// /api/v1/public-config (which the caller reads) or the USDC default.

/**
 * Builds an x402 client with a payment ceiling that actually works.
 * The schemes (the exact chain) are registered by the CALLER - that is a
 * decision of its own, and it is about the network, not about money.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.maxPaymentUsd] the ceiling, in dollars
 * @param {Function}[opts.warn] where to complain (stderr by default: stdout
 *                              is taken by the MCP protocol)
 * @returns {x402Client}
 */
export function buildPaymentClient({
  maxPaymentUsd = DEFAULT_MAX_PAYMENT_USD,
  warn = (msg) => console.error(msg),
  // What we know about the asset. The object is read ON EVERY payment, so
  // the caller may fill it in after the public-config answer arrives.
  assetInfo = { decimals: DEFAULT_ASSET_DECIMALS, address: null },
} = {}) {
  const usd = resolveMaxPaymentUsd(maxPaymentUsd)

  // Dollars -> atomic units is computed by the library itself (as a string,
  // without floating point), for this particular asset's decimals.
  const capByDecimals = new Map()
  const capAtomic = (decimals) => {
    if (!capByDecimals.has(decimals)) {
      let cap
      try {
        cap = BigInt(convertToTokenAmount(String(usd), decimals))
      } catch {
        // The ceiling is not expressible in this asset's precision (say,
        // $0.5 with zero decimals) - so every positive price exceeds it.
        cap = 0n
      }
      capByDecimals.set(decimals, cap)
    }
    return capByDecimals.get(decimals)
  }

  const client = new x402Client()

  // Out of several surviving demands the core takes the first in the
  // server's order. Choosing the price is our business: take the cheapest.
  client.paymentRequirementsSelector = (_version, accepts) => {
    const list = (accepts || []).slice().sort((a, b) => {
      const av = requirementAmount(a) ?? 0n
      const bv = requirementAmount(b) ?? 0n
      return av < bv ? -1 : av > bv ? 1 : 0
    })
    return list[0]
  }

  // The policy is the real ceiling: it works on every version of the core
  // and cuts off expensive demands before the wallet signs anything.
  client.registerPolicy((x402Version, accepts) => {
    const decimals = Number.isInteger(assetInfo?.decimals) ? assetInfo.decimals : DEFAULT_ASSET_DECIMALS
    const wantAsset = typeof assetInfo?.address === 'string' ? assetInfo.address.toLowerCase() : null
    const affordable = accepts.filter((req) => {
      const amount = requirementAmount(req)
      if (amount === null) return false
      // A foreign token is not signed for: a price denominated in IT says
      // nothing about dollars.
      if (wantAsset && String(req?.asset || '').toLowerCase() !== wantAsset) return false
      const seconds = Number(req?.maxTimeoutSeconds)
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_AUTHORIZATION_SECONDS) return false
      return amount <= capAtomic(decimals)
    })
    if (affordable.length === 0) {
      // Our own error instead of the library's "All payment requirements
      // were filtered out by policies": the agent needs to know that the
      // cause is ITS ceiling, not the network, and that a retry will not help.
      const priced = accepts
        .map((req) => req?.amount ?? req?.maxAmountRequired ?? '?')
        .join(', ')
      const err = new Error(
        `${PAYMENT_CEILING_MARKER}: this action is quoted at ${priced} atomic units of the asset, ` +
        `above the per-payment limit of $${usd}. Raise CROWNS_MAX_PAYMENT_USD in the MCP server environment ` +
        `(entry fee plus your play budget) if the price is legitimate - retrying without changing it will not help.`
      )
      err.code = 'CROWNS_PAYMENT_CEILING'
      throw err
    }
    return affordable
  })

  // >= 2.23: raise the core's own ceiling to our bar, or its default ($1)
  // kills the entry before the policy ever gets to run.
  if (typeof client.setSpendControls === 'function') {
    try {
      client.setSpendControls({ maxAmountPerPayment: `$${usd}` })
    } catch (err) {
      // Not fatal: the bar is held by the policy above in any case. This is
      // the one line of this file an operator sees at runtime.
      warn(`[crowns] the x402 core refused setSpendControls($${usd}) - ${err.message}. `
        + `The per-payment limit of $${usd} still holds: it is enforced by this client's own policy, not by the core.`)
    }
  }

  return client
}
