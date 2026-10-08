import { Writable } from 'node:stream';
import type { LogPipeline } from './pipeline';

/**
 * A pino destination that feeds the monitor's own log lines into the log pipeline under the
 * pseudo-service `_monitor`, so they get the same live view, files and retention as services.
 * Lines logged before the pipeline exists are held (bounded) and replayed on `attach`.
 */
export class PipelineSink extends Writable {
  private pipeline: LogPipeline | null = null;
  private held: string[] = [];

  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const text = chunk.toString();
    if (this.pipeline) this.pipeline.ingest('_monitor', -1, 'app', text);
    else if (this.held.length < 200) this.held.push(text);
    cb();
  }

  attach(pipeline: LogPipeline): void {
    this.pipeline = pipeline;
    for (const t of this.held) pipeline.ingest('_monitor', -1, 'app', t);
    this.held = [];
  }
}
