# Runbook: Nginx in front of monitor-api (H8)

The current reference for the Nginx configuration on the Windows VPS. The configuration itself lives only on the server (for example `C:\nginx\conf\nginx.conf`); this file is what it should contain for `monitor-api.thediv.in`. The blocks below were checked with `nginx -t` and a burst test against Nginx 1.24, and `apps/backend/test/nginx-config.test.ts` repeats both checks in CI wherever `nginx` is installed.

## 1. What is limited

| Path | Limit per client address | When exceeded | Why |
|---|---|---|---|
| `/api/v1/auth/` | 30 per minute, 10 at once | 429, JSON | Password guessing (done before H8) |
| `/webhooks/` | 120 per minute, 60 at once; body at most 256 KB (413 above) | 429 | Resend sends small bodies and retries a 429 later. The app has the same 120 per minute; Nginx stops a flood before Node reads it |
| `POST /api/v1/logs/search` | 6 per minute, 5 at once; CORS preflights (`OPTIONS`) not counted | 429, JSON | Each search reads hour files on `E:`. The app also allows one running search per user |

The JSON body is `{"error":"rate_limited","message":"Too many requests. Wait a minute and try again."}`, the shape the dashboard already shows for its own errors. It carries `Access-Control-Allow-Origin: https://monitor.thediv.in` and `Access-Control-Allow-Credentials: true`, because the dashboard calls the API from another origin and the browser would otherwise hide the answer and report a network error. If the dashboard's address changes, change it there too.

Everything else goes through the general `location /` and is limited only by the app (300 requests per minute per address).

## 2. Configuration

In the `http` block of `nginx.conf`, once (the `auth` zone is already there; add the rest):

```nginx
# --- Command Center rate limits (http block, once) ---------------------------
limit_req_zone $binary_remote_addr zone=auth:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=webhooks:10m rate=120r/m;
# CORS preflights for the search (OPTIONS) get an empty key, which Nginx does not limit.
map $request_method $cc_search_key {
    OPTIONS "";
    default $binary_remote_addr;
}
limit_req_zone $cc_search_key zone=logsearch:10m rate=6r/m;
```

The `server` block for `monitor-api.thediv.in`. Keep your existing `listen`, `server_name` and certificate lines; replace the `location` blocks with these:

```nginx
server {
    listen 443 ssl;
    server_name monitor-api.thediv.in;
    # ssl_certificate / ssl_certificate_key: unchanged, managed by the ACME client

    location /api/v1/auth/ {
        limit_req zone=auth burst=10 nodelay;
        limit_req_status 429;
        error_page 429 = @cc_too_many;
        proxy_pass http://127.0.0.1:4111;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # H8: Resend webhooks. The app also allows 120 per minute; Nginx stops a flood before the
    # body reaches Node. Resend retries a 429 later.
    location /webhooks/ {
        limit_req zone=webhooks burst=60 nodelay;
        limit_req_status 429;
        client_max_body_size 256k;
        proxy_pass http://127.0.0.1:4111;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # H8: log search reads files on E: and is expensive. 6 per minute per address, 5 at once.
    location = /api/v1/logs/search {
        limit_req zone=logsearch burst=5 nodelay;
        limit_req_status 429;
        error_page 429 = @cc_too_many;
        proxy_pass http://127.0.0.1:4111;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # The answer when the auth or search limit is hit. The dashboard calls the API from another
    # origin; without these headers the browser hides the 429 and the page shows a network error.
    location @cc_too_many {
        default_type application/json;
        add_header Access-Control-Allow-Origin "https://monitor.thediv.in" always;
        add_header Access-Control-Allow-Credentials "true" always;
        add_header Vary "Origin" always;
        return 429 '{"error":"rate_limited","message":"Too many requests. Wait a minute and try again."}';
    }

    location / {
        proxy_pass http://127.0.0.1:4111;
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

## 3. Applying it on the server

1. Copy the current file first: `Copy-Item C:\nginx\conf\nginx.conf C:\nginx\conf\nginx.conf.before-h8`.
2. Edit `nginx.conf` as in section 2.
3. Test, then reload (from the Nginx folder, as the account that runs Nginx):
   ```powershell
   cd C:\nginx
   .\nginx.exe -t
   .\nginx.exe -s reload
   ```
   If `-t` fails, nothing has changed yet; fix or copy the `.before-h8` file back.
4. Check from your own computer (not the server, whose address is local to Nginx). Windows 10 and later have `curl.exe`:
   ```powershell
   1..8 | % { curl.exe -s -o NUL -w "%{http_code} " -X POST https://monitor-api.thediv.in/api/v1/logs/search }
   ```
   Expected: six answers from the app (403, because the test sends no dashboard header), then `429 429`. Wait a minute before searching in the dashboard: this used up your allowance. Then open Logs in the dashboard and run one search: it works as before.
5. Resend: Email page counts keep rising after the next sent mail. A Resend test event (V5) still arrives.

To undo: copy `nginx.conf.before-h8` back, `.\nginx.exe -t`, `.\nginx.exe -s reload`.

## 4. Outside port scan (V11)

Run from a machine outside the VPS's network (your own computer, or a cloud shell), never from the VPS itself. With nmap (`winget install Insecure.Nmap`, or the installer from nmap.org):

```powershell
nmap -Pn -sT -p- --min-rate 500 monitor-api.thediv.in
```

This scans all TCP ports and takes a few minutes. Expected open: `80` and `443` (Nginx). Anything else open is a finding:

| Port | Should be | If open |
|---|---|---|
| 4111 (`monitor-api`), 4001 (agent ingest), 8081 (`stub_status`) | closed or filtered | The backend or Nginx status is bound to a public address: check `BIND_HOST=127.0.0.1` and the `listen 127.0.0.1:8081` line, and the Windows firewall |
| 27017 (MongoDB) | closed or filtered | Bind Mongo to `127.0.0.1` and block it in the firewall |
| 3389 (Remote Desktop) | filtered, or open only to your own addresses | Restrict the firewall rule's remote addresses (scope) to your own IPs, or put it behind a VPN |
| anything else | closed or filtered | Find the program with `Get-NetTCPConnection -State Listen -LocalPort <port>` on the VPS |

Without nmap, a quick check of the important ports from your computer:

```powershell
4111, 4001, 8081, 27017, 3389 | % { "{0}: {1}" -f $_, (Test-NetConnection monitor-api.thediv.in -Port $_ -WarningAction SilentlyContinue).TcpTestSucceeded }
```

`False` is the wanted answer for all but 3389. Record the date, the tool and the open ports as V11 in `implementation-plan.md` section 0.3.
