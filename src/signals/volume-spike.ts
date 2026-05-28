import type { TradeEvent } from "../clob-ws.js";
import { canAlert, markAlerted } from "../alert-cooldown.js";
import { sendMessage } from "../telegram.js";
import { escapeMd } from "../markdown.js";
import { marketLink, fmtMoneyShort, shortDate, EXTREME_PRICE_HIGH } from "../alert-format.js";
import { log } from "../log.js";

const HOUR_MS = 60 * 60 * 1000;
const BASELINE_HOURS = 168; // 7 days
const COOLDOWN_MS = 2 * HOUR_MS;
const SPIKE_MULTIPLE = 10;
const ONE_SIDED_PCT = 0.7;
/**
 * Volume is measured in USD notional (size × price), NOT share count.
 * Share-count thresholds were meaningless across markets (100 shares of
 * a 2c outcome is $2; 100 shares of a 90c outcome is $90). Absolute
 * floor: the current hour must move at least this many dollars to even
 * be considered for a spike — kills micro-spikes on thin/dead markets
 * (e.g. a $1k trade on a market whose baseline is $10/hr = "100×" but
 * is absolute pocket change). Set to $500 for the test pass.
 */
const MIN_CUR_VOL_USD = 500;
/** Baseline floor (USD/hr) — prevents divide-by-near-zero multiples. */
const MIN_BASELINE_USD = 10;

/** Per-side hourly volume bucket — USD notional summed, by BUY/SELL. */
interface Bucket {
  buy: number;
  sell: number;
}

function hourKey(ts: number): number {
  return Math.floor(ts / HOUR_MS);
}

/**
 * Per-market rolling hourly volume buckets, last 168 hours.
 * In-memory; rebuilt on restart from trades.jsonl replay.
 */
export class VolumeSpikeDetector {
  // slug -> hourKey -> Bucket
  private buckets = new Map<string, Map<number, Bucket>>();

  /** Slug → market metadata for alerts. */
  private meta = new Map<string, { question: string; end_date: string; risk_tag: string }>();

  setMarketMeta(slug: string, meta: { question: string; end_date: string; risk_tag: string }): void {
    this.meta.set(slug, meta);
  }

  trackedSlugs(): string[] {
    return [...this.meta.keys()];
  }

  removeMarket(slug: string): void {
    this.buckets.delete(slug);
    this.meta.delete(slug);
  }

  /** Ingest a trade. Mutates the per-market bucket map. */
  ingest(slug: string, t: TradeEvent): void {
    // Skip near-certain trades (>=95c) — volume churn on an already-decided
    // market isn't an informative spike. Trades while the market is still
    // contested (<95c) still accumulate, so a news-driven move INTO 95c
    // still trips the spike on the contested-price volume.
    if (t.price >= EXTREME_PRICE_HIGH) return;
    let perSlug = this.buckets.get(slug);
    if (!perSlug) {
      perSlug = new Map();
      this.buckets.set(slug, perSlug);
    }
    const hk = hourKey(t.ts);
    let b = perSlug.get(hk);
    if (!b) {
      b = { buy: 0, sell: 0 };
      perSlug.set(hk, b);
    }
    // USD notional, not share count.
    const usd = t.size * t.price;
    if (t.side === "BUY") b.buy += usd;
    else b.sell += usd;

    // Trim old buckets.
    const cutoff = hk - BASELINE_HOURS;
    for (const k of perSlug.keys()) {
      if (k < cutoff) perSlug.delete(k);
    }
  }

  /**
   * Check current hour vs baseline for each tracked market.
   * Returns alerts that fired (after recording cooldown).
   */
  async checkAll(): Promise<void> {
    const now = Date.now();
    const curH = hourKey(now);
    for (const [slug, perSlug] of this.buckets) {
      const cur = perSlug.get(curH);
      if (!cur) continue;
      const curVol = cur.buy + cur.sell; // USD notional this hour
      if (curVol < MIN_CUR_VOL_USD) continue; // absolute $ floor — kills micro-spikes

      // Baseline: mean hourly USD volume across previous hours, excluding current.
      let total = 0;
      let count = 0;
      for (const [k, b] of perSlug) {
        if (k === curH) continue;
        total += b.buy + b.sell;
        count++;
      }
      if (count < 6) continue; // need at least 6 hours of history
      const baseline = total / count;
      if (baseline < MIN_BASELINE_USD) continue; // skip dead markets / divide-by-tiny

      const multiple = curVol / baseline;
      if (multiple < SPIKE_MULTIPLE) continue;

      const sideRatio = Math.max(cur.buy, cur.sell) / curVol;
      const oneSided = sideRatio >= ONE_SIDED_PCT;
      const dominantSide = cur.buy >= cur.sell ? "BUY" : "SELL";

      const key = `volspike:${slug}:${curH}`;
      if (!canAlert(key, COOLDOWN_MS)) continue;

      await this.fireAlert(slug, {
        curVol,
        baseline,
        multiple,
        oneSided,
        dominantSide,
        sideRatio,
      });
      markAlerted(key);
    }
  }

  private async fireAlert(
    slug: string,
    info: {
      curVol: number;
      baseline: number;
      multiple: number;
      oneSided: boolean;
      dominantSide: string;
      sideRatio: number;
    },
  ): Promise<void> {
    const meta = this.meta.get(slug);
    const chat = process.env.TG_CHAT_MAIN;
    const thread = process.env.TG_THREAD_VOLUME;
    if (!chat) return;

    const sideTxt = info.oneSided
      ? ` · ${Math.round(info.sideRatio * 100)}% *${info.dominantSide.toUpperCase()}*`
      : "";
    const titleLink = meta
      ? marketLink(slug, escapeMd(meta.question))
      : marketLink(slug, `\`${escapeMd(slug)}\``);
    const endTxt = meta?.end_date ? ` · ends ${shortDate(meta.end_date)}` : "";
    const text = [
      `🚨 *Volume spike · ${info.multiple.toFixed(1)}×*`,
      "",
      titleLink,
      `${fmtMoneyShort(info.curVol)}/hr${sideTxt} · baseline ${fmtMoneyShort(info.baseline)}/hr${endTxt}`,
    ].join("\n");

    await sendMessage({
      chatId: chat,
      threadId: thread || undefined,
      text,
      parseMode: "Markdown",
    });
    log("volume-spike", `alert: ${slug} ${info.multiple.toFixed(1)}x baseline`);
  }
}
