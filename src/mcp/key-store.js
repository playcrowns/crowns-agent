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
 *   4. ./crowns.<wallet address, lowercase>.apikey — last resort, when HOME is
 *      unwritable (a read-only container is a real case, and silence there would
 *      cost the operator $50). Older doors wrote ./crowns.apikey with no wallet
 *      in the name; that file is adopted only through the door's owner check.
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
  const wallet = walletAddress ? String(walletAddress).toLowerCase() : null
  const name = wallet ? `${wallet}.apikey` : 'crowns.apikey'
  try {
    const home = homedir()
    if (home) out.push(join(home, '.crowns', name))
  } catch { /* no home on this host — fall through to cwd */ }
  // The working directory carries the wallet in the name too (review of wave 1
  // recheck, round 2, 13.09, C9) - the example client already does. Two agents
  // in one container with a read-only HOME share a working directory: B's entry
  // wrote B's key to ./crowns.apikey, and A's door read it as its own and played
  // every tool with B's kingdom. The old wallet-less name is read only through
  // the door's owner check (readLegacyCwdKey + src/mcp/server.js).
  out.push(join(process.cwd(), wallet ? `crowns.${wallet}.apikey` : 'crowns.apikey'))
  return out
}

/** The working-directory name older doors wrote, with no wallet in it. */
export function legacyCwdKeyPath() {
  return join(process.cwd(), 'crowns.apikey')
}

/**
 * The key in the old wallet-less working-directory file, or null. NOT a key to
 * send: whose it is only the game can say (GET /api/v1/wallet names the
 * wallet), and the door asks before adopting it. Without a wallet address the
 * ordinary candidates already read this very name.
 */
export function readLegacyCwdKey(walletAddress = null) {
  if (!walletAddress) return null
  const p = legacyCwdKeyPath()
  try {
    if (!existsSync(p)) return null
    const key = readFileSync(p, 'utf8').trim()
    return key ? { path: p, key } : null
  } catch {
    return null
  }
}

/** Drop the old wallet-less file - only after it was adopted under the wallet's own name. */
export function forgetLegacyCwdKey() {
  try { unlinkSync(legacyCwdKeyPath()); return true } catch { return false }
}

// ── The operator key: the human's, kept beside the agent's ──────────
//
// 13.09 (C9 recon, operator cabinet). The entry answer carries a second
// key, `operator_key` (crowns_op_…), and until now no door wrote it anywhere:
// it lived in exactly one tool answer. An answer that was cut off, or a
// transcript nobody read, meant the human never learned they had a cabinet
// and watched the whole tournament blind.
//
// Same shape as the agent key on purpose - the same directory, the same mode,
// the same loud refusal - with its own extension, so the two files never
// overwrite each other and a person looking in ~/.crowns sees both at once:
//   CROWNS_KEY_FILE=/x/k.apikey      -> /x/k.operatorkey
//   $HOME/.crowns/<wallet>.apikey    -> $HOME/.crowns/<wallet>.operatorkey
//   ./crowns.<wallet>.apikey         -> ./crowns.<wallet>.operatorkey
// No new environment variable: the operator file follows the agent file.
//
// What the model still sees. The raw operator key stays in the tool answer
// (maskAgentKey spares it): the agent is the only courier the product has
// to the human, and a masked key cannot be handed over. It is a watching
// key - it cannot play or move money anywhere but the kingdom's own wallet
// - and the human can re-mint it at any time with the wallet, which kills
// every earlier copy, including the one the model saw. The AGENT key, which
// plays, still never reaches the model.
export function operatorKeyPathFor(agentKeyPath) {
  const p = String(agentKeyPath)
  return p.endsWith('.apikey') ? `${p.slice(0, -'.apikey'.length)}.operatorkey` : `${p}.operatorkey`
}

function operatorCandidates(walletAddress) {
  return candidates(walletAddress).map(operatorKeyPathFor)
}

/**
 * Where an operator key may LIE: the write candidates plus the old wallet-less
 * ./crowns.operatorkey. Every copy is checked against the game before anyone
 * hears it is the human's (savedOperatorKeyState marks another wallet's 'foreign').
 */
function operatorReadCandidates(walletAddress) {
  const out = operatorCandidates(walletAddress)
  if (walletAddress) out.push(operatorKeyPathFor(legacyCwdKeyPath()))
  return out
}

/** Where the operator key file lies, or null when this door holds none. */
export function storedOperatorKeyPath(walletAddress = null) {
  for (const p of operatorReadCandidates(walletAddress)) {
    try { if (existsSync(p)) return p } catch { /* keep looking */ }
  }
  return null
}

/** The operator key this door holds, or null. */
export function readStoredOperatorKey(walletAddress = null) {
  for (const p of operatorCandidates(walletAddress)) {
    try {
      if (!existsSync(p)) continue
      const v = readFileSync(p, 'utf8').trim()
      if (v) return v
    } catch { /* unreadable candidate - try the next */ }
  }
  return null
}

/**
 * Every operator key copy this door holds, in lookup order: `[{ path, key }]`.
 *
 * Review of wave 1 recheck (13.09, C9): the check read the FIRST copy and on a
 * 401 dropped ALL of them - a dead copy of an earlier tournament under
 * CROWNS_KEY_FILE took the live one in $HOME down with it. Each copy is now
 * checked and dropped on its own.
 */
export function readStoredOperatorKeyEntries(walletAddress = null) {
  const out = []
  for (const p of operatorReadCandidates(walletAddress)) {
    try {
      if (!existsSync(p)) continue
      const key = readFileSync(p, 'utf8').trim()
      if (key) out.push({ path: p, key })
    } catch { /* unreadable candidate - try the next */ }
  }
  return out
}

/** Drop ONE operator key copy the server refused. Returns whether it is gone. */
export function forgetOperatorKeyFile(path) {
  try { if (existsSync(path)) unlinkSync(path); return true } catch { return false }
}

/**
 * Drop the operator key file - ONLY after the server said the key is dead.
 *
 * forgetKey deliberately leaves this file alone: an agent key can die while
 * the human's key lives (recovery rotates only the agent key). But a file the
 * game refuses is worse than none (review of wave 1b): after a transition the
 * old tournament's copy sat here, and the recovery answer pointed the model
 * at it as the human's key. The caller checks the key first, then calls this.
 */
export function forgetOperatorKey(walletAddress = null) {
  const gone = []
  for (const p of operatorCandidates(walletAddress)) {
    try { if (existsSync(p)) { unlinkSync(p); gone.push(p) } } catch { /* leave it */ }
  }
  return gone
}

/**
 * Save the operator key. Returns `{ saved: true, path }` or `{ saved: false, tried }`.
 *
 * CROWNS_API_KEY does not stop this write, unlike saveKey: that variable pins
 * the AGENT key, and there is no second truth about the operator key to
 * collide with - a fresh operator key exists nowhere else.
 */
export function saveOperatorKey(key, walletAddress = null) {
  if (!key || typeof key !== 'string') return { saved: false, tried: [] }
  const tried = []
  for (const p of operatorCandidates(walletAddress)) {
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
 * transition it answers 401 "Invalid API key" (the row is wiped), and a
 * cancelled tournament answers 401 "API key revoked" at once. A door that keeps replaying a
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
