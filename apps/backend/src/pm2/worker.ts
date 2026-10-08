import { parentPort } from 'node:worker_threads';
import { InProcPm2Source } from './inproc';
import type { Pm2EventPacket, Pm2LogPacket } from './types';

/**
 * Worker thread entry: owns the `pm2` package and speaks to the main thread by messages.
 * If pm2 calls process.exit() or crashes, only this thread ends.
 */
if (!parentPort) throw new Error('worker.ts must run as a worker thread');
const port = parentPort;
const src = new InProcPm2Source();

type Request = { id: number; op: 'connect' | 'list' | 'bus_start' | 'bus_stop' | 'dispose' };

port.on('message', async (m: Request) => {
  try {
    let result: unknown = null;
    switch (m.op) {
      case 'connect':
        await src.connect();
        break;
      case 'list':
        result = await src.list();
        break;
      case 'bus_start':
        await src.startBus({
          onLogs: (items: Pm2LogPacket[]) => port.postMessage({ type: 'logs', items }),
          onEvents: (items: Pm2EventPacket[]) => port.postMessage({ type: 'events', items }),
          onBusClosed: () => port.postMessage({ type: 'bus_closed' }),
        });
        break;
      case 'bus_stop':
        await src.stopBus();
        break;
      case 'dispose':
        await src.dispose();
        break;
    }
    port.postMessage({ id: m.id, ok: true, result });
  } catch (e) {
    port.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
