# @cc/agent

The optional in-app agent for the Command Center. It adds what the host and PM2 cannot see:
event-loop lag, request latency, open sockets and active users per tenant. **Only counts leave
the process.** User identifiers live in an in-memory set for five minutes and are never sent.

It has no runtime dependencies, works as middleware for Express, Connect and plain `http` (Fastify: call it from an
`onRequest` hook with `request.raw` and `reply.raw`; not covered by the tests here), and never throws into your application: if the monitor is down the report is dropped
after one second.

## Add it to a service

1. In the monitor's `.env`, set `INGEST_TOKEN` (24+ random characters) and restart the monitor.
   The ingest port (`PORT_INGEST`, default 4001) listens on `127.0.0.1` only.
2. In the service (the PM2 process name is used as the service name):

```js
const { createMonitor, attachWs } = require('@cc/agent');

const monitor = createMonitor({ token: process.env.INGEST_TOKEN });

// Which tenant and user does this request belong to? Called when the response finishes, so
// authentication has already run. Return nothing and the traffic is filed under `_unknown`.
monitor.tenantResolver((req) => ({ tenantId: req.user?.orgId, userId: req.user?.id }));

app.use(monitor.middleware());             // Express / Connect / plain http
attachWs(monitor, wss, (req) => ({ tenantId: tenantOf(req) })); // `ws` servers
// or by hand: monitor.socketOpened(tenantId, userId) / monitor.socketClosed(tenantId)
```

3. Restart the service. Within a few seconds the service page shows **Application runtime**.

Switch it off without a code change by setting `COMMAND_CENTER_AGENT=off` in the service's
environment, or `createMonitor({ enabled: false })`.

## What it costs

`pnpm --filter @cc/agent bench` measures it. On the build machine, recording one request takes
about a quarter of a microsecond; the rest of the cost is one 5-second timer, an event-loop-delay
histogram and a single small POST every five seconds. Memory is bounded: 2,000 latency samples per
window, at most 100,000 user ids per tenant and 1,000 tracked tenants.
