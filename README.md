# vitals

A personal field journal — Sankha Cooray's notes on intermittent fasting,
autophagy, lean-mass hyper-responder profile, and self-tracked metabolic
experiments.

Deployed at **[vitals.sankhacooray.com](https://vitals.sankhacooray.com)** via
GitHub Pages.

## Sections

1. **About** — quiet, long-running self-experiment
2. **What I Actually Do** — eating window, training, tracking
3. **Self-Studies from Lab Reports** — LMHR phenotype, glucose/HbA1c, body comp
4. **Working Beliefs** — autophagy, real food, n=1 learning

## Files

| File | Purpose |
|------|---------|
| `index.html` | Single-file site, all CSS inline |
| `CNAME` | GitHub Pages custom-domain pointer |

## Live data

The **Live Signal** section pulls a curated JSON snapshot from a private Apps
Script proxy (see `withings-body-scan/apps-script/` in the sclab workspace):

- **Body Scan** metrics render in `#live-data` (vitality, vascular age, rings).
- **ScanWatch 2** metrics render in `#watch-data` when the payload carries a
  `watch` block (sleep score/hours, night HR, respiratory rate, steps, SpO₂).
  Until then the section shows the "arrived · syncing up" teaser; JS flips it
  to a live grid automatically once watch data flows.

## Migration — Cloudflare Worker replaces the Apps Script

A Cloudflare Worker (`worker.js` + `wrangler.toml`) now serves this static site
**and** exposes the Withings broker at `GET /api/vitals`, replacing the Google
Apps Script proxy (`sclab/bodyscan-appscript`). `/api/vitals` returns the exact
same curated JSON the Apps Script's `doGet` did — snapshot by default,
`?trends=1` for the charts feed, `?export=csv|json` for the dataset, and an
optional `?callback=` for JSONP — so the front-end works unchanged after cutover.

### Deploy (scaffold)

```
npx wrangler deploy        # workers.dev only; serves the site immediately
```

It deploys and serves the site with **no KV and no secrets**. Until they exist,
`/api/vitals` returns `503 {error:"withings not configured"}` and `/api/health`
reports `withings:false` — the site is unaffected (it still calls the Apps
Script until DNS cutover).

### Enable `/api/vitals`

1. **KV** — our deploy token can't create namespaces. Create one in the
   Cloudflare dashboard (Workers & Pages → KV), paste its id into the
   `[[kv_namespaces]]` block in `wrangler.toml` (binding `HEALTH_KV`), uncomment.
2. **Client id** — set `WITHINGS_CLIENT_ID` in `[vars]` (copy from the Apps
   Script's Script Properties). Optionally set `BIRTHDATE` for the vascular-age
   delta.
3. **Secrets** — copy from the Apps Script's Script Properties:
   ```
   npx wrangler secret put WITHINGS_CLIENT_SECRET
   npx wrangler secret put WITHINGS_REFRESH_TOKEN   # seed; rotates into KV on first use
   ```
4. Redeploy. First `/api/vitals` refreshes the token, **persists the rotated
   refresh token to KV**, builds the snapshot, and caches it (~45 min TTL).

### DNS cutover

`health.sankhacooray.com` currently serves this repo via **GitHub Pages** (see
`CNAME`). When ready to move it to the Worker:

1. Switch the site's `VITALS_ENDPOINT` (in `index.html`) to `/api/vitals`
   (same-origin plain `fetch`; drop the Apps Script `/exec` URL).
2. Uncomment the `[[routes]] custom_domain` block for `health.sankhacooray.com`
   in `wrangler.toml` and redeploy (auto-provisions the DNS record).
3. Delete the GitHub-Pages DNS record for the host.
4. **Retire `bodyscan-appscript`** — it and the Worker cannot share a rotating
   Withings refresh token, so only one may run once the seed token is live here.

## Next steps

- [ ] Write up each self-study card (replace "write-up coming" links)
- [ ] Add a longitudinal chart (lipid panels / body comp) when data is ready
