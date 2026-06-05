import "dotenv/config";
import { spikeThemeSummary24h } from "./signals/volume-spike.js";

/**
 * Prints the one-line 24h volume-spike THEME summary for the daily digest
 * (market types where hype rose + per-theme count). Not the full /spikes list.
 *
 *   npx tsx src/spike-summary-cli.ts
 */
spikeThemeSummary24h()
  .then((s) => console.log(s))
  .catch((e) => {
    console.error("spike-summary-cli failed:", (e as Error).message);
    process.exit(1);
  });
