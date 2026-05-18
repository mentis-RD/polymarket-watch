# addresses/

Per-chain × per-category address dictionaries for `src/funding-source.ts` classifier.

## Format

Filename: `<chain>-<category>.json` (or `shared-<category>.json` for chain-agnostic entries).

Content: a flat object of `{ "<lowercased-address>": "<brand-name>" }`.

```json
{
  "0xf977814e90da44bfa03b6295a0616a897441acec": "binance",
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": "coinbase"
}
```

## Chains

`ethereum`, `polygon`, `base`, `arbitrum`, `bsc`, `optimism`, `solana`, or `shared` (chain-agnostic).

## Categories

| Category | Cluster contribution | What goes here |
|---------|----------------------|----------------|
| `cex` | direct=0.5, same-brand=0.5/0.1, as-origin=0.2 | Centralized exchange hot wallets |
| `swap` | same as `cex` | Non-custodial swap aggregators (ChangeNOW, FixedFloat, etc.) |
| `fiat` | direct=0.4, same-brand=0.4/0.05, as-origin=0.15 | Card-purchase onramps (MoonPay, Ramp, Transak) |
| `bridge` | identification only, no cluster weight | Cross-chain bridges. Phase 6b Relay tracing handles origin-side linking; other bridges identified but not traced |
| `service` | 0 | High fan-out hubs (Polymarket onramp distributor, internal relayers) that fund many unrelated users |

## Adding a new address

1. Identify the address category and chain.
2. Open or create the matching JSON file.
3. Add `"0x<lowercased>": "<brand>"` row.
4. Commit + push. Server auto-deploy restarts `pmw-trade-enricher` and `pmw-tg-control` to pick up the new dict.

## Discovering candidates

Run `/scan_unknowns` in any topic, or `npx tsx src/scan-unknown-funders.ts` on the server.
It reports addresses currently classified as `private` (unknown) that fund many distinct
proxy wallets — strong candidates for CEX/swap/service expansion. Look the address up on
the relevant block explorer to confirm what it is, then add to the right JSON.

## Why per-chain matters

EVM EOAs derive the same address from the same private key on every EVM chain (Ethereum =
Polygon = Base address-wise), but exchanges operationally use **different hot wallets** on
different chains. Bitget on Base is not the same EOA as Bitget on Ethereum or BSC. So an
address in `ethereum-cex.json` won't necessarily match a Base inflow — keep separate files.

Solana addresses are completely independent (base58, distinct keyspace).
