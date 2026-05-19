import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./atomic-write.js";

const PATH = join(process.cwd(), "state", "sent_alerts.json");

type Store = Record<string, number>;

function load(): Store {
  if (!existsSync(PATH)) return {};
  try {
    return JSON.parse(readFileSync(PATH, "utf-8")) as Store;
  } catch {
    return {};
  }
}

function saveDisk(s: Store): void {
  writeJsonAtomic(PATH, s);
}

/**
 * In-process cache. Eliminates the canAlert→markAlerted race where two
 * concurrent signals both read "no prior" and both fire, AND removes
 * the read-modify-write contention between the 5 signals living in
 * trade-enricher's event loop. Disk is the authority across PROCESS
 * restarts only; within one process this Map is canonical.
 */
const MEM: Store = (() => {
  try {
    return load();
  } catch {
    return {};
  }
})();
let dirty = false;
let lastFlushTs = 0;
const FLUSH_INTERVAL_MS = 30_000;

function maybeFlush(): void {
  if (!dirty) return;
  if (Date.now() - lastFlushTs < FLUSH_INTERVAL_MS) return;
  try {
    saveDisk(MEM);
    dirty = false;
    lastFlushTs = Date.now();
  } catch {
    // keep dirty=true; retry next call
  }
}

/** Returns true if a new alert with this key may fire (cooldown elapsed). */
export function canAlert(key: string, cooldownMs: number): boolean {
  const last = MEM[key] || 0;
  return Date.now() - last >= cooldownMs;
}

/** Record that an alert just fired so future checks honor the cooldown. */
export function markAlerted(key: string): void {
  MEM[key] = Date.now();
  dirty = true;
  maybeFlush();
}

/** Force-flush the in-process cache to disk (e.g. before shutdown). */
export function flush(): void {
  if (dirty) {
    saveDisk(MEM);
    dirty = false;
    lastFlushTs = Date.now();
  }
}
