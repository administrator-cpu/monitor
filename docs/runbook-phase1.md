# Runbook: Phase 1 and 2 (backend core and frontend)

Companion to `implementation-plan.md`. Each section ends in something you can check.

## 1. Prerequisites on the VPS (plan, Phase 0)

- Node.js 22 LTS (`node -v`), pnpm 10 (`corepack enable`), NSSM on `PATH`.
- A low-privilege Windows account for the service, with write access to `C:\monitor\data` and (from phase 3) `E:\monitor-logs`, and no administrator rights.
- Folders: `C:\monitor\app` (the repo), `C:\monitor\data`, `C:\monitor\config`.
- **First hour of phase 1: confirm the native modules load.**

  ```powershell
  cd C:\monitor\app
  pnpm install --frozen-lockfile
  node -e "const D=require('better-sqlite3');const d=new D(':memory:');console.log(d.prepare('select sqlite_version() v').get())"
  node -e "require('bcrypt').hash('x',4).then(()=>console.log('bcrypt ok'))"
  ```

  Both ship `win32-x64` prebuilds, so a compiler is not expected. If `bcrypt` fails to load, nothing needs changing: the backend falls back to `bcryptjs` automatically (slower hashing, no native dependency). Note which one is active in the startup log or by running a login.

## 2. Build and configure

```powershell
cd C:\monitor\app
pnpm build:shared
pnpm --filter @cc/backend build
```

Create `C:\monitor\config\backend.env` (outside the repository; restrict its ACL to the service account and administrators):

```
NODE_ENV=development            # plain cookie while localhost-only; production once HTTPS is in place
BIND_HOST=127.0.0.1
PORT_API=4000
ALLOWED_ORIGINS=http://localhost:3000
SQLITE_PATH=C:\monitor\data\monitor.db
LOG_LEVEL=info
```

Create the first admin (no default credentials exist):

```powershell
$env:CC_ENV_FILE='C:\monitor\config\backend.env'
node apps\backend\dist\create-admin.js --username owner --email you@example.com --name "Owner"
```

## 3. Install as a Windows service

```powershell
.\scripts\install-service.ps1   # defaults: service monitor-api, C:\Apps\command-center-deploy\apps\backend, .\Administrator
curl http://127.0.0.1:4000/health        # {"status":"ok"}
```

The service runs outside PM2 on purpose. Production was first set up under PM2; the switch to the service is `docs/runbook-service.md` (H9). To remove it: `.\scripts\uninstall-service.ps1`.

## 4. Run the frontend

Locally against the VPS backend over an SSH tunnel, or on a laptop against localhost:

```bash
cp apps/frontend/.env.example apps/frontend/.env.local     # NEXT_PUBLIC_API_BASE=http://localhost:4000
pnpm dev:frontend
```

Vercel (build only, not yet pointed at a public API): set `NEXT_PUBLIC_API_BASE=https://api.<domain>`, root directory `apps/frontend`, install command `pnpm install --frozen-lockfile` from the repo root. The build applies a CSP limiting `connect-src` to the API origin.

## 5. Before the API is public (plan section 4 preconditions)

Historical: production now runs on port 4111 at `monitor-api.thediv.in`. The current Nginx configuration, with the H8 limits, is in `runbook-nginx.md`.

`NODE_ENV=production` must be set at that point (Secure `__Host-session` cookie). Nginx block for `api.<domain>`:

```nginx
server {
    listen 443 ssl;
    server_name api.<domain>;
    # ssl_certificate / ssl_certificate_key managed by the ACME client

    limit_req_zone $binary_remote_addr zone=auth:10m rate=30r/m;

    location /api/v1/auth/ {
        limit_req zone=auth burst=10 nodelay;
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}
```

(`limit_req_zone` belongs in the `http` context; shown here for brevity.) Set `ALLOWED_ORIGINS=https://monitor.<domain>`. The backend trusts `X-Forwarded-For` only from `127.0.0.1`, which is why it must stay bound to localhost behind Nginx.

## 6. Demo script (phase 1 and 2)

1. `create-admin` creates the first account; running it again with the same username refuses.
2. Sign in on the UI. The badge shows **Live**; CPU, memory, swap, network, uptime and the `C:` / `E:` disks update.
3. Open **Host**. Reload: charts are already populated.
4. **Users** > New user (engineer). Sign in as that user in a private window: forced password change, then no Users / Audit navigation, and `/admin/users` bounces to Overview.
5. As admin, **Disable** that user: their open tab returns to the login screen without a reload.
6. **Audit log** shows `user_created`, `login_success`, `user_disabled`, and any `login_failed`.
7. Stop the backend service: the UI shows **Disconnected · retrying** and hides values. Start it: the UI recovers without a reload.

## 7. Acceptance checklist (implementation plan, phase 1)

| Criterion | Evidence | Where |
|---|---|---|
| Wrong password five times locks the account, each failure audited | automated: `auth.test.ts` "locks the account after 5 failures" | tests |
| Non-allowlisted Origin rejected on REST and WebSocket | automated: `auth.test.ts` (origin and CSRF), `ws.test.ts` (4403) | tests |
| WebSocket without a session cookie closed with 4401 | automated: `ws.test.ts`; also run against a real process | tests |
| Killing and restarting the service keeps sessions valid | automated: new app on the same database file accepts the old cookie. **Repeat on the VPS** (V2): sign in, `Restart-Service monitor-api`, reload | tests + **on-host** |
| Backend memory and CPU within the TRD budget over a one-hour idle run | **not yet measured**. Watch the Host page "Monitor health" panel for an hour: RSS < 500 MB, process CPU < 10 %, event loop lag p95 < 50 ms | **on-host** |
| Native modules install; `systeminformation` returns all host fields | **on-host**: section 1, then check Overview shows CPU, RAM, swap, network, uptime, `C:` and `E:` | **on-host** |

Phase 2 acceptance (login, live charts, admin management; charts populated on reload; phone width; disconnect and self-recovery) is covered by the Playwright suite, and should be repeated once by eye on a real phone.

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| Backend exits at startup with `Invalid configuration` | The message names the variable. `ALLOWED_ORIGINS` must be full origins (`http://localhost:3000`), comma separated |
| UI banner "API rejected this site's origin" | The browser origin is not in `ALLOWED_ORIGINS` (scheme, host and port must match exactly) |
| Login works but the page bounces back to login | Cookie not stored: with `NODE_ENV=production` the cookie is Secure and needs HTTPS (Chrome accepts it on `http://localhost`; Safari does not) |
| "Disconnected · retrying" forever | Backend down, or Nginx not forwarding `Upgrade` headers |
| Disks list shows `stale` | `disk` collector failing; see the Collectors table on the Host page for the error |
| Locked out as the only admin | Stop the service, then `UPDATE users SET failed_attempts=0, locked_until=NULL WHERE username='owner';` in `monitor.db`, or wait 15 minutes |
