import { request } from "undici";
import { log, err } from "./log.js";

const POLYGON_BASE = "https://polygon-mainnet.g.alchemy.com/v2/";
const EXHAUSTED_RETRY_MS = 5 * 60 * 1000;

interface KeyState {
  key: string;
  exhausted_at?: number;
  fail_count: number;
}

let pool: KeyState[] | null = null;
let cursor = 0;

function getPool(): KeyState[] {
  if (pool) return pool;
  const raw = process.env.ALCHEMY_KEYS || "";
  const keys = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (keys.length === 0) throw new Error("ALCHEMY_KEYS env var is empty");
  pool = keys.map((key) => ({ key, fail_count: 0 }));
  return pool;
}

function pickKey(): KeyState {
  const p = getPool();
  for (let i = 0; i < p.length; i++) {
    const idx = (cursor + i) % p.length;
    const k = p[idx];
    if (!k.exhausted_at || Date.now() - k.exhausted_at > EXHAUSTED_RETRY_MS) {
      cursor = (idx + 1) % p.length;
      return k;
    }
  }
  // All exhausted — pick the one whose cooldown is earliest expiring.
  let oldest = p[0];
  for (const k of p) {
    if ((k.exhausted_at ?? 0) < (oldest.exhausted_at ?? 0)) oldest = k;
  }
  cursor = (p.indexOf(oldest) + 1) % p.length;
  return oldest;
}

function looksExhausted(status: number, text: string): boolean {
  if (status === 401 || status === 402 || status === 403 || status === 429) return true;
  return /credit|quota|exceeded|insufficient|depleted|limit/i.test(text);
}

/** Call a Polygon JSON-RPC method via the next non-exhausted Alchemy key. */
export async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const p = getPool();
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < p.length; attempt++) {
    const k = pickKey();
    const url = POLYGON_BASE + k.key;
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

export function poolStatus(): { keys: number; exhausted: number } {
  const p = getPool();
  return {
    keys: p.length,
    exhausted: p.filter((k) => k.exhausted_at && Date.now() - k.exhausted_at < EXHAUSTED_RETRY_MS).length,
  };
}
