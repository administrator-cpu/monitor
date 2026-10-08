# Command Center watchdog

A tiny, independent service that emails you when the Command Center backend stops answering. It runs on Render (not on the VPS) and **shares no code with the backend**, so a VPS outage cannot take it down with it.

## How it works

An external scheduler (cron-job.org) calls `GET /ping` every 5 minutes with an `X-Cron-Token` header. `/ping` answers immediately with the current state and runs one background check:

- up to 3 attempts, 10 s apart, 8 s timeout each, against `TARGET_URL`;
- healthy means HTTP 200 and a body of `ok` or `{"status":"ok"}`; redirects are not followed;
- UP → DOWN sends **email 1**; if still down after 60 minutes, **email 2** (reminder);
- 2 consecutive successes → RECOVERING and **email 3** (recovered); 30 minutes without a failure → UP;
- a failure while RECOVERING goes back to DOWN **without a new email**: at most 3 emails per outage;
- an email that could not be sent is retried on later checks; "recovered" is never sent if "down" was never delivered.

`GET /` returns `ok` (Render's health check, no token). `/ping` without the right token returns 401 and does nothing.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `TARGET_URL` | yes | The backend's `/health` URL. `https://` only (`http://` allowed for localhost tests) |
| `CRON_TOKEN` | yes | 32+ characters |
| `RESEND_API_KEY` | yes | |
| `ALERT_FROM` | yes | `name@domain` or `Name <name@domain>`, on a domain verified in Resend |
| `ALERT_TO` | yes | Comma separated, up to 10 |
| `PORT` | no | Render sets it (default 10000) |
| `ATTEMPTS`, `ATTEMPT_DELAY_MS`, `ATTEMPT_TIMEOUT_MS`, `REMINDER_AFTER_MS`, `FLAP_WINDOW_MS`, `RECOVERY_SUCCESSES`, `RESEND_API_URL` | no | Test overrides; logged at start when changed |

Invalid configuration stops startup and names the variable, never its value.

## Deploy

1. Push the repository, create a Render Blueprint from `apps/watchdog/render.yaml` (or a Web Service with the same settings), and fill in the five secrets.
2. On cron-job.org create a job: URL `https://<service>.onrender.com/ping`, every 5 minutes, request header `X-Cron-Token: <CRON_TOKEN>`, treat any 2xx as success.
3. Verify with `curl -H "X-Cron-Token: …" https://<service>.onrender.com/ping`.

## Testing safely

Never take production down to test this.

```
npm test            # unit tests
npm run smoke       # builds, then runs the real process against a fake target and a mock Resend
npm run fake-target # a controllable target: curl http://127.0.0.1:4199/__mode/down | bad | slow | err | ok
```

For a manual run, start the fake target, run the watchdog with `TARGET_URL=http://127.0.0.1:4199/` and short timings (`ATTEMPT_DELAY_MS=100 REMINDER_AFTER_MS=5000`), and use your real Resend key.

## Known limits

- If Resend is also down, nothing can be sent; the unsent email is retried on later checks.
- After a recovery, a second failure inside the 30-minute window is treated as the same outage and sends no new "down" email.
