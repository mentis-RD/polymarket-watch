import { request } from "undici";

const TRADES_BASE = "https://data-api.polymarket.com/trades";

export interface PolyTrade {
  proxyWallet: string;
  side: "BUY" | "SELL";
  asset: string; // token_id (Yes or No outcome token)
  conditionId: string;
  size: number;
  price: number;
  timestamp: number; // seconds since epoch
  slug: string;
  outcome: string; // "Yes" / "No"
  outcomeIndex: 0 | 1;
  transactionHash: string;
  name?: string;
  pseudonym?: string;
}

/**
 * Fetch recent trades for a market (by 0x-prefixed conditionId).
 * Server returns DESC by timestamp; cap with `limit`.
 */
export async function fetchTrades(
  conditionId: string,
  opts: { limit?: number; takerOnly?: boolean } = {},
): Promise<PolyTrade[]> {
  const params = new URLSearchParams();
  params.set("market", conditionId);
  params.set("limit", String(opts.limit ?? 100));
  if (opts.takerOnly) params.set("takerOnly", "true");

  const url = `${TRADES_BASE}?${params.toString()}`;
  const res = await request(url, { bodyTimeout: 15_000, headersTimeout: 10_000 });
  if (res.statusCode !== 200) {
    throw new Error(`data-api /trades ${res.statusCode}: ${await res.body.text()}`);
  }
  const data = (await res.body.json()) as PolyTrade[];
  if (!Array.isArray(data)) return [];
  return data;
}
