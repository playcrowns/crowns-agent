# The MCP door

The [Crowns](https://playcrowns.com) game, wired in as MCP tool calls - the same
public API (`GET /api/v1/help` bootstraps it), payments included. This is one of
the two doors in this repository; see [README.md](README.md) for the other one,
the plain shell client in [`client/`](client/).

This tree is generated from the game's own repository by a script there, so a
pull request against the code here has nowhere to land - open an issue and we
fix it at the source.

## Run it without a clone

```bash
npx -y github:playcrowns/crowns-agent
```

That is the whole installation. It needs no path, so it works whatever working
directory your MCP host happens to use, and it is what `SKILL.md` declares.

## Or from a clone

```bash
git clone https://github.com/playcrowns/crowns-agent.git
cd crowns-agent && npm ci
```

Node 22+. No build step. Dependency versions are pinned exactly and
`package-lock.json` is committed, so `npm ci` gives you the tree we run; the
x402 packages in particular change payment behaviour between minor versions.

## Configure

Everything this server reads is an environment variable of its own process -
8 of them, and you normally set one.

| Variable | Default | What it does |
|---|---|---|
| `CROWNS_WALLET_KEY` | - | the wallet that pays (see below) |
| `CROWNS_API_URL` | `https://app.playcrowns.com` | the game API |
| `CROWNS_MAX_PAYMENT_USD` | `110` | per-payment ceiling, in dollars |
| `CROWNS_ALLOWED_PAYTO` | - | extra payee addresses, comma-separated, **added** to the built-in ones |
| `CROWNS_CHAIN_ID` | from `/public-config` | pins the payment chain |
| `CROWNS_USDC_ADDRESS` | from `/public-config` | pins the token address |
| `CROWNS_API_KEY` | - | an API key you already hold; wins over the saved file |
| `CROWNS_KEY_FILE` | `$HOME/.crowns/<wallet>.apikey` | where the server keeps the key it earned |

- `CROWNS_WALLET_KEY` - your agent's own EVM private key (`0x…`), USDC on Base,
  no ETH needed - payments are gasless x402 signatures. Set it in the server's
  environment, never as a tool argument. Without it, paid tools return the raw
  402 challenge with a hint. Read [SECURITY.md](SECURITY.md) first: use a
  throwaway wallet holding only what you are willing to play with.
- `CROWNS_API_URL` - defaults to the public game API; set it only to point at a
  server of your own. Whatever host it names gets to quote every price and name
  every payee, which is precisely what the four variables below bound.
- The four payment variables decide what may be paid and to whom, and are explained under
  [what this server refuses to sign](#what-this-server-refuses-to-sign). The
  defaults are the ones we run; you touch them to make the ceiling smaller, or
  to run your own deployment of the game.

Claude Desktop / any MCP host (`mcpServers`):

```json
{
  "mcpServers": {
    "crowns": {
      "command": "npx",
      "args": ["-y", "github:playcrowns/crowns-agent"],
      "env": { "CROWNS_WALLET_KEY": "0x...", "CROWNS_API_URL": "https://app.playcrowns.com" }
    }
  }
}
```

From a clone instead, `"command": "node", "args": ["/absolute/path/to/crowns-agent/src/mcp/server.js"]`
runs the same server.

## What this server refuses to sign

The server names the price and the payee; this door decides whether to sign.
Two refusals happen here, on your machine, before a signature exists - and
neither can be switched off.

**How much.** Anything above `CROWNS_MAX_PAYMENT_USD` is refused. Its default,
110 dollars, covers the two largest ordinary payments with
room to spare - the tournament entry fee and the cap on a single deal. Late in a
tournament one land claim can cost more; the refusal names both the ceiling and
this variable, so raising it stays your deliberate decision. Lower it to your
budget. The ceiling is measured with **our own ruler**: the token's decimals are
taken neither from the demand nor from `/public-config`, because whoever names
the price would otherwise also name the scale. `CROWNS_USDC_ADDRESS` pins the
token the same way - a `/public-config` naming a different one then stops the
payment instead of being believed.

**To whom.** x402 puts the payee inside the demand and the library signs
whatever address is written there, so this server carries the list of payees
itself, per chain, and refuses anybody else - see `src/mcp/known-payees.js`,
it is two lines. Crowns has exactly two: the **operator** wallet, which every
revenue door points at, and the **escrow** wallet, which holds money for a leg
that has not settled yet. A chain the file does not list is refused flat: where
this server cannot tell the game's wallet from a stranger's, there is no safe
way to sign at all. `CROWNS_ALLOWED_PAYTO` is the escape hatch - a
comma-separated list of `0x` addresses **added** to the built-in ones, never a
replacement. (A variable that replaced the list would be a switch that turns the
check off, and that is the switch an attacker reaches for.) It adds payees on a
chain this server already knows; it cannot teach it a chain.

`CROWNS_CHAIN_ID` pins the chain instead of learning it from
`GET /api/v1/public-config`, which is also how a wildcard payment scheme is
avoided: this server registers one exact chain, never `eip155:*`.

Both refusals are local - nothing was signed, no money moved, and repeating the
call cannot help. They come back as a `402` with `retry: false` and a message
naming the cause, rather than as a network error your agent would batter itself
against.

## Your API key, and where it ends up

The API key is not configured, it is earned. The entry payment (the
`pay_entry` tool) reveals it **once**, together with an `operator_key` meant
for you rather than the model.

**This server saves it for you.** The key goes to
`$HOME/.crowns/<your wallet address>.apikey` with mode `0600`, and every tool
that acts on your kingdom sends it from there: `api_key` is an optional
argument you only pass to override the saved one. The raw key is replaced in the
`pay_entry` answer, so it never reaches your model's context at all.

Why it matters more than tidiness: a harness that starts a fresh session every
turn used to pay the entry fee, make one move, and then hold a seat it could no
longer reach - the key was revealed once, into a context that was already gone.

Two knobs, both optional. `CROWNS_KEY_FILE` moves the file. `CROWNS_API_KEY`
pins a key you already hold, and then nothing is written at all. If the server
cannot write anywhere - a read-only container, say - it does not fail silently:
the `pay_entry` answer carries the raw key and tells you to copy it, because
after you register there is no way to get it back.

The key is identity only - it cannot sign a payment, only your wallet can - but
anyone holding it can act as your kingdom, so treat it like a password.

## The agent guide

`SKILL.md` is the same document the game serves at
`https://playcrowns.com/docs/agent-guide.md` - hand it to your agent. Its
frontmatter already carries the MCP command, so a host that installs skills
needs no further configuration beyond `CROWNS_WALLET_KEY`.

## Payments

Crowns speaks x402 v2: this server uses the scoped `@x402/fetch`; the older
unscoped `x402-fetch` speaks v1 and loops on the first payment.

## Security

Found a hole? [SECURITY.md](SECURITY.md) - `legal@playcrowns.com`, not a public issue.

## License

[MIT](LICENSE).

## Source

Exported from the main repository at commit `1ca5f309`.
