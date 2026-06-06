import { request } from "undici";
import { log, err } from "./log.js";

const EXHAUSTED_RETRY_MS = 5 * 60 * 1000;

/**
 * Alchemy network subdomain per logical chain. One key works across all
 * networks enabled on the Alchemy app. `rpc()` defaults to polygon for
 * backward-compat; pass a chain to hit another network. Add subdomains
 * here as needed (Alchemy now covers non-EVM too, e.g. solana-mainnet).
 */
const NETWORK_SUBDOMAIN: Record<string, string> = {
  polygon: "polygon-mainnet",
  arbitrum: "arb-mainnet",
  base: "base-mainnet",
  optimism: "opt-mainnet",
  ethereum: "eth-mainnet",
  bnb: "bnb-mainnet",
  avalanche: "avax-mainnet",
  solana: "solana-mainnet",
};

export type AlchemyChain = keyof typeof NETWORK_SUBDOMAIN | string;

function baseUrlFor(chain: AlchemyChain): string {
  const sub = NETWORK_SUBDOMAIN[chain] || NETWORK_SUBDOMAIN.polygon;
  return `https://${sub}.g.alchemy.com/v2/`;
}

interface KeyState {
  key: string;
  exhausted_at?: number;
  fail_count: number;
  /** Reserve (paid) key — used ONLY when every free key is exhausted. */
  reserve: boolean;
}

let pool: KeyState[] | null = null;
let cursor = 0; // rotates over FREE keys only

function getPool(): KeyState[] {
  if (pool) return pool;
  const parse = (raw: string) => (raw || "").split(",").map((s) => s.trim()).filter(Boolean);
  const free = parse(process.env.ALCHEMY_KEYS || "");
  if (free.length === 0) throw new Error("ALCHEMY_KEYS env var is empty");
  // Reserve keys are billed (paid plan) → kept out of normal rotation; only hit
  // once every free key is rate-limited. Set ALCHEMY_KEYS_RESERVE to enable.
  const reserve = parse(process.env.ALCHEMY_KEYS_RESERVE || "");
  pool = [
    ...free.map((key) => ({ key, fail_count: 0, reserve: false })),
    ...reserve.map((key) => ({ key, fail_count: 0, reserve: true })),
  ];
  return pool;
}

function usable(k: KeyState): boolean {
  return !k.exhausted_at || Date.now() - k.exhausted_at > EXHAUSTED_RETRY_MS;
}

function pickKey(): KeyState {
  const p = getPool();
  const free = p.filter((k) => !k.reserve);
  const reserve = p.filter((k) => k.reserve);
  // 1. round-robin a usable FREE key.
  for (let i = 0; i < free.length; i++) {
    const idx = (cursor + i) % free.length;
    if (usable(free[idx])) {
      cursor = (idx + 1) % free.length;
      return free[idx];
    }
  }
  // 2. all free exhausted → a usable RESERVE (paid) key.
  for (const k of reserve) if (usable(k)) return k;
  // 3. everything exhausted → earliest-expiring, FREE preferred (so a recovering
  //    free key is chosen over burning paid credits on a tie).
  const ordered = [...free, ...reserve];
  let oldest = ordered[0];
  for (const k of ordered) if ((k.exhausted_at ?? 0) < (oldest.exhausted_at ?? 0)) oldest = k;
  return oldest;
}

function looksExhausted(status: number, text: string): boolean {
  if (status === 401 || status === 402 || status === 403 || status === 429) return true;
  return /credit|quota|exceeded|insufficient|depleted|limit/i.test(text);
}

/**
 * Call a JSON-RPC method via the next non-exhausted Alchemy key.
 * `chain` selects the Alchemy network (default "polygon" for back-compat).
 */
export async function rpc<T = unknown>(
  method: string,
  params: unknown[],
  chain: AlchemyChain = "polygon",
): Promise<T> {
  const p = getPool();
  let lastErr: unknown = null;
  const base = baseUrlFor(chain);

  for (let attempt = 0; attempt < p.length; attempt++) {
    const k = pickKey();
    const url = base + k.key;
    try {
      const res = await request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        bodyTimeout: 20_000,
        headersTimeout: 10_000,
      });
      const text = await res.body.text();
      if (looksExhausted(res.statusCode, text)) {
        k.exhausted_at = Date.now();
        k.fail_count++;
        err("alchemy-pool", `key ${maskKey(k.key)} exhausted (HTTP ${res.statusCode})`);
        continue;
      }
      let data: { result?: T; error?: { code: number; message: string } };
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`alchemy: malformed JSON (status ${res.statusCode})`);
      }
      if (data.error) {
        if (looksExhausted(0, data.error.message)) {
          k.exhausted_at = Date.now();
          k.fail_count++; // mirror the HTTP-exhausted path
          err("alchemy-pool", `key ${maskKey(k.key)} JSON-RPC quota error: ${data.error.message}`);
          continue;
        }
        throw new Error(`alchemy error: ${data.error.code} ${data.error.message}`);
      }
      // success — reset fail count
      k.fail_count = 0;
      return data.result as T;
    } catch (e) {
      lastErr = e;
      k.fail_count++;
    }
  }

  const allExhausted = p.every((k) => k.exhausted_at);
  if (allExhausted) {
    err("alchemy-pool", "ALL keys exhausted simultaneously");
  }
  throw lastErr instanceof Error ? lastErr : new Error("alchemy: all keys failed");
}

function maskKey(k: string): string {
  if (k.length <= 6) return "***";
  return k.slice(0, 3) + "…" + k.slice(-3);
}

export function poolStatus(): { keys: number; free: number; reserve: number; exhausted: number } {
  const p = getPool();
  const isExhausted = (k: KeyState) => k.exhausted_at && Date.now() - k.exhausted_at < EXHAUSTED_RETRY_MS;
  return {
    keys: p.length,
    free: p.filter((k) => !k.reserve).length,
    reserve: p.filter((k) => k.reserve).length,
    exhausted: p.filter(isExhausted).length,
  };
}
