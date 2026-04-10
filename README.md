# M-Pesa Tracker

Personal financial intelligence tool. M-Pesa SMS → parsed transactions → AI advisor (Claude).

**Stack:** Node.js · Express · SQLite · Anthropic SDK · Vanilla HTML/CSS/JS  
**Deployed at:** `https://mpesa.smartshamba.io`

---

## Local Development

```bash
cp .env.example .env       # fill in your keys
npm install
npm run dev                # node --watch server.js
```

Open `http://localhost:3000`.

---

## Deploy to Hostinger VPS

### Prerequisites on the VPS (one-time)

```bash
# SSH in (Hostinger uses port 2222)
ssh -p 2222 user@YOUR_VPS_IP

# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 globally
sudo npm install -g pm2

# Install nginx + certbot
sudo apt install -y nginx certbot python3-certbot-nginx
```

---

### Option A — Deploy via SCP

```bash
# From your local machine:
scp -P 2222 -r \
  server.js db.js parser.js advisor.js \
  package.json .env \
  public/ setup/ \
  user@YOUR_VPS_IP:~/mpesa-tracker/

# Then on the VPS:
ssh -p 2222 user@YOUR_VPS_IP
cd ~/mpesa-tracker
npm install --omit=dev
pm2 start server.js --name mpesa-tracker
pm2 save
```

### Option B — Deploy via Git

```bash
# On the VPS (one-time):
git clone https://github.com/YOUR_USER/mpesa-tracker.git ~/mpesa-tracker
cd ~/mpesa-tracker
cp .env.example .env
nano .env          # fill in ANTHROPIC_API_KEY, API_SECRET, APP_URL
npm install --omit=dev
pm2 start server.js --name mpesa-tracker
pm2 save

# Future deploys:
cd ~/mpesa-tracker && git pull && pm2 restart mpesa-tracker
```

---

## PM2 — Process Management

```bash
pm2 start server.js --name mpesa-tracker   # start
pm2 restart mpesa-tracker                  # restart (after .env changes)
pm2 stop mpesa-tracker                     # stop
pm2 logs mpesa-tracker --lines 50          # live logs
pm2 status                                 # check all processes
```

### Auto-restart on reboot

```bash
# Run once after first pm2 start:
pm2 startup        # outputs a sudo command — run it
pm2 save           # saves the process list
```

After a reboot the app will restart automatically.

---

## nginx — Reverse Proxy

Create `/etc/nginx/sites-available/mpesa-tracker`:

```nginx
server {
    listen 80;
    server_name mpesa.smartshamba.io;

    # Redirect HTTP → HTTPS (certbot will update this automatically)
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name mpesa.smartshamba.io;

    # SSL certs — filled in by certbot
    ssl_certificate     /etc/letsencrypt/live/mpesa.smartshamba.io/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mpesa.smartshamba.io/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    # Proxy to Node app
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Required for SSE (AI advisor streaming)
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection '';
        proxy_cache_bypass $http_upgrade;
        proxy_buffering    off;
        chunked_transfer_encoding on;

        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # SSE connections can be long-lived
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/mpesa-tracker /etc/nginx/sites-enabled/
sudo nginx -t          # test config
sudo systemctl reload nginx
```

---

## SSL — Certbot

```bash
sudo certbot --nginx -d mpesa.smartshamba.io
```

Certbot will obtain the certificate, update the nginx config, and set up auto-renewal.  
Verify renewal works:

```bash
sudo certbot renew --dry-run
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable            | Description                                              |
|---------------------|----------------------------------------------------------|
| `ANTHROPIC_API_KEY` | From console.anthropic.com — powers the AI Advisor       |
| `API_SECRET`        | Any long random string — used to authenticate iOS Shortcut POST requests |
| `APP_URL`           | Your public URL, e.g. `https://mpesa.smartshamba.io`     |
| `PORT`              | Port to bind (default 3000)                              |

Generate a strong `API_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## iOS Shortcut Setup

The full interactive setup guide is at **`/setup`** on your running app.  
Quick reference below.

### What it does
Every time an SMS arrives from **MPESA**, the Shortcut silently POSTs the message body to `/api/sms`. No tapping required.

### Steps

1. Open **Shortcuts** app → **Automation** tab → tap **+**
2. Trigger: **Message** → From: `MPESA` → enable **Run Immediately**
3. Add action: **Get Contents of Shortcut Input**
4. Add action: **Get Body of [Message]** (use Shortcut Input as input)
5. Add action: **Get Contents of URL**
   - URL: `https://mpesa.smartshamba.io/api/sms`
   - Method: `POST`
   - Request Body: `JSON`
     - Key: `sms`  →  Value: `Body` (from step 4)
   - Headers:
     - Key: `X-API-Secret`  →  Value: `<your API_SECRET>`
6. *(Optional)* Add action: **Open URLs** → `https://mpesa.smartshamba.io`
7. Tap **Done**

### Test without a real SMS

```bash
curl -X POST https://mpesa.smartshamba.io/api/sms \
  -H "Content-Type: application/json" \
  -H "X-API-Secret: YOUR_SECRET" \
  -d '{"sms":"QK58XXXXX Confirmed. KES1,500.00 sent to JOHN DOE 0712345678 on 10/4/24 at 2:30 PM. New M-PESA balance is Ksh8,500.00."}'
```

---

## API Reference

| Method | Path                     | Auth          | Description                        |
|--------|--------------------------|---------------|------------------------------------|
| POST   | `/api/sms`               | X-API-Secret  | Submit raw M-Pesa SMS for parsing  |
| GET    | `/api/transactions`      | —             | List transactions (filterable)     |
| PATCH  | `/api/transactions/:id`  | —             | Update category / note / pending   |
| GET    | `/api/summary`           | —             | Aggregated totals by category      |
| POST   | `/api/advisor`           | —             | Stream AI analysis via SSE         |
| GET    | `/setup`                 | —             | Onboarding page                    |

**GET /api/transactions** query params: `direction`, `category`, `from`, `to`, `pending`  
**GET /api/summary** query params: `period` (`this_month` | `last_month` | `3_months` | `all`)  
**POST /api/advisor** query param: `period`

---

## Project Structure

```
mpesa-tracker/
  server.js         Express app — all routes, SSE, startup banner
  db.js             SQLite init, schema, all query functions
  parser.js         M-Pesa SMS pattern matching (6 formats + fallback)
  advisor.js        Financial snapshot builder + Claude streaming
  public/
    index.html      Full frontend — Ledger / Budget / Advisor tabs
  setup/
    index.html      iOS Shortcut + onboarding instructions
  .env.example      Variable reference (safe to commit)
  .env              Your secrets (never commit)
  mpesa.db          SQLite database (auto-created on first run)
  README.md
```

---

## Troubleshooting

**App not starting**
```bash
pm2 logs mpesa-tracker --lines 30
# Check for missing .env variables or port conflicts
```

**401 from iOS Shortcut**  
`API_SECRET` in your Shortcut header doesn't match `.env`. Restart app after any `.env` change.

**Advisor returns "ANTHROPIC_API_KEY is not set"**  
Add key to `.env`, then `pm2 restart mpesa-tracker`.

**SSE streaming cuts off**  
Ensure nginx `proxy_buffering off` and `proxy_read_timeout 300s` are set (see nginx config above).

**SMS not parsing (parse_failed = 1)**  
Open the Ledger tab — failed SMS appear with a ⚠ flag and the raw text. You can still label them manually. Common cause: Safaricom changed their SMS format. Check `parser.js` patterns.
