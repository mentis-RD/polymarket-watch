import "dotenv/config";
import { crossMarketReport } from "./signals/cross-market-correlation.js";

/**
 * CLI wrapper so the daily digest (headless `claude -p`) can re-derive a
 * cross-market alert's ACTUAL cluster at digest time — same as cluster-cli
 * does for coordinated clusters.
 *
 *   npx tsx src/xmarket-cli.ts <wallet>
 *
 * Why: the `[cross-market] alert: <wallet> <N> markets, $<notional>` log line
 * carries NO market slugs. Without this, the digest has to guess a title for
 * the line and tends to grab the wallet's top OVERALL position (incl. markets
 * NOT in the keyword cluster, and not even on our watchlist) — mislabelling an
 * Iran-uranium cluster as "Russia Kostyantynivka / Ukraine", or surfacing a
 * "France win World Cup" title that isn't in the cluster at all.
 *
 * This re-runs the real keyword-correlation + EOD position prune and prints
 * the Markdown report. The digest must title/theme the line from the report's
 * TOP market (first bullet — rows are sorted by current held $ desc), use the
 * report's current notional, and DROP the alert if the report says
 * "no correlated-market cluster" / "decayed".
 */
async function main(): Promise<void> {
  const wallet = process.argv[2];
  if (!wallet) {
    console.error("usage: tsx src/xmarket-cli.ts <wallet>");
    process.exit(1);
  }
  const report = await crossMarketReport(wallet);
  console.log(report);
}

main().catch((e) => {
  console.error("xmarket-cli failed:", (e as Error).message);
  process.exit(1);
});
