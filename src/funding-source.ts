import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { err } from "./log.js";

/**
 * Classify the sender of a USDC.e/USDC transfer into a Polymarket proxy wallet,
 * OR the origin wallet on the source chain after Relay tracing.
 *
 * Categories:
 *   - "bridge:<name>"  — known cross-chain bridge contract. Identification
 *     only; cluster signal does not use this as a same-funder hint (Phase 6b
 *     Relay tracing is what resolves bridge-funded actors).
 *   - "cex:<name>"     — known centralized exchange hot wallet.
 *   - "swap:<name>"    — non-custodial swap aggregator (ChangeNOW etc.).
 *     Behaves like CEX in cluster scoring.
 *   - "fiat:<name>"    — card-purchase onramp (MoonPay, Ramp, Transak). Weaker
 *     than CEX/swap because base rate of coincidence is lower.
 *   - "service:<name>" — fan-out hub (Polymarket onramp distributor, internal
 *     relayer). Funder identity here has zero clustering signal value.
 *   - null             — unknown sender. Two wallets with the same unknown
 *     direct funder are the strongest correlation signal.
 *
 * Addresses are loaded from JSON files in `addresses/` at module init.
 * Filename pattern: `<chain>-<category>.json` or `shared-<category>.json`.
 */

export type FundingCategory =
  | `bridge:${string}`
  | `cex:${string}`
  | `swap:${string}`
  | `fiat:${string}`
  | `service:${string}`
  | null;

const ADDRESSES_DIR = join(process.cwd(), "addresses");

const BRIDGE_ADDRESSES: Record<string, string> = {};
const CEX_ADDRESSES: Record<string, string> = {};
const SWAP_AGGREGATOR_ADDRESSES: Record<string, string> = {};
const FIAT_ONRAMP_ADDRESSES: Record<string, string> = {};
const SHARED_SERVICE_ADDRESSES: Record<string, string> = {};

function targetDictForCategory(category: string): Record<string, string> | null {
  switch (category) {
    case "cex":
      return CEX_ADDRESSES;
    case "bridge":
      return BRIDGE_ADDRESSES;
    case "swap":
      return SWAP_AGGREGATOR_ADDRESSES;
    case "fiat":
      return FIAT_ONRAMP_ADDRESSES;
    case "service":
      return SHARED_SERVICE_ADDRESSES;
    default:
      return null;
  }
}

function loadDicts(): void {
  if (!existsSync(ADDRESSES_DIR)) return;
  const files = readdirSync(ADDRESSES_DIR);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const base = file.slice(0, -".json".length);
    const dashIdx = base.lastIndexOf("-");
    if (dashIdx <= 0) continue;
    const category = base.slice(dashIdx + 1);
    const target = targetDictForCategory(category);
    if (!target) continue;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(join(ADDRESSES_DIR, file), "utf-8"));
    } catch (e) {
      // Surface bad JSON loudly — otherwise a typo silently disables the
      // whole file's classifications and the only clue is /scan_unknowns
      // showing addresses that should have been recognized.
      err("funding-source", `failed to parse ${file}: ${(e as Error).message}`);
      continue;
    }
    for (const [addr, brand] of Object.entries(data)) {
      if (typeof brand !== "string") continue;
      if (addr.startsWith("_")) continue; // skip _comment fields
      target[addr.toLowerCase()] = brand;
    }
  }
}

loadDicts();

/** Classify a from-address. Always lowercased input. */
export function classify(addressLower: string): FundingCategory {
  if (!addressLower) return null;
  const service = SHARED_SERVICE_ADDRESSES[addressLower];
  if (service) return `service:${service}` as FundingCategory;
  const bridge = BRIDGE_ADDRESSES[addressLower];
  if (bridge) return `bridge:${bridge}` as FundingCategory;
  const cex = CEX_ADDRESSES[addressLower];
  if (cex) return `cex:${cex}` as FundingCategory;
  const swap = SWAP_AGGREGATOR_ADDRESSES[addressLower];
  if (swap) return `swap:${swap}` as FundingCategory;
  const fiat = FIAT_ONRAMP_ADDRESSES[addressLower];
  if (fiat) return `fiat:${fiat}` as FundingCategory;
  return null;
}

/** Coarse buckets used by cluster scoring. */
export function categoryBucket(
  c: FundingCategory,
): "bridge" | "cex" | "swap" | "fiat" | "service" | "private" {
  if (c === null) return "private";
  if (c.startsWith("service:")) return "service";
  if (c.startsWith("bridge:")) return "bridge";
  if (c.startsWith("swap:")) return "swap";
  if (c.startsWith("fiat:")) return "fiat";
  return "cex";
}

/** Counts in loaded dictionaries (for diagnostics). */
export function dictSizes(): { bridge: number; cex: number; swap: number; fiat: number; service: number } {
  return {
    bridge: Object.keys(BRIDGE_ADDRESSES).length,
    cex: Object.keys(CEX_ADDRESSES).length,
    swap: Object.keys(SWAP_AGGREGATOR_ADDRESSES).length,
    fiat: Object.keys(FIAT_ONRAMP_ADDRESSES).length,
    service: Object.keys(SHARED_SERVICE_ADDRESSES).length,
  };
}
