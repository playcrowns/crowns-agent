# Security

## Reporting a vulnerability

Write to <legal@playcrowns.com> with the subject line `security`. Do not open a
public issue for it. Say what you did, what happened, and how to reproduce it;
a working example beats a description. You get an answer within 7 days.

Report first, publish when it is fixed or after 90 days, whichever comes first.
We have no bounty programme; we will credit you by whatever name you give us.

This file covers both doors in this repository: the MCP server at the root and
the example client in `client/`. The client keeps its own, longer wallet
doctrine in [client/SECURITY.md](client/SECURITY.md); read whichever door you run.

## What we treat as a vulnerability

- Money moving without the owner's signature: a charge larger than the amount
  quoted in the HTTP 402 challenge, a payment authorization replayed, a prize
  claimed by a wallet that is not on the final table.
- Acting as another kingdom: forged or guessable API keys, an endpoint that
  takes a kingdom id without proving the key, a nonce or session reused.
- Reading what the fog hides: sealed letters, another kingdom's plans,
  unrevealed map state, anything a tournament only opens at the closing gong.
- Either door leaking your private key - `CROWNS_WALLET_KEY` for the MCP server,
  the wallet file for the client - into logs, error text, tool output, or a tool
  argument that would accept a private key from the model.

Not vulnerabilities: losing a tournament, an agent spending its own budget
badly, rate limits doing their job, missing headers on static pages, and
scanner output with no working example.

## Wallet doctrine

Read this before you put a key anywhere.

- **A throwaway wallet, funded with the budget you are willing to play with.**
  Not your main wallet, not a key that holds anything else, not a key you reuse
  somewhere. Crowns pays out to the same wallet, so treat it as a game account
  and sweep winnings out of it.
- **The key never leaves your machine.** Each door keeps it its own way - the
  MCP server reads `CROWNS_WALLET_KEY` from its environment, the client reads
  the wallet file `CROWNS_WALLET` points at (mode 600) - and neither sends it
  anywhere. It is not recoverable from us if you lose it.
- **The server never asks for a private key.** No Crowns endpoint, no tool
  argument, no support reply will ever ask for one. Anything that does is an
  attack, whatever it claims to be - and never pass the key as a tool argument,
  where the model and its transcript would see it.
- **Every payment is your own signature for one exact amount** taken from the
  402 challenge. The facilitator can refuse a payment; it cannot take more than
  you signed. Both doors also refuse before a signature exists: anything above
  `CROWNS_MAX_PAYMENT_USD` (default 110 dollars) and anything payable to an
  address that is not one of the game's own two wallets. Lower the ceiling to
  your budget. Neither check has an off switch, and `CROWNS_ALLOWED_PAYTO` only
  ever adds addresses to the payee list - it never replaces it.
- **Identity and money are separate.** The API key says who you are, the wallet
  only pays. Rotating one does not rotate the other.
