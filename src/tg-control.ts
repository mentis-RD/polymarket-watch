import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connections: 50, pipelining: 1, keepAliveTimeout: 30_000 }));
import "dotenv/config";

import { request } from "undici";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { sendMessage } from "./telegram.js";
import { heartbeat } from "./heartbeat.js";
import { log, err } from "./log.js";
import * as watchlist from "./watchlist.js";
import { fetchMarketBySlug, parseClobTokenIds } from "./polymarket-api.js";
import { getProfile } from "./wallet-profiler.js";

const TOKEN = process.env.TG_TOKEN || "";
const ALLOWED_CHAT = process.env.TG_CHAT_MAIN || "";
const STATE_DIR = join(process.cwd(), "state");
const OFFSET_PATH = join(STATE_DIR, "tg_offset.txt");
const SEEN_PATH = join(STATE_DIR, "seen_markets.json");
const TRADES_ENRICHED_PATH = join(STATE_DIR, "trades_enriched.jsonl");

const POLL_TIMEOUT_SEC = 25;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

interface TGUpdate {
  update_id: number;
  message?: TGMessage;
  edited_message?: TGMessage;
}

interface TGMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number };
  message_thread_id?: number;
  text?: string;
  entities?: { type: string; offset: number; length: number }[];
}

interface SeenMarket {
  first_seen_ts: number;
  created_at: string;
  start_date: string;
  end_date: string;
  question: string;
}

function loadOffset(): number {
  if (!existsSync(OFFSET_PATH)) return 0;
  try {
    return Number(readFileSync(OFFSET_PATH, "utf-8").trim()) || 0;
  } catch {
    return 0;
  }
}

function saveOffset(n: number): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(OFFSET_PATH, String(n));
}

function loadSeen(): Record<string, SeenMarket> {
  if (!existsSync(SEEN_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SEEN_PATH, "utf-8")) as Record<string, SeenMarket>;
  } catch {
    return {};
  }
}

async function fetchUpdates(offset: number): Promise<TGUpdate[]> {
  const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT_SEC}&allowed_updates=%5B%22message%22%5D`;
  const res = await request(url, { bodyTimeout: (POLL_TIMEOUT_SEC + 10) * 1000 });
  const data = (await res.body.json()) as { ok: boolean; result?: TGUpdate[]; description?: string };
  if (!data.ok) throw new Error(`getUpdates: ${data.description}`);
  return data.result || [];
}

async function reply(msg: TGMessage, text: string): Promise<void> {
  await sendMessage({
    chatId: String(msg.chat.id),
    threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
    text,
    parseMode: "Markdown",
  });
}

function parseCommand(text: string): { cmd: string; args: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.split(/\s+/);
  let head = parts[0].slice(1);
  // Strip @botname if present.
  const at = head.indexOf("@");
  if (at >= 0) head = head.slice(0, at);
  return { cmd: head.toLowerCase(), args: parts.slice(1) };
}

async function handleWatch(msg: TGMessage, args: string[]): Promise<void> {
  if (args.length === 0) {
    await reply(msg, "usage: `/watch <slug> [HIGH|MED] [reason...]`");
    return;
  }
  const slug = args[0];
  let tag: watchlist.RiskTag = "MED";
  let reasonStart = 1;
  if (args[1] === "HIGH" || args[1] === "MED") {
    tag = args[1];
    reasonStart = 2;
  }
  const reason = args.slice(reasonStart).join(" ");

  const seen = loadSeen();
  const marketMeta = seen[slug];
  if (!marketMeta) {
    await reply(msg, `❌ slug \`${slug}\` not found in seen_markets. typo?`);
    return;
  }

  // Fetch fresh market data to get clob_token_ids and condition_id for monitor subscription.
  let condition_id = "";
  let clob_token_ids: string[] = [];
  try {
    const fresh = await fetchMarketBySlug(slug);
    if (fresh) {
      condition_id = fresh.conditionId || "";
      clob_token_ids = parseClobTokenIds(fresh);
    }
  } catch (e) {
    err("tg-control", `fetchMarketBySlug(${slug}) failed`, e);
  }

  if (clob_token_ids.length === 0) {
    await reply(msg, `⚠️ \`${slug}\` has no clob_token_ids (market may not be tradable yet); monitor cannot subscribe`);
  }

  if (watchlist.has(slug)) {
    await reply(msg, `ℹ️ \`${slug}\` already on watchlist; updating tag/reason`);
  }

  watchlist.add(slug, {
    added_at: Date.now(),
    added_by: "manual",
    risk_tag: tag,
    reason,
    end_date: marketMeta.end_date,
    question: marketMeta.question,
    condition_id,
    clob_token_ids,
  });

  await reply(
    msg,
    `✅ watching \`${slug}\` (${tag})\n_${marketMeta.question}_${reason ? `\nreason: ${reason}` : ""}`,
  );
}

async function handleUnwatch(msg: TGMessage, args: string[]): Promise<void> {
  if (args.length === 0) {
    await reply(msg, "usage: `/unwatch <slug>`");
    return;
  }
  const slug = args[0];
  if (watchlist.remove(slug)) {
    await reply(msg, `✅ unwatched \`${slug}\``);
  } else {
    await reply(msg, `❌ \`${slug}\` not on watchlist`);
  }
}

async function handleWl(msg: TGMessage): Promise<void> {
  const wl = watchlist.load();
  const slugs = Object.keys(wl);
  if (slugs.length === 0) {
    await reply(msg, "📋 watchlist is empty");
    return;
  }
  const lines = slugs
    .sort((a, b) => wl[a].added_at - wl[b].added_at)
    .map((s) => {
      const e = wl[s];
      const reason = e.reason ? ` — ${e.reason}` : "";
      const end = e.end_date ? ` (ends ${e.end_date.slice(0, 10)})` : "";
      return `• \`${s}\` ${e.risk_tag}${end}${reason}`;
    });
  await reply(msg, `📋 watchlist (${slugs.length}):\n${lines.join("\n")}`);
}

async function handleHelp(msg: TGMessage): Promise<void> {
  await reply(
    msg,
    [
      "*polymarket-watch commands*",
      "`/watch <slug> [HIGH|MED] [reason]` — add to watchlist",
      "`/unwatch <slug>` — remove from watchlist",
      "`/wl` — show current watchlist",
      "`/profile <wallet>` — wallet profile + recent watchlist activity",
      "`/help` — this message",
    ].join("\n"),
  );
}

interface EnrichedTradeLine {
  ts: number;
  slug: string;
  market: string;
  wallet: string;
  side: "BUY" | "SELL";
  outcome: string;
  outcomeIndex: 0 | 1;
  price: number;
  size: number;
  notional: number;
  tx: string;
}

function readWalletTrades(wallet: string, maxAgeMs = 30 * 24 * 60 * 60 * 1000): EnrichedTradeLine[] {
  if (!existsSync(TRADES_ENRICHED_PATH)) return [];
  const lc = wallet.toLowerCase();
  const cutoff = Date.now() - maxAgeMs;
  const out: EnrichedTradeLine[] = [];
  const raw = readFileSync(TRADES_ENRICHED_PATH, "utf-8");
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const t = JSON.parse(line) as EnrichedTradeLine;
      if (t.wallet !== lc) continue;
      if (t.ts < cutoff) continue;
      out.push(t);
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

function isAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

async function handleProfile(msg: TGMessage, args: string[]): Promise<void> {
  if (args.length === 0) {
    await reply(msg, "usage: `/profile <wallet 0x...>`");
    return;
  }
  const wallet = args[0];
  if (!isAddress(wallet)) {
    await reply(msg, `❌ \`${wallet}\` is not a valid 0x-address`);
    return;
  }
  const lc = wallet.toLowerCase();

  const profile = await getProfile(lc);
  if (!profile) {
    await reply(msg, `❌ profile fetch failed (Alchemy unreachable; no cache)`);
    return;
  }

  const trades = readWalletTrades(lc, 30 * 24 * 60 * 60 * 1000);

  const ageTxt =
    profile.age_days === null
      ? "no $1k+ USDC inflow on record"
      : `${profile.age_days}d since first $1k+ USDC inflow`;

  // Per-market net BUY notional 24h vs 30d.
  const byMarket = new Map<string, { slug: string; buy_24h: number; buy_30d: number; sell_30d: number; last_ts: number }>();
  const dayCutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const t of trades) {
    let m = byMarket.get(t.slug);
    if (!m) {
      m = { slug: t.slug, buy_24h: 0, buy_30d: 0, sell_30d: 0, last_ts: t.ts };
      byMarket.set(t.slug, m);
    }
    if (t.side === "BUY") {
      m.buy_30d += t.notional;
      if (t.ts >= dayCutoff) m.buy_24h += t.notional;
    } else {
      m.sell_30d += t.notional;
    }
    if (t.ts > m.last_ts) m.last_ts = t.ts;
  }

  const marketLines = [...byMarket.values()]
    .sort((a, b) => b.buy_30d - a.buy_30d)
    .slice(0, 10)
    .map((m) => {
      const buy24 = m.buy_24h > 0 ? ` (24h: $${m.buy_24h.toFixed(0)})` : "";
      return `• \`${m.slug}\` buy=$${m.buy_30d.toFixed(0)}${buy24} sell=$${m.sell_30d.toFixed(0)}`;
    });

  const lines = [
    `👤 *Wallet profile* \`${lc}\``,
    `score: ${profile.score}/10`,
    ageTxt,
    `https://polygonscan.com/address/${lc}`,
    "",
    `*recent watchlist trades (30d, ${trades.length} total):*`,
    marketLines.length > 0 ? marketLines.join("\n") : "_no trades on watchlist markets_",
  ];

  await reply(msg, lines.join("\n"));
}

async function handleMessage(msg: TGMessage): Promise<void> {
  if (!msg.text) return;
  if (ALLOWED_CHAT && String(msg.chat.id) !== ALLOWED_CHAT) return; // ignore other chats

  const parsed = parseCommand(msg.text);
  if (!parsed) return;

  log("tg-control", `cmd=${parsed.cmd} args=${parsed.args.join("|")} from=${msg.from?.first_name}`);

  try {
    switch (parsed.cmd) {
      case "watch":
        await handleWatch(msg, parsed.args);
        break;
      case "unwatch":
        await handleUnwatch(msg, parsed.args);
        break;
      case "wl":
        await handleWl(msg);
        break;
      case "profile":
        await handleProfile(msg, parsed.args);
        break;
      case "help":
      case "start":
        await handleHelp(msg);
        break;
      default:
        // Silent ignore unknown commands.
        break;
    }
  } catch (e) {
    err("tg-control", `command ${parsed.cmd} failed`, e);
    await reply(msg, `⚠️ command failed: ${(e as Error).message}`);
  }
}

async function pollLoop(): Promise<void> {
  let offset = loadOffset();
  let lastCleanup = 0;

  while (true) {
    try {
      const updates = await fetchUpdates(offset);
      for (const u of updates) {
        const msg = u.message || u.edited_message;
        if (msg) {
          try {
            await handleMessage(msg);
          } catch (e) {
            err("tg-control", "handleMessage failed", e);
          }
        }
        if (u.update_id >= offset) offset = u.update_id + 1;
      }
      saveOffset(offset);
      heartbeat("tg-control", { offset });

      if (Date.now() - lastCleanup > CLEANUP_INTERVAL_MS) {
        // 14d grace: resolution tracker needs the watchlist entry to find
        // condition_id; 7d was too tight if the tracker is briefly down.
        const removed = watchlist.cleanupExpired(14);
        if (removed.length > 0) {
          log("tg-control", `auto-removed expired: ${removed.join(", ")}`);
        }
        lastCleanup = Date.now();
      }
    } catch (e) {
      err("tg-control", "poll failed", e);
      await sleep(5000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

if (!TOKEN) {
  err("tg-control", "TG_TOKEN not set");
  process.exit(1);
}

log("tg-control", `starting (chat=${ALLOWED_CHAT}, poll_timeout=${POLL_TIMEOUT_SEC}s)`);
pollLoop().catch((e) => {
  err("tg-control", "fatal", e);
  process.exit(1);
});
