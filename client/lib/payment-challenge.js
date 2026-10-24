/**
 * A 402 is not always a bill.
 *
 * x402 makes HTTP 402 a payment challenge: the PAYMENT-REQUIRED header (x402 v2) or a body with
 * `x402Version: 1` names the price, and @x402/fetch signs and repeats. But the game's FREE doors use 402 for
 * plain words too: the ticket door answers 402 "No ticket on this wallet is valid for this tournament…" to a
 * wallet without a ticket, and register answers 402 "Entry fee not paid…" before the entry is paid. Such an
 * answer carries neither the header nor `x402Version`.
 *
 * The wrapper does not know the difference. On every 402 it parses a challenge, finds none and throws
 * "Failed to parse payment requirements: Invalid payment required response" - after it has read the body, so
 * the server's words are gone. The MCP server then answered the agent "Crowns API unreachable … retry: true",
 * and the command-line helper "this client refused to pay": an agent without a ticket retried into the same
 * wall, an agent that had not paid its entry never heard that the way in is pay-entry.
 *
 * passServerWords sits between the wrapper and the network. A 402 to an UNSIGNED request that is not a
 * challenge is handed back untouched, by throwing it past the wrapper (serverWordsOf picks it up on the other
 * side); nothing is signed, nothing moves. A 402 to a SIGNED request is left to the wrapper as before: it reads
 * the settle result and returns the answer itself.
 *
 * What counts as a challenge mirrors @x402/core getPaymentRequiredResponse exactly (header, or body
 * `x402Version === 1`), so every answer the core would have taken for a bill still goes to it - the ceiling
 * and the payee check stand in front of every signature as before.
 *
 * Both doors carry this file: src/mcp/ for the MCP server, client/lib/ for the command-line helper. The two
 * trees are closed - neither imports from the other - so it is a copy, and a test holds the two copies byte
 * for byte. In the MCP tree it is a module of its own for one more reason: server.js raises the stdio
 * transport on its last line, so a test importing server.js would hang.
 */

const WORDS = Symbol('crowns.serverWords')

/** Does this 402 carry a payment challenge the x402 core would read? Reads a clone - the body stays whole. */
export const isPaymentChallenge = async (res) => {
  if (res?.headers?.get?.('PAYMENT-REQUIRED')) return true
  let body = null
  try {
    const text = await res.clone().text()
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return !!(body && typeof body === 'object' && 'x402Version' in body && body.x402Version === 1)
}

const signedRequest = (input) => typeof input?.headers?.has === 'function'
  && (input.headers.has('PAYMENT-SIGNATURE') || input.headers.has('X-PAYMENT'))

/** Wrap the fetch the x402 wrapper calls: a 402 of words to an unsigned request goes past the wrapper. */
export function passServerWords(impl) {
  return async (input, init) => {
    const res = await impl(input, init)
    if (res?.status !== 402 || signedRequest(input)) return res
    if (await isPaymentChallenge(res)) return res
    const err = new Error(`the server answered 402 without a payment challenge (HTTP ${res.status})`)
    err[WORDS] = res
    throw err
  }
}

/** The server's own 402 answer carried past the wrapper, or null for any other error. */
export function serverWordsOf(err) {
  return (err && typeof err === 'object' && err[WORDS]) || null
}
