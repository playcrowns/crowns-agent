/**
 * Where this door keeps the API key.
 *
 * The problem it solves. The entry payment reveals `api_key` exactly once, and
 * until now this door never held it: the key lived only in the model's context,
 * and every tool demanded it back as an argument. An agent whose session starts
 * fresh on every turn — the common shape for a harness that wakes an agent on a
 * schedule — paid the entry fee, made one move, and lost its kingdom for the
 * rest of the tournament. The seat stays paid and unreachable.
 *
 * The example client already solved this (client/crowns.js): the key lives in a
 * file next to the wallet, mode 0600, and the raw key never reaches stdout. This
 * module is the same shape for the MCP door, so the two doors behave alike and
 * an operator reading one understands the other.
 *
 * Where the file goes, in order:
 *   1. CROWNS_API_KEY in the environment — wins over everything, written nowhere.
 *      This is how an operator pins a key they already hold.
 *   2. CROWNS_KEY_FILE — an explicit path, for an operator who wants their own.
 *   3. $HOME/.crowns/<wallet address, lowercase>.apikey — the default. HOME and
 *      not the working directory: this door is usually started as
 *      `npx -y github:playcrowns/crowns-agent` with whatever cwd the host
 *      happens to have, while HOME is stable across sessions. The wallet address
 *      in the name keeps two wallets on one machine from overwriting each other.
 *   4. ./crowns.apikey — last resort, when HOME is unwritable (a read-only
 *      container is a real case, and silence there would cost the operator $50).
 *
 * What this module deliberately does NOT do: throw. A door that cannot save a
 * key must still be able to SAY so, in the response the model reads, because
 * stderr here goes to the host's log and the model never sees it.
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/** Candidate paths, most specific first. The wallet address may be null. */
function candidates(walletAddress) {
  const out = []
  if (process.env.CROWNS_KEY_FILE) out.push(process.env.CROWNS_KEY_FILE)
  const name = walletAddress ? `${String(walletAddress).toLowerCase()}.apikey` : 'crowns.apikey'
  try {
    const home = homedir()
    if (home) out.push(join(home, '.crowns', name))
  } catch { /* no home on this host — fall through to cwd */ }
  out.push(join(process.cwd(), 'crowns.apikey'))
  return out
}

/**
 * The key this door should use, or null.
 *
 * The environment wins: an operator who sets CROWNS_API_KEY means it, and a
 * stale file must not quietly outrank them.
 */
export function readStoredKey(walletAddress = null) {
  const fromEnv = (process.env.CROWNS_API_KEY || '').trim()
  if (fromEnv) return fromEnv
  for (const p of candidates(walletAddress)) {
    try {
      if (!existsSync(p)) continue
      const v = readFileSync(p, 'utf8').trim()
      if (v) return v
    } catch { /* unreadable candidate — try the next */ }
  }
  return null
}

/** Where the key currently lives, for telling the operator the truth. */
export function storedKeyPath(walletAddress = null) {
  if ((process.env.CROWNS_API_KEY || '').trim()) return 'CROWNS_API_KEY (environment)'
  for (const p of candidates(walletAddress)) {
    try { if (existsSync(p)) return p } catch { /* keep looking */ }
  }
  return null
}

/**
 * Save the key. Returns `{ saved: true, path }` or `{ saved: false, tried }`.
 *
 * Mode is set twice on purpose: `writeFileSync`'s mode applies only when the
 * file is created, so an existing file keeps its old permissions unless chmod
 * follows. The example client learned this the same way.
 */
export function saveKey(key, walletAddress = null) {
  if (!key || typeof key !== 'string') return { saved: false, tried: [] }
  if ((process.env.CROWNS_API_KEY || '').trim()) {
    // The operator pinned a key by hand. Writing a file beside it would create
    // two truths, and the environment would keep winning anyway.
    return { saved: true, path: 'CROWNS_API_KEY (environment, kept as set)' }
  }
  const tried = []
  for (const p of candidates(walletAddress)) {
    try {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, `${key.trim()}\n`, { mode: 0o600 })
      try { chmodSync(p, 0o600) } catch { /* best effort on exotic filesystems */ }
      return { saved: true, path: p }
    } catch (e) {
      tried.push(`${p}: ${e.code || e.message}`)
    }
  }
  return { saved: false, tried }
}

/**
 * Drop a key this door can no longer use.
 *
 * The key is bound to one tournament (src/lib/api-key.js); after the next
 * transition it answers 401 "API key revoked". A door that keeps replaying a
 * dead key looks broken to the agent, so the 401 path forgets the file and says
 * what to do instead.
 */
export function forgetKey(walletAddress = null) {
  const gone = []
  for (const p of candidates(walletAddress)) {
    try { if (existsSync(p)) { unlinkSync(p); gone.push(p) } } catch { /* leave it */ }
  }
  return gone
}

/**
 * Hide raw agent keys in anything the model is about to read.
 *
 * The negative lookahead is not a nicety: the operator key is `crowns_op_` +
 * 32 characters from the same alphabet, and a naive pattern eats it too. The
 * operator key is revealed in exactly one response in the whole product, so
 * eating it means the human never gets their cabinet.
 */
const AGENT_KEY_RE = /crowns_(?!op_)[A-Za-z0-9_-]{8,}/g

export function maskAgentKey(text, note = '<saved by the door>') {
  if (typeof text !== 'string') return text
  return text.replace(AGENT_KEY_RE, note)
}
