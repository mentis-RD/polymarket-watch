import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connections: 50, pipelining: 1, keepAliveTimeout: 30_000 }));
import "dotenv/config";

import { request } from "undici";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { sendMessage, sendMessageReturningId, deleteMessage, setMyCommands } from "./telegram.js";
import { addGate, removeGate, listGates } from "./consensus-gates.js";
import { isSkippedCategoryEvent } from "./category-filter.js";
import { clusterReport } from "./signals/coordinated-cluster.js";
import { crossMarketReport } from "./signals/cross-market-correlation.js";
import { spikeDigest24h } from "./signals/volume-spike.js";
import { heartbeat } from "./heartbeat.js";
import { writeAtomic } from "./atomic-write.js";
import { escapeMd } from "./markdown.js";
import { log, err } from "./log.js";
import * as watchlist from "./watchlist.js";
import {
  parseClobTokenIds,
  resolveEventFromAnySlug,
  type PolyEventFull,
} from "./polymarket-api.js";
import { getProfile } from "./wallet-profiler.js";
import { dictSizes } from "./funding-source.js";

const TOKEN = process.env.TG_TOKEN || "";
const ALLOWED_CHAT = process.env.TG_CHAT_MAIN || "";
const STATE_DIR = join(process.cwd(), "state");
const OFFSET_PATH = join(STATE_DIR, "tg_offset.txt");
const TRADES_ENRICHED_PATH = join(STATE_DIR, "trades_enriched.jsonl");

const POLL_TIMEOUT_SEC = 25;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

interface TGUpdate {
  update_id: number;
  message?: TGMessage;
  edited_message?: TGMessage;
  callback_query?: {
    id: string;
    data?: string;
    message?: TGMessage;
    from?: { id: number; first_name?: string; username?: string };
  };
}

interface TGMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number };
  message_thread_id?: number;
  text?: string;
  entities?: { type: string; offset: number; length: number }[];
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
  writeAtomic(OFFSET_PATH, String(n));
}

// loadSeen() removed: /watch resolves event slugs directly via Gamma API
// (resolveEventFromAnySlug) instead of consulting seen_markets.json.
// seen_events.json is owned by event-discovery and not read here.

async function fetchUpdates(offset: number): Promise<TGUpdate[]> {
  // allowed_updates includes callback_query so inline-keyboard button taps
  // (e.g. the digest's "show cluster" buttons) reach us.
  const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT_SEC}&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D`;
  const res = await request(url, { bodyTimeout: (POLL_TIMEOUT_SEC + 10) * 1000 });
  const data = (await res.body.json()) as { ok: boolean; result?: TGUpdate[]; description?: string };
  if (!data.ok) throw new Error(`getUpdates: ${data.description}`);
  return data.result || [];
}

async function answerCallback(callbackId: string, text?: string): Promise<void> {
  try {
    await request(`https://api.telegram.org/bot${TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text: text || "" }),
    });
  } catch (e) {
    err("tg-control", "answerCallbackQuery failed", e);
  }
}

/**
 * Handle an inline-button tap. callback_data shape `c:<event_slug>` →
 * run cluster report and post it into the same thread. The digest
 * attaches one such button per listed cluster so the user gets the
 * member wallets with a single tap.
 */
async function handleCallback(cq: NonNullable<TGUpdate["callback_query"]>): Promise<void> {
  const data = cq.data || "";
  const m = cq.message;
  if (!m) { await answerCallback(cq.id); return; }
  let report: string | null = null;
  if (data.startsWith("c:")) {
    await answerCallback(cq.id, "scanning cluster…");
    report = await clusterReport(data.slice(2));
  } else if (data.startsWith("x:")) {
    await answerCallback(cq.id, "scanning cross-market…");
    report = await crossMarketReport(data.slice(2).toLowerCase());
  } else {
    await answerCallback(cq.id);
    return;
  }
  await sendMessage({
    chatId: String(m.chat.id),
    threadId: m.message_thread_id ? String(m.message_thread_id) : undefined,
    text: report,
    parseMode: "Markdown",
  });
}

const CMD_TTL_MS = 60 * 60 * 1000; // command replies auto-delete after 1h

/** Schedule deletion of a message after `ttlMs`. setTimeout in-process —
 *  if the bot restarts before firing, the message simply persists (rare). */
function scheduleDelete(chatId: string, messageId: number, ttlMs: number): void {
  setTimeout(() => { void deleteMessage(chatId, messageId); }, ttlMs);
}

/**
 * Reply to a command. By default the reply auto-deletes after 1h (`ttlMs`);
 * the dispatcher deletes the triggering command message on the same clock.
 * Pass ttlMs=0 to keep the reply permanently (e.g. /spikes digest).
 */
async function reply(msg: TGMessage, text: string, ttlMs: number = CMD_TTL_MS): Promise<void> {
  const id = await sendMessageReturningId({
    chatId: String(msg.chat.id),
    threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
    text,
    parseMode: "Markdown",
  });
  if (id && ttlMs > 0) scheduleDelete(String(msg.chat.id), id, ttlMs);
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

function buildSubMarkets(event: PolyEventFull): watchlist.SubMarket[] {
  const out: watchlist.SubMarket[] = [];
  for (const m of event.markets ?? []) {
    if (!m.slug) continue;
    if (m.closed || m.archived) continue;
    out.push({
      slug: m.slug,
      question: m.question || "",
      condition_id: m.conditionId || "",
      clob_token_ids: parseClobTokenIds(m),
      end_date: m.endDate,
    });
  }
  return out;
}

async function handleWatch(msg: TGMessage, args: string[]): Promise<void> {
  if (args.length === 0) {
    await reply(
      msg,
      "usage: `/watch <event-or-market-slug> [HIGH|MED] [reason...]`\n_resolves market slugs back to their parent event_",
    );
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

  // Try event first, fall back to market → parent event.
  let event: PolyEventFull | null = null;
  try {
    event = await resolveEventFromAnySlug(slug);
  } catch (e) {
    err("tg-control", `resolveEventFromAnySlug(${slug}) failed`, e);
  }
  if (!event) {
    await reply(msg, `❌ \`${escapeMd(slug)}\` not found as event or market on Gamma. typo?`);
    return;
  }

  // Reject events whose end_date is already past (UMA pending, nothing to monitor live).
  if (event.endDate) {
    const endTs = Date.parse(event.endDate);
    if (Number.isFinite(endTs) && endTs < Date.now()) {
      await reply(
        msg,
        `❌ event \`${escapeMd(event.slug)}\` ended ${event.endDate.slice(0, 10)} — nothing to monitor live.`,
      );
      return;
    }
  }

  const subMarkets = buildSubMarkets(event);
  if (subMarkets.length === 0) {
    await reply(
      msg,
      `⚠️ event \`${escapeMd(event.slug)}\` has no open sub-markets with clob_token_ids; monitor cannot subscribe`,
    );
    return;
  }

  const subsWithTokens = subMarkets.filter((sm) => sm.clob_token_ids.length > 0).length;
  if (subsWithTokens < subMarkets.length) {
    log(
      "tg-control",
      `${event.slug}: ${subMarkets.length - subsWithTokens} sub-markets without tokens (skipped from subscription)`,
    );
  }

  const wasOnList = watchlist.has(event.slug);
  watchlist.add(event.slug, {
    added_at: Date.now(),
    added_by: "manual",
    risk_tag: tag,
    reason,
    event_slug: event.slug,
    event_title: event.title || "",
    end_date: event.endDate || "",
    sub_markets: subMarkets,
  });

  const verb = wasOnList ? "↻ updated" : "✅ watching";
  await reply(
    msg,
    `${verb} event \`${escapeMd(event.slug)}\` (${tag}) — ${subMarkets.length} sub-markets\n_${escapeMd(event.title || "")}_${reason ? `\nreason: ${escapeMd(reason)}` : ""}\nhttps://polymarket.com/event/${event.slug}`,
  );
}

async function handleUnwatch(msg: TGMessage, args: string[]): Promise<void> {
  if (args.length === 0) {
    await reply(msg, "usage: `/unwatch <event-slug>`");
    return;
  }
  const slug = args[0];
  // Allow unwatch by sub-market slug too — find the parent event in watchlist.
  let target = slug;
  if (!watchlist.has(slug)) {
    const parent = watchlist.findEventForSubMarketSlug(slug);
    if (parent) target = parent.event_slug;
  }
  if (watchlist.remove(target)) {
    await reply(msg, `✅ unwatched event \`${escapeMd(target)}\``);
  } else {
    await reply(msg, `❌ \`${escapeMd(slug)}\` not on watchlist`);
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
      const reason = e.reason ? ` — ${escapeMd(e.reason)}` : "";
      const end = e.end_date ? ` (ends ${e.end_date.slice(0, 10)})` : "";
      const subs = ` [${e.sub_markets.length} sub]`;
      return `• \`${escapeMd(s)}\` ${e.risk_tag}${subs}${end}${reason}`;
    });
  await reply(msg, `📋 watchlist (${slugs.length} events):\n${lines.join("\n")}`);
}

/**
 * `/gate <slug-or-regex> [maxprice]` — add a market family to the fresh-wallet
 * NO-consensus gate: on matched markets the NO side ("event won't happen") is
 * counted ONLY when bought ≤ maxprice (default 0.30), since buying the NO
 * favorite rich is consensus, not insider. YES is never gated, at any price.
 */
async function handleGate(msg: TGMessage, args: string[]): Promise<void> {
  const pattern = args[0];
  if (!pattern) {
    await reply(msg, "usage: `/gate <slug-or-regex> [maxprice=0.30]`\nNO на совпавших рынках считается только при цене ≤ maxprice. YES не трогается.");
    return;
  }
  const maxPrice = args[1] !== undefined ? Number(args[1]) : 0.3;
  if (Number.isNaN(maxPrice)) { await reply(msg, "❌ maxprice не число"); return; }

  // Breadth check: fresh-wallet fires on WATCHLIST markets, so show how many the
  // pattern would gate (event slug OR any sub-market slug) and reject a clearly
  // over-broad one. Catches an accidental wide pattern before it silently
  // suppresses NO across unrelated markets.
  let re: RegExp;
  try { re = new RegExp(pattern, "i"); } catch { await reply(msg, "❌ невалидный regex"); return; }
  const wl = watchlist.load();
  const matched: string[] = [];
  for (const [slug, e] of Object.entries(wl)) {
    if (re.test(slug) || (e.sub_markets ?? []).some((sm) => re.test(sm.slug))) matched.push(slug);
  }
  if (matched.length > 20) {
    await reply(msg, `❌ слишком широкий паттерн — матчит *${matched.length}* рынков вотчлиста. Уточни (полный слаг или конкретное семейство).`);
    return;
  }

  const r = addGate(pattern, maxPrice);
  if (!r.ok) { await reply(msg, `❌ не добавлен: ${r.reason}`); return; }
  const sample = matched.slice(0, 5).map((s) => `\`${escapeMd(s)}\``).join(", ");
  const scope = matched.length === 0
    ? "⚠️ 0 совпадений в текущем вотчлисте (паттерн на будущие рынки?)"
    : `матчит ${matched.length}: ${sample}${matched.length > 5 ? " …" : ""}`;
  await reply(msg, `✅ гейт добавлен: \`${escapeMd(pattern)}\` → NO считается только при цене ≤ ${maxPrice}\n${scope}`);
}

/** `/gates` — list active NO-consensus gates (seed + user-added). */
async function handleGates(msg: TGMessage): Promise<void> {
  const gates = listGates();
  if (gates.length === 0) { await reply(msg, "нет гейтов"); return; }
  const lines = gates.map((g) => `• \`${escapeMd(g.pattern)}\` → NO ≤ ${g.maxPrice}${g.seed ? " _(seed)_" : ""}`);
  await reply(msg, `🚧 *NO-consensus гейты* (NO считается только при низкой цене; YES не трогается):\n${lines.join("\n")}`);
}

/** `/ungate <pattern>` — remove a user-added gate (seed gates are permanent). */
async function handleUngate(msg: TGMessage, args: string[]): Promise<void> {
  const pattern = args[0];
  if (!pattern) { await reply(msg, "usage: `/ungate <pattern>`"); return; }
  const r = removeGate(pattern);
  await reply(msg, r.ok ? `✅ удалён: \`${escapeMd(pattern)}\`` : `❌ ${r.reason}`);
}

/**
 * Bulk-add every event from the last 24h of new_events.jsonl (same
 * window as the daily digest sends). Existing watchlist entries kept;
 * expired events / no-sub events / Gamma errors skipped silently.
 *
 * Reply auto-deletes (both user command and bot reply) after 60s so the
 * command channel stays clean. Auto-delete of user message requires bot
 * to be admin with "Can Delete Messages" — falls back gracefully if not.
 */
async function handleWatchDigest(msg: TGMessage): Promise<void> {
  const NEW_LOG_PATH = join(STATE_DIR, "new_events.jsonl");
  if (!existsSync(NEW_LOG_PATH)) {
    await reply(msg, "❌ no new_events.jsonl on disk yet");
    return;
  }
  // Anchor the window to the LAST DIGEST SNAPSHOT, not "now". The digest is a
  // point-in-time send (window = [last_sent_ts-24h, last_sent_ts]); reading the
  // live rolling window here would add events discovered AFTER the digest that
  // the user never reviewed. Pin upper bound to last_sent_ts so "added" ⊆ what
  // the digest showed. Fallback to now() only if no digest has been sent yet.
  let upper = Date.now();
  try {
    const ld = JSON.parse(readFileSync(join(STATE_DIR, "last_digest.json"), "utf-8")) as { last_sent_ts?: number };
    if (ld.last_sent_ts && Number.isFinite(ld.last_sent_ts)) upper = ld.last_sent_ts;
  } catch { /* no digest yet → use now() */ }
  const since = upper - 24 * 60 * 60 * 1000;
  const slugs: string[] = [];
  const seenSlugs = new Set<string>();
  try {
    const lines = readFileSync(NEW_LOG_PATH, "utf-8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as { ts: number; event_slug: string; tags?: string };
        if (r.ts < since || r.ts > upper) continue;
        if (seenSlugs.has(r.event_slug)) continue; // dedup if event appeared multiple times in window
        const tagObjs = (r.tags || "").split("|").filter(Boolean).map((label) => ({ id: "", label, slug: "" }));
        if (isSkippedCategoryEvent(tagObjs, r.event_slug)) continue;
        seenSlugs.add(r.event_slug);
        slugs.push(r.event_slug);
      } catch { /* skip malformed line */ }
    }
  } catch (e) {
    await reply(msg, `❌ failed to read new_events.jsonl: ${(e as Error).message}`);
    return;
  }

  if (slugs.length === 0) {
    await reply(msg, "❌ no events in last 24h after filter");
    return;
  }

  // Acknowledge start so user knows the long-running job is alive.
  const startMsgId = await sendMessageReturningId({
    chatId: String(msg.chat.id),
    threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
    text: `⏳ /watch_digest: resolving ${slugs.length} events from last-24h digest (≈${Math.ceil(slugs.length * 0.2)}s)...`,
    parseMode: "Markdown",
  });

  const wlBefore = watchlist.load();
  const stats = { added: 0, skippedExisting: 0, skippedExpired: 0, skippedNoSubs: 0, errs: 0 };
  const now = Date.now();
  const newEntries: Record<string, watchlist.WatchEntry> = {};

  for (const slug of slugs) {
    if (wlBefore[slug]) { stats.skippedExisting++; continue; }
    let event: PolyEventFull | null = null;
    try {
      event = await resolveEventFromAnySlug(slug);
    } catch { stats.errs++; await sleep(200); continue; }
    if (!event) { stats.errs++; await sleep(200); continue; }
    if (event.endDate) {
      const endTs = Date.parse(event.endDate);
      if (Number.isFinite(endTs) && endTs < now) { stats.skippedExpired++; await sleep(200); continue; }
    }
    const subMarkets = buildSubMarkets(event);
    const subsWithTokens = subMarkets.filter((sm) => sm.clob_token_ids.length > 0).length;
    if (subMarkets.length === 0 || subsWithTokens === 0) { stats.skippedNoSubs++; await sleep(200); continue; }
    newEntries[event.slug] = {
      added_at: now,
      added_by: "bulk_import",
      risk_tag: "MED",
      reason: "watch_digest",
      event_slug: event.slug,
      event_title: event.title || "",
      end_date: event.endDate || "",
      sub_markets: subMarkets,
    };
    stats.added++;
    await sleep(200);
  }

  if (Object.keys(newEntries).length > 0) {
    const wl = watchlist.load();
    Object.assign(wl, newEntries);
    watchlist.save(wl);
  }

  const summary = [
    `✅ /watch_digest done`,
    `*added:* ${stats.added}`,
    stats.skippedExisting > 0 ? `_already watched:_ ${stats.skippedExisting}` : null,
    stats.skippedExpired > 0 ? `_expired:_ ${stats.skippedExpired}` : null,
    stats.skippedNoSubs > 0 ? `_no open subs:_ ${stats.skippedNoSubs}` : null,
    stats.errs > 0 ? `_fetch errors:_ ${stats.errs}` : null,
  ].filter((x) => x).join("\n");

  const replyMsgId = await sendMessageReturningId({
    chatId: String(msg.chat.id),
    threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
    text: summary,
    parseMode: "Markdown",
  });

  // Schedule cleanup: delete the progress msg + final summary + the user's
  // command itself after 60s. Keeps command channel tidy.
  setTimeout(async () => {
    const chatId = String(msg.chat.id);
    if (startMsgId) await deleteMessage(chatId, startMsgId);
    if (replyMsgId) await deleteMessage(chatId, replyMsgId);
    await deleteMessage(chatId, msg.message_id);
  }, 60_000);
}

/**
 * /cluster <event_slug> — on-demand cluster report. Lists member wallets
 * with side / notional / age for each detected cluster on the event, so
 * the user can actually act on a "coordinated cluster" alert (the live
 * alert + digest only show counts). Accepts an event OR sub-market slug
 * and resolves to the parent event first.
 */
async function handleCluster(msg: TGMessage, args: string[]): Promise<void> {
  if (args.length === 0) {
    await reply(
      msg,
      "usage: `/cluster <slug>`\n_slug = the part after `/event/` in a Polymarket URL, e.g._\n`polymarket.com/event/`*`russia-x-ukraine-ceasefire-agreement-by`*\n_→_ `/cluster russia-x-ukraine-ceasefire-agreement-by`\n_(a sub-market slug also works — it resolves to the parent event)_",
    );
    return;
  }
  const slug = args[0];
  // Resolve to parent event slug (cluster analysis aggregates at event level).
  let eventSlug = slug;
  try {
    const ev = await resolveEventFromAnySlug(slug);
    if (ev?.slug) eventSlug = ev.slug;
  } catch { /* fall back to raw slug */ }
  const report = await clusterReport(eventSlug);
  await reply(msg, report);
}

/**
 * /xmarket <wallet> (alias /xm) — drill into a cross-market correlation
 * alert: lists the wallet's keyword-correlated markets with side / current
 * held position. The digest's inline buttons are reserved for clusters
 * (callback `c:`), so cross-market drill-down is this text command (paste
 * the wallet address from the alert) — also wired as callback `x:`.
 */
async function handleXmarket(msg: TGMessage, args: string[]): Promise<void> {
  if (args.length === 0 || !isAddress(args[0])) {
    await reply(msg, "usage: `/xmarket <0xwallet>`\n_paste the wallet from a cross-market alert_");
    return;
  }
  const report = await crossMarketReport(args[0].toLowerCase());
  await reply(msg, report);
}

/**
 * /spikes (alias /spikedigest) — on-demand 24h volume-spike digest in the
 * same themed format as the daily alerts digest. Volume-spike was removed
 * from the daily digest; this is its dedicated surface. The reply does NOT
 * auto-delete (ttlMs handled by sending permanently); the command message
 * is deleted immediately by the dispatcher.
 */
async function handleSpikes(msg: TGMessage): Promise<void> {
  const report = await spikeDigest24h();
  // Permanent reply (no TTL) — send directly, not via the 1h-default reply().
  await sendMessage({
    chatId: String(msg.chat.id),
    threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
    text: report,
    parseMode: "Markdown",
  });
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
      "`/scan_unknowns [min_fanout]` — high fan-out funders not in any dict (default min=3)",
      "`/help` — this message",
    ].join("\n"),
  );
}

interface CachedWalletProfile {
  wallet: string;
  first_inflow_from?: string | null;
  funding_source?: string | null;
  bridge_origin_wallet?: string | null;
  bridge_origin_chain?: number | null;
  bridge_origin_funding_source?: string | null;
}

const WALLET_PROFILES_PATH = join(STATE_DIR, "wallet_profiles.json");

function loadAllProfiles(): CachedWalletProfile[] {
  if (!existsSync(WALLET_PROFILES_PATH)) return [];
  try {
    const obj = JSON.parse(readFileSync(WALLET_PROFILES_PATH, "utf-8")) as Record<
      string,
      CachedWalletProfile
    >;
    return Object.values(obj);
  } catch {
    return [];
  }
}

async function handleScanUnknowns(msg: TGMessage, args: string[]): Promise<void> {
  const minFanout = Math.max(2, Math.min(50, Number(args[0]) || 3));
  // Yield once before the blocking file parse so the long-poll loop can
  // process other updates first. For small caches this is invisible; for
  // large caches it prevents starving other commands.
  await new Promise<void>((r) => setImmediate(r));
  const profiles = loadAllProfiles();
  const sizes = dictSizes();

  if (profiles.length === 0) {
    await reply(
      msg,
      `🔎 wallet_profiles cache is empty (${profiles.length}). Run for a while with watchlist active.\n_dicts: cex=${sizes.cex} bridge=${sizes.bridge} swap=${sizes.swap} fiat=${sizes.fiat} service=${sizes.service}_`,
    );
    return;
  }

  // 1) Direct-funder candidates: first_inflow_from groups when funding_source is null.
  const directBuckets = new Map<string, string[]>();
  // 2) Bridge-origin candidates: bridge_origin_wallet groups when origin_source is null.
  const bridgeBuckets = new Map<string, { wallets: string[]; chains: Set<number> }>();

  for (const p of profiles) {
    if (
      (p.funding_source === null || p.funding_source === undefined) &&
      p.first_inflow_from
    ) {
      const arr = directBuckets.get(p.first_inflow_from) ?? [];
      arr.push(p.wallet);
      directBuckets.set(p.first_inflow_from, arr);
    }
    if (
      (p.bridge_origin_funding_source === null ||
        p.bridge_origin_funding_source === undefined) &&
      p.bridge_origin_wallet
    ) {
      const entry =
        bridgeBuckets.get(p.bridge_origin_wallet) ?? { wallets: [], chains: new Set<number>() };
      entry.wallets.push(p.wallet);
      if (p.bridge_origin_chain) entry.chains.add(p.bridge_origin_chain);
      bridgeBuckets.set(p.bridge_origin_wallet, entry);
    }
  }

  const direct = [...directBuckets.entries()]
    .map(([addr, ws]) => ({ addr, count: ws.length, sample: ws[0] }))
    .filter((r) => r.count >= minFanout)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const bridge = [...bridgeBuckets.entries()]
    .map(([addr, e]) => ({
      addr,
      count: e.wallets.length,
      sample: e.wallets[0],
      chains: [...e.chains].join(","),
    }))
    .filter((r) => r.count >= minFanout)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const lines: string[] = [
    `🔎 *Unknown funders* (min fan-out ${minFanout}, scanned ${profiles.length} profiles)`,
    `_dicts: cex=${sizes.cex} bridge=${sizes.bridge} swap=${sizes.swap} fiat=${sizes.fiat} service=${sizes.service}_`,
    "",
    `*Direct funders (sender of first \\$1k+ USDC):* ${direct.length || "—"}`,
  ];
  for (const r of direct) {
    lines.push(
      `• \`${r.addr}\` × ${r.count}  (e.g. \`${r.sample.slice(0, 6)}…${r.sample.slice(-4)}\`)`,
    );
  }
  lines.push("");
  lines.push(`*Bridge origins (Relay-traced user on source chain):* ${bridge.length || "—"}`);
  for (const r of bridge) {
    lines.push(
      `• \`${r.addr}\` × ${r.count} chains:${r.chains || "?"}  (e.g. \`${r.sample.slice(0, 6)}…${r.sample.slice(-4)}\`)`,
    );
  }
  lines.push("");
  lines.push(
    "_Look each address up on the matching block explorer. If it's a CEX/swap/fiat/service, add to the right `addresses/<chain>-<category>.json` and push._",
  );

  await reply(msg, lines.join("\n"));
}

interface EnrichedTradeLine {
  ts: number;
  slug: string;
  market: string;
  event_slug?: string;
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

  // Group by EVENT (not sub-market). Trades on multiple strikes of one
  // event collapse into one event line, with sub-market count noted.
  const byEvent = new Map<
    string,
    {
      key: string;
      buy_24h: number;
      buy_30d: number;
      sell_30d: number;
      last_ts: number;
      sub_count: Set<string>;
    }
  >();
  const dayCutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const t of trades) {
    const key = t.event_slug ?? t.slug;
    let m = byEvent.get(key);
    if (!m) {
      m = {
        key,
        buy_24h: 0,
        buy_30d: 0,
        sell_30d: 0,
        last_ts: t.ts,
        sub_count: new Set<string>(),
      };
      byEvent.set(key, m);
    }
    m.sub_count.add(t.slug);
    if (t.side === "BUY") {
      m.buy_30d += t.notional;
      if (t.ts >= dayCutoff) m.buy_24h += t.notional;
    } else {
      m.sell_30d += t.notional;
    }
    if (t.ts > m.last_ts) m.last_ts = t.ts;
  }

  const marketLines = [...byEvent.values()]
    .sort((a, b) => b.buy_30d - a.buy_30d)
    .slice(0, 10)
    .map((m) => {
      const buy24 = m.buy_24h > 0 ? ` (24h: $${m.buy_24h.toFixed(0)})` : "";
      const subs = m.sub_count.size > 1 ? ` [${m.sub_count.size} subs]` : "";
      return `• \`${escapeMd(m.key)}\`${subs} buy=$${m.buy_30d.toFixed(0)}${buy24} sell=$${m.sell_30d.toFixed(0)}`;
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
      case "watch_digest":
      case "watchdigest":
        await handleWatchDigest(msg);
        break;
      case "cluster":
        await handleCluster(msg, parsed.args);
        break;
      case "xmarket":
      case "xm":
        await handleXmarket(msg, parsed.args);
        break;
      case "spikes":
      case "spikedigest":
        await handleSpikes(msg);
        break;
      case "profile":
        await handleProfile(msg, parsed.args);
        break;
      case "scan_unknowns":
      case "scanunknowns":
        await handleScanUnknowns(msg, parsed.args);
        break;
      case "gate":
        await handleGate(msg, parsed.args);
        break;
      case "gates":
        await handleGates(msg);
        break;
      case "ungate":
        await handleUngate(msg, parsed.args);
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

  // Auto-delete the triggering COMMAND message.
  // - watch_digest manages its own 60s cleanup (incl. the command msg) → skip.
  // - spikes: delete the command msg immediately (its digest reply persists).
  // - everything else: delete on the 1h clock, matching the reply TTL.
  const chatId = String(msg.chat.id);
  if (parsed.cmd === "watch_digest" || parsed.cmd === "watchdigest") {
    // handled internally
  } else if (parsed.cmd === "spikes" || parsed.cmd === "spikedigest") {
    void deleteMessage(chatId, msg.message_id);
  } else {
    scheduleDelete(chatId, msg.message_id, CMD_TTL_MS);
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
        } else if (u.callback_query) {
          try {
            await handleCallback(u.callback_query);
          } catch (e) {
            err("tg-control", "handleCallback failed", e);
          }
        }
        if (u.update_id >= offset) offset = u.update_id + 1;
      }
      saveOffset(offset);
      heartbeat("tg-control", { offset });

      if (Date.now() - lastCleanup > CLEANUP_INTERVAL_MS) {
        // Primary cleanup: remove events resolution-tracker has fully
        // post-mortem'd (every sub-market resolved). Catches early
        // resolution + no-end_date markets, and removes normal markets
        // right after post-mortem instead of waiting out 14d.
        const resolvedIds = loadResolvedConditionIds();
        if (resolvedIds.size > 0) {
          const doneRemoved = watchlist.cleanupResolved(resolvedIds);
          if (doneRemoved.length > 0) {
            log("tg-control", `auto-removed resolved: ${doneRemoved.join(", ")}`);
          }
        }
        // Date-based safety net (14d grace) for anything the tracker
        // never managed to process.
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

/**
 * Read the set of resolved condition_ids from resolution-tracker's
 * state/resolutions.json (keyed by condition_id). Used by the cleanup
 * tick to drop fully-resolved events. Returns empty set if file absent.
 */
function loadResolvedConditionIds(): Set<string> {
  const path = join(STATE_DIR, "resolutions.json");
  if (!existsSync(path)) return new Set();
  try {
    const obj = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return new Set(Object.keys(obj));
  } catch {
    return new Set();
  }
}

if (!TOKEN) {
  err("tg-control", "TG_TOKEN not set");
  process.exit(1);
}

log("tg-control", `starting (chat=${ALLOWED_CHAT}, poll_timeout=${POLL_TIMEOUT_SEC}s)`);

// Register command menu so the "/" UI in Telegram shows our commands.
// Idempotent — Telegram caches per-bot. Re-runs at every restart so
// deploys auto-sync any new command additions.
void setMyCommands([
  { command: "watch", description: "watch event/market: /watch <slug> [HIGH|MED] [reason]" },
  { command: "unwatch", description: "remove from watchlist: /unwatch <slug>" },
  { command: "wl", description: "list current watchlist" },
  { command: "watch_digest", description: "bulk-add all events from last 24h digest" },
  { command: "cluster", description: "show coordinated-cluster wallets: /cluster <slug>" },
  { command: "xmarket", description: "show cross-market wallet's correlated markets: /xmarket <0xwallet>" },
  { command: "spikes", description: "24h volume-spike digest (themed)" },
  { command: "profile", description: "wallet profile: /profile <0xwallet>" },
  { command: "scan_unknowns", description: "scan watchlist for fresh wallets with hidden funding" },
  { command: "gate", description: "NO-consensus гейт: /gate <slug-or-regex> [maxprice] — NO считается только дёшево" },
  { command: "gates", description: "список NO-consensus гейтов" },
  { command: "ungate", description: "убрать гейт: /ungate <pattern>" },
  { command: "help", description: "show help" },
]);

pollLoop().catch((e) => {
  err("tg-control", "fatal", e);
  process.exit(1);
});
