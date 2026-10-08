import http from 'node:http';

export interface TransportStats {
  sent: number;
  failed: number;
}

/**
 * Fire-and-forget POST with a hard timeout. It never throws, never retries and never keeps the
 * process alive: a monitor that is down must not slow down or break the application.
 */
export class Transport {
  readonly stats: TransportStats = { sent: 0, failed: 0 };

  constructor(
    private readonly url: URL,
    private readonly token: string,
    private readonly timeoutMs = 1000,
  ) {}

  post(body: string): void {
    try {
      const req = http.request(
        {
          protocol: this.url.protocol,
          hostname: this.url.hostname,
          port: this.url.port,
          path: this.url.pathname + this.url.search,
          method: 'POST',
          agent: false,
          timeout: this.timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'X-Monitor-Token': this.token,
          },
        },
        (res) => {
          if (res.statusCode === 204 || (res.statusCode !== undefined && res.statusCode < 300)) this.stats.sent += 1;
          else this.stats.failed += 1;
          res.resume();
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => {
        this.stats.failed += 1;
      });
      req.on('socket', (sock) => sock.unref());
      req.end(body);
    } catch {
      this.stats.failed += 1;
    }
  }
}
