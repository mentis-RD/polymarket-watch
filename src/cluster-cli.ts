import "dotenv/config";
import { clusterReport } from "./signals/coordinated-cluster.js";

/**
 * CLI wrapper so the daily digest (headless `claude -p`) can re-review a
 * cluster at digest time — applying the same-side gate, funder-fanout
 * neutralization, and EOD position prune that clusterReport does — instead
 * of trusting the stale `cluster=N` count from the alert log.
 *
 *   npx tsx src/cluster-cli.ts <event_slug>
 *
 * Prints the reviewed Markdown report. If it contains "no qualifying" /
 * "none survive", the cluster has decayed (sold out / over-linked) and the
 * digest should DROP it. Otherwise the printed header lines carry the
 * current member count / side / $ held for the digest's themed line.
 */
async function main(): Promise<void> {
  const slug = process.argv[2];
  if (!slug) {
    console.error("usage: tsx src/cluster-cli.ts <event_slug>");
    process.exit(1);
  }
  const report = await clusterReport(slug);
  console.log(report);
}

main().catch((e) => {
  console.error("cluster-cli failed:", (e as Error).message);
  process.exit(1);
});
