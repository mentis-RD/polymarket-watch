import { request } from "undici";

/**
 * Etherscan V2 (unified multi-chain, chainid param) transfer lookups — the FREE
 * historical/indexed replacement for Alchemy `alchemy_getAssetTransfers`, whose
 * free tier throttles the Transfers API (429 "consider upgrading") under load.
 * eth_getLogs can't do this (its free-tier ≤10-block window can't scan a
 * wallet's whole history for its FIRST inflow); Etherscan's `tokentx` is indexed
 * and sorted, so it can. One `ETHERSCAN_KEY` (shared with dork-track /
 * polygon-check) → be polite with the throttle.
 */

const BASE = "https://api.etherscan.io/v2/api";
const key = (): string => process.env.ETHERSCAN_KEY || "";

/** Chain name → Etherscan V2 chainid. Matches the profiler's chain keys. */
export const CHAIN_ID: Record<string, number> = {
  polygon: 137,
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
};

export interface EtherscanTokenTx {
  blockNumber: string;
  timeStamp: string; // unix seconds
  hash: string;
  from: string;
  to: string;
  value: string; // raw token units
  contractAddress: string;
  tokenSymbol: string;
  tokenDecimal: string;
}

// Etherscan free tier = 5 req/s, SHARED with dork-track + polygon-check → keep a
// global min-interval so a profiling burst doesn't starve the others.
let lastCallTs = 0;
const MIN_INTERVAL_MS = 280; // ~3.5 req/s, leaves headroom on the shared key
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function throttle(): Promise<void> {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCallTs);
  if (wait > 0) await sleep(wait);
  lastCallTs = Date.now();
}

/**
 * ERC20 token transfers for `address` on `chain` (V2). Sorted asc/desc, up to
 * `offset` rows. Returns [] on error / no-transactions / bad chain. Retries once
 * on an Etherscan rate-limit response.
 */
export async function tokenTx(opts: {
  chain: string;
  address: string;
  contractaddress?: string;
  sort?: "asc" | "desc";
  offset?: number;
}): Promise<EtherscanTokenTx[]> {
  const chainid = CHAIN_ID[opts.chain];
  if (!chainid || !key()) return [];
  const q = new URLSearchParams({
    chainid: String(chainid),
    module: "account",
    action: "tokentx",
    address: opts.address,
    sort: opts.sort || "asc",
    page: "1",
    offset: String(opts.offset ?? 100),
    apikey: key(),
  });
  if (opts.contractaddress) q.set("contractaddress", opts.contractaddress);
  const url = `${BASE}?${q.toString()}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    await throttle();
    try {
      const res = await request(url, { bodyTimeout: 12_000, headersTimeout: 8_000 });
      const j = (await res.body.json()) as { status?: string; message?: string; result?: unknown };
      if (Array.isArray(j.result)) return j.result as EtherscanTokenTx[];
      // status 0 "No transactions found" → legitimately empty; rate-limit → retry.
      if (typeof j.result === "string" && /rate limit|max .*rate/i.test(j.result)) {
        await sleep(700);
        continue;
      }
      return [];
    } catch {
      await sleep(300);
    }
  }
  return [];
}

/** Convert a raw tokentx row's value to a decimal (USD for stables) number. */
export function txUsd(t: EtherscanTokenTx): number {
  const dec = Number(t.tokenDecimal);
  const raw = Number(t.value);
  if (!Number.isFinite(raw)) return 0;
  return raw / 10 ** (Number.isFinite(dec) ? dec : 6);
}
