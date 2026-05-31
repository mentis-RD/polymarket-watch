import { request } from "undici";
import { log, err } from "./log.js";

export interface BridgeOrigin {
  /** Origin chain wallet (lowercased) that initiated the bridge to the recipient. */
  user: string;
  /** Origin chain ID where the user wallet lives (EVM chain id, or 0 for Solana). */
  chain_id: number | null;
  /** ISO timestamp of the earliest known bridge tx to this recipient. */
  first_seen_iso: string;
  /** Which bridge resolved the origin — useful for logging / metrics. */
  bridge: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Relay
// ────────────────────────────────────────────────────────────────────────────

const RELAY_BASE = "https://api.relay.link";

interface RelayRequest {
  id: string;
  status: string;
  user: string;
  recipient: string;
  data: {
    inTxs?: { hash?: string; chainId?: number; type?: string }[];
    metadata?: {
      sender?: string;
      recipient?: string;
      originChainId?: number;
      currencyIn?: { amountUsd?: string | number };
    };
  };
  createdAt: string;
}

/** Min USD size for a Relay leg to count as real funding — below this it's
 *  solver-fill noise (a wallet that is itself a Relay solver receives dozens
 *  of tiny diverse-currency fills/sec; those must not be read as funding). */
const MIN_FUNDING_USD = 1000;

function relayAmountUsd(r: RelayRequest): number {
  const v = r.data?.metadata?.currencyIn?.amountUsd;
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Resolve a wallet's Relay funding origin. Queries BOTH directions:
 *   recipient=<w> — someone bridged INTO this wallet; origin = request.user
 *   user=<w>      — this wallet INITIATED a deposit; funder = metadata.sender
 * The `user=` direction is essential: a wallet that funds its own Polymarket
 * position via Relay (the standard deposit rail) has NO inbound `recipient=`
 * legs except solver noise. Sub-$1k legs are dropped as solver/dust noise.
 * Picks the EARLIEST qualifying (>= $1k) leg across both directions.
 */
async function fetchEarliestRelayOrigin(
  wallet: string,
  limit = 50,
): Promise<BridgeOrigin | null> {
  const w = wallet.toLowerCase();
  const ZERO = "0x0000000000000000000000000000000000000000";

  async function pull(dir: "recipient" | "user"): Promise<BridgeOrigin | null> {
    const url = `${RELAY_BASE}/requests?${dir}=${w}&limit=${limit}`;
    try {
      const res = await request(url, { bodyTimeout: 15_000, headersTimeout: 10_000 });
      if (res.statusCode !== 200) return null;
      const data = (await res.body.json()) as { requests?: RelayRequest[] };
      const reqs = (data.requests ?? []).filter((r) => relayAmountUsd(r) >= MIN_FUNDING_USD);
      if (reqs.length === 0) return null;
      reqs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      for (const r of reqs) {
        // recipient-dir: the bridge initiator (request.user) is the origin.
        // user-dir: the wallet itself initiated, so the FUNDER (who supplied
        // the input funds = metadata.sender) is the meaningful origin.
        const originRaw = dir === "recipient"
          ? (r.user || r.data?.metadata?.sender)
          : (r.data?.metadata?.sender || r.user);
        // EVM addresses are case-insensitive → lowercase for dedup/matching.
        // Solana/Tron origins are base58 and CASE-SENSITIVE → lowercasing
        // corrupts them (breaks explorer links + identity). Preserve non-0x case.
        const origin = (originRaw || "").startsWith("0x") ? (originRaw as string).toLowerCase() : (originRaw || "");
        if (!origin || origin === ZERO || origin === w) continue;
        return {
          user: origin,
          chain_id: r.data?.metadata?.originChainId ?? r.data.inTxs?.[0]?.chainId ?? null,
          first_seen_iso: r.createdAt,
          bridge: "relay",
        };
      }
      return null;
    } catch (e) {
      err("bridge-tracer", `relay ${dir} lookup failed for ${w}`, (e as Error).message);
      return null;
    }
  }

  const [recip, init] = await Promise.all([pull("recipient"), pull("user")]);
  if (recip && init) {
    return Date.parse(recip.first_seen_iso) <= Date.parse(init.first_seen_iso) ? recip : init;
  }
  return recip || init;
}

// ────────────────────────────────────────────────────────────────────────────
// Wormhole
// ────────────────────────────────────────────────────────────────────────────

const WORMHOLE_BASE = "https://api.wormholescan.io/api/v1";

/** Wormhole's internal chain numbering → standard EVM chain id (0 for non-EVM). */
const WORMHOLE_CHAIN_MAP: Record<number, number> = {
  1: 0, // Solana
  2: 1, // Ethereum
  4: 56, // BSC
  5: 137, // Polygon
  6: 43114, // Avalanche
  10: 250, // Fantom
  14: 42220, // Celo
  16: 1284, // Moonbeam
  23: 42161, // Arbitrum
  24: 10, // Optimism
  30: 8453, // Base
};

interface WormholeOperation {
  id: string;
  sourceChain?: {
    chainId?: number;
    timestamp?: string;
    from?: string;
  };
  standarizedProperties?: {
    fromChain?: number;
    fromAddress?: string;
    toChain?: number;
    toAddress?: string;
  };
  data?: { symbol?: string };
}

async function fetchEarliestWormholeOrigin(
  recipientWallet: string,
  limit = 50,
): Promise<BridgeOrigin | null> {
  const url = `${WORMHOLE_BASE}/operations?destAddress=${recipientWallet}&pageSize=${limit}`;
  try {
    const res = await request(url, { bodyTimeout: 15_000, headersTimeout: 10_000 });
    if (res.statusCode !== 200) return null;
    const data = (await res.body.json()) as { operations?: WormholeOperation[] };
    const ops = data.operations ?? [];
    if (ops.length === 0) return null;
    // Sort ascending by source-chain timestamp; fall back to id ordering.
    ops.sort((a, b) => {
      const at = a.sourceChain?.timestamp ? Date.parse(a.sourceChain.timestamp) : Infinity;
      const bt = b.sourceChain?.timestamp ? Date.parse(b.sourceChain.timestamp) : Infinity;
      return at - bt;
    });
    const earliest = ops[0];
    const fromAddr = (
      earliest.sourceChain?.from ||
      earliest.standarizedProperties?.fromAddress ||
      ""
    ).toLowerCase();
    if (!fromAddr || fromAddr === "0x0000000000000000000000000000000000000000") return null;
    const whChain = earliest.sourceChain?.chainId ?? earliest.standarizedProperties?.fromChain ?? 0;
    const chainId = WORMHOLE_CHAIN_MAP[whChain] ?? null;
    return {
      user: fromAddr,
      chain_id: chainId,
      first_seen_iso: earliest.sourceChain?.timestamp || new Date().toISOString(),
      bridge: "wormhole",
    };
  } catch (e) {
    err("bridge-tracer", `wormhole lookup failed for ${recipientWallet}`, (e as Error).message);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Dispatcher
// ────────────────────────────────────────────────────────────────────────────

/**
 * Trace the origin EOA on the source chain for a Polymarket proxy. Dispatches
 * by `bridgeName` (derived from funding_source classification like "bridge:relay").
 *
 * If bridgeName is null/unknown ("private" bucket), tries known tracers in
 * descending coverage order until one returns data, since the unknown sender
 * might actually be a Relay solver / Wormhole emitter we don't have in dict.
 *
 * Coverage as of 2026-05-18:
 *   relay     — full origin lookup via api.relay.link/requests
 *   wormhole  — full origin lookup via api.wormholescan.io operations
 *   across    — TODO (no working public filter API; would need Graph API key)
 *   stargate  — TODO (LayerZero scan does not expose arbitrary addr lookup)
 *   hop / synapse / bungee / debridge / squid / polygon-pos — TODO
 *
 * Returns null when no tracer has data, or when the responsible bridge has
 * no tracing support yet.
 */
export async function fetchEarliestBridgeOrigin(
  bridgeName: string | null,
  recipientWallet: string,
): Promise<BridgeOrigin | null> {
  if (bridgeName === "relay") {
    return await fetchEarliestRelayOrigin(recipientWallet);
  }
  if (bridgeName === "wormhole") {
    return await fetchEarliestWormholeOrigin(recipientWallet);
  }
  if (bridgeName === null) {
    // Unknown sender — try fallbacks to see if it's actually a Relay/Wormhole tx.
    const relay = await fetchEarliestRelayOrigin(recipientWallet);
    if (relay) return relay;
    const wormhole = await fetchEarliestWormholeOrigin(recipientWallet);
    if (wormhole) return wormhole;
    return null;
  }
  // Known-but-unsupported bridge (across/stargate/etc): identification only.
  log("bridge-tracer", `no tracer for bridge=${bridgeName}; origin unresolved`);
  return null;
}

// Kept for backwards-compat callers; same semantics as the dispatcher with
// bridgeName=null (i.e. try fallbacks).
export const fetchEarliestRelayOriginCompat = (recipient: string) =>
  fetchEarliestBridgeOrigin(null, recipient);

const CHAIN_NAMES: Record<number, string> = {
  0: "solana",
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  137: "polygon",
  250: "fantom",
  8453: "base",
  42161: "arbitrum",
  43114: "avalanche",
  // Relay's synthetic IDs for non-EVM chains (seen in request metadata).
  792703809: "solana",
  728126428: "tron",
};

export function chainName(id: number | null): string {
  if (id === null || id === undefined) return "?";
  return CHAIN_NAMES[id] || `chain:${id}`;
}
