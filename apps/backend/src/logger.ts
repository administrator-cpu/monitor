import type { Writable } from 'node:stream';
import pino, { multistream, type Logger } from 'pino';

export type { Logger };

/** `extra` receives the same lines as stdout (used to feed the monitor's own log into the pipeline). */
export function createLogger(level: string, extra?: Writable): Logger {
  const opts = {
    level,
    // Defence in depth: the app never logs these on purpose.
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'headers.cookie',
        'password',
        '*.password',
        '*.currentPassword',
        '*.newPassword',
        '*.token',
      ],
      censor: '[redacted]',
    },
  };
  if (!extra) return pino(opts);
  return pino(
    opts,
    multistream([
      { level, stream: process.stdout },
      { level, stream: extra },
    ]),
  );
}
