# Runbook: phases 3 to 5 (PM2 and logs, alerts, watchdog)

## 1. PM2 access
The monitor connects to the PM2 daemon that runs your apps; it never starts one. It must run as the **same Windows user** as PM2 (or have `PM2_HOME` pointing at that user's `.pm2` folder). Check: `pm2 ls` as that user, then start the monitor and open **Services**. If PM2 is unreachable the page says so and retries with backoff (1 s to 30 s). When a service is first seen the monitor shows the tail of PM2's own log files; after that it follows the live feed. An empty log view therefore means PM2's files are empty or unreadable by the monitor's user, or the app logs to a custom path PM2 does not know about.

## 2. Log volume
Set `LOG_ROOT` to a folder on the `E:` volume (default `E:\monitor-logs`). With `LOG_REQUIRE_SEPARATE_VOLUME=true` the monitor refuses to write logs onto the same volume as the database and raises `monitor.log_volume_missing`. Retention trims the oldest hour when the volume runs short.
Moving PM2's own logs off `C:` (optional): `pm2 flush`, then set `error_file` / `out_file` in each app's ecosystem entry to `E:\pm2-logs\...` and `pm2 reload ecosystem.config.js`. Install `pm2-logrotate` to cap them.

## 3. Resend
1. Create a Resend account, verify the sending domain, create an API key.
2. In the backend env file set `RESEND_API_KEY`, `ALERT_FROM`, `PUBLIC_DASHBOARD_URL`.
3. Restart. Open **Alerts**; the email panel shows configured. Admin: "Send test email" goes to your own address.
4. Admins always receive alerts; engineers receive categories they subscribe to (Alerts > Subscriptions).

## 4. Demo script (phase 3 and 4)
1. Start two PM2 apps. **Services** lists them with live CPU/memory; open one and watch the log tail.
2. `pm2 stop <app>`: within about a minute the service shows stopped, `pm2.service_down` opens after its duration, an email arrives.
3. Start it again: the incident resolves after the hysteresis period and a "resolved" email follows.
4. Make an app crash repeatedly: crash loop opens and the plain service_down email is suppressed.
5. Alerts > Mutes: mute the service, repeat; the incident is recorded but nothing is sent until the mute ends.
6. Unplug email (wrong key): after 3 failed attempts `monitor.email_failing` shows on the dashboard.
Automated equivalent: `pnpm pm2:check` (throw-away PM2 under `/tmp`, never your real one) and `pnpm --filter @cc/frontend e2e`.

## 5. Watchdog on Render
See `apps/watchdog/README.md`. Summary: deploy `apps/watchdog/render.yaml`, set the five secrets, create the cron-job.org job (every 5 min, `X-Cron-Token` header). `TARGET_URL` is your public `/health`.

## 6. Safe testing of the watchdog
Do not stop production. Run `pnpm smoke:watchdog` (fully local), or point a throw-away watchdog at `npm run fake-target` and flip it with `/__mode/down|bad|slow|ok`. Expected: one DOWN email, a reminder after the reminder interval, one RECOVERED email, never more than three per outage.

## 7. Troubleshooting
- No emails: Alerts > email panel; check the outbox row for the error. 4xx from Resend (other than 408/409/429) is permanent: fix the key or sender.
- Services empty: PM2 user/`PM2_HOME` mismatch.
- Logs missing after restart of the monitor: expected for the gap while it was down (see section 1).
