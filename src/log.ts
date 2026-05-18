export function ts(): string {
  return new Date().toISOString();
}

export function log(scope: string, msg: string, ...rest: unknown[]): void {
  const line = `[${ts()}] [${scope}] ${msg}`;
  if (rest.length > 0) console.log(line, ...rest);
  else console.log(line);
}

export function err(scope: string, msg: string, ...rest: unknown[]): void {
  const line = `[${ts()}] [${scope}] ERROR: ${msg}`;
  if (rest.length > 0) console.error(line, ...rest);
  else console.error(line);
}
