import { request } from "undici";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Importer for exchange / swap / fiat-onramp hot-wallet sets, sourced from
 * Dune's spellbook (hildobby-curated `cex_*_addresses` — the canonical open
 * label dataset). Routes each brand into the correct bucket so cluster
 * scoring weights stay right:
 *   - CEX            → addresses/<chain>-cex.json     (cex bucket, 0.5)
 *   - swap aggregator→ addresses/shared-swap.json     (swap bucket, == cex)
 *   - fiat onramp    → addresses/shared-fiat.json     (fiat bucket, 0.4)
 *
 *   npx tsx src/import-cex-addresses.ts
 *
 * Sources:
 *   - EVM (chain-agnostic, addresses reused across EVM)  → shared-cex.json
 *   - Tron  (base58)                                     → tron-cex.json
 *   - Solana (base58)                                    → solana-cex.json
 *
 * swap/fiat + the Solana file are MERGED with whatever is already on disk so
 * hand-curated entries survive. Non-EVM addresses are lowercased to match
 * bridge-tracer origin normalization (see funding_classifier caveat #5).
 * Hyperliquid (perp DEX, not in Dune's CEX taxonomy) stays manual in
 * arbitrum-cex.json and is untouched.
 */

const RAW = "https://raw.githubusercontent.com/duneanalytics/spellbook/main/dbt_subprojects/hourly_spellbook/models/_sector/cex/addresses/chains";
const ADDR_DIR = join(process.cwd(), "addresses");

// Brands that are instant non-custodial SWAP aggregators, NOT exchanges.
// User: "обменки должны быть отдельно и это реально важно."
const SWAP_BRANDS = new Set([
  "changenow", "simpleswap", "fixedfloat", "sideshift", "shapeshift",
  "changelly", "switchain", "stealthex", "exch-sc", "godex", "swft-blockchain",
]);
// Brands that are FIAT onramps (lower cluster weight than CEX).
const FIAT_BRANDS = new Set([
  "moonpay", "ramp-network", "ramp", "transak", "simplex", "mercuryo",
  "paybis", "coinify", "banxa", "wyre", "guardarian", "sardine", "mercuryo",
]);

type Brand = string;
function slug(name: string): Brand {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function bucketOf(brand: Brand): "swap" | "fiat" | "cex" {
  if (SWAP_BRANDS.has(brand)) return "swap";
  if (FIAT_BRANDS.has(brand)) return "fiat";
  return "cex";
}

async function fetchText(url: string): Promise<string> {
  const res = await request(url, { bodyTimeout: 30_000, headersTimeout: 10_000 });
  if (res.statusCode !== 200) throw new Error(`fetch ${url}: HTTP ${res.statusCode}`);
  return res.body.text();
}

// EVM rows: (0xADDR, 'Cex', 'distinct', ...)
const EVM_ROW = /\(\s*(0x[0-9a-fA-F]{40})\s*,\s*'([^']+)'\s*,\s*'([^']*)'/g;
// Non-EVM rows: ('chain', 'ADDR', 'Cex', 'distinct', ...)
const NONEVM_ROW = /\(\s*'[a-z]+'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']*)'/g;

/** Accumulator: target file basename → { addr: brand }. */
const files: Record<string, Record<string, Brand>> = {};
function put(file: string, addr: string, brand: Brand): void {
  (files[file] ??= {})[addr] = brand;
}

function routeEvm(addr: string, brand: Brand): void {
  const b = bucketOf(brand);
  if (b === "swap") put("shared-swap", addr, brand);
  else if (b === "fiat") put("shared-fiat", addr, brand);
  else put("shared-cex", addr, brand);
}
function routeNonEvm(chainFile: string, addrLower: string, brand: Brand): void {
  const b = bucketOf(brand);
  if (b === "swap") put("shared-swap", addrLower, brand);
  else if (b === "fiat") put("shared-fiat", addrLower, brand);
  else put(chainFile, addrLower, brand);
}

function mergeExisting(file: string): void {
  const path = join(ADDR_DIR, `${file}.json`);
  if (!existsSync(path)) return;
  try {
    const cur = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
    const acc = (files[file] ??= {});
    for (const [k, v] of Object.entries(cur)) {
      if (k === "_comment") continue;
      if (!(k in acc)) acc[k] = v; // keep manual entry if spellbook didn't supply it
    }
  } catch { /* ignore */ }
}

const COMMENTS: Record<string, string> = {
  "shared-cex": "Full CEX EVM hot-wallet set (Dune spellbook cex_evms, hildobby). Chain-agnostic flat lookup. Regenerate: npx tsx src/import-cex-addresses.ts",
  "shared-swap": "Non-custodial swap aggregators (swap bucket; scores == CEX in cluster). Spellbook + manual. Regenerate: npx tsx src/import-cex-addresses.ts",
  "shared-fiat": "Fiat onramps (fiat bucket; lower cluster weight). Spellbook + manual. Regenerate: npx tsx src/import-cex-addresses.ts",
  "tron-cex": "Tron CEX hot wallets (Dune spellbook cex_tron, hildobby). base58, lowercased to match bridge-tracer.",
  "solana-cex": "Solana CEX hot wallets (Dune spellbook cex_solana, hildobby) + manual. base58, lowercased.",
};

async function main(): Promise<void> {
  // EVM
  const evm = await fetchText(`${RAW}/cex_evms_addresses.sql`);
  let m: RegExpExecArray | null;
  while ((m = EVM_ROW.exec(evm))) routeEvm(m[1].toLowerCase(), slug(m[2]));
  // Tron
  const tron = await fetchText(`${RAW}/tron/cex_tron_addresses.sql`);
  while ((m = NONEVM_ROW.exec(tron))) routeNonEvm("tron-cex", m[1].toLowerCase(), slug(m[2]));
  // Solana
  const sol = await fetchText(`${RAW}/solana/cex_solana_addresses.sql`);
  while ((m = NONEVM_ROW.exec(sol))) routeNonEvm("solana-cex", m[1].toLowerCase(), slug(m[2]));

  // shared-cex / tron-cex are spellbook-authoritative (overwrite). swap/fiat
  // and solana-cex merge with existing manual entries.
  for (const f of ["shared-swap", "shared-fiat", "solana-cex"]) mergeExisting(f);

  for (const [file, map] of Object.entries(files)) {
    const out: Record<string, string> = { _comment: COMMENTS[file] || "imported" };
    for (const [k, v] of Object.entries(map)) out[k] = v;
    writeFileSync(join(ADDR_DIR, `${file}.json`), JSON.stringify(out, null, 2) + "\n");
    console.log(`${file}.json: ${Object.keys(map).length} addresses`);
  }
}

main().catch((e) => {
  console.error("import failed:", (e as Error).message);
  process.exit(1);
});
