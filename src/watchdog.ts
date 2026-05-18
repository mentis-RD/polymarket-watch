import { Agent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new Agent({ connections: 50, pipelining: 1, keepAliveTimeout: 30_000 }));
import "dotenv/config";

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { sendMessage } from "./telegram.js";
import { log } from "./log.js";

const STATE_DIR = join(process.cwd(), "state");
const HB_DIR = join(STATE_DIR, "heartbeats");
const ALERTS_DIR = join(STATE_DIR, "alerts");

interface ProcessSpec {
  name: string;
  maxAgeMs: number;
}

const PROCESSES: ProcessSpec[] = [
  { name: "market-discovery", maxAgeMs: 90 * 60 * 1000 }, // 90 min (cycle is 60 min)
  { name: "digest", maxAgeMs: 10 * 60 * 1000 }, // 10 min (ticks every 1 min)
  { name: "tg-control", maxAgeMs: 5 * 60 * 1000 }, // 5 min (long-poll heartbeats per cycle)
  { name: "market-monitor", maxAgeMs: 5 * 60 * 1000 }, // 5 min (ticks every 1 min)
  { name: "trade-enricher", maxAgeMs: 5 * 60 * 1000 }, // 5 min (60s cycle)
];

const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between alerts per process

function readHeartbeatAge(name: string): number | null {
  const p = join(HB_DIR, `${name}.txt`);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as { ts?: number };
    if (typeof data.ts !== "number") return null;
    return Date.now() - data.ts;
  } catch {
    try {
      // Fallback: use mtime.
      return Date.now() - statSync(p).mtimeMs;
    } catch {
      return null;
    }
  }
}

function canAlert(name: string): boolean {
  mkdirSync(ALERTS_DIR, { recursive: true });
  const p = join(ALERTS_DIR, `${name}.txt`);
  if (!existsSync(p)) return true;
  try {
    const t = Number(readFileSync(p, "utf-8"));
    if (!Number.isFinite(t)) return true;
    return Date.now() - t > ALERT_COOLDOWN_MS;
  } catch {
    return true;
  }
}

function recordAlert(name: string): void {
  mkdirSync(ALERTS_DIR, { recursive: true });
  writeFileSync(join(ALERTS_DIR, `${name}.txt`), String(Date.now()));
}

async function main(): Promise<void> {
  const chat = process.env.TG_CHAT_MAIN;
  const thread = process.env.TG_THREAD_ERRORS;

  if (!existsSync(HB_DIR)) {
    log("watchdog", "heartbeats dir missing; nothing to check yet");
    return;
  }

  const present = new Set(readdirSync(HB_DIR).map((f) => f.replace(/\.txt$/, "")));

  for (const proc of PROCESSES) {
    const age = readHeartbeatAge(proc.name);

    if (age == null) {
      if (present.size === 0) continue; // brand-new install — skip false alarm
      if (!canAlert(proc.name)) continue;
      log("watchdog", `${proc.name}: no heartbeat`);
      if (chat) {
        await sendMessage({
          chatId: chat,
          threadId: thread || undefined,
          text: `⚠️ watchdog: \`${proc.name}\` has no heartbeat (process may be dead)`,
          parseMode: "Markdown",
        });
      }
      recordAlert(proc.name);
      continue;
    }

    if (age > proc.maxAgeMs) {
      if (!canAlert(proc.name)) continue;
      const min = Math.round(age / 60000);
      log("watchdog", `${proc.name}: stale heartbeat ${min}min`);
      if (chat) {
        await sendMessage({
          chatId: chat,
          threadId: thread || undefined,
          text: `⚠️ watchdog: \`${proc.name}\` heartbeat stale (${min}m old, max ${Math.round(proc.maxAgeMs / 60000)}m)`,
          parseMode: "Markdown",
        });
      }
      recordAlert(proc.name);
    }
  }
}

main().catch((e) => {
  console.error("[watchdog] fatal", e);
  process.exit(1);
});
