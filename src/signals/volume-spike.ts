import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { TradeEvent } from "../clob-ws.js";
import { canAlert, markAlerted } from "../alert-cooldown.js";
import { sendMessage } from "../telegram.js";
import { escapeMd } from "../markdown.js";
import { marketLink, fmtMoneyShort, shortDate, EXTREME_PRICE_HIGH } from "../alert-format.js";
import { log } from "../log.js";

/** Spike-event log the /spikes digest command reads (bot is a separate
 *  process from market-monitor, so it can't see the in-memory detector). */
const SPIKES_LOG = join(process.cwd(), "state", "spikes.jsonl");
export interface SpikeRecord {
  ts: number; slug: string; question: string; end_date: string;
  multiple: number; oneSided: boolean; dominantSide: string; sideRatio: number;
  curVol: number;
}

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
 * is absolute pocket change).
 */
const MIN_CUR_VOL_USD = 1500;
/**
 * Baseline floor (USD/hr) — the market's NORMAL hourly volume must clear this
 * to be tracked at all. At the old $10/hr (~$240/day of total volume) genuinely
 * thin markets surfaced; raised to $50/hr (~$1.2k/day) so a spike means real
 * money on an already-liquid market, not noise on a dead one.
 */
const MIN_BASELINE_USD = 50;

/**
 * Per-hour volume bucket — USD notional split by (outcome × taker side), so
 * the digest can show OUTCOME direction (YES/NO), not just taker aggression.
 * For a binary market, buying YES and selling NO both push toward YES, and
 * buying NO / selling YES push toward NO. So:
 *   yesPressure = buyYes + sellNo,  noPressure = buyNo + sellYes
 *   (yesPressure + noPressure === total gross volume)
 */
interface Bucket {
  buyYes: number;
  sellYes: number;
  buyNo: number;
  sellNo: number;
}

function bucketVol(b: Bucket): number {
  return b.buyYes + b.sellYes + b.buyNo + b.sellNo;
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

  /** Ingest a trade. Mutates the per-market bucket map. `outcomeIndex` is the
   *  token's outcome (0=YES, 1=NO) resolved by the caller from clob_token_ids. */
  ingest(slug: string, t: TradeEvent, outcomeIndex: 0 | 1): void {
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
      b = { buyYes: 0, sellYes: 0, buyNo: 0, sellNo: 0 };
      perSlug.set(hk, b);
    }
    // USD notional, not share count. Split by outcome × side.
    const usd = t.size * t.price;
    if (outcomeIndex === 0) {
      if (t.side === "BUY") b.buyYes += usd;
      else b.sellYes += usd;
    } else {
      if (t.side === "BUY") b.buyNo += usd;
      else b.sellNo += usd;
    }

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
      const curVol = bucketVol(cur); // gross USD notional this hour
      if (curVol < MIN_CUR_VOL_USD) continue; // absolute $ floor — kills micro-spikes

      // Baseline: mean hourly USD volume across previous hours, excluding current.
      let total = 0;
      let count = 0;
      for (const [k, b] of perSlug) {
        if (k === curH) continue;
        total += bucketVol(b);
        count++;
      }
      if (count < 6) continue; // need at least 6 hours of history
      const baseline = total / count;
      if (baseline < MIN_BASELINE_USD) continue; // skip dead markets / divide-by-tiny

      const multiple = curVol / baseline;
      if (multiple < SPIKE_MULTIPLE) continue;

      // OUTCOME direction (not taker aggression): buying YES and selling NO
      // both push toward YES; buying NO / selling YES push toward NO.
      const yesPressure = cur.buyYes + cur.sellNo;
      const noPressure = cur.buyNo + cur.sellYes;
      const sideRatio = Math.max(yesPressure, noPressure) / curVol;
      const oneSided = sideRatio >= ONE_SIDED_PCT;
      const dominantSide = yesPressure >= noPressure ? "YES" : "NO";

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

    // Persist for the on-demand /spikes digest (separate bot process).
    try {
      const rec: SpikeRecord = {
        ts: Date.now(), slug, question: meta?.question || slug,
        end_date: meta?.end_date || "", multiple: info.multiple,
        oneSided: info.oneSided, dominantSide: info.dominantSide,
        sideRatio: info.sideRatio, curVol: info.curVol,
      };
      appendFileSync(SPIKES_LOG, JSON.stringify(rec) + "\n");
    } catch { /* non-fatal */ }

    await sendMessage({
      chatId: chat,
      threadId: thread || undefined,
      text,
      parseMode: "Markdown",
    });
    log("volume-spike", `alert: ${slug} ${info.multiple.toFixed(1)}x baseline`);
  }
}

// ── /spikes on-demand 24h digest ─────────────────────────────────────────

const THEMES: { emoji: string; name: string; re: RegExp }[] = [
  { emoji: "🇮🇷", name: "Iran / Middle East", re: /iran|israel|hezbollah|hormuz|gaza|lebanon|netanyahu/i },
  { emoji: "🇺🇦", name: "Ukraine / Russia", re: /ukraine|russia|putin|zelensk/i },
  { emoji: "🗳", name: "Politics", re: /primary|nominee|midterm|governor|senate|congress|election|trump|biden|powell/i },
  { emoji: "🚀", name: "Crypto launches", re: /token|airdrop|ipo-by|fdv|launch/i },
  { emoji: "₿", name: "Crypto markets", re: /bitcoin|ethereum|btc-|eth-|stablecoin|solana|crypto/i },
  { emoji: "📈", name: "Equity / macro", re: /aapl|msft|nvda|googl|tsla|amzn|meta|pltr|fed|gdp|cpi|company/i },
  { emoji: "📦", name: "Прочее", re: /.*/ },
];

function themeFor(slug: string, title: string): { emoji: string; name: string } {
  const hay = `${slug} ${title}`;
  for (const t of THEMES) if (t.re.test(hay)) return { emoji: t.emoji, name: t.name };
  return THEMES[THEMES.length - 1];
}

/**
 * On-demand digest of the last 24h of volume-spikes, same themed shape as
 * the daily alerts digest. Deduped by slug (peak multiplier). Titles
 * resolved via Gamma (cached per slug). Returns Markdown.
 */
export async function spikeDigest24h(): Promise<string> {
  const { readFileSync, existsSync } = await import("node:fs");
  if (!existsSync(SPIKES_LOG)) return "📈 *Volume spikes · 24h*\n\n_нет данных_";
  const since = Date.now() - 24 * 60 * 60 * 1000;
  // Dedupe by slug → peak record.
  const peak = new Map<string, SpikeRecord>();
  for (const line of readFileSync(SPIKES_LOG, "utf-8").split("\n")) {
    if (!line) continue;
    let r: SpikeRecord;
    try { r = JSON.parse(line) as SpikeRecord; } catch { continue; }
    if (r.ts < since) continue;
    const cur = peak.get(r.slug);
    if (!cur || r.multiple > cur.multiple) peak.set(r.slug, r);
  }
  const recs = [...peak.values()];
  if (recs.length === 0) return "📈 *Volume spikes · 24h*\n\n_тихо — спайков нет_";

  // Resolve titles via Gamma (best-effort, cached).
  const { request } = await import("undici");
  const titleCache = new Map<string, string>();
  for (const r of recs) {
    if (r.question && r.question !== r.slug) { titleCache.set(r.slug, r.question); continue; }
    try {
      const res = await request(`https://gamma-api.polymarket.com/events?slug=${r.slug}`, { bodyTimeout: 8000, headersTimeout: 6000 });
      if (res.statusCode === 200) {
        const arr = (await res.body.json()) as Array<{ title?: string }>;
        if (arr?.[0]?.title) titleCache.set(r.slug, arr[0].title);
      }
    } catch { /* keep slug */ }
    await new Promise((x) => setTimeout(x, 150));
  }

  // Group by theme.
  const groups = new Map<string, { emoji: string; name: string; items: SpikeRecord[] }>();
  for (const r of recs) {
    const title = titleCache.get(r.slug) || r.slug;
    const th = themeFor(r.slug, title);
    const g = groups.get(th.name) ?? { emoji: th.emoji, name: th.name, items: [] };
    g.items.push(r);
    groups.set(th.name, g);
  }

  const out: string[] = ["📈 *Volume spikes · 24h*"];
  // Themes ordered by total peak-multiplier desc.
  const ordered = [...groups.values()].sort(
    (a, b) => b.items.reduce((s, r) => s + r.multiple, 0) - a.items.reduce((s, r) => s + r.multiple, 0),
  );
  for (const g of ordered) {
    g.items.sort((a, b) => b.multiple - a.multiple);
    out.push(`\n*${g.emoji} ${g.name}* (${g.items.length})`);
    for (const r of g.items.slice(0, 10)) {
      const title = titleCache.get(r.slug) || r.slug;
      const side = r.oneSided ? ` · ${Math.round(r.sideRatio * 100)}% *${r.dominantSide.toUpperCase()}*` : "";
      out.push(`• ${marketLink(r.slug, escapeMd(title))} — *${r.multiple.toFixed(1)}×*${side}`);
    }
    if (g.items.length > 10) out.push(`_…и ещё ${g.items.length - 10}_`);
  }
  out.push(`\n_Всего: ${recs.length} рынков_`);
  return out.join("\n");
}
