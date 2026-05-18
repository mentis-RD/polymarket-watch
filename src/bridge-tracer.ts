import { request } from "undici";
import { log, err } from "./log.js";

const BASE = "https://api.relay.link";

interface RelayRequest {
  id: string;
  status: string;
  user: string;
  recipient: string;
  data: {
    inTxs?: { hash?: string; chainId?: number; type?: string }[];
    metadata?: { sender?: string; recipient?: string };
  };
  createdAt: string;
}

interface RelayResponse {
  requests?: RelayRequest[];
}

export interface BridgeOrigin {
  /** Origin chain wallet (lowercased) that initiated the bridge to the recipient. */
  user: string;
  /** Origin chain ID where the user wallet lives. */
  chain_id: number | null;
  /** ISO timestamp of the earliest known Relay request to this recipient. */
  first_seen_iso: string;
}

/**
 * Look up Relay bridge history for a recipient wallet on Polygon. Returns
 * the *earliest* origin wallet, which gives the cleanest "true funder" hint.
 *
 * Network failures and empty responses both return null.
 */
export async function fetchEarliestRelayOrigin(
  recipientWallet: string,
  limit = 50,
): Promise<BridgeOrigin | null> {
  const url = `${BASE}/requests?recipient=${recipientWallet}&limit=${limit}`;
  try {
    const res = await request(url, { bodyTimeout: 15_000, headersTimeout: 10_000 });
    if (res.statusCode !== 200) {
      log("bridge-tracer", `relay HTTP ${res.statusCode} for ${recipientWallet}`);
      return null;
    }
    const data = (await res.body.json()) as RelayResponse;
    const reqs = data.requests ?? [];
    if (reqs.length === 0) return null;

    // Sort ascending by createdAt to pick the earliest.
    reqs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const earliest = reqs[0];
    const user = (earliest.user || earliest.data?.metadata?.sender || "").toLowerCase();
    if (!user || user === "0x0000000000000000000000000000000000000000") return null;
    const chainId = earliest.data.inTxs?.[0]?.chainId ?? null;
    return {
      user,
      chain_id: chainId,
      first_seen_iso: earliest.createdAt,
    };
  } catch (e) {
    err("bridge-tracer", `relay lookup failed for ${recipientWallet}`, (e as Error).message);
    return null;
  }
}

const CHAIN_NAMES: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  137: "polygon",
  42161: "arbitrum",
  8453: "base",
  324: "zksync",
  43114: "avalanche",
  56: "bsc",
  7777777: "zora",
  59144: "linea",
  534352: "scroll",
};

export function chainName(id: number | null): string {
  if (id === null || id === undefined) return "?";
  return CHAIN_NAMES[id] || `chain:${id}`;
}
