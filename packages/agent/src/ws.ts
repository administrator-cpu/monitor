import type { Monitor, TenantInfo } from './monitor';

/** The slice of a `ws` WebSocketServer / socket the adapter needs; no import of `ws` required. */
interface WsServerLike {
  on(event: 'connection', cb: (socket: SocketLike, req: unknown) => void): unknown;
}
interface SocketLike {
  on(event: 'close', cb: () => void): unknown;
}

/**
 * Counts connections of a `ws` server:
 *   attachWs(monitor, wss, (req) => ({ tenantId: tenantFrom(req), userId: userFrom(req) }));
 */
export function attachWs(monitor: Monitor, wss: WsServerLike, who?: (req: any) => TenantInfo | null | undefined): void {
  wss.on('connection', (socket, req) => {
    let info: TenantInfo = {};
    try {
      info = who?.(req) ?? {};
    } catch {
      info = {};
    }
    monitor.socketOpened(info.tenantId, info.userId);
    let closed = false;
    socket.on('close', () => {
      if (closed) return;
      closed = true;
      monitor.socketClosed(info.tenantId);
    });
  });
}
