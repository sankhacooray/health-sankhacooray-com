# health.sankhacooray.com — project memory

Personal "vitals" journal + live Withings data. Single-file site (`index.html`)
served by a Cloudflare Worker (`worker.js`, Worker name `health`) that also brokers
Withings. README.md covers endpoints, deploy commands and theming in detail;
this file holds the context and gotchas behind them.

## State (2026-10-25)

- Live Worker version `a95a16f7` (31 Oct 2026): contrast pass, Lighthouse a11y 100 in
  both themes (`--text-muted` dark #8a9177 / light #666c5c; light `--gold` #58721b,
  `--cyan` #975c17). Keep text tokens ≥4.5:1 on `--surface2`. Rollback: `npx wrangler rollback f0c79343`.
- Live Worker version `f0c79343` (31 Oct 2026): fasting copy is now 16:8 (ring arc,
  chips, protocol cards); hero live chips render as placeholders with a shimmer
  value until `/api/vitals` lands, plus a "live readings from Withings" note.
  Rollback: `npx wrangler rollback fb9d593b`.
- Live Worker version `fb9d593b` (ui-ux-style restyle, 25 Oct 2026): full-width app
  bar with scrollspy pills + "Collaborate on research" CTA, hero fasting-ring
  illustration with live chips, screen-fit groups (↑/↓ page), body-as-scroller,
  ambient particle canvas, tabbed Live Signal (Scale · Watch · Trends · Research,
  remembered in `localStorage` `vitals-live-tab`), one-line footer with the
  medical disclaimer behind ⓘ (the shared `sankha-footer.js` is no longer used),
  theme key moved to `sc-theme` (old `vitals-theme` still read once). Rollback:
  `npx wrangler rollback c3a2b722` (pre-restyle).
- Previous live version `c3a2b722` (filter side rail + viewport-fit chart) on top of `92521a76` (trends permalinks,
  `?metric&range&date#trends` — see README "Permalinks"). Previous live was
  `6036c6a0` (intraday + theme). Local only — not yet pushed to GitHub.
- Hourly cron `17 * * * *` is running clean (`GET /api/health` → `sync`);
  intraday backfill was 67/90 days and completes on its own.
- Rollback points: `npx wrangler rollback 8900e10f-dace-43e1-8bd8-0acc6797abfa`
  (intraday, pre-theme) · `b71cfde8-dbba-47d5-bf78-a1792db88cfa` (pre-intraday,
  old token handling) · git tag `stable-2026-10-05` (pre-intraday code).

## What was built (Oct 2026)

- **Sleep-bounded days.** Withings' daily steps reset at local midnight, so late
  walks home landed on the next day. The Worker pulls `getintradayactivity`
  samples (~1–2 min) and cuts days at **sleep onset** of the main sleep (≥3h,
  from sleep `getsummary`); fallback cut 04:00 local. Day status:
  `provisional` → `final` once the next night syncs (`fallback` if none).
  Real effect: Oct 1 2026 went 6,952 → 10,005 (+3,091 after midnight).
- **Day range** in "The longer view": hourly bars (asleep shaded, midnight line,
  after-midnight hours amber), sleep hypnogram, overnight HR line. Metrics with
  no hourly view are dimmed in Day mode; clicking one jumps back to Week.
- **Week/Month bars** for steps & distance are stacked hour slices (faint rules)
  with an amber after-midnight cap; click a bar → that day's hours.
- **Light/dark theme** switch in the app bar (tokens + `:root[data-theme=light]`).
- **Owner re-auth** route `/api/withings/auth?key=ADMIN_KEY`; access token cached
  in KV so cron + page requests don't race refresh-token rotation.

## Gotchas learned

- **Withings refresh token silently died ~2026-09-10**; the Worker kept serving
  stale KV cache for ~25 days with no visible error. If numbers look frozen,
  check `/api/vitals?intraday=probe` for `invalid refresh_token` and re-auth.
  Suspected cause: another client refreshing on the same Withings app/user
  invalidates the chain — don't run a second token holder (old Apps Script
  proxy `sclab/bodyscan-appscript`) against the same Withings app.
- `ADMIN_KEY` owner copy lives in `~/.config/health-sankhacooray/admin-key`.
  Never put secrets/keys in the repo: assets dir is the repo root (see
  `.assetsignore`), so stray files become public.
- Deploy via `wrangler versions upload` → check preview URL →
  `wrangler versions deploy <id>@100% --yes`. `wrangler secret put` and plain
  `wrangler deploy` push straight to production; use `wrangler versions secret put`.
  Cron changes need `wrangler triggers deploy`.
- Withings returns **no breathing-rate (rr)** samples and only sparse overnight
  HR (~44 pts/night) for this ScanWatch 2 — Resp-rate Day view shows an
  explanatory empty state, not a bug.
- Subrequest budget: one sync ≈ 23 Withings calls + snapshot/trends warm-up;
  keep under the 50/invocation free-plan limit when adding fetches
  (`BACKFILL_PER_RUN`, `RECENT_DAYS` in worker.js).
- Chart colours must come from `--ch-*` tokens (read in `readPalette()`), and
  inline SVG in live cards uses `style="stroke:var(--…)"` — SVG presentation
  attributes can't take `var()`.
- Shared footer (`cdn.sankhacooray.com/js/sankha-footer.js`) re-themes itself on
  `<html data-theme>` changes / `sc-themechange` — no work needed there.

## Testing without hitting Withings

Synthetic mock: serve `index.html` plus a fake `/api/vitals` (trends, intraday,
`day=` night detail) built with the real `buildIntradaySummary` from worker.js
(strip `export default`, re-export the helpers), then drive it with
puppeteer-core + system Chrome. Use a port outside the reserved 4710–4779 bands
(4493 worked). The Claude-in-Chrome extension wasn't connected last time.

## Ideas not done yet

- Use effective (sleep-bounded) steps in the Live Signal "Steps" card too (it
  still shows Withings' midnight total from `getactivity`).
- Withings Notify webhooks (appli 16 activity / 44 sleep) instead of hourly
  polling, for near-real-time correction after a sync.
- Push `main` + `feat/intraday-steps` to GitHub.
