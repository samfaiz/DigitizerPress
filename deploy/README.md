# Deploying Digitizer Press

Target: a CloudPanel VPS, site root
`/home/faisalkhan-digitizerpress/htdocs/digitizerpress.faisalkhan.cloud`.

## Read this first

**This is CloudPanel, not cPanel.** The `htdocs/<domain>` layout is
CloudPanel's; cPanel uses `public_html`. It matters because the whole approach
below relies on systemd and root SSH, which CloudPanel gives you and cPanel
shared hosting does not. If you are genuinely on cPanel, see the last section.

**Three processes, not a website.** Nothing here is static. A Next.js server, a
NestJS gateway and a Python scorer all run continuously. Any host that only
serves files cannot run this.

**Size the box honestly.** The scorer loads PyTorch and a transformer model.
Installing torch alone is about 2 GB on disk, and the model resident costs
roughly 500 MB to 1 GB, before the two Node processes. **4 GB RAM is the
realistic minimum.** On 2 GB the scorer will be killed by the OOM reaper part
way through a job, which presents as articles failing for no visible reason.

**Set a password before the first deploy.** This is going on a public domain.
Without `ACCESS_PASSWORD`, anyone who finds the URL can spend your Anthropic
budget and read every saved article. It is one line in `.env` and it is the
difference between an internal tool and an open one.

---

## 1. Install the runtimes (once, as root)

```bash
# Node 20+. CloudPanel's per-site Node is not on systemd's PATH, so install
# system-wide and let the unit files use /usr/bin/node.
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs python3.11 python3.11-venv git

node -v   # expect v22.x
python3.11 --version
```

## 2. Get the code

```bash
su - faisalkhan-digitizerpress
cd /home/faisalkhan-digitizerpress/htdocs/digitizerpress.faisalkhan.cloud

# The directory already exists and may hold CloudPanel's placeholder page.
# Cloning into a non-empty directory needs this dance rather than git clone.
git init
git remote add origin https://github.com/samfaiz/DigitizerPress.git
git fetch origin main
git reset --hard origin/main
```

## 3. Configure

```bash
cp .env.example .env
chmod 600 .env          # it will hold your Anthropic key
nano .env
```

Set these. Everything else has a working default:

```ini
ANTHROPIC_API_KEY=sk-ant-...         # yours
LLM_PROVIDER=anthropic
ANTHROPIC_MODEL=claude-sonnet-5

# Not optional on a public domain. See "Read this first".
ACCESS_PASSWORD=pick-something-long

# Same origin, because nginx routes /api/ to the gateway on this same domain.
NEXT_PUBLIC_API_URL=https://digitizerpress.faisalkhan.cloud
CORS_ORIGIN=https://digitizerpress.faisalkhan.cloud

SCORER_BACKEND=transformer
SCORER_URL=http://127.0.0.1:8000
API_PORT=4000

# A VPS has no Apple GPU and usually no CUDA. Being explicit avoids torch
# probing for accelerators that are not there.
SCORER_FORCE_CPU=true
```

## 4. Build

```bash
cd /home/faisalkhan-digitizerpress/htdocs/digitizerpress.faisalkhan.cloud

# Full install, not --omit=dev: `next build` and `nest build` are dev
# dependencies and the build fails without them.
npm ci
npm run build

# The Python scorer. The transformer extra is the heavy one.
cd services/scorer
python3.11 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -e ".[transformer]"

# Pull the model now rather than on the first request, which would otherwise
# time out while it downloads.
.venv/bin/python -c "from transformers import AutoModelForCausalLM, AutoTokenizer; AutoTokenizer.from_pretrained('distilgpt2'); AutoModelForCausalLM.from_pretrained('distilgpt2')"
```

## 5. Start the services (as root)

```bash
cd /home/faisalkhan-digitizerpress/htdocs/digitizerpress.faisalkhan.cloud
cp deploy/*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now digitizerpress-scorer digitizerpress-api digitizerpress-web

systemctl status digitizerpress-scorer --no-pager
curl -s localhost:8000/health
curl -s localhost:4000/api/config | head -c 200
```

## 6. Point nginx at them

In CloudPanel: **Sites → digitizerpress.faisalkhan.cloud → Vhost**. Paste the
two `location` blocks from `deploy/nginx-vhost.conf` inside the existing
`server { }` block, replacing any default `location /`. Save, which reloads
nginx.

Then issue the certificate under **SSL/TLS → Let's Encrypt** if you have not.

## 7. Check it

```bash
curl -s https://digitizerpress.faisalkhan.cloud/api/config | head -c 200
# passwordRequired should be true

curl -s -o /dev/null -w "%{http_code}\n" https://digitizerpress.faisalkhan.cloud/api/library/brands
# 401, because no password was sent

curl -s -o /dev/null -w "%{http_code}\n" https://digitizerpress.faisalkhan.cloud/
# 200
```

Open the site, enter the password once, and generate something short to prove
the whole chain works before committing to a bulk run.

---

## Updating

```bash
su - faisalkhan-digitizerpress
cd /home/faisalkhan-digitizerpress/htdocs/digitizerpress.faisalkhan.cloud
git pull
npm ci && npm run build
exit
systemctl restart digitizerpress-api digitizerpress-web
```

Restart the scorer only when `services/scorer` changed; it takes a minute to
reload the model.

## When something is wrong

```bash
journalctl -u digitizerpress-api -n 100 --no-pager
journalctl -u digitizerpress-web -n 50 --no-pager
journalctl -u digitizerpress-scorer -n 50 --no-pager
```

- **Articles fail with "Scoring service is unavailable"** — the scorer died,
  most likely out of memory. Check `journalctl -u digitizerpress-scorer` and
  `dmesg | tail`. More RAM, or set `SCORER_BACKEND=heuristic` to drop torch
  entirely at the cost of real perplexity.
- **Generation returns 504** — nginx timed out. The `proxy_read_timeout` in the
  vhost is what prevents this; confirm it was pasted.
- **Every visitor shares one rate-limit bucket** — `X-Forwarded-For` is not
  reaching the gateway. Check that header line in the vhost.
- **Budget refusals** — expected. `MAX_COST_PER_ARTICLE` is enforced strictly
  and a 2,000-word article needs about $0.21. Raise the cap or use the bulk
  endpoint, which batches every phase at half price.

## Backups

Two directories hold work that cost money and are excluded from git:

- `.data/` saved brands and articles
- `.bulk/` bulk job records

```bash
tar czf ~/digitizerpress-$(date +%F).tar.gz .data .bulk .env
```

---

## If you really are on cPanel

Shared cPanel will not run this. "Setup Node.js App" can host the two Node
processes through Passenger, but there is no systemd, no way to run a
persistent Python service, and torch will not install inside the memory and
disk limits of a shared plan. The scorer is not optional: the API refuses to
start a bulk job without it and every article is scored several times.

If cPanel is the only option, the workable split is to run the scorer on a
separate small VPS, point `SCORER_URL` at it over a private network or an
allow-listed address, and accept that you are administering two machines. A
single 4 GB VPS with CloudPanel, which is what the path you gave me suggests
you already have, is simpler and cheaper.
