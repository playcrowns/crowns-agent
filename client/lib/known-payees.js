// Who this client is willing to pay.
//
// x402 puts the PAYEE inside the demand: the server names `payTo`, the
// library copies that address straight into the authorization your wallet
// signs, and the money goes wherever it was written. Until now nothing
// checked it. A server that had been tampered with - or a base URL pointing
// at a look-alike host - could take every paid move of a tournament night to
// an address of its own, and the per-payment ceiling would not save you: a
// ceiling bounds ONE payment, and a night is dozens of them.
//
// So the list of payees travels WITH the client, per chain, and anything
// else is refused before a signature exists. Crowns has exactly two payees:
//
//   operator - every revenue door (entry fee, claims, builds, repairs);
//   escrow   - money held for a leg that has not settled yet (market buys
//              and listings, pacts, alliance seats, vassal offers).
//
// A chain this file does not list is a flat refusal, not a warning. On a
// chain where we cannot tell the game's wallet from a stranger's, there is
// no safe way to sign at all. The live network joins this table when its
// wallets are born, and publishing that release is part of moving to it.
//
// CROWNS_ALLOWED_PAYTO (comma-separated 0x addresses) is the escape hatch:
// it ADDS to the list and never replaces it. A variable that replaced the
// list would be a switch that turns the whole check off, which is the one
// thing an attacker would reach for. Use it for your own deployment, or on
// the day our own list is the thing with a typo in it.
//
// ── Why the table travels with the client ───────────────────────────
//
// Under the threat model "the server is tampered with, or the base URL is a
// stranger's" the attacker owns both the 402 demand and /public-config. A
// list taken from the server's own answer would have the server checking
// itself. So the table is a literal inside each of the two doors of this
// client - the command-line helper and the MCP server - and a test guards
// that the two copies match byte for byte: the two trees are closed, and
// neither may import from the other.

/** The addresses we pay, by chain. The key is the chain id. */
export const KNOWN_PAYEES = {
  // The test network today's tournaments are played on.
  84532: {
    operator: '0x0E10050c337710EB9d4f86067e125d532d5fdfeb',
    escrow: '0x541Ebb8C8D870df7a4CedBB31BABe8c258997f80',
  },
}

/** The operator's environment variable: comma-separated addresses, IN ADDITION. */
export const PAYEE_ENV_VAR = 'CROWNS_ALLOWED_PAYTO'

// The refusal marker is text, and that is deliberate. @x402/fetch rebuilds a
// policy's exception into its own `new Error('Failed to create payment
// payload: …')` and loses both `code` and `cause`: the only way left to
// recognise OUR refusal is by the message. Without the marker the client
// would read this refusal as a lost answer, and a lost answer on the entry
// door is what leads to signing the entry a second time.
export const PAYEE_REFUSAL_MARKER = 'Payment refused: unknown payee'

// The only wrapper OUR marker may legitimately stand behind: @x402/fetch
// puts it around everything createPaymentPayload threw.
export const PAYMENT_PAYLOAD_WRAPPER = 'Failed to create payment payload: '

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

// The refusal code travels IN THE TEXT, not only in `err.code`: the
// @x402/fetch wrapper builds a new exception and loses the fields, while the
// client needs DIFFERENT words for different causes (a stranger's address / a
// stranger's chain / junk in the demand / junk in the variable). The shape is
// stable: "<marker> (<CODE>) - <text>".
function refuse(text, code) {
  const err = new Error(`${PAYEE_REFUSAL_MARKER} (${code}) - ${text}`)
  err.code = code
  return err
}

/**
 * The text of an exception with the @x402/fetch wrapper taken off.
 *
 * Needed because the marker must NOT be looked for with a bare `includes`:
 * the @x402/core, finding no scheme for a demand, puts a `JSON.stringify` of
 * the server's ENTIRE accepts array into the text of its own error. A
 * tampered server could drop our marker into any field of its own and make
 * the client name a false cause to the agent. Our own text stands at the
 * BEGINNING of the message - and that is where it is looked for.
 */
export function unwrapPaymentError(err) {
  const text = String(err?.message ?? err ?? '')
  // Exactly one layer: there is nothing else to take off, and a loop would
  // open the way to a message the server itself began with this same line.
  return text.startsWith(PAYMENT_PAYLOAD_WRAPPER) ? text.slice(PAYMENT_PAYLOAD_WRAPPER.length) : text
}

/** Is this our own payee refusal (not the network, not the server, not the ceiling). */
export function isPayeeRefusal(err) {
  return unwrapPaymentError(err).startsWith(PAYEE_REFUSAL_MARKER)
}

/**
 * The code of our payee refusal, or null.
 *
 * Four causes call for four different sets of words to the agent: not one of
 * them is cured by raising the ceiling, and each needs something else fixed -
 * your own environment, your chain, or the API address.
 */
export function payeeRefusalCode(err) {
  const text = unwrapPaymentError(err)
  if (!text.startsWith(PAYEE_REFUSAL_MARKER)) return null
  const tail = text.slice(PAYEE_REFUSAL_MARKER.length)
  const m = /^ \((CROWNS_PAYEE_[A-Z_]+)\)/.exec(tail)
  if (m) return m[1]
  // The direct path (no wrapper) carries the code as a field too, and a
  // field is more exact than text.
  return typeof err?.code === 'string' && err.code.startsWith('CROWNS_PAYEE_') ? err.code : null
}

/**
 * Parsing CROWNS_ALLOWED_PAYTO.
 *
 * Junk is a loud error, not a silent skip: whoever wrote "0x123" or a file
 * name into the variable believes that address is allowed. Dropping it
 * quietly means playing with the guard switched off while thinking it is on.
 */
export function parseExtraPayees(raw) {
  if (raw == null) return []
  const text = String(raw).trim()
  if (!text) return []
  const out = []
  for (const piece of text.split(',')) {
    const one = piece.trim()
    if (!one) continue
    if (!ADDRESS_RE.test(one)) {
      throw refuse(
        `${PAYEE_ENV_VAR} lists "${one}", which is not an address (0x followed by 40 hex characters). ` +
        `Nothing was signed. Fix the variable or unset it: a list this client cannot read is not a list ` +
        `it will guess at, and guessing here spends money.`,
        'CROWNS_PAYEE_ENV_INVALID',
      )
    }
    out.push(one.toLowerCase())
  }
  return out
}

/** The chain as a table key: a positive integer, or null (no chain was named). */
function chainKey(chainId) {
  const n = typeof chainId === 'number' ? chainId : Number(String(chainId ?? '').trim())
  return Number.isInteger(n) && n > 0 ? String(n) : null
}

/**
 * Who may be paid on this chain.
 *
 * @returns {{chainKnown: boolean, builtIn: string[], extra: string[], all: string[]}}
 *   addresses come back lower-cased; `all` is empty when the chain is
 *   unknown, because on such a chain nobody is allowed - the addresses from
 *   the variable included.
 */
export function allowedPayees(chainId, extraCsv) {
  const extra = parseExtraPayees(extraCsv)
  const key = chainKey(chainId)
  const row = key == null ? null : KNOWN_PAYEES[key]
  const builtIn = row ? Object.values(row).map((a) => a.toLowerCase()) : []
  return {
    chainKnown: Boolean(row),
    builtIn,
    extra,
    all: row ? [...new Set([...builtIn, ...extra])] : [],
  }
}

/**
 * Let a payment through only to a known payee, otherwise throw a refusal.
 *
 * The comparison ignores case: viem hands back the checksummed form, the
 * environment and the server hand back whatever they please, and an address
 * is twenty bytes, not a string.
 */
export function assertKnownPayee({ chainId, payTo, extraCsv } = {}) {
  const { chainKnown, builtIn, extra, all } = allowedPayees(chainId, extraCsv)
  const key = chainKey(chainId)
  const where = key == null ? 'a chain it was never told the number of' : `chain ${key}`

  if (!chainKnown) {
    const chains = Object.keys(KNOWN_PAYEES).join(', ')
    throw refuse(
      `this client knows no Crowns wallet on ${where}, so it cannot tell the game's own address from a ` +
      `stranger's there. It knows payees on these chains only: ${chains}. Nothing was signed. ` +
      `A new chain needs a new release of this client - ${PAYEE_ENV_VAR} adds addresses on a chain this ` +
      `client already knows, it does not teach it a chain.`,
      'CROWNS_PAYEE_CHAIN_UNKNOWN',
    )
  }

  const address = typeof payTo === 'string' ? payTo.trim() : ''
  if (!ADDRESS_RE.test(address)) {
    const shown = payTo == null
      ? `the payment demand on ${where} names no payee at all`
      : `the payment demand on ${where} names "${String(payTo).slice(0, 80)}" as the payee`
    throw refuse(
      `${shown}, and that is not an address. A demand this client cannot read the payee of is a demand ` +
      `it will not sign. Nothing was signed.`,
      'CROWNS_PAYEE_MALFORMED',
    )
  }

  if (!all.includes(address.toLowerCase())) {
    const mine = builtIn.join(' and ')
    const added = extra.length ? `, plus ${extra.join(', ')} from ${PAYEE_ENV_VAR}` : ''
    throw refuse(
      `the server asked to send the money to ${address} on ${where}, and that address is not a Crowns ` +
      `wallet. This client pays ${mine}${added}. Nothing was signed and no money moved. Repeating the ` +
      `call cannot fix this: either the API in your environment is not the real game (CROWNS_API_BASE ` +
      `for the command-line helper, CROWNS_API_URL for the MCP server), or a payee really changed - in ` +
      `which case name the new address yourself in ${PAYEE_ENV_VAR}, a comma-separated list that is ` +
      `ADDED to the built-in one.`,
      'CROWNS_PAYEE_UNKNOWN',
    )
  }
  return true
}

// Out of several refusals over one demand the agent is shown ONE. Let it be
// the one that names an address: the server puts its demands in whatever
// order it likes, and a malformed demand placed first would hide the thief's
// address behind words about an unreadable field - while the client's hint
// promises an address.
const REFUSAL_RANK = {
  CROWNS_PAYEE_UNKNOWN: 3,        // names a stranger's address - this IS the switch
  CROWNS_PAYEE_CHAIN_UNKNOWN: 2,  // names a chain we are blind on
  CROWNS_PAYEE_MALFORMED: 1,      // names nothing but junk in the payTo field
}

/**
 * The x402 policy: keep only the demands that pay our own addresses.
 *
 * `payeeInfo` is read ON EVERY payment, not once when it is built: both doors
 * learn the chain lazily (from the environment, or from /public-config before
 * the first payment), and the object is filled in after the policy has
 * already been installed.
 */
export function payeeGuardPolicy(payeeInfo) {
  return (_version, accepts) => {
    const extraCsv = payeeInfo?.extraCsv ?? null
    // Junk in the variable is an error on the very first payment, even when
    // no demands arrived at all: silence here would read as "the check works".
    parseExtraPayees(extraCsv)
    const list = Array.isArray(accepts) ? accepts : []
    // An empty list is none of our business: let the core say in its own
    // words that there is nothing to pay. A payee refusal must mean the payee.
    if (!list.length) return list
    const chainId = payeeInfo?.chainId ?? null
    const kept = []
    let refusal = null
    for (const req of list) {
      try {
        assertKnownPayee({ chainId, payTo: req?.payTo, extraCsv })
        kept.push(req)
      } catch (err) {
        const rank = REFUSAL_RANK[err?.code] ?? 0
        if (refusal == null || rank > (REFUSAL_RANK[refusal.code] ?? 0)) refusal = err
      }
    }
    if (!kept.length) throw refusal
    return kept
  }
}

/**
 * Install the payee check on an x402 client of any version.
 *
 * We wrap `selectPaymentRequirements` rather than `registerPolicy`, for three
 * reasons: policies run AFTER the filtering by registered schemes (a
 * stranger's chain would then die with someone else's words about "no
 * network/scheme registered"), their order depends on the order they were
 * registered in (a payee refusal has to name the switch before the ceiling
 * names a price), and cores without policies have none at all. The wrapper
 * works everywhere, and it always goes first.
 *
 * A core without `selectPaymentRequirements` gets a refusal, not a quiet
 * installation: silently returning a guard with nothing to sit on would mean
 * handing a whole night to a tampered server with a client that looks healthy.
 */
export function applyPayeeGuard(client, payeeInfo) {
  if (typeof client?.selectPaymentRequirements !== 'function') {
    const err = new Error(
      'Payment refused: the payee check cannot be installed - this x402 core has no ' +
      'selectPaymentRequirements(), so nothing would verify who the money goes to. Nothing was signed. ' +
      'Reinstall the client dependencies with `npm ci` (it pins the version this check is written for); ' +
      'a client that pays without this check pays whichever address the server names.',
    )
    err.code = 'CROWNS_PAYEE_GUARD_UNSUPPORTED'
    throw err
  }
  const guard = payeeGuardPolicy(payeeInfo)
  const inner = client.selectPaymentRequirements.bind(client)
  client.selectPaymentRequirements = (version, accepts) => inner(version, guard(version, accepts))
  return guard
}
