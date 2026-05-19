import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write a file atomically: write to `<path>.tmp` first, then rename over the
 * target. Either the OLD content or the NEW content is observable at every
 * point — never a half-written file. Critical for large JSON state blobs
 * that get corrupted on SIGKILL / OOM / pm2 restart mid-write.
 */
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** Convenience: stringify then atomic-write. */
export function writeJsonAtomic(path: string, data: unknown, indent: number | undefined = 2): void {
  writeAtomic(path, indent !== undefined ? JSON.stringify(data, null, indent) : JSON.stringify(data));
}
