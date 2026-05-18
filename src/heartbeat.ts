import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "state", "heartbeats");

export function heartbeat(name: string, extra?: Record<string, unknown>): void {
  try {
    mkdirSync(DIR, { recursive: true });
    const payload = {
      name,
      ts: Date.now(),
      iso: new Date().toISOString(),
      ...extra,
    };
    writeFileSync(join(DIR, `${name}.txt`), JSON.stringify(payload));
  } catch {
    // Heartbeat failure shouldn't crash the worker.
  }
}
