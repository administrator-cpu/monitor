/** One JSON object per line on stdout, which `docker logs` keeps. Tokens are never passed in here. */
export interface Log {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function jsonLog(write: (line: string) => void = (l) => process.stdout.write(l)): Log {
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) =>
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n');
  return { info: at('info'), warn: at('warn'), error: at('error') };
}

export const silentLog: Log = { info() {}, warn() {}, error() {} };
