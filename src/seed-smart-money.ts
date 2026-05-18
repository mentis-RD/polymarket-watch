import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connections: 50, pipelining: 1, keepAliveTimeout: 30_000 }));
import "dotenv/config";

import { fetchLeaderboard } from "./clob-rest.js";
import * as smartMoney from "./smart-money-db.js";
import { log, err } from "./log.js";

/**
 * Seed state/smart_money.json with the top wallets from the public Polymarket
 * leaderboard. Idempotent: existing entries are preserved.
 *
 * Run once (or anytime to refresh):
 *   npx tsx src/seed-smart-money.ts [topN]
 */
async function main(): Promise<void> {
  const topN = Number(process.argv[2] ?? "200");
  log("seed", `fetching top ${topN} by profit + volume`);

  let added = 0;
  try {
    const profit = await fetchLeaderboard("profit", { window: "all", limit: topN });
    const rows = profit.map((e) => ({
      wallet: e.proxyWallet,
      pseudonym: e.pseudonym || e.name,
      amount: e.amount,
      added_by: "leaderboard_profit" as const,
    }));
    added += smartMoney.bulkAdd(rows);
    log("seed", `profit list: ${profit.length} entries, ${added} new`);
  } catch (e) {
    err("seed", "profit fetch failed", (e as Error).message);
  }

  try {
    const volume = await fetchLeaderboard("volume", { window: "all", limit: topN });
    const rows = volume.map((e) => ({
      wallet: e.proxyWallet,
      pseudonym: e.pseudonym || e.name,
      amount: e.amount,
      added_by: "leaderboard_volume" as const,
    }));
    const added2 = smartMoney.bulkAdd(rows);
    log("seed", `volume list: ${volume.length} entries, ${added2} new`);
    added += added2;
  } catch (e) {
    err("seed", "volume fetch failed", (e as Error).message);
  }

  log("seed", `done. total db size=${smartMoney.size()}, newly added=${added}`);
}

main().catch((e) => {
  err("seed", "fatal", e);
  process.exit(1);
});
