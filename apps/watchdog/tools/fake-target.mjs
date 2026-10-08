// A stand-in for the Command Center backend, for testing the watchdog without touching production.
//   node tools/fake-target.mjs [port]            (default 4199, listens on 127.0.0.1 only)
// Switch behaviour while it runs:  curl http://127.0.0.1:4199/__mode/down
//   ok    -> 200 "ok"          down -> connection reset     bad -> 200 with a non-ok body
//   slow  -> never answers     err  -> HTTP 503
import http from 'node:http';

export function startFakeTarget(port = 4199) {
  let mode = 'ok';
  const hits = [];
  const server = http.createServer((req, res) => {
    const m = /^\/__mode\/(ok|down|bad|slow|err)$/.exec(req.url ?? '');
    if (m) {
      mode = m[1];
      res.end(`mode=${mode}\n`);
      return;
    }
    if (req.url === '/__mode') return void res.end(`mode=${mode}\n`);
    hits.push({ at: Date.now(), mode });
    if (mode === 'ok') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    } else if (mode === 'down') req.socket.destroy();
    else if (mode === 'bad') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>maintenance</html>');
    } else if (mode === 'err') {
      res.writeHead(503);
      res.end('unavailable');
    } // slow: leave the request open
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        hits,
        setMode: (x) => (mode = x),
        close: () => {
          server.closeAllConnections?.();
          return new Promise((r) => server.close(() => r()));
        },
      }),
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t = await startFakeTarget(Number(process.argv[2] ?? 4199));
  console.log(`fake target on http://127.0.0.1:${t.port}/  (switch: /__mode/ok|down|bad|slow|err)`);
}
