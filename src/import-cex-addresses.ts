import { request } from "undici";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One-shot importer for the full centralized-exchange EVM hot-wallet set,
 * sourced from Dune's spellbook (hildobby-curated `cex_evms_addresses` — the
 * canonical open CEX label dataset). Writes addresses/shared-cex.json, which
 * funding-source.ts merges (flat, by-address) into CEX_ADDRESSES across all
 * chains.
 *
 *   npx tsx src/import-cex-addresses.ts
 *
 * Re-run to refresh whenever the upstream set grows. Chain-agnostic by
 * design: our classify() is a flat address lookup, so one file covers
 * Coinbase/Binance/OKX/etc on Polygon, Arbitrum, Base, Ethereum, etc.
 *
 * Non-EVM (Solana/Tron) live in separate spellbook files and our existing
 * solana-cex.json — not imported here. Hyperliquid (perp DEX, not in Dune's
 * CEX taxonomy) stays in arbitrum-cex.json.
 */

const SRC =
  "https://raw.githubusercontent.com/duneanalytics/spellbook/main/dbt_subprojects/hourly_spellbook/models/_sector/cex/addresses/chains/cex_evms_addresses.sql";

const OUT = join(process.cwd(), "addresses", "shared-cex.json");

// Row shape: (0xADDR, 'Cex Name', 'distinct', 'added_by', date '...')
const ROW = /\(\s*(0x[0-9a-fA-F]{40})\s*,\s*'([^']+)'\s*,\s*'([^']*)'/g;

function slug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function main(): Promise<void> {
  const res = await request(SRC, { bodyTimeout: 30_000, headersTimeout: 10_000 });
  if (res.statusCode !== 200) throw new Error(`fetch failed: HTTP ${res.statusCode}`);
  const txt = await res.body.text();

  const out: Record<string, string> = {
    _comment:
      "Full CEX EVM hot-wallet set, imported from Dune spellbook " +
      "cex_evms_addresses (hildobby-curated). Chain-agnostic: classify() is a " +
      "flat by-address lookup. Regenerate: npx tsx src/import-cex-addresses.ts",
  };
  const brands = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = ROW.exec(txt))) {
    const addr = m[1].toLowerCase();
    const brand = slug(m[2]);
    if (!brand) continue;
    out[addr] = brand;
    brands.set(brand, (brands.get(brand) ?? 0) + 1);
  }

  const n = Object.keys(out).length - 1;
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  const top = [...brands.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`wrote ${n} addresses across ${brands.size} brands → ${OUT}`);
  console.log("top brands:", top.map(([b, c]) => `${b}:${c}`).join(", "));
}

main().catch((e) => {
  console.error("import-cex-addresses failed:", (e as Error).message);
  process.exit(1);
});
