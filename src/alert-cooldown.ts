import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

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

function save(s: Store): void {
  mkdirSync(dirname(PATH), { recursive: true });
  writeFileSync(PATH, JSON.stringify(s, null, 2));
}

/** Returns true if a new alert with this key may fire (cooldown elapsed). */
export function canAlert(key: string, cooldownMs: number): boolean {
  const s = load();
  const last = s[key] || 0;
  return Date.now() - last >= cooldownMs;
}

/** Record that an alert just fired so future checks honor the cooldown. */
export function markAlerted(key: string): void {
  const s = load();
  s[key] = Date.now();
  save(s);
}
