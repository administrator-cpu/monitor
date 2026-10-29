# Runbook: phases 6 to 9 (Nginx, MongoDB, agent, history and search)

Everything here is read-only. Every source is optional: leave its variable unset and that part of the dashboard says "not configured" and its alert rules stay quiet.

## 1. Nginx (phase 6)

1. **JSON access log.** In the `http` block:
   ```nginx
   log_format monitor_json escape=json
     '{"t":"$time_iso8601","host":"$host","status":$status,"rt":$request_time,'
     '"urt":"$upstream_response_time","up":"$upstream_addr","bytes":$body_bytes_sent,"method":"$request_method"}';
   access_log C:/nginx/logs/access.json.log monitor_json;
   ```
   The request path and query string are deliberately not logged.
2. **stub_status**, loopback only:
   ```nginx
   server { listen 127.0.0.1:8081; location /nginx_status { stub_status; allow 127.0.0.1; deny all; } }
   ```
3. Set `NGINX_STATUS_URL`, `NGINX_ACCESS_LOG`, `NGINX_ERROR_LOG` and `TLS_CHECK_HOSTS`, then restart the backend. Reload Nginx after editing its config (`nginx -s reload`).
4. Give each service its Nginx host(s) on the Services page (`nginxMatch`, for example `api.example.com, *.example.com` or `127.0.0.1:3001`). Traffic that matches no service is shown as unattributed.
5. The tailer starts at the end of the file, so old traffic is never replayed after a restart. It follows log rotation.

Check: the Nginx page shows connections, requests per second, 5xx rate, p95 time and per-service rows within about 30 s.

## 2. MongoDB (phase 7)

1. Create a monitoring user with the built-in `clusterMonitor` role, and read access to `system.profile` in the databases you profile:
   ```js
   use admin
   db.createUser({ user: "monitor", pwd: "<password>", roles: [ "clusterMonitor",
     { role: "read", db: "app" } ] })   // "read" is needed only for system.profile
   ```
   For least privilege use a custom role that grants only `find` on `app.system.profile`.
2. Turn the profiler on for slow operations: `db.setProfilingLevel(0, { slowms: 200 })` is not enough, level 1 records them: `db.setProfilingLevel(1, { slowms: 200 })`.
3. Set `MONGO_URI` and `MONGO_PROFILE_DBS=app`.
4. Run `pnpm mongo:check`. It must show the allowed reads working and every write, drop, `killOp` and application-collection read refused.

Slow queries are stored as a shape (operation, namespace, field names) and never as values.

## 3. Adding the agent to a service (phase 8)

1. Set on the monitor: `INGEST_TOKEN` (24+ characters) and optionally `PORT_INGEST` (default 4001). The listener binds to 127.0.0.1 only.
2. In the service (`@cc/agent` has no runtime dependencies; see `packages/agent/README.md`):
   ```ts
   import { createMonitor } from '@cc/agent';
   const monitor = createMonitor({ token: process.env.INGEST_TOKEN! });
   app.use(monitor.middleware());
   monitor.tenantResolver((req) => req.headers['x-tenant-id'] as string | undefined);
   ```
   For sockets call `monitor.socketOpened(tenantId, userId)` / `socketClosed(tenantId)`, or use `attachWs(monitor, wss, who)`.
3. The service name is taken from PM2 (`name`, `pm_id`). Reports from a name PM2 does not list are rejected and counted.
4. `COMMAND_CENTER_AGENT=off` turns the agent into a no-op without a code change. It never throws and never waits more than 1 s.
5. Run `pnpm agent:bench` after any change to the hot path. Budget: 25 microseconds per request (measured about 0.26).

Only counts and timings leave the process. User ids are never sent, only the number of distinct users in the last 5 minutes.

## 4. History, search and retention (phase 9)

- **Rollup** runs hourly. Raw 10 s rows older than `retention.metrics_raw_hours` are folded into 1-minute rows in one transaction per table; running it twice changes nothing. It is recorded in `maintenance_runs`.
- **Retention** deletes by age: metrics, Windows events, slow queries, process events, alerts and the audit log.
- **History charts** (Host, Service, Nginx, MongoDB) take 1 h up to `retention.metrics_days` (7 days by default). Gaps are shown as gaps.
- **Log search** (`/logs`): up to `logs.retention_hours` (24 hours by default), one search per user and four overall, 30 s limit, regex checked for catastrophic patterns, runs in a worker thread. The audit log records the filter, never the results.
- **Windows Event Log** (Windows only): critical, error and warning events every minute; only critical raises `host.eventlog_critical`, and the alert shows provider and event id, not the message.

## 5. Demo and checks

| Command | Does |
|---|---|
| `pnpm demo` | Real backend with a pretend Nginx, MongoDB and an agent with three tenants. Open the UI and see every page populated. |
| `pnpm mongo:check` | Proves the Mongo account is read-only. |
| `pnpm agent:bench` | Per-request overhead of the agent. |
| `pnpm size:check` | Database size for 10 services x 20 tenants over 7 days (about 164 MB; tenant rows dominate). |
