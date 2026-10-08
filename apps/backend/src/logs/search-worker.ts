import { parentPort } from 'node:worker_threads';
import { runSearch, type SearchJob } from './search';

// One job per worker: the worker is started for a search and ends with it.
parentPort?.once('message', (job: SearchJob) => {
  runSearch(job)
    .then((result) => parentPort?.postMessage({ ok: true, result }))
    .catch((e: unknown) => parentPort?.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) }));
});
