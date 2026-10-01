# OmniSwap on the Qwilon VPS

Production runs at **https://omniswap.qwilon.com** on `148.113.237.230`, a shared
host that also serves a mail stack, several other nginx sites and two Docker
stacks. Everything below is scoped so it cannot disturb them.

```
ssh -i ~/.ssh/usecert_vps usecert@148.113.237.230
```

## Layout

| What | Where |
|---|---|
| Checkout | `/opt/omniswap/app` (branch `main`, a deploy target — never edit here) |
| Deploy script | `/opt/omniswap/deploy.sh` |
| Deploy log | `/opt/omniswap/deploy.log` |
| Secrets | `/etc/usecert/omniswap.env` (root-owned, `0600`) |
| App log | `/var/log/usecert/omniswap.log` |
| Cron log | `/var/log/usecert/omniswap-cron.log` |
| nginx site | `/etc/nginx/sites-available/omniswap.qwilon.com` |
| Service | `omniswap-web.service` → `127.0.0.1:3000` |
| Timers | `omniswap-check-alerts.timer`, `omniswap-check-orders.timer` (every 5 min) |

Postgres is **local**: database `omniswap`, role `omniswap`, on the host's
PostgreSQL 18 cluster at `127.0.0.1:5432`. There is no remote Supabase or Neon
dependency.

## Deploying

```bash
/opt/omniswap/deploy.sh
```

It pulls `origin/main`, installs, runs `prisma migrate deploy`, rebuilds and
restarts the service, then waits for `/api/health` to come back green. It exits
non-zero and prints the unit status if the app does not recover.

`git reset --hard origin/main` is part of it: the server checkout is a deploy
target, so any local change there is discarded.

## Things worth knowing

- **Build from the repo root, not `apps/web`.** `apps/web` depends on the
  `@omniswap/shared` and `@omniswap/types` workspace packages; turbo's `^build`
  builds those first. Building inside `apps/web` fails with
  `Cannot find module '@omniswap/types'`.
- **`--force` on the turbo build is deliberate.** `turbo.json` does not list the
  `NEXT_PUBLIC_*` variables in its env hash, so without it a cached `.next`
  would keep stale values inlined after an env change.
- **pnpm hoists everything to the repo-root `node_modules`** on this project, so
  the service runs `/opt/omniswap/app/node_modules/next/dist/bin/next`, not a
  binary under `apps/web`.
- **nginx `limit_req_zone` names are global on this host.** Every zone in the
  OmniSwap site is prefixed `oms_` so it cannot collide with the `yam_*`,
  `qwilon_*` or `signer_*` zones other sites declare.
- **The cron routes are `POST`.** A `GET` returns 405.
- **Deploys rebuild `.next` in place** while the service is serving from it.
  There is a few-second window where a page load can miss a chunk. Acceptable at
  the current traffic level; a blue/green release directory is the fix if that
  stops being true.

## Secrets

`/etc/usecert/omniswap.env` holds them all. Generated fresh for this host:
`JWT_SECRET`, `ADMIN_SESSION_SECRET`, `USER_SESSION_SECRET`, `CRON_SECRET`,
`ADMIN_PASSWORD_HASH`. API keys and RPC URLs were carried over from the previous
config.

Telegram operator alerts are configured and verified end to end: the bot posts
to the `CF` supergroup (`TELEGRAM_CHAT_ID` is set on the host and as a GitHub
Actions secret, so both the app and `monitor.yml` can reach it).

Still blank, each disabling one optional feature:

| Variable | What stays off without it |
|---|---|
| `RESEND_API_KEY`, `ALERT_EMAIL_FROM` | Price-alert emails (alerts still fire in-app) |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect; injected wallets still work |
| `NEXT_PUBLIC_0X_API_KEY` | The 0x fallback quote; 1inch is primary and configured |

Custom RPC endpoints use the key names in `apps/web/src/config/chains.json`
(`NEXT_PUBLIC_ETH_RPC`, `NEXT_PUBLIC_BASE_RPC`, …), not the `*_RPC_URL` names.
They are `NEXT_PUBLIC_`, so the URL ships to browsers — do not put a keyed
provider URL (Alchemy, Infura) in one.

After changing anything in that file, re-run the deploy script: the
`NEXT_PUBLIC_*` values are inlined at build time, so a restart alone is not
enough.

## Health

```bash
curl https://omniswap.qwilon.com/api/health
```

Reports the database, the alert-cron heartbeat and which optional config is
present. Returns 503 when degraded. `monitor.yml` in GitHub Actions polls it
from outside the host and notifies Telegram on state transitions.
