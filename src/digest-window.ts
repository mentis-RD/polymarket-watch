import { readFileSync } from "node:fs";

/**
 * Deterministic 24h-window gate for the daily alerts digest (STEP 1).
 *
 * The digest used to ask the headless `claude -p` to "parse the ISO timestamp
 * and drop anything older than 24h" — LLM timestamp arithmetic, which silently
 * failed: a fresh-wallet alert that fired 2026-05-29 05:04 was kept in the
 * 2026-05-31 04:18 digest (~47h old), re-surfacing a DORMANT $3.1M position
 * (last trade 44h prior) as an active "🔁 добирает" signal. The cost-basis
 * progression gave it away — $3.1M→$3.1M, i.e. no new money, because there was
 * no new trade.
 *
 * This filters the raw alert log to ONLY lines whose app-timestamp (the
 * bracketed `[…Z]`, not the pm2 wrapper time) is within the window. A wallet
 * with no in-window alert simply never reaches the digest — so "добирает Nд"
 * can only mean it genuinely fired (traded) on N distinct days.
 *
 * Usage (stdin = raw grepped alert lines, stdout = in-window lines):
 *   grep -E '\[(cluster|cross-market|fresh-wallet)\] alert' ... \
 *     | npx tsx src/digest-window.ts [windowHours] [nowIsoOrEpochMs]
 * Defaults: windowHours=24, now=current time.
 */

const ISO_IN_BRACKETS = /\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\]/;

function main(): void {
  const windowHours = Number(process.argv[2]) || 24;
  const nowArg = process.argv[3];
  const now =
    nowArg === undefined
      ? Date.now()
      : /^\d+$/.test(nowArg)
        ? Number(nowArg)
        : Date.parse(nowArg);
  if (!Number.isFinite(now)) {
    process.stderr.write(`digest-window: bad now "${nowArg}"\n`);
    process.exit(1);
  }
  const cutoff = now - windowHours * 60 * 60 * 1000;

  let kept = 0;
  let dropped = 0;
  const input = readFileSync(0, "utf-8"); // fd 0 = stdin
  for (const line of input.split("\n")) {
    if (!line.trim()) continue;
    const m = ISO_IN_BRACKETS.exec(line);
    if (!m) {
      // No parseable app-timestamp → keep (don't silently drop), let downstream see it.
      process.stdout.write(line + "\n");
      kept++;
      continue;
    }
    const ts = Date.parse(m[1]);
    if (Number.isFinite(ts) && ts >= cutoff) {
      process.stdout.write(line + "\n");
      kept++;
    } else {
      dropped++;
    }
  }
  process.stderr.write(`digest-window: kept ${kept}, dropped ${dropped} (>${windowHours}h old)\n`);
}

main();
