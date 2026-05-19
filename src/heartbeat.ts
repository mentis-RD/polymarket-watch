import { join } from "node:path";

import { writeAtomic } from "./atomic-write.js";

const DIR = join(process.cwd(), "state", "heartbeats");

export function heartbeat(name: string, extra?: Record<string, unknown>): void {
  try {
    const payload = {
      name,
      ts: Date.now(),
      iso: new Date().toISOString(),
      ...extra,
    };
    writeAtomic(join(DIR, `${name}.txt`), JSON.stringify(payload));
  } catch {
    // Heartbeat failure shouldn't crash the worker.
  }
}
