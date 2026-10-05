/**
 * health — Cloudflare Worker: serves the static site AND a Withings data broker.
 * ---------------------------------------------------------------------------
 * Replaces the standalone Google Apps Script proxy (sclab/bodyscan-appscript)
 * that health.sankhacooray.com currently calls for its "Live Signal" section.
 *
 * The Worker:
 *   1. Serves the static site from ./ via the ASSETS binding (everything that
 *      isn't /api/*).
 *   2. Brokers Withings server-side: holds client_id (var) + client_secret &
 *      the seed refresh_token (secrets), refreshes the access token, and — the
 *      critical bit — persists the ROTATED refresh token back to KV, because
 *      Withings single-uses and invalidates the old one on every refresh.
 *   3. Pulls body-composition measures + ScanWatch sleep/activity/SpO2, curates
 *      them into the SAME JSON shape the Apps Script's doGet returned, caches
 *      the snapshot in KV, and serves it at GET /api/vitals.
 *
 * Endpoints:
 *   GET /api/health   -> { ok, app, withings }
 *   GET /api/vitals   -> curated snapshot   (default)
 *   GET /api/vitals?trends=1   -> full-resolution trends feed (site charts)
 *   GET /api/vitals?trends=fresh -> force a trends rebuild
 *   GET /api/vitals?export=csv|json -> researcher dataset export
 *   GET /api/vitals?intraday=1 -> hourly bands per sleep-bounded day
 *   GET /api/vitals?intraday=1&day=YYYY-MM-DD -> one day + that night's stages/HR/RR
 *   GET /api/vitals?intraday=refresh -> pull new intraday data now (throttled)
 *   GET /api/vitals?intraday=probe[&day=..] -> raw sample peek (debug)
 *   GET /api/withings/auth?key=ADMIN_KEY -> owner re-consent (fresh refresh token)
 *   GET /api/vitals?callback=fn -> JSONP-wrap any of the above (default: JSON)
 *
 * Cron (hourly, see wrangler.toml): syncs intraday data and pre-warms the
 * snapshot/trends caches; last run status lands in KV `sync:last`.
 *
 * Scaffold contract: with no KV binding and/or no Withings config it degrades
 * gracefully — /api/health reports withings:false, /api/vitals returns 503
 * {error:"withings not configured"} — so it deploys and serves the site BEFORE
 * any secrets/KV exist. The live GitHub-Pages site keeps calling the Apps
 * Script until DNS cutover (see README.md).
 */

// ── HTTP helpers ─────────────────────────────────────────────────────
const CT_JSON = "application/json";
const CT_JS = "application/javascript";
const CT_CSV = "text/csv";

/** JSON (or JSONP if `callback`) response with an optional cache-control. */
function reply(obj, { status = 200, callback = null, cache = "no-store", mime = null } = {}) {
  const json = JSON.stringify(obj);
  if (callback) {
    return new Response(sanitizeCb(callback) + "(" + json + ");",
      { status, headers: { "content-type": CT_JS, "cache-control": cache } });
  }
  return new Response(json, { status, headers: { "content-type": mime || CT_JSON, "cache-control": cache } });
}
/** JSONP callback names are attacker-controllable — keep to a safe identifier. */
function sanitizeCb(cb) { return /^[A-Za-z_$][\w$.]{0,63}$/.test(cb) ? cb : "callback"; }

/** URL-encoded form body from a plain object (skips null/undefined). */
function form(obj) {
  const p = new URLSearchParams();
  for (const k in obj) if (obj[k] != null) p.set(k, String(obj[k]));
  return p;
}

const nowSec = () => Math.floor(Date.now() / 1000);
function round(n, d) { const f = Math.pow(10, d || 0); return Math.round(n * f) / f; }
function pct(part, whole) { if (!part || !whole) return null; return round((part / whole) * 100, 1); }
function ymd(d) { return new Date(d).toISOString().slice(0, 10); }
function isoDay(epoch) { return new Date(epoch * 1000).toISOString().slice(0, 10); }

// ── Withings config ──────────────────────────────────────────────────
const TOKEN_URL = "https://wbsapi.withings.net/v2/oauth2";
const MEASURE_URL = "https://wbsapi.withings.net/measure";           // getmeas
const SLEEP_URL = "https://wbsapi.withings.net/v2/sleep";           // getsummary
const MEASURE_V2_URL = "https://wbsapi.withings.net/v2/measure";    // getactivity

// Measure type IDs (value = raw * 10^unit).
const T = {
  WEIGHT: 1, FAT_RATIO: 6, HEART_PULSE: 11, SPO2: 54, MUSCLE_MASS: 76,
  HYDRATION: 77, VO2MAX: 123, VASCULAR_AGE: 155, VISCERAL_FAT: 174,
};
const REQUEST_TYPES = [T.WEIGHT, T.FAT_RATIO, T.HEART_PULSE, T.SPO2, T.MUSCLE_MASS,
  T.HYDRATION, T.VO2MAX, T.VASCULAR_AGE, T.VISCERAL_FAT];

const HISTORY_DAYS = 365;   // measure look-back for trend sparklines
const WATCH_DAYS = 90;      // sleep/activity look-back for the watch layer + trends
const SERIES_MAX = 30;      // max points per metric in the snapshot
const SNAPSHOT_TTL = 45 * 60;   // serve a cached snapshot up to ~45 min old

// Curated scale metrics — [key, label, unit, band, goodLow, derive(vals)].
const METRICS = [
  ["bodyFat", "Body fat", "%", [8, 20], true, (v) => v[T.FAT_RATIO]],
  ["muscle", "Muscle", "%", [38, 50], false, (v) => pct(v[T.MUSCLE_MASS], v[T.WEIGHT])],
  ["hydration", "Hydration", "%", [50, 65], false, (v) => pct(v[T.HYDRATION], v[T.WEIGHT])],
  ["visceralFat", "Visceral fat", "idx", [1, 12], true, (v) => v[T.VISCERAL_FAT]],
  ["vo2max", "VO₂ max", "ml/kg·min", [35, 60], false, (v) => v[T.VO2MAX]],
  ["restingHr", "Resting HR", "bpm", [40, 70], true, (v) => v[T.HEART_PULSE]],
];

// Watch (ScanWatch 2) sleep metrics — [key, label, unit, band, goodLow, derive(d)].
const WATCH_SLEEP_METRICS = [
  ["sleepScore", "Sleep score", "/100", [70, 100], false, (d) => d.sleep_score],
  ["sleepHours", "Sleep", "h", [7, 9], false, (d) => {
    const s = d.total_sleep_time ||
      ((d.deepsleepduration || 0) + (d.lightsleepduration || 0) + (d.remsleepduration || 0));
    return s ? s / 3600 : null;
  }],
  ["nightHr", "Night heart rate", "bpm", [40, 65], true, (d) => d.hr_average],
  ["respRate", "Respiratory rate", "br/min", [12, 20], true, (d) => d.rr_average],
];

// ── config predicate ─────────────────────────────────────────────────
function withingsConfigured(env) {
  const cid = env.WITHINGS_CLIENT_ID || "";
  const hasId = !!cid && cid.indexOf("REPLACE") === -1;
  const hasSecret = !!env.WITHINGS_CLIENT_SECRET;
  const hasSeed = !!env.HEALTH_KV || !!env.WITHINGS_REFRESH_TOKEN;   // KV may hold a rotated token
  return hasId && hasSecret && hasSeed;
}

// ── token: refresh with rotation, persisted back to KV ───────────────
// The access token (~3h life) is cached in KV so the hourly cron and page
// requests share one instead of each rotating the refresh token — two racing
// refreshes would invalidate each other's token.
async function getAccessToken(env) {
  const cachedTok = await kvGetJson(env, "access_token");
  if (cachedTok && cachedTok.t && cachedTok.exp - nowSec() > 300) return cachedTok.t;

  // Current refresh token: KV (rotated) first, seed secret on first run.
  let refresh = null;
  try { refresh = await env.HEALTH_KV.get("refresh_token"); } catch (e) { /* KV read best-effort */ }
  if (!refresh) refresh = env.WITHINGS_REFRESH_TOKEN || null;
  if (!refresh) throw new Error("no refresh token (seed WITHINGS_REFRESH_TOKEN)");

  const body = form({
    action: "requesttoken",
    grant_type: "refresh_token",
    client_id: env.WITHINGS_CLIENT_ID,
    client_secret: env.WITHINGS_CLIENT_SECRET,
    refresh_token: refresh,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const d = await r.json().catch(() => ({}));
  if (d.status !== 0 || !d.body || !d.body.access_token) {
    throw new Error("refresh failed: status=" + d.status + (d.error ? " " + d.error : ""));
  }
  // Persist the ROTATED refresh token — Withings invalidates the one just used.
  if (d.body.refresh_token) {
    try { await env.HEALTH_KV.put("refresh_token", d.body.refresh_token); } catch (e) { /* best-effort */ }
  }
  await kvPutJson(env, "access_token", { t: d.body.access_token, exp: nowSec() + (d.body.expires_in || 10800) });
  return d.body.access_token;
}

/** Authorized POST to a Withings endpoint; returns the parsed body object. */
async function apiPost(url, params, token) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Bearer " + token,
    },
    body: form(params),
  });
  return r.json().catch(() => ({}));
}

// ── Withings data pulls (mirror Code.gs params/windows) ──────────────
async function fetchMeasureGroups(token) {
  const startdate = nowSec() - HISTORY_DAYS * 86400;
  const data = await apiPost(MEASURE_URL, {
    action: "getmeas",
    meastypes: REQUEST_TYPES.join(","),
    category: "1",
    startdate: String(startdate),
  }, token);
  if (data.status !== 0) throw new Error("getmeas failed: " + data.status);
  const groups = ((data.body && data.body.measuregrps) || []).map((g) => {
    const vals = {};
    (g.measures || []).forEach((m) => { vals[m.type] = m.value * Math.pow(10, m.unit); });
    return { date: g.date, vals };
  });
  groups.sort((a, b) => a.date - b.date);   // oldest -> newest
  return groups;
}

async function fetchSleepNights(token) {
  const end = Date.now();
  const start = end - WATCH_DAYS * 86400 * 1000;
  const data = await apiPost(SLEEP_URL, {
    action: "getsummary",
    startdateymd: ymd(start),
    enddateymd: ymd(end),
    data_fields: "sleep_score,total_sleep_time,deepsleepduration,lightsleepduration," +
      "remsleepduration,wakeupduration,hr_average,hr_min,rr_average",
  }, token);
  if (data.status !== 0) throw new Error("sleep getsummary failed: " + data.status);
  const nights = ((data.body && data.body.series) || []).map((s) => ({
    date: s.enddate || s.startdate, data: s.data || {},
  }));
  nights.sort((a, b) => a.date - b.date);
  return nights;
}

async function fetchActivityDays(token) {
  const end = Date.now();
  const start = end - WATCH_DAYS * 86400 * 1000;
  const data = await apiPost(MEASURE_V2_URL, {
    action: "getactivity",
    startdateymd: ymd(start),
    enddateymd: ymd(end),
    data_fields: "steps,distance,totalcalories,hr_average,moderate,intense",
  }, token);
  if (data.status !== 0) throw new Error("getactivity failed: " + data.status);
  const days = ((data.body && data.body.activities) || [])
    .filter((a) => a.steps > 0)   // drop empty placeholder days
    .map((a) => ({
      // anchor at local-ish noon so the epoch lands on the right calendar day
      date: Math.floor(new Date(a.date + "T12:00:00Z").getTime() / 1000), a,
    }));
  days.sort((a, b) => a.date - b.date);
  return days;
}

// ── curated payload (mirrors buildCuratedPayload_) ───────────────────
function lastValue(groups, typeId) {
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].vals[typeId] !== undefined) return groups[i].vals[typeId];
  }
  return null;
}
function weekStart(epochSec) {
  const d = new Date(epochSec * 1000);
  const day = (d.getUTCDay() + 6) % 7;   // Monday = 0
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - day * 86400 * 1000;
}
function weekKey(epochSec) { return String(weekStart(epochSec)); }
function consecutiveWeeks(groups) {
  const weeks = {};
  groups.forEach((g) => { weeks[weekKey(g.date)] = true; });
  let cursor = weekStart(groups[groups.length - 1].date);
  let streak = 0;
  while (weeks[weekKey(cursor / 1000)]) { streak++; cursor -= 7 * 86400 * 1000; }
  return streak;
}
function vitalityScore(metrics) {
  const keys = Object.keys(metrics);
  let sum = 0, n = 0;
  keys.forEach((k) => {
    const m = metrics[k], lo = m.band[0], hi = m.band[1], v = m.value;
    let s;
    if (v <= lo) s = m.goodLow ? 100 : 40;
    else if (v >= hi) s = m.goodLow ? 40 : 100;
    else { const frac = (v - lo) / (hi - lo); s = Math.round((m.goodLow ? (1 - frac) : frac) * 60 + 40); }
    sum += s; n++;
  });
  return n ? Math.round(sum / n) : null;
}
function computeAge(birthdate) {
  if (!birthdate) return null;
  const b = new Date(birthdate);
  if (isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age;
}
/** Fold a {t,v} series into the public metric shape (or null if empty). */
function metricFromSeries(label, unit, band, goodLow, series) {
  if (!series.length) return null;
  series = series.slice(-SERIES_MAX);
  const current = series[series.length - 1];
  const prev = series.length > 1 ? series[0] : current;
  return { label, unit, band, goodLow, value: current.v, trend: round(current.v - prev.v, 1), series };
}

function buildWatchPayload(groups, nights, days) {
  const metrics = {};

  WATCH_SLEEP_METRICS.forEach((def) => {
    const series = [];
    nights.forEach((n) => {
      const v = def[5](n.data);
      if (v !== null && v !== undefined && !isNaN(v)) series.push({ t: n.date, v: round(v, 1) });
    });
    const m = metricFromSeries(def[1], def[2], def[3], def[4], series);
    if (m) metrics[def[0]] = m;
  });

  const steps = metricFromSeries("Steps", "/day", [7000, 12000], false,
    days.map((d) => ({ t: d.date, v: d.a.steps })));
  if (steps) { steps.trend = Math.round(steps.trend); metrics.steps = steps; }

  const spo2Series = [];
  groups.forEach((g) => {
    if (g.vals[T.SPO2] !== undefined) spo2Series.push({ t: g.date, v: round(g.vals[T.SPO2], 0) });
  });
  const spo2 = metricFromSeries("Blood oxygen", "%", [95, 100], false, spo2Series);
  if (spo2) metrics.spo2 = spo2;

  const keys = Object.keys(metrics);
  if (!keys.length) return null;
  let lastSync = 0;
  keys.forEach((k) => { const s = metrics[k].series; lastSync = Math.max(lastSync, s[s.length - 1].t); });
  return { metrics, lastSync };
}

async function buildSnapshot(env, token) {
  const groups = await fetchMeasureGroups(token);
  if (!groups.length) return { ok: false, error: "no-data", updated: nowSec() };

  const out = { ok: true, updated: nowSec(), metrics: {} };

  METRICS.forEach((def) => {
    const key = def[0], derive = def[5];
    let series = [];
    groups.forEach((g) => {
      const val = derive(g.vals);
      if (val !== null && val !== undefined && !isNaN(val)) series.push({ t: g.date, v: round(val, 1) });
    });
    if (!series.length) return;
    series = series.slice(-SERIES_MAX);
    const current = series[series.length - 1];
    const prev = series.length > 1 ? series[0] : current;
    out.metrics[key] = {
      label: def[1], unit: def[2], band: def[3], goodLow: def[4],
      value: current.v, trend: round(current.v - prev.v, 1), series,
    };
  });

  // Vascular age vs. calendar age (BIRTHDATE optional — set as a Worker var).
  const realAge = computeAge(env.BIRTHDATE);
  const lastVasc = lastValue(groups, T.VASCULAR_AGE);
  if (lastVasc !== null) {
    out.vascularAge = {
      label: "Vascular age", value: Math.round(lastVasc), realAge,
      delta: realAge ? Math.round(lastVasc) - realAge : null,
    };
  } else if (realAge) {
    out.vascularAge = { realAge };
  }

  out.lastMeasured = groups[groups.length - 1].date;
  out.streakWeeks = consecutiveWeeks(groups);
  out.vitalityScore = vitalityScore(out.metrics);

  // Watch layer — soft-fail so the scale payload never breaks.
  try {
    const [nights, days] = await Promise.all([fetchSleepNights(token), fetchActivityDays(token)]);
    const watch = buildWatchPayload(groups, nights, days);
    if (watch) out.watch = watch;
  } catch (err) {
    out.watchError = String(err && err.message || err);
  }
  return out;
}

// ── trends feed (mirrors buildTrendsPayload_) ────────────────────────
function secToH(s) { return s ? round(s / 3600, 2) : 0; }

async function buildTrends(token) {
  const nights = await fetchSleepNights(token);
  const sleep = { days: [], deep: [], light: [], rem: [], awake: [], score: [], hours: [], hrAvg: [], hrMin: [], rr: [] };
  nights.forEach((n) => {
    const d = n.data;
    const total = d.total_sleep_time
      ? d.total_sleep_time / 3600
      : ((d.deepsleepduration || 0) + (d.lightsleepduration || 0) + (d.remsleepduration || 0)) / 3600;
    sleep.days.push(n.date);
    sleep.deep.push(secToH(d.deepsleepduration));
    sleep.light.push(secToH(d.lightsleepduration));
    sleep.rem.push(secToH(d.remsleepduration));
    sleep.awake.push(secToH(d.wakeupduration));
    sleep.score.push(d.sleep_score != null ? d.sleep_score : null);
    sleep.hours.push(total ? round(total, 2) : null);
    sleep.hrAvg.push(d.hr_average != null ? Math.round(d.hr_average) : null);
    sleep.hrMin.push(d.hr_min != null ? Math.round(d.hr_min) : null);
    sleep.rr.push(d.rr_average != null ? round(d.rr_average, 1) : null);
  });

  const days = await fetchActivityDays(token);
  const steps = { days: [], v: [], distance: [], calories: [], hrAvg: [], active: [] };
  days.forEach((r) => {
    const a = r.a;
    steps.days.push(r.date);
    steps.v.push(a.steps);
    steps.distance.push(a.distance != null ? round(a.distance / 1000, 2) : null);
    steps.calories.push(a.totalcalories != null ? Math.round(a.totalcalories) : null);
    steps.hrAvg.push(a.hr_average != null ? Math.round(a.hr_average) : null);
    steps.active.push(Math.round(((a.moderate || 0) + (a.intense || 0)) / 60));
  });

  return { ok: true, updated: nowSec(), windowDays: WATCH_DAYS, sleep, steps };
}

// ── dataset export (mirrors exportData_) ─────────────────────────────
function csvEscape(c) { const s = String(c); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

async function buildExportCsv(token) {
  const rows = [["source", "metric", "unit", "date", "epoch", "value"]];
  const groups = await fetchMeasureGroups(token);
  METRICS.forEach((def) => {
    groups.forEach((g) => {
      const v = def[5](g.vals);
      if (v !== null && v !== undefined && !isNaN(v)) rows.push(["bodyscan", def[1], def[2], isoDay(g.date), g.date, round(v, 1)]);
    });
  });
  groups.forEach((g) => {
    if (g.vals[T.SPO2] !== undefined) rows.push(["scanwatch", "Blood oxygen", "%", isoDay(g.date), g.date, round(g.vals[T.SPO2], 0)]);
  });
  try {
    const nights = await fetchSleepNights(token);
    WATCH_SLEEP_METRICS.forEach((def) => {
      nights.forEach((n) => {
        const v = def[5](n.data);
        if (v !== null && v !== undefined && !isNaN(v)) rows.push(["scanwatch", def[1], def[2], isoDay(n.date), n.date, round(v, 1)]);
      });
    });
    const STAGES = [["Deep sleep", "deepsleepduration"], ["Light sleep", "lightsleepduration"], ["REM sleep", "remsleepduration"], ["Awake", "wakeupduration"]];
    STAGES.forEach((st) => {
      nights.forEach((n) => {
        const sec = n.data[st[1]];
        if (sec !== null && sec !== undefined && !isNaN(sec)) rows.push(["scanwatch", st[0], "h", isoDay(n.date), n.date, secToH(sec)]);
      });
    });
    const days = await fetchActivityDays(token);
    days.forEach((d) => { rows.push(["scanwatch", "Steps", "/day", isoDay(d.date), d.date, d.a.steps]); });
  } catch (err) { /* watch layer unavailable — export scale data only */ }
  return rows.map((r) => r.map(csvEscape).join(",")).join("\n");
}

// ── KV cache helpers ─────────────────────────────────────────────────
async function kvGetJson(env, key) {
  try { const raw = await env.HEALTH_KV.get(key); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}
async function kvPutJson(env, key, obj) {
  try { await env.HEALTH_KV.put(key, JSON.stringify(obj)); } catch (e) { /* best-effort */ }
}

// ── intraday: hourly bands + sleep-bounded "effective day" ───────────
// Withings' daily totals reset at local midnight, so a walk home at 00:40
// lands on the next day. Instead we pull the high-frequency samples
// (getintradayactivity) and cut days at SLEEP ONSET: day D runs from the
// onset of the night that ends on D's morning to the onset of the next main
// sleep. With no sleep recorded the cut falls back to 04:00 local.
//
// KV layout:
//   raw:YYYY-MM-DD    one local calendar day of samples [[ts, steps, m, kcal]]
//   night:YYYY-MM-DD  sleep stages + HR/RR for the night ending that morning
//   intraday:meta     { raw: {date: fetchedAt}, night: {...} } fetch ledger
//   intraday          summary served to the site (per-day hourly bands)
const INTRADAY_DAYS = 90;       // window kept in the summary
const RECENT_DAYS = 3;          // always re-pulled (late watch syncs)
const BACKFILL_PER_RUN = 8;     // older days fetched per run (subrequest budget)
const FALLBACK_CUT_H = 4;       // day boundary when no sleep was recorded
const MAIN_SLEEP_MIN = 3 * 3600;        // shorter sleeps are naps, not boundaries
const MAX_DAY_HOURS = 40;       // guard against runaway windows
const SYNC_MIN_GAP = 5 * 60;    // on-demand refresh throttle

/** Seconds east of UTC for `tz` at `epoch` (0 if the zone is unknown). */
function tzOffsetSec(tz, epoch) {
  try {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(epoch * 1000));
    const g = (t) => Number(p.find((x) => x.type === t).value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) / 1000 - epoch;
  } catch (e) { return 0; }
}
function localYmd(epoch, tz) { return isoDay(epoch + tzOffsetSec(tz, epoch)); }
function addDays(date, n) { return isoDay(Date.parse(date + "T00:00:00Z") / 1000 + n * 86400); }
function localMidnight(date, tz) {
  const guess = Date.parse(date + "T00:00:00Z") / 1000;
  return guess - tzOffsetSec(tz, guess - tzOffsetSec(tz, guess));
}

/** Main sleep per wake date: { date: {start, end, tz} } (longest ≥ 3h wins). */
async function fetchSleepWindows(call, days, defaultTz) {
  const out = {};
  let tz = null, offset = 0;
  for (let page = 0; page < 4; page++) {
    const data = await call(SLEEP_URL, {
      action: "getsummary",
      startdateymd: ymd(Date.now() - days * 86400 * 1000),
      enddateymd: ymd(Date.now() + 86400 * 1000),
      data_fields: "total_sleep_time",
      offset: offset || null,
    });
    if (data.status !== 0) throw new Error("sleep getsummary failed: " + data.status);
    const body = data.body || {};
    (body.series || []).forEach((s) => {
      if (!s.startdate || !s.enddate) return;
      const len = s.enddate - s.startdate;
      if (len < MAIN_SLEEP_MIN) return;
      const z = s.timezone || defaultTz;
      if (z) tz = z;
      const date = localYmd(s.enddate, z);
      if (!out[date] || len > out[date].end - out[date].start) out[date] = { start: s.startdate, end: s.enddate, tz: z };
    });
    if (!body.more) break;
    offset = body.offset;
  }
  return { nights: out, tz };
}

/** One local calendar day of intraday samples, compacted. */
async function fetchIntradayDay(call, date, tz) {
  const start = localMidnight(date, tz), end = localMidnight(addDays(date, 1), tz);
  const data = await call(MEASURE_V2_URL, {
    action: "getintradayactivity",
    startdate: start, enddate: end - 1,   // >24h spans are silently truncated
    data_fields: "steps,distance,calories",
  });
  if (data.status !== 0) throw new Error("getintradayactivity failed: " + data.status);
  const series = (data.body && data.body.series) || {};
  const s = [];
  Object.keys(series).forEach((k) => {
    const v = series[k] || {}, ts = Number(k);
    const st = v.steps || 0, m = v.distance || 0, kc = v.calories || 0;
    if (ts >= start && ts < end && (st || m || kc)) s.push([ts, st, round(m, 1), round(kc, 2)]);
  });
  s.sort((a, b) => a[0] - b[0]);
  return { d: date, tz, s };
}

/** Sleep stages + HR/RR for one night (bounded by its summary window). */
async function fetchNightDetail(call, date, night) {
  const data = await call(SLEEP_URL, {
    action: "get",
    startdate: night.start - 600, enddate: Math.min(night.end + 600, night.start - 600 + 86400),
    data_fields: "hr,rr",
  });
  if (data.status !== 0) throw new Error("sleep get failed: " + data.status);
  const seg = [], hr = [], rr = [];
  ((data.body && data.body.series) || []).forEach((x) => {
    if (x.startdate && x.enddate) seg.push([x.startdate, x.enddate, x.state]);
    const pick = (obj, dst) => { if (obj) Object.keys(obj).forEach((k) => { if (obj[k] != null) dst.push([Number(k), obj[k]]); }); };
    pick(x.hr, hr); pick(x.rr, rr);
  });
  const byTs = (a, b) => a[0] - b[0];
  seg.sort(byTs); hr.sort(byTs); rr.sort(byTs);
  return { d: date, start: night.start, end: night.end, off: tzOffsetSec(night.tz, night.start), seg, hr, rr };
}

/** Split the sample timeline into sleep-bounded days with hourly bands. */
function buildIntradaySummary(dates, raws, nights, tz) {
  const days = {};
  const now = nowSec();
  dates.forEach((D) => {
    const raw = raws[D];
    if (!raw) return;
    const z = (nights[D] && nights[D].tz) || raw.tz || tz;
    const fallbackStart = localMidnight(D, z) + FALLBACK_CUT_H * 3600;
    const nextMidnight = localMidnight(addDays(D, 1), z);
    const fallbackEnd = nextMidnight + FALLBACK_CUT_H * 3600;
    let start = nights[D] ? nights[D].start : fallbackStart;
    const nextNight = nights[addDays(D, 1)];
    let end = nextNight ? nextNight.start : fallbackEnd;
    if (end <= start || end - start > MAX_DAY_HOURS * 3600) { start = fallbackStart; end = fallbackEnd; }
    const status = nextNight ? "final" : (now > fallbackEnd + 12 * 3600 ? "fallback" : "provisional");

    const off = tzOffsetSec(z, start);
    const h0 = Math.floor((start + off) / 3600) * 3600 - off;
    const nH = Math.min(MAX_DAY_HOURS, Math.ceil((end - h0) / 3600));
    const steps = new Array(nH).fill(0), dist = new Array(nH).fill(0), cal = new Array(nH).fill(0);
    let am = 0;
    [addDays(D, -1), D, addDays(D, 1)].forEach((k) => {
      const r = raws[k];
      if (!r) return;
      r.s.forEach((x) => {
        if (x[0] < start || x[0] >= end) return;
        const i = Math.floor((x[0] - h0) / 3600);
        if (i < 0 || i >= nH) return;
        steps[i] += x[1]; dist[i] += x[2]; cal[i] += x[3];
        if (x[0] >= nextMidnight) am += x[1];
      });
    });
    const sum = (a) => a.reduce((p, c) => p + c, 0);
    const calendarSteps = raw.s.reduce((p, x) => p + x[1], 0);
    const tot = sum(steps);
    if (!tot && !calendarSteps) return;
    days[D] = {
      s: start, e: end, st: status, h0, off,
      w: nights[D] && nights[D].start === start ? nights[D].end : null,   // woke up (null: no sleep recorded)
      steps, dist: dist.map((m) => Math.round(m)), cal: cal.map((c) => Math.round(c)),
      tot: { steps: tot, dist: Math.round(sum(dist)), cal: Math.round(sum(cal)) },
      cal0: calendarSteps,    // midnight-to-midnight count (what Withings shows)
      am,                     // steps after midnight credited to this day
      night: !!nights[D],
      partial: !raws[addDays(D, 1)] && end > nextMidnight && end < now,
    };
  });
  return days;
}

/**
 * Pull new/changed intraday + sleep data and rebuild the summary.
 * `call` counts subrequests so one run stays inside the Workers budget.
 */
async function syncIntraday(env, token) {
  let calls = 0;
  const call = (url, params) => { calls++; return apiPost(url, params, token); };
  const meta = (await kvGetJson(env, "intraday:meta")) || { raw: {}, night: {} };
  const errors = [];

  const { nights, tz: seenTz } = await fetchSleepWindows(call, INTRADAY_DAYS + 5, meta.tz || env.HOME_TZ);
  const tz = seenTz || meta.tz || env.HOME_TZ || "UTC";
  meta.tz = tz;
  const today = localYmd(nowSec(), tz);
  const dates = [];
  for (let i = INTRADAY_DAYS - 1; i >= 0; i--) dates.push(addDays(today, -i));

  // Raw activity: recent days every run, then backfill newest-missing first.
  const recent = dates.slice(-RECENT_DAYS);
  const missing = dates.filter((d) => !meta.raw[d] && recent.indexOf(d) === -1).reverse().slice(0, BACKFILL_PER_RUN);
  for (const d of recent.concat(missing)) {
    try {
      const raw = await fetchIntradayDay(call, d, (nights[d] && nights[d].tz) || tz);
      await kvPutJson(env, "raw:" + d, raw);
      meta.raw[d] = nowSec();
    } catch (err) { errors.push(d + ": " + (err.message || err)); }
  }

  // Night detail (stages/HR/RR) for nights the summary knows about.
  const nightDates = Object.keys(nights).filter((d) => dates.indexOf(d) !== -1);
  const recentNights = nightDates.filter((d) => recent.indexOf(d) !== -1);
  const missingNights = nightDates.filter((d) => !meta.night[d] && recent.indexOf(d) === -1)
    .sort().reverse().slice(0, BACKFILL_PER_RUN);
  for (const d of recentNights.concat(missingNights)) {
    try {
      await kvPutJson(env, "night:" + d, await fetchNightDetail(call, d, nights[d]));
      meta.night[d] = nowSec();
    } catch (err) { errors.push("night " + d + ": " + (err.message || err)); }
  }

  // Rebuild from everything stored (one extra day either side for the cut).
  const raws = {};
  const span = [addDays(dates[0], -1)].concat(dates);
  await Promise.all(span.map(async (d) => { if (meta.raw[d]) raws[d] = await kvGetJson(env, "raw:" + d); }));
  const days = buildIntradaySummary(dates, raws, nights, tz);

  // Trim the ledger to the window so it can't grow forever.
  [meta.raw, meta.night].forEach((m) => Object.keys(m).forEach((d) => { if (d < span[0]) delete m[d]; }));
  meta.lastSync = nowSec();
  await kvPutJson(env, "intraday:meta", meta);
  const summary = {
    ok: true, updated: nowSec(), tz, cutHour: FALLBACK_CUT_H, days,
    backfill: { have: dates.filter((d) => meta.raw[d]).length, of: dates.length },
    calls, errors: errors.slice(0, 10),
  };
  await kvPutJson(env, "intraday", summary);
  return summary;
}

/** Debug: a peek at the raw API shapes for one day (never cached). */
async function intradayProbe(token, date, tz) {
  const call = (url, params) => apiPost(url, params, token);
  const raw = await fetchIntradayDay(call, date, tz);
  const intervals = [];
  for (let i = 1; i < raw.s.length; i++) intervals.push(raw.s[i][0] - raw.s[i - 1][0]);
  intervals.sort((a, b) => a - b);
  return {
    ok: true, date, tz, samples: raw.s.length,
    steps: raw.s.reduce((p, x) => p + x[1], 0),
    medianGapSec: intervals.length ? intervals[Math.floor(intervals.length / 2)] : null,
    first: raw.s.slice(0, 12),
  };
}

/** Hourly cron: keep the intraday store fresh and pre-warm the page caches. */
async function runScheduled(env) {
  if (!env.HEALTH_KV || !withingsConfigured(env)) return;
  const status = { at: nowSec(), ok: true, errors: [] };
  try {
    const token = await getAccessToken(env);
    try { const s = await syncIntraday(env, token); status.calls = s.calls; status.errors = s.errors; }
    catch (err) { status.ok = false; status.errors.push("intraday: " + (err.message || err)); }
    try { await kvPutJson(env, "trends", await buildTrends(token)); }
    catch (err) { status.errors.push("trends: " + (err.message || err)); }
    try { await kvPutJson(env, "snapshot", await buildSnapshot(env, token)); }
    catch (err) { status.errors.push("snapshot: " + (err.message || err)); }
  } catch (err) { status.ok = false; status.errors.push(String(err.message || err)); }
  await kvPutJson(env, "sync:last", status);
}

async function handleIntraday(env, url, callback) {
  const mode = url.searchParams.get("intraday");
  const day = url.searchParams.get("day");
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

  if (mode === "probe") {
    const meta = (await kvGetJson(env, "intraday:meta")) || {};
    const tz = url.searchParams.get("tz") || meta.tz || env.HOME_TZ || "UTC";
    const date = isDate(day) ? day : localYmd(nowSec(), tz);
    try { return reply(await intradayProbe(await getAccessToken(env), date, tz), { callback }); }
    catch (err) { return reply({ ok: false, error: String(err.message || err) }, { status: 502, callback }); }
  }

  let summary = await kvGetJson(env, "intraday");
  const meta = (await kvGetJson(env, "intraday:meta")) || {};
  const stale = !summary || (mode === "refresh" && nowSec() - (meta.lastSync || 0) > SYNC_MIN_GAP);
  if (stale) {
    try { summary = await syncIntraday(env, await getAccessToken(env)); }
    catch (err) { if (!summary) return reply({ ok: false, error: String(err.message || err), updated: nowSec() }, { callback }); }
  }

  if (isDate(day)) {
    const night = await kvGetJson(env, "night:" + day);
    return reply({ ok: true, d: day, tz: summary.tz, day: summary.days[day] || null, night },
      { callback, cache: "public, max-age=300" });
  }
  return reply(summary, { callback, cache: "public, max-age=300" });
}

// ── /api/vitals broker ───────────────────────────────────────────────
async function handleVitals(env, url) {
  const callback = url.searchParams.get("callback");
  const cacheHdr = "public, max-age=300";

  // Gating: without KV or Withings config, degrade gracefully.
  if (!env.HEALTH_KV || !withingsConfigured(env)) {
    return reply({ error: "withings not configured" }, { status: 503, callback });
  }

  // Intraday hourly bands / sleep-bounded days.
  if (url.searchParams.has("intraday")) return handleIntraday(env, url, callback);

  // Export (built live, never cached).
  const exp = url.searchParams.get("export");
  if (exp) {
    let token;
    try { token = await getAccessToken(env); } catch (err) { return reply({ ok: false, error: String(err.message || err), updated: nowSec() }, { status: 502, callback }); }
    if (String(exp).toLowerCase() === "json") {
      const snap = (await kvGetJson(env, "snapshot")) || (await buildSnapshot(env, token).catch(() => null)) || { ok: false, error: "no-data" };
      return reply(snap, { callback, mime: callback ? null : CT_JSON });
    }
    try {
      const csv = await buildExportCsv(token);
      return new Response(csv, { status: 200, headers: { "content-type": CT_CSV, "content-disposition": 'attachment; filename="vitals-export.csv"', "cache-control": "no-store" } });
    } catch (err) { return reply({ ok: false, error: String(err.message || err) }, { status: 502, callback }); }
  }

  // Trends feed.
  const trends = url.searchParams.get("trends");
  if (trends) {
    if (trends !== "fresh") {
      const cached = await kvGetJson(env, "trends");
      if (cached && (nowSec() - (cached.updated || 0)) < SNAPSHOT_TTL) return reply(cached, { callback, cache: cacheHdr });
    }
    try {
      const token = await getAccessToken(env);
      const payload = await buildTrends(token);
      await kvPutJson(env, "trends", payload);
      return reply(payload, { callback, cache: cacheHdr });
    } catch (err) {
      const stale = await kvGetJson(env, "trends");
      if (stale) return reply(stale, { callback, cache: cacheHdr });
      return reply({ ok: false, error: String(err.message || err), updated: nowSec() }, { callback });
    }
  }

  // Default: curated snapshot (cached ~45 min).
  const cached = await kvGetJson(env, "snapshot");
  if (cached && (nowSec() - (cached.updated || 0)) < SNAPSHOT_TTL) {
    return reply(cached, { callback, cache: cacheHdr });
  }
  try {
    const token = await getAccessToken(env);
    const payload = await buildSnapshot(env, token);
    await kvPutJson(env, "snapshot", payload);
    return reply(payload, { callback, cache: cacheHdr });
  } catch (err) {
    if (cached) return reply(cached, { callback, cache: cacheHdr });   // serve stale on failure
    return reply({ ok: false, error: String(err.message || err), updated: nowSec() }, { callback });
  }
}

// ── re-authorisation (owner only) ────────────────────────────────────
// If the refresh-token chain breaks (status 503 "invalid refresh_token"),
// visit /api/withings/auth?key=ADMIN_KEY, approve on Withings, and the
// callback stores a fresh refresh token in KV. The callback URL
// (<origin>/api/withings/callback) must be listed in the Withings app.
const AUTHORIZE_URL = "https://account.withings.com/oauth2_user/authorize2";
const AUTH_SCOPE = "user.info,user.metrics,user.activity";

async function handleAuth(env, url) {
  if (!env.HEALTH_KV || !env.ADMIN_KEY || !withingsConfigured(env)) return reply({ error: "auth not configured" }, { status: 503 });
  const redirectUri = url.origin + "/api/withings/callback";

  if (url.pathname === "/api/withings/auth") {
    if (url.searchParams.get("key") !== env.ADMIN_KEY) return reply({ error: "forbidden" }, { status: 403 });
    const nonce = crypto.randomUUID();
    await env.HEALTH_KV.put("oauth:state", nonce, { expirationTtl: 600 });
    const q = form({ response_type: "code", client_id: env.WITHINGS_CLIENT_ID, scope: AUTH_SCOPE, redirect_uri: redirectUri, state: nonce });
    return Response.redirect(AUTHORIZE_URL + "?" + q.toString(), 302);
  }

  // callback
  const expected = await env.HEALTH_KV.get("oauth:state");
  if (!expected || url.searchParams.get("state") !== expected) return reply({ error: "bad or expired state" }, { status: 403 });
  await env.HEALTH_KV.delete("oauth:state");
  const code = url.searchParams.get("code");
  if (!code) return reply({ error: "no code" }, { status: 400 });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ action: "requesttoken", grant_type: "authorization_code", client_id: env.WITHINGS_CLIENT_ID,
      client_secret: env.WITHINGS_CLIENT_SECRET, code, redirect_uri: redirectUri }),
  });
  const d = await r.json().catch(() => ({}));
  if (d.status !== 0 || !d.body || !d.body.refresh_token) return reply({ ok: false, error: "token exchange failed: " + d.status }, { status: 502 });
  await env.HEALTH_KV.put("refresh_token", d.body.refresh_token);
  await kvPutJson(env, "access_token", { t: d.body.access_token, exp: nowSec() + (d.body.expires_in || 10800) });
  return new Response("Withings re-authorised. Data will refresh on the next request or hourly sync.",
    { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
}

// ── router ───────────────────────────────────────────────────────────
async function handleApi(request, env, url) {
  if (url.pathname === "/api/health") {
    const sync = env.HEALTH_KV ? await kvGetJson(env, "sync:last") : null;
    return reply({ ok: true, app: "health", withings: withingsConfigured(env), sync });
  }
  if (url.pathname === "/api/withings/auth" || url.pathname === "/api/withings/callback") {
    return handleAuth(env, url);
  }
  if (url.pathname === "/api/vitals") {
    if (request.method !== "GET") return reply({ error: "GET only" }, { status: 405 });
    return handleVitals(env, url);
  }
  return reply({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    return env.ASSETS.fetch(request);   // static site
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
};
