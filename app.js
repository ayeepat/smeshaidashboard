/* СМЭШ AI admin dashboard — data + rendering. Static, no build, no deps.
   Talks to the license worker's /admin/stats/* endpoints with the read-only
   stats token. */

'use strict';

// The worker's custom domain (smeshapi.site) — NOT the old *.workers.dev URL:
// that pointed at the pre-2026-07-07 Cloudflare account (stale D1) and the
// suffix is DPI-blocked in RU anyway. The worker allows this dashboard's
// origin (and only it) on /admin/stats/* — see statsCors in worker.js.
const API_BASE = 'https://smeshapi.site';
const MODEL_API_BASE = 'https://ai.smeshapi.site';
// AI spend is billed in USD; revenue is in RUB. The USD→RUB rate is the
// official Central Bank of Russia rate, fetched via the worker (keyless,
// cbr-xml-daily.ru) — never a hardcoded guess. See loadRate() / fxRate().

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------- auth -------------------------------- */

// The dashboard's credential is STATS_SECRET, sent as X-Stats-Token: a
// read-only capability that can reach /admin/stats/* and nothing else.
//
// It is NOT ADMIN_SECRET. The worker rejects any request carrying an Origin on
// the issue/revoke/backfill routes, and its stats preflight allows exactly
// `Content-Type, X-Stats-Token`. Sending x-admin-token therefore failed the
// preflight and the browser reported "Failed to fetch" — a blocked request,
// never a wrong password, which is why the stored key appeared to stop working.
const TOKEN_HEADER = 'x-stats-token';
const TOKEN_KEY = 'smesh_stats_token';
const MODEL_TOKEN_KEY = 'smesh_model_admin_token';
// The pre-split key held ADMIN_SECRET. It is useless here now and is a
// full-privilege credential sitting in browser storage, so drop it on sight.
const LEGACY_TOKEN_KEY = 'smesh_admin_token';
localStorage.removeItem(LEGACY_TOKEN_KEY);
sessionStorage.removeItem(LEGACY_TOKEN_KEY);

let token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || '';
let modelToken = sessionStorage.getItem(MODEL_TOKEN_KEY) || '';

function saveToken(t, remember) {
  token = t;
  (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, t);
}
function clearToken() {
  token = '';
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}

function saveModelToken(value) {
  modelToken = value;
  sessionStorage.setItem(MODEL_TOKEN_KEY, value);
}
function clearModelToken() {
  modelToken = '';
  sessionStorage.removeItem(MODEL_TOKEN_KEY);
}

// A fetch() that rejects never reached the worker: DNS, TLS, offline, or a
// refused CORS preflight. Surfacing the raw "Failed to fetch" made a blocked
// request look like a bad key, so name what it actually is.
const NETWORK_MSG = `нет ответа от ${API_BASE} (сеть, деплой воркера или CORS)`;

async function api(path) {
  let res;
  try { res = await fetch(API_BASE + path, { headers: { [TOKEN_HEADER]: token } }); }
  catch { throw new Error(NETWORK_MSG); }
  if (res.status === 401) { logout(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({ ok: false, reason: 'bad_json' }));
  if (!res.ok || data.ok === false) throw new Error(data.reason || ('http_' + res.status));
  return data;
}

async function modelApi(method, body) {
  let res;
  try {
    res = await fetch(MODEL_API_BASE + '/admin/model-config', {
      method,
      headers: {
        'X-Model-Admin-Key': modelToken,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new Error(`Нет ответа от ${MODEL_API_BASE}. Проверьте VPS, CORS и MODEL_DASHBOARD_ORIGIN.`);
  }
  const data = await res.json().catch(() => ({ ok: false, reason: 'bad_json' }));
  if (res.status === 401) throw Object.assign(new Error('MODEL_ADMIN_KEY отклонён.'), { code: 'unauthorized' });
  if (res.status === 429) throw new Error('Слишком много неверных попыток. Подождите 10 минут.');
  if (res.status === 409) throw Object.assign(new Error('Конфигурацию уже изменили в другой вкладке. Загружена свежая версия.'), { code: 'stale' });
  if (!res.ok || data.ok === false) throw new Error(data.reason || ('VPS вернул ' + res.status));
  return data;
}

/* ---------------------------- formatting ----------------------------- */

const nf = new Intl.NumberFormat('ru-RU');
const int = (v) => nf.format(Math.round(Number(v) || 0));
const rub = (v) => int(v) + ' ₽';
function usd(v) {
  v = Number(v) || 0;
  if (v === 0) return '$0';
  if (v < 0.1) return '$' + v.toFixed(4);
  if (v < 10) return '$' + v.toFixed(3);
  return '$' + v.toFixed(2);
}
function tokens(v) {
  v = Number(v) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return int(v);
}
const pct = (v) => (v == null ? '—' : (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%');

/* ---- live USD→RUB + honesty flags ---- */
// The live rate lives in state.rate (fetched from the worker). fxRate() is the
// number or null when the rate is genuinely unavailable — displays then say so
// instead of inventing a conversion.
const fxRate = () => (state.rate && state.rate.ok && state.rate.rate > 0 ? state.rate.rate : null);
const usd2rub = (v) => { const r = fxRate(); return r == null ? null : (Number(v) || 0) * r; };
// Formatted ₽ equivalent of a $ amount, or null if no live rate. Adaptive
// precision so tiny per-request costs don't collapse to a useless "0 ₽".
function rubEq(usdVal) {
  const r = usd2rub(usdVal);
  if (r == null) return null;
  if (r >= 100) return int(r) + ' ₽';
  if (r >= 1) return r.toFixed(1) + ' ₽';
  return r.toFixed(2) + ' ₽';
}
// A $ amount with its live ₽ equivalent beside it — used everywhere a dollar
// figure appears, per the "every $ shows ₽" requirement.
function usdDual(v) {
  const r = rubEq(v);
  return `${usd(v)} <span class="rub-eq${r == null ? ' unv' : ''}">${r == null ? '₽ —' : '≈ ' + r}</span>`;
}

// Token & cost figures come from the AI provider's usage frame. The pipeline is
// proven the moment ANY real usage is recorded (nonzero tokens can only come
// from a captured live frame), so the flag auto-clears — see state.captured.
const CAPTURE_MSG = 'Токены и стоимость берутся из ответа ИИ-провайдера. ' +
  'Логика проверена по документации, но пока НЕ подтверждена живым запросом. ' +
  'Сделайте один запрос или тест через расширение — если здесь появятся токены/расход больше нуля, значит захват работает и метка исчезнет.';
const unvBadge = (msg = CAPTURE_MSG) => ` <span class="badge unverified" title="${esc(msg)}">unverified!</span>`;
// Badge shown on cost/token stats until real usage confirms the capture.
const costFlag = () => (state.captured ? '' : unvBadge());
// A muted "projection" tag for extrapolated (not measured) numbers.
const projTag = ' <span class="proj-tag" title="Проекция: рассчитано из имеющихся данных, не измерено напрямую">проекция</span>';
// Telemetry is opt-in and OFF by default (settings.js: telemetryEnabled = false),
// and the VPS proxy reports server-side usage only for the same opt-in
// (backend-vps/server.js: job.telemetryOptIn !== true → no /t/ai event). So the
// devices table holds only the students who switched it on: every event in it
// is real, but the totals are a floor, never the whole audience. Money and bot
// data have no such filter. Anything counted from devices/events carries this.
const SAMPLE_MSG = 'Считается только по тем, кто включил телеметрию в настройках (по умолчанию выключена). ' +
  'События настоящие, но это нижняя граница: реальных установок и решений больше.';
const sampleTag = ` <span class="proj-tag" title="${SAMPLE_MSG}">выборка</span>`;

function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(Number(ms)).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: '2-digit' });
}
function fmtDateTime(ms) {
  if (!ms) return '—';
  return new Date(Number(ms)).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function timeAgo(ms) {
  const s = Math.floor((Date.now() - Number(ms)) / 1000);
  if (s < 60) return 'только что';
  const m = Math.floor(s / 60); if (m < 60) return m + ' мин назад';
  const h = Math.floor(m / 60); if (h < 24) return h + ' ч назад';
  const d = Math.floor(h / 24); if (d < 30) return d + ' дн назад';
  return fmtDate(ms);
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const BROWSER_LABEL = { chrome: 'Chrome', yandex: 'Yandex', opera: 'Opera', edge: 'Edge', firefox: 'Firefox', other: 'Другой' };
const LICENSE_LABEL = { subscription: 'Подписка', lifetime: 'Навсегда', none: 'Нет', paid: 'Платная' };

/* ---------------------------- delta chip ----------------------------- */
// Percentage change vs the previous equal-length window. dir='up_good' means a
// rise is coloured green (revenue); 'up_bad' means a rise is red (errors/cost).
function deltaChip(cur, prev, dir = 'up_good') {
  if (prev == null || prev === 0) return cur > 0 ? '<span class="delta flat">нов.</span>' : '';
  const change = (cur - prev) / prev;
  if (Math.abs(change) < 0.005) return '<span class="delta flat">= 0%</span>';
  const up = change > 0;
  const good = dir === 'up_good' ? up : !up;
  const arrow = up ? '↑' : '↓';
  return `<span class="delta ${good ? 'up' : 'down'}">${arrow} ${Math.abs(change * 100).toFixed(0)}%</span>`;
}

/* ------------------------------- KPIs -------------------------------- */
function kpi({ label, value, sub, foot, accent, icon }) {
  return `<div class="kpi${accent ? ' accent' : ''}">
    <div class="kpi-label">${icon || ''}${esc(label)}</div>
    <div class="kpi-value">${value}${sub ? ` <small>${sub}</small>` : ''}</div>
    ${foot ? `<div class="kpi-foot">${foot}</div>` : ''}
  </div>`;
}
function renderKpis(el, items) { el.innerHTML = items.map(kpi).join(''); }

/* ------------------------------ charts ------------------------------- */
// Compact hand-rolled SVG. Internal coordinate box scales to container width
// via viewBox; colours come from CSS custom properties so themes just work.
const CW = 680, CH = 230, PAD = { t: 14, r: 12, b: 26, l: 44 };

function niceMax(v) {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}
// Number of horizontal gridlines. Small integer maxes get integer steps so the
// axis never shows fractional-rounded duplicates (e.g. 1,1,1,0,0 for a max of 1).
const tickCount = (max) => (Number.isInteger(max) && max <= 5 ? max : 4);
function xLabels(labels) {
  const n = labels.length;
  if (n <= 1) return labels.map((l, i) => ({ i, l }));
  const want = Math.min(7, n);
  const stride = Math.max(1, Math.round((n - 1) / (want - 1)));
  const out = [];
  for (let i = 0; i < n; i += stride) out.push({ i, l: labels[i] });
  if (out[out.length - 1].i !== n - 1) out.push({ i: n - 1, l: labels[n - 1] });
  return out;
}
const dayLabel = (d) => { const p = String(d).split('-'); return p.length === 3 ? `${p[2]}.${p[1]}` : d; };

// Multi-series line/area chart. series: [{color, values, fill?}]. fmt(value).
function lineChart(el, { labels, series, fmt = int }) {
  if (!labels.length) { el.innerHTML = emptyChart(); return; }
  const iw = CW - PAD.l - PAD.r, ih = CH - PAD.t - PAD.b;
  let max = 0;
  for (const s of series) for (const v of s.values) max = Math.max(max, Number(v) || 0);
  max = niceMax(max);
  const X = (i) => PAD.l + (labels.length === 1 ? iw / 2 : (i / (labels.length - 1)) * iw);
  const Y = (v) => PAD.t + ih - (Math.max(0, v) / max) * ih;

  let g = '';
  const nt = tickCount(max);
  for (let t = 0; t <= nt; t++) {
    const y = PAD.t + (t / nt) * ih;
    const val = max * (1 - t / nt);
    g += `<line class="grid-line" x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${CW - PAD.r}" y2="${y.toFixed(1)}"/>`;
    g += `<text class="axis-lbl" x="${PAD.l - 7}" y="${(y + 3).toFixed(1)}" text-anchor="end">${fmt(val)}</text>`;
  }
  for (const { i, l } of xLabels(labels)) {
    g += `<text class="axis-lbl" x="${X(i).toFixed(1)}" y="${CH - 8}" text-anchor="middle">${esc(dayLabel(l))}</text>`;
  }
  for (const s of series) {
    const pts = s.values.map((v, i) => `${X(i).toFixed(1)},${Y(Number(v) || 0).toFixed(1)}`);
    if (s.fill !== false) {
      const area = `M${X(0).toFixed(1)},${(PAD.t + ih).toFixed(1)} L${pts.join(' L')} L${X(labels.length - 1).toFixed(1)},${(PAD.t + ih).toFixed(1)} Z`;
      g += `<path class="area" d="${area}" fill="${s.color}"/>`;
    }
    g += `<path class="line" d="M${pts.join(' L')}" stroke="${s.color}"/>`;
    if (labels.length <= 14) {
      s.values.forEach((v, i) => { g += `<circle class="dot" cx="${X(i).toFixed(1)}" cy="${Y(Number(v) || 0).toFixed(1)}" r="3" fill="${s.color}"/>`; });
    }
  }
  el.innerHTML = `<svg viewBox="0 0 ${CW} ${CH}" role="img">${g}</svg>`;
}

// Stacked bar chart. series: [{color, values}] stacked bottom→top per label.
function stackChart(el, { labels, series, fmt = int }) {
  if (!labels.length) { el.innerHTML = emptyChart(); return; }
  const iw = CW - PAD.l - PAD.r, ih = CH - PAD.t - PAD.b;
  const totals = labels.map((_, i) => series.reduce((s, ser) => s + (Number(ser.values[i]) || 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const n = labels.length;
  const bw = Math.max(3, Math.min(30, (iw / n) * 0.66));
  const X = (i) => PAD.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const Y = (v) => PAD.t + ih - (v / max) * ih;

  let g = '';
  const nt = tickCount(max);
  for (let t = 0; t <= nt; t++) {
    const y = PAD.t + (t / nt) * ih;
    g += `<line class="grid-line" x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${CW - PAD.r}" y2="${y.toFixed(1)}"/>`;
    g += `<text class="axis-lbl" x="${PAD.l - 7}" y="${(y + 3).toFixed(1)}" text-anchor="end">${fmt(max * (1 - t / nt))}</text>`;
  }
  for (const { i, l } of xLabels(labels)) {
    g += `<text class="axis-lbl" x="${X(i).toFixed(1)}" y="${CH - 8}" text-anchor="middle">${esc(dayLabel(l))}</text>`;
  }
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (const s of series) {
      const v = Number(s.values[i]) || 0;
      if (v <= 0) continue;
      const y0 = Y(acc), y1 = Y(acc + v);
      g += `<rect class="bar" x="${(X(i) - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, y0 - y1).toFixed(1)}" rx="2" fill="${s.color}"><title>${esc(dayLabel(labels[i]))}: ${fmt(v)}</title></rect>`;
      acc += v;
    }
  }
  el.innerHTML = `<svg viewBox="0 0 ${CW} ${CH}" role="img">${g}</svg>`;
}
const emptyChart = () => `<div class="empty-state">Пока нет данных за этот период.</div>`;

// horizontal proportion bars (browser/license/subject splits).
// Labels are ALWAYS escaped here (not at call sites): several of them come
// from client-controlled telemetry fields (license_type, subject), and an
// unescaped label in the ADMIN dashboard would be stored XSS with the admin
// token in localStorage as the prize.
function propBars(rows, { color = 'var(--accent)', total } = {}) {
  const sum = total != null ? total : rows.reduce((s, r) => s + r.value, 0);
  if (!sum) return emptyChart();
  return rows.map((r) => {
    const w = Math.max(2, (r.value / sum) * 100);
    return `<div class="hbar-row">
      <div class="lbl">${esc(r.label)}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${w.toFixed(1)}%;background:${r.color || color}"></div></div>
      <div class="val">${r.display != null ? r.display : int(r.value)}</div>
    </div>`;
  }).join('');
}

/* ------------------------------ toast -------------------------------- */
let toastT;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ============================ VIEWS ============================ */

const state = {
  view: 'overview',
  range: { overview: 7, users: 30, money: 30, subjects: 30, retention: 0, feedback: 30, errors: 30 },
  users: { sort: 'cost', browser: '', license: '', q: '', offset: 0, limit: 50 },
  loaded: {},
  rate: { ok: false, rate: null, fetched_at: null, stale: true }, // live USD→RUB
  captured: false, // has any real token/cost usage been recorded yet?
  apiLive: false,  // has the VPS server-truth pipeline (/t/ai) sent anything?
  models: { current: null, busy: false }
};

// Fetch the live USD→RUB rate (worker-proxied; key stays server-side) and paint
// the always-visible sidebar chip.
async function loadRate() {
  try { state.rate = await api('/admin/stats/rate'); }
  catch { state.rate = { ok: false, rate: null, fetched_at: null, stale: true }; }
  renderRateChip();
}
function renderRateChip() {
  const el = $('#rateChip'); if (!el) return;
  if (!state.rate.ok || !state.rate.rate) {
    el.innerHTML = `<span class="badge unverified" title="Не удалось получить курс USD→RUB">курс $→₽ unverified!</span>`;
    return;
  }
  const stale = !!state.rate.stale;
  el.innerHTML = `1&nbsp;$ = <b>${state.rate.rate.toFixed(2)}&nbsp;₽</b> <span class="rate-src${stale ? ' stale' : ''}">${stale ? 'кэш' : 'ЦБ'}</span>`;
  el.title = 'Официальный курс ЦБ РФ · обновлён ' + fmtDateTime(Date.parse(state.rate.fetched_at));
}
// "Is the token/cost capture proven?" — true once any real usage exists
// all-time, on EITHER pipeline: client telemetry (opt-in) or the VPS proxy's
// server-truth /t/ai events. state.apiLive tracks the server pipeline alone.
async function loadCaptured() {
  try {
    const ov = await api('/admin/stats/overview?days=0');
    const u = ov.usage;
    state.apiLive = Number(u.api_calls) > 0;
    state.captured = (Number(u.tokens_in) + Number(u.tokens_out) +
      Number(u.api_tokens_in) + Number(u.api_tokens_out)) > 0;
  } catch { state.captured = false; state.apiLive = false; }
}
// Plain-language honesty banner: what's real vs. what still needs confirming.
function renderOverviewBanner() {
  const el = $('#ovBanner'); if (!el) return;
  const notes = [];
  if (!state.apiLive) notes.push('<b>Серверный учёт API-вызовов (302.AI)</b> ещё не прислал ни одного события. Он не зависит от клиентской телеметрии, но требует деплоя: секрет INGEST_KEY на воркере (wrangler secret put INGEST_KEY) и тот же ключ в /etc/smesh-proxy.env на VPS. После первого решения через прокси здесь появятся реальные вызовы.');
  if (!state.captured) notes.push('<b>Токены и расход на ИИ</b> помечены «unverified!» — они берутся из ответа провайдера, но пока не подтверждены живым запросом. Сделайте один solve или тест через расширение: как только здесь появятся ненулевые токены, метки исчезнут сами.');
  if (!fxRate()) notes.push('<b>Курс USD→RUB недоступен</b> — рублёвые эквиваленты показаны как «₽ —».');
  // Two different kinds of caveat, kept apart on purpose. The notes above clear
  // themselves once a pipeline proves itself; the coverage line below never
  // does — it is the permanent difference between "all buyers" and "everyone
  // who opted into telemetry", and hiding it is what would make these numbers
  // look like a full picture when they are a floor.
  const coverage =
    `<div class="banner-real">Полные данные, по всем: выручка, возвраты, покупки, рефералы, бот и отзывы — они пишутся сервером на каждое событие.</div>` +
    `<div class="banner-line">Выборка (только включившие телеметрию, по умолчанию она выключена): устройства, браузеры, DAU/WAU/MAU, решения/тесты/ГДЗ, предметы, удержание, ошибки${state.apiLive ? ', API-вызовы 302.AI' : ''}. Цифры настоящие, но это нижняя граница — реальных пользователей больше.</div>`;
  el.style.display = '';
  el.innerHTML = (notes.length ? `<div class="banner-title">Не подтверждено:</div>` + notes.map((n) => `<div class="banner-line">${n}</div>`).join('') : '') + coverage;
}

/* ---------- Overview ---------- */
async function loadOverview() {
  const days = state.range.overview;
  const ov = $('[data-view="overview"]');
  $('#ovKpis').innerHTML = skeletonKpis(8);
  let data, ts;
  try { [data, ts] = await Promise.all([api(`/admin/stats/overview?days=${days}`), api(`/admin/stats/timeseries?days=${days > 0 ? days : 30}`)]); }
  catch (e) { $('#ovKpis').innerHTML = errBox(e); return; }

  renderOverviewBanner();
  const u = data.usage, c = data.cost, r = data.revenue, rp = data.revenue_prev, up = data.usage_prev, d = data.devices;
  // Real owner spend = the server-observed 302.AI calls. Until that pipeline
  // is live we fall back to the flagged client estimate rather than showing
  // a confidently wrong $0.
  const API_MSG = 'Серверный учёт вызовов 302.AI (VPS → /t/ai) ещё не прислал событий. Проверьте INGEST_KEY на воркере и VPS.';
  const realCostUsd = state.apiLive ? u.api_cost_usd : c.window_usd;
  const costRub = usd2rub(realCostUsd);
  // Profit starts from money actually kept: gross minus refunds settled in the
  // same window. Falls back to gross only when refunds could not be read.
  const keptRub = r.net_revenue_rub == null ? r.revenue_rub : r.net_revenue_rub;
  const net = costRub == null ? null : (keptRub - costRub);
  renderKpis($('#ovKpis'), [
    { label: 'Выручка', value: rub(r.revenue_rub), accent: r.revenue_rub > 0, foot: `${int(r.paid)} оплат · ${r.refunds ? `−${rub(r.refunded_rub)} возвраты` : (deltaChip(r.revenue_rub, rp ? rp.revenue_rub : null) || 'реальные платежи')}`, icon: iconMoney() },
    { label: 'API-вызовы (сервер)', value: int(u.api_calls), foot: state.apiLive ? `все реальные вызовы 302.AI · ${tokens(u.api_tokens_in + u.api_tokens_out)} токенов` : 'нет событий' + unvBadge(API_MSG), icon: iconChip() },
    { label: 'Расход 302.AI (сервер)', value: usd(u.api_cost_usd), sub: rubEq(u.api_cost_usd) == null ? '' : '≈ ' + rubEq(u.api_cost_usd), foot: state.apiLive ? 'токены с сервера · $ по тарифам' : 'нет событий' + unvBadge(API_MSG) },
    { label: 'Чистыми', value: net == null ? '—' : rub(net), foot: net == null ? 'нужен курс $→₽' : `выручка${r.refunds ? ' − возвраты' : ''} − расход (${state.apiLive ? 'сервер' : 'оценка клиентов'})${net < 0 ? ' · пока в минусе' : ''}`, accent: net != null && net > 0 },
    { label: 'Расход (оценка клиентов)', value: usd(c.window_usd), sub: rubEq(c.window_usd) == null ? '' : '≈ ' + rubEq(c.window_usd), foot: (deltaChip(c.window_usd, c.prev_usd, 'up_bad') || 'телеметрия, opt-in') + costFlag() },
    { label: 'Средний чек', value: r.avg_check_rub ? rub(r.avg_check_rub) : '—', foot: `${int(r.subscriptions)} подписок · ${int(r.lifetimes)} навсегда` },
    { label: 'Активные (MAU)', value: int(d.mau), foot: `DAU ${int(d.dau)} · WAU ${int(d.wau)}${sampleTag}`, icon: iconUsers() },
    { label: 'Устройств с телеметрией', value: int(d.total), foot: `+${int(d.new_in_window)} за период${sampleTag}` },
    { label: 'Решений', value: int(u.solves), foot: `${deltaChip(u.solves, up ? up.solves : null) || 'за период'} · ${int(u.tests)} тестов · ${int(u.gdz)} ГДЗ${sampleTag}` },
    { label: 'Расход на юзера', value: usd(c.per_active_user_usd), sub: rubEq(c.per_active_user_usd) == null ? '' : '≈ ' + rubEq(c.per_active_user_usd), foot: `в день ${usd(c.per_user_day_usd)} · мес ${usd(c.per_user_month_usd)}${projTag}${costFlag()}` }
  ]);

  const rows = ts.rows;
  const labels = rows.map((x) => x.day);
  const rate = fxRate();
  $('#ovMoneyNote').innerHTML = rate ? `1 $ = ${rate.toFixed(2)} ₽${costFlag()}` : `<span class="badge unverified">курс $→₽ unverified!</span>`;
  lineChart($('#ovMoneyChart'), {
    labels,
    series: [
      { color: 'var(--green)', values: rows.map((x) => x.revenue_rub) },
      { color: 'var(--warn)', values: rows.map((x) => (Number(x.api_cost_usd) || 0) * (rate || 0)) },
      { color: 'var(--tertiary)', values: rows.map((x) => (Number(x.cost_usd) || 0) * (rate || 0)), fill: false }
    ],
    fmt: (v) => v >= 1000 ? (v / 1000).toFixed(0) + 'k' : int(v)
  });
  lineChart($('#ovDauChart'), { labels, series: [{ color: 'var(--accent)', values: rows.map((x) => x.active) }] });

  // Server-truth API-call volume (counted by the VPS, not by opt-in clients).
  lineChart($('#ovApiChart'), { labels, series: [{ color: 'var(--warn)', values: rows.map((x) => x.api_calls) }] });
  const apiCalls = rows.reduce((s, x) => s + (Number(x.api_calls) || 0), 0);
  const apiCost = rows.reduce((s, x) => s + (Number(x.api_cost_usd) || 0), 0);
  $('#ovApiNote').innerHTML = apiCalls > 0
    ? `${int(apiCalls)} вызовов · ${usdDual(apiCost)}`
    : `<span class="badge unverified" title="${esc(API_MSG)}">нет серверных событий</span>`;
  stackChart($('#ovUsageChart'), {
    labels,
    series: [
      { color: 'var(--accent)', values: rows.map((x) => x.solves) },
      { color: 'var(--violet)', values: rows.map((x) => x.tests) },
      { color: 'var(--blue)', values: rows.map((x) => x.gdz) }
    ]
  });

  const totalBrowsers = d.browsers.reduce((s, b) => s + b.n, 0);
  $('#ovBrowsers').innerHTML =
    `<div class="panel-sub" style="margin-bottom:8px">Браузеры · всего ${int(totalBrowsers)}</div>` +
    propBars(d.browsers.map((b) => ({ label: BROWSER_LABEL[b.browser] || b.browser, value: b.n, color: browserColor(b.browser) }))) +
    `<div class="panel-sub" style="margin:16px 0 8px">Лицензии на устройствах</div>` +
    propBars(d.license_types.map((l) => ({ label: LICENSE_LABEL[l.type] || l.type, value: l.n, color: l.type === 'none' ? 'var(--tertiary)' : 'var(--accent)' })));
}
const browserColor = (b) => ({ chrome: 'var(--blue)', yandex: 'var(--danger)', opera: 'var(--danger)', edge: 'var(--green)', firefox: 'var(--warn)' }[b] || 'var(--tertiary)');

/* ---------- Users ---------- */
let userSearchT;
async function loadUsers() {
  const days = state.range.users, u = state.users;
  const body = $('#usersBody');
  body.innerHTML = `<tr class="loading-row"><td colspan="12">Загрузка…</td></tr>`;
  const qs = new URLSearchParams({ days, sort: u.sort, browser: u.browser, license: u.license, q: u.q, limit: u.limit, offset: u.offset });
  let data;
  try { data = await api('/admin/stats/users?' + qs); }
  catch (e) { body.innerHTML = `<tr class="loading-row"><td colspan="12">Ошибка: ${esc(e.message)}</td></tr>`; return; }

  // Top-line KPIs for the cohort in view.
  try {
    const ov = await api(`/admin/stats/overview?days=${days}`);
    renderKpis($('#usersKpis'), [
      { label: 'Активных за период', value: int(ov.usage.active_devices), icon: iconUsers() },
      { label: 'Платных устройств', value: int((ov.devices.license_types.find((l) => l.type === 'subscription')?.n || 0) + (ov.devices.license_types.find((l) => l.type === 'lifetime')?.n || 0)) },
      { label: 'Расход на всех', value: usd(ov.usage.cost_usd), sub: rubEq(ov.usage.cost_usd) == null ? '' : '≈ ' + rubEq(ov.usage.cost_usd), foot: 'кредиты API' + costFlag() },
      { label: 'Средний расход/юзера', value: usd(ov.cost.per_active_user_usd), sub: rubEq(ov.cost.per_active_user_usd) == null ? '' : '≈ ' + rubEq(ov.cost.per_active_user_usd), foot: costFlag() }
    ]);
  } catch { /* KPIs are best-effort */ }

  if (!data.users.length) {
    body.innerHTML = `<tr class="loading-row"><td colspan="12">Ничего не найдено.</td></tr>`;
  } else {
    body.innerHTML = data.users.map((x, i) => {
      const rank = u.offset + i + 1;
      const lic = x.license_type && x.license_type !== 'none'
        ? `<span class="badge ${x.license_type === 'lifetime' ? 'lifetime' : 'sub'}">${esc(LICENSE_LABEL[x.license_type] || x.license_type)}</span>`
        : `<span class="badge none">нет</span>`;
      return `<tr class="clickable" data-device="${esc(x.device_id)}">
        <td class="rank">${rank}</td>
        <td class="mono">${esc(x.device_id.slice(0, 8))}…${x.version ? ` <span class="muted">v${esc(x.version)}</span>` : ''}</td>
        <td><span class="badge ${x.browser || 'other'}">${BROWSER_LABEL[x.browser] || 'Другой'}</span></td>
        <td>${lic}</td>
        <td class="num">${int(x.solves)}</td>
        <td class="num">${int(x.tests)}</td>
        <td class="num">${int(x.gdz)}</td>
        <td class="num">${int(x.pdf)}</td>
        <td class="num">${tokens(x.tokens)}</td>
        <td class="num">${int(x.active_days)}</td>
        <td class="num"><div class="spent">${usd(x.cost_usd)}</div>${(() => { const rr = rubEq(x.cost_usd); return rr == null ? '' : `<div class="rub-eq">${rr}</div>`; })()}</td>
        <td class="muted">${timeAgo(x.last_seen)}</td>
      </tr>`;
    }).join('');
  }
  const from = data.total ? u.offset + 1 : 0;
  const to = u.offset + data.users.length;
  $('#usersCount').textContent = `${from}–${to} из ${int(data.total)} устройств`;
  $('#usersPrev').disabled = u.offset === 0;
  $('#usersNext').disabled = to >= data.total;
}

/* ---------- Ops worklist strip ---------- */
// Every one of these is a promise to a paying customer that is currently
// unkept. The strip is only drawn when something is actually stuck (or when
// the check itself failed) so it never becomes background noise you stop
// seeing — which is exactly what would make it useless the day it matters.
const WORKLIST_LABEL = {
  delivery_exhausted: 'Оплатили, но ключ не доставлен',
  payment_review_open: 'Платежи на ручной проверке',
  payment_reconciliation_errors: 'Ошибки сверки с Robokassa',
  refund_submission_unknown: 'Возврат начат, но не отправлен',
  refund_poll_stalled: 'Возврат завис у провайдера',
  referral_unsettled: 'Реферальные награды не начислены',
  referral_legacy_unjournaled: 'Старые реф. начисления без журнала',
  support_forward_exhausted: 'Обращения не дошли до меня',
  subscription_notify_exhausted: 'Напоминания не отправились'
};

// "Could not check" must never look like "nothing is stuck" — that is the one
// mistake this strip cannot afford, and hiding it on any failure made exactly
// that mistake. A 404 is the single honest exception: the route does not exist
// yet on the deployed worker, so there is nothing to have failed.
function showWorklistProbeFailure(el, detail) {
  el.style.display = '';
  el.className = 'banner ops-strip';
  el.innerHTML = `<div class="banner-title">Очереди не проверены</div>
    <div class="banner-line">Не удалось прочитать рабочие очереди. Это <b>не</b> значит, что всё чисто — значит, что проверить не вышло.${
      detail ? ` <span class="muted">${esc(detail)}</span>` : ''}</div>`;
}

async function loadWorklists() {
  const el = $('#opsStrip');
  if (!el) return;
  let data;
  try { data = await api('/admin/stats/worklists'); }
  catch (e) {
    // Route absent = worker not deployed with this build yet. Anything else
    // (network, CORS, 500, expired token) is a real failed check and is said so.
    if (/http_404|not_found/.test(e.message)) el.style.display = 'none';
    else showWorklistProbeFailure(el, e.message);
    return;
  }

  // The worker's own probe failed inside collectWorklists().
  if (data.worklists === null) {
    showWorklistProbeFailure(el, '');
    return;
  }
  const stuck = Object.entries(data.worklists).filter(([, n]) => n > 0);
  if (!stuck.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.className = 'banner ops-strip alert';
  el.innerHTML = `<div class="banner-title">Нужно вмешаться — ${int(data.total)}</div>` +
    stuck.map(([k, n]) => `<div class="banner-line"><b>${int(n)}</b> · ${esc(WORKLIST_LABEL[k] || k)}</div>`).join('');
}

/* ---------- Money ---------- */
// Refunds are counted on the day the money went back, so a refund of an older
// purchase lands in this window while its sale does not — the same convention
// an accounting period uses.
function refundFoot(s) {
  if (!s.refunds_known) {
    return 'возвраты не прочитаны' + unvBadge('Таблица payment_orders недоступна: показана только валовая выручка, вычесть возвраты не из чего.');
  }
  if (!s.refunds) return 'возвратов за период не было';
  return `−${rub(s.refunded_rub)} · ${int(s.refunds)} возврат(ов) в этом периоде`;
}

async function loadMoney() {
  const days = state.range.money;
  $('#moneyKpis').innerHTML = skeletonKpis(5);
  let data, refs;
  try {
    [data, refs] = await Promise.all([
      api(`/admin/stats/purchases?days=${days}`),
      api('/admin/stats/referrals')
    ]);
  } catch (e) { $('#moneyKpis').innerHTML = errBox(e); return; }

  // The newer panels are loaded independently and each survives its own
  // failure. Their routes ship with the worker, so between a dashboard push
  // and a `wrangler deploy` they return 404 — and one undeployed endpoint must
  // not blank out the revenue view that was working fine before.
  // Subscription state takes no period: "how many subscriptions do I have" is
  // not a question about a window.
  loadPanel('#subsKpis', '/admin/stats/subscriptions', renderSubscriptions);
  loadPanel('#funnelBox', `/admin/stats/funnel?days=${days}`, renderFunnel);
  const s = data.summary;
  // Gross is what was charged; net subtracts refunds that actually settled in
  // the same period. A revoked key is NOT a refund — it can be revoked for
  // abuse with the money kept, or refunded from an order that was never
  // revoked — so the two are shown as the separate facts they are.
  renderKpis($('#moneyKpis'), [
    { label: 'Выручка за период', value: rub(s.revenue_rub), accent: true, foot: `${int(s.paid)} оплаченных ключей · до возвратов`, icon: iconMoney() },
    { label: 'Чистыми после возвратов', value: s.net_revenue_rub == null ? '—' : rub(s.net_revenue_rub), foot: refundFoot(s) },
    { label: 'Средний чек', value: s.avg_check_rub ? rub(s.avg_check_rub) : '—', foot: `${int(s.subscriptions)} подписок · ${int(s.lifetimes)} навсегда` },
    { label: 'Отозвано ключей', value: int(s.revoked), foot: `${int(s.preorders)} предзаказов · отзыв ≠ возврат денег` },
    { label: 'Реф. награды', value: int(s.referral_rewards), foot: `${int(refs.total_referred_purchases)} покупок по кодам` }
  ]);

  $('#moneyCount').textContent = `${data.purchases.length} записей`;
  const pb = $('#purchasesBody');
  pb.innerHTML = data.purchases.length ? data.purchases.map((p) => {
    const contact = p.email || (p.telegram_user_id ? 'TG ' + p.telegram_user_id : '—');
    const typeBadge = p.type === 'lifetime' ? '<span class="badge lifetime">Навсегда</span>' : p.type === 'subscription' ? '<span class="badge sub">Подписка</span>' : `<span class="badge none">${esc(p.type || '—')}</span>`;
    const statusBadge = p.status === 'revoked' ? '<span class="badge revoked">отозван</span>' : '<span class="badge paid">активен</span>';
    return `<tr>
      <td>${fmtDate(p.issued_at)}</td>
      <td>${typeBadge}</td>
      <td class="muted">${esc(p.gateway || '—')}</td>
      <td class="num money${p.amount_rub ? ' pos' : ''}">${p.amount_rub ? int(p.amount_rub) : '—'}</td>
      <td class="mono">${esc(contact)}</td>
      <td>${statusBadge}</td>
    </tr>`;
  }).join('') : `<tr class="loading-row"><td colspan="6">Пока нет покупок за этот период.</td></tr>`;

  renderMargin(days);

  $('#gatewaysBox').innerHTML = data.gateways.length
    ? propBars(data.gateways.map((g) => ({ label: g.gateway, value: g.revenue_rub || g.n, display: g.revenue_rub ? rub(g.revenue_rub) : int(g.n) + ' шт' })))
    : emptyChart();

  $('#referralsBox').innerHTML = `
    <div class="mini-kpis" style="grid-template-columns:repeat(3,1fr)">
      <div class="mini-kpi"><div class="l">Кодов</div><div class="v">${int(refs.total_codes)}</div></div>
      <div class="mini-kpi"><div class="l">Покупок</div><div class="v">${int(refs.total_referred_purchases)}</div></div>
      <div class="mini-kpi"><div class="l">Дней выдано</div><div class="v">${int(refs.total_days_earned)}</div></div>
    </div>
    ${refs.top.length ? `<div class="panel-sub" style="margin:14px 0 6px">Топ рефереров</div>` + refs.top.slice(0, 8).map((r) =>
      `<div class="hbar-row" style="grid-template-columns:1fr auto auto;gap:10px">
        <div class="lbl mono">${esc(r.code)}</div>
        <div class="val">${int(r.purchases)} пок.</div>
        <div class="val" style="color:var(--accent)">+${int(r.days_earned)} дн</div>
      </div>`).join('') : ''}`;
}

// Fetch one panel's data and render it, containing any failure to that panel.
// A 404 here means "the worker predates this endpoint", which is a deploy
// state worth naming rather than a generic red box.
async function loadPanel(selector, path, render) {
  const el = $(selector);
  if (!el) return;
  try {
    render(await api(path));
  } catch (e) {
    const stale = /http_404|not_found/.test(e.message);
    el.innerHTML = `<div class="empty-state">${stale
      ? 'Этот блок появится после деплоя воркера (npx wrangler deploy).'
      : 'Не удалось загрузить: ' + esc(e.message)}</div>`;
  }
}

/* ---------- Subscription state (snapshot, not a window) ---------- */
function renderSubscriptions(s) {
  renderKpis($('#subsKpis'), [
    { label: 'MRR', value: rub(s.mrr_rub), accent: s.mrr_rub > 0, icon: iconMoney(),
      // Each plan is normalised to 30 days from its own term, so a 90-day
      // purchase contributes a third of its price per month instead of
      // looking like a spike in the month it was bought.
      foot: `${int(s.active)} активных подписок · нормализовано на 30 дней` },
    { label: 'Средний чек в месяц', value: s.arpu_rub == null ? '—' : rub(s.arpu_rub),
      foot: s.arpu_rub == null ? 'нет активных подписок' : 'MRR ÷ активные подписки' },
    { label: 'Истекает за 7 дней', value: int(s.expiring_7d),
      foot: `${int(s.expiring_30d)} за 30 дней · бот напомнит сам`,
      accent: false },
    { label: 'Не продлили за 30 дней', value: int(s.lapsed_30d),
      foot: 'истекли и не купили заново' },
    { label: 'Ключи навсегда', value: int(s.lifetimes), foot: 'не входят в MRR' }
  ]);
}

/* ---------- Checkout funnel ---------- */
function renderFunnel(f) {
  const box = $('#funnelBox');
  if (!f.created) {
    box.innerHTML = `<div class="empty-state">За период не создано ни одного заказа.</div>`;
    return;
  }
  const rows = [
    { label: 'Создали заказ', value: f.created, color: 'var(--tertiary)' },
    { label: 'Оплатили', value: f.paid, color: 'var(--green)' },
    { label: 'Получили ключ', value: f.fulfilled, color: 'var(--accent)' }
  ];
  const conv = f.conversion_rate == null ? '—' : pct(f.conversion_rate);
  box.innerHTML =
    `<div class="mini-kpis" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px">
      <div class="mini-kpi"><div class="l">Конверсия в оплату</div><div class="v">${conv}</div></div>
      <div class="mini-kpi"><div class="l">Бросили корзину</div><div class="v">${int(f.abandoned)}</div></div>
      <div class="mini-kpi"><div class="l">Недополучено</div><div class="v">${rub(f.lost_rub)}</div></div>
    </div>` +
    propBars(rows, { total: f.created }) +
    `<p class="muted" style="font-size:11.5px;margin:14px 0 0">
      ${int(f.in_flight)} заказов ещё в процессе (срок не истёк) — они не считаются потерянными.
      «Недополучено» — сумма брошенных корзин по прайсу, а не долг.
      ${f.review ? `<b>${int(f.review)}</b> на ручной проверке. ` : ''}Только продакшен-заказы.
    </p>`;
}

/* ---------- Cost to serve each paying customer ---------- */
async function renderMargin(days) {
  const body = $('#marginBody');
  body.innerHTML = `<tr class="loading-row"><td colspan="6">Загрузка…</td></tr>`;
  let m;
  try { m = await api(`/admin/stats/margin?days=${days}&limit=100`); }
  catch (e) {
    const stale = /http_404|not_found/.test(e.message);
    body.innerHTML = `<tr class="loading-row"><td colspan="6">${stale
      ? 'Появится после деплоя воркера (npx wrangler deploy).'
      : 'Ошибка: ' + esc(e.message)}</td></tr>`;
    return;
  }

  if (!m.customers.length) {
    body.innerHTML = `<tr class="loading-row"><td colspan="6">Нет платных ключей за период.</td></tr>`;
    $('#marginNote').textContent = '';
    return;
  }
  // The proxy only reports AI calls for students who switched telemetry on, and
  // it is off by default — so "no calls" means "not measured", not "free". The
  // totals and the per-row margin below therefore cover the observed subset
  // only; "N keys cost $X" over the whole page would understate spend by however
  // many customers never opted in. A worker predating these fields reports
  // nothing here, so fall back to treating the page as fully observed rather
  // than claiming none of it is.
  const unobserved = Number(m.unobserved) || 0;
  const observedCount = m.observed == null ? m.customers.length : Number(m.observed) || 0;
  const observedPaid = m.observed_paid_rub == null ? m.paid_rub : m.observed_paid_rub;
  const totalCostRub = usd2rub(m.api_cost_usd);
  const coverage = unobserved
    ? ` · <b>${int(unobserved)}</b> без телеметрии — расход неизвестен`
    : '';
  $('#marginNote').innerHTML = (totalCostRub == null
    ? `${int(m.counted)} ключей · ${usd(m.api_cost_usd)} расхода`
    : `${int(m.counted)} ключей · видно расход у ${int(observedCount)}: заплатили ${rub(observedPaid)} · стоили ${usdDual(m.api_cost_usd)}`
  ) + coverage;

  body.innerHTML = m.customers.map((c) => {
    // `cost_observed === false` is a customer the proxy never reported on.
    // Rendering their cost as $0 made an unmeasured heavy user the single most
    // profitable row on a panel whose whole job is finding loss-makers.
    const observed = c.cost_observed !== false;
    const costRub = observed ? usd2rub(c.api_cost_usd) : null;
    // Margin is only meaningful once the $→₽ rate is known; without it the
    // row shows the two figures and refuses to invent a comparison.
    const margin = costRub == null ? null : c.paid_rub - costRub;
    const bad = margin != null && margin < 0;
    const unknown = '<span class="muted" title="Этот пользователь не включал телеметрию, поэтому его вызовы ИИ прокси не передаёт">—</span>';
    return `<tr${bad ? ' class="row-alert"' : ''}>
      <td class="mono">${esc(c.key_hint)}</td>
      <td>${c.type === 'lifetime' ? '<span class="badge lifetime">Навсегда</span>' : '<span class="badge sub">Подписка</span>'}</td>
      <td class="num money pos">${int(c.paid_rub)}</td>
      <td class="num">${observed ? int(c.api_calls) : unknown}</td>
      <td class="num">${observed
        ? `${usd(c.api_cost_usd)}${costRub == null ? '' : ` <span class="rub-eq">${rubEq(c.api_cost_usd)}</span>`}`
        : unknown}</td>
      <td class="num money${bad ? '' : ' pos'}">${margin == null ? unknown : (bad ? '−' : '') + int(Math.abs(margin))}</td>
    </tr>`;
  }).join('');
}

/* ---------- Subjects ---------- */
async function loadSubjects() {
  const days = state.range.subjects;
  const bars = $('#subjectBars');
  bars.innerHTML = `<div class="empty-state">Загрузка…</div>`;
  let data;
  try { data = await api(`/admin/stats/subjects?days=${days}`); }
  catch (e) { bars.innerHTML = errBox(e); return; }
  const dt = $('#subjDetailTitle'); if (dt) dt.innerHTML = 'Детально' + costFlag();
  const subs = data.subjects;
  if (!subs.length) { bars.innerHTML = emptyChart(); $('#subjectsBody').innerHTML = `<tr class="loading-row"><td colspan="6">Пока нет данных.</td></tr>`; return; }
  const max = Math.max(...subs.map((s) => s.n));
  bars.innerHTML = subs.slice(0, 12).map((s) => `
    <div class="hbar-row">
      <div class="lbl">${esc(s.subject)}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(2, (s.n / max) * 100).toFixed(1)}%"></div></div>
      <div class="val">${int(s.n)}</div>
    </div>`).join('');
  $('#subjectsBody').innerHTML = subs.map((s) => `<tr>
    <td class="strong">${esc(s.subject)}</td>
    <td class="num">${int(s.n)}</td>
    <td class="num">${int(s.solves)}</td>
    <td class="num">${int(s.gdz)}</td>
    <td class="num">${int(s.devices)}</td>
    <td class="num"><div class="spent">${usd(s.cost_usd)}</div>${(() => { const rr = rubEq(s.cost_usd); return rr == null ? '' : `<div class="rub-eq">${rr}</div>`; })()}</td>
  </tr>`).join('');
}

/* ---------- Retention ---------- */
async function loadRetention() {
  $('#retentionKpis').innerHTML = skeletonKpis(3);
  let data;
  try { data = await api('/admin/stats/retention'); }
  catch (e) { $('#retentionKpis').innerHTML = errBox(e); return; }
  const c = data.classic;
  renderKpis($('#retentionKpis'), [
    { label: 'Возврат D1', value: pct(c.d1.rate), foot: `${int(c.d1.returned)} из ${int(c.d1.eligible)} устройств`, accent: true },
    { label: 'Возврат D7', value: pct(c.d7.rate), foot: `${int(c.d7.returned)} из ${int(c.d7.eligible)}` },
    { label: 'Возврат D30', value: pct(c.d30.rate), foot: `${int(c.d30.returned)} из ${int(c.d30.eligible)}` }
  ]);

  const wrap = $('#cohortWrap');
  if (!data.cohorts.length) { wrap.innerHTML = emptyChart(); return; }
  let html = '<table class="cohort"><thead><tr><th class="colhead" style="text-align:right">Когорта</th><th class="colhead"></th>';
  for (let w = 0; w < 8; w++) html += `<th class="colhead">Н${w}</th>`;
  html += '</tr></thead><tbody>';
  for (const co of data.cohorts) {
    html += `<tr><td class="rowhead">${fmtDate(Date.parse(co.cohort))}</td><td class="size">${int(co.size)} чел</td>`;
    for (let w = 0; w < 8; w++) {
      const v = co.weeks[w];
      if (v == null) { html += `<td><div class="cell empty"></div></td>`; continue; }
      const rate = co.size ? v / co.size : 0;
      const op = w === 0 ? 1 : Math.max(0.12, rate);
      const shown = w === 0 ? '100%' : (rate * 100).toFixed(0) + '%';
      html += `<td><div class="cell" style="background:color-mix(in srgb, var(--accent) ${Math.round(op * 100)}%, var(--surface-2))" title="${int(v)} из ${int(co.size)}">${v ? shown : ''}</div></td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

/* ---------- Errors ---------- */
async function loadErrors() {
  const days = state.range.errors;
  const body = $('#errorsBody');
  body.innerHTML = `<tr class="loading-row"><td colspan="4">Загрузка…</td></tr>`;
  let data;
  try { data = await api(`/admin/stats/errors?days=${days}`); }
  catch (e) { body.innerHTML = `<tr class="loading-row"><td colspan="4">Ошибка: ${esc(e.message)}</td></tr>`; return; }
  $('#errCount').textContent = `${data.errors.length} записей`;
  if (!data.errors.length) { body.innerHTML = `<tr class="loading-row"><td colspan="4">Ошибок нет — хорошо.</td></tr>`; return; }
  body.innerHTML = data.errors.map((e) => {
    let meta = {}; try { meta = JSON.parse(e.meta || '{}'); } catch { /* */ }
    return `<tr>
      <td class="muted" style="white-space:nowrap">${fmtDateTime(e.ts)}</td>
      <td class="mono">${esc(meta.op || '—')}</td>
      <td>${esc(meta.msg || '—')}</td>
      <td class="mono">${esc(String(e.device_id || '').slice(0, 8))}…</td>
    </tr>`;
  }).join('');
}

/* ---------- Feedback & bot ---------- */
// Labels mirror delivery/subscription.js: STAGE_OFFSETS and WINBACK_REASONS.
const STAGE_LABEL = {
  expiry_3d: 'Напоминание за 3 дня',
  expiry_1d: 'Напоминание за 1 день',
  expired: 'Подписка закончилась',
  winback: 'Опрос через 3 дня'
};
const REASON_LABEL = {
  price: '💸 Дорого',
  unused: '🤷 Не пригодилось',
  quality: '😕 Ответы не устроили',
  bugs: '🐞 Ошибки и глюки',
  alternative: '🔀 Пользуюсь другим',
  other: '✍️ Другое (написали текстом)'
};
// telegram_updates.result_kind — what the handler decided for each update.
const KIND_LABEL = {
  submit_ticket: 'Обращение в поддержку',
  submit_feature: 'Предложили идею',
  sub_winback_text: 'Ответ на опрос текстом',
  sub_winback_choice: 'Ответ на опрос кнопкой',
  sub_card: 'Открыли /sub',
  sub_bind: 'Привязали ключ',
  sub_bind_prompt: 'Начали привязку ключа',
  sub_release: 'Отвязали устройство',
  sub_release_confirm: 'Подтверждение отвязки',
  sub_callback_ignored: 'Устаревшая кнопка',
  callback_ticket: 'Кнопка «обращение»',
  callback_feature: 'Кнопка «идея»',
  callback_unknown: 'Неизвестная кнопка',
  resolve: 'Закрыли своё обращение',
  owner_reply: 'Мой ответ пользователю',
  owner_reply_replay: 'Мой ответ (повтор)',
  owner_menu: 'Моё меню',
  start_menu: 'Открыли меню',
  start_support: 'Меню → поддержка',
  help: 'Команда /help',
  rate_limited: 'Сработал лимит частоты',
  service_unavailable: 'Сбой сервиса',
  ignored: 'Не по теме',
  incomplete: 'Не завершено (сбой/лизинг)'
};
const MODE_LABEL = { ticket: 'Обращение', feature: 'Идея', winback: 'Ушёл — почему' };
const SOURCE_LABEL = {
  reminders: 'напоминания', winback: 'ответы опроса', links: 'привязки Telegram',
  updates: 'действия в боте', support: 'очередь поддержки', coverage: 'глубина истории'
};

async function loadFeedback() {
  const days = state.range.feedback;
  $('#fbKpis').innerHTML = skeletonKpis(6);
  let data, tickets;
  try {
    [data, tickets] = await Promise.all([
      api(`/admin/stats/feedback?days=${days}`),
      api('/admin/stats/tickets?limit=60')
    ]);
  } catch (e) { $('#fbKpis').innerHTML = errBox(e); return; }

  const r = data.reminders, w = data.winback, tg = data.telegram, sup = data.support;
  const sentAll = r.expiry_3d.sent + r.expiry_1d.sent + r.expired.sent + r.winback.sent;
  const savedAll = r.expiry_3d.cancelled + r.expiry_1d.cancelled;
  const stalledAll = r.expiry_3d.stalled + r.expiry_1d.stalled + r.expired.stalled + r.winback.stalled;

  renderKpis($('#fbKpis'), [
    { label: 'Привязано Telegram', value: int(tg.linked_total), foot: `+${int(tg.linked_in_window)} за период · доступ к /sub`, icon: iconUsers() },
    { label: 'Отправлено сообщений', value: int(sentAll), foot: 'напоминания, финал и опрос', accent: sentAll > 0 },
    // A reminder is cancelled when the key stopped needing it before the send.
    { label: 'Продлили до напоминания', value: int(savedAll), foot: 'напоминание отменено — подписка уже продлена' },
    { label: 'Ответов на опрос', value: int(w.answered), sub: w.response_rate == null ? '' : pct(w.response_rate), foot: w.sent ? `из ${int(w.sent)} отправленных опросов` : 'опросы ещё не уходили' },
    { label: 'Сообщений от людей', value: int(sup.total), foot: `${int(sup.forwarded)} доставлено мне${sup.pending ? ' · ' + int(sup.pending) + ' в очереди' : ''}` },
    { label: 'Застряло в отправке', value: int(stalledAll + sup.exhausted), foot: stalledAll + sup.exhausted > 0 ? 'исчерпаны попытки — нужен разбор' : 'очереди чистые', accent: false }
  ]);

  // Honesty line: what these numbers cover and what could not be read.
  const notes = [];
  if (data.unavailable && data.unavailable.length) {
    notes.push(`<b>Не прочитано:</b> ${data.unavailable.map((s) => esc(SOURCE_LABEL[s] || s)).join(', ')}. Эти блоки показывают нули потому, что таблица недоступна (миграция не применена), а не потому, что событий не было.`);
  }
  const cov = data.coverage || {};
  if (cov.oldest_update_at) {
    notes.push(`<b>Действия в боте</b> хранятся 7 дней (потом чистятся). Самая старая запись: ${fmtDateTime(cov.oldest_update_at)} — за более длинный период это не полная картина.`);
  }
  if (cov.oldest_notification_at) {
    notes.push(`Напоминания и опросы хранятся 365 дней. Самая старая запись: ${fmtDateTime(cov.oldest_notification_at)}.`);
  }
  if (tickets.truncated) notes.push('Список сообщений обрезан по лимиту сканирования KV.');
  const fbNote = $('#fbNote');
  fbNote.style.display = notes.length ? '' : 'none';
  fbNote.innerHTML = notes.map((n) => `<div class="banner-line">${n}</div>`).join('');

  // Lifecycle funnel — one row per stage, in the order they fire.
  $('#fbStages').innerHTML = ['expiry_3d', 'expiry_1d', 'expired', 'winback'].map((s) => {
    const v = r[s];
    return `<tr>
      <td>${esc(STAGE_LABEL[s])}</td>
      <td class="num">${int(v.queued)}</td>
      <td class="num">${int(v.sent)}</td>
      <td class="num">${int(v.cancelled)}</td>
      <td class="num">${int(v.pending)}</td>
      <td class="num">${v.stalled ? `<span class="badge unverified">${int(v.stalled)}</span>` : '0'}</td>
    </tr>`;
  }).join('');

  $('#fbReasons').innerHTML = w.reasons.length
    ? propBars(w.reasons.map((x) => ({ label: REASON_LABEL[x.code] || x.code, value: x.n })), { total: w.answered })
    : `<div class="empty-state">${w.sent ? 'Опросы отправлены, ответов пока нет.' : 'Опрос ещё никому не уходил.'}</div>`;

  $('#fbKinds').innerHTML = tg.updates.length
    ? propBars(tg.updates.map((x) => ({ label: KIND_LABEL[x.kind] || x.kind, value: x.n })), { total: tg.updates_total })
    : `<div class="empty-state">За период бот не обработал ни одного обновления.</div>`;

  const body = $('#fbTicketsBody');
  $('#fbTicketsCount').textContent = tickets.tickets.length
    ? `${tickets.tickets.length} из ${int(tickets.total_retained)} · открытых ${int(tickets.counts.open)}`
    : '';
  body.innerHTML = tickets.tickets.length
    ? tickets.tickets.map((t) => `<tr>
        <td class="mono">#${esc(t.no)}</td>
        <td><span class="badge ${t.mode === 'winback' ? 'unverified' : ''}">${esc(MODE_LABEL[t.mode] || t.mode)}</span></td>
        <td class="muted" style="white-space:nowrap">${t.at ? fmtDateTime(Date.parse(t.at)) : '—'}</td>
        <td>${esc(t.text)}</td>
        <td>${t.status === 'resolved' ? 'закрыто' : 'открыто'}</td>
      </tr>`).join('')
    : `<tr class="loading-row"><td colspan="5">Сообщений пока нет. Тексты хранятся 90 дней.</td></tr>`;
}

/* ---------- User drawer ---------- */
async function openUser(deviceId) {
  const drawer = $('#drawer'), scrim = $('#drawerScrim'), bodyEl = $('#drawerBody');
  $('#drawerTitle').textContent = deviceId.slice(0, 8) + '…';
  bodyEl.innerHTML = `<div class="empty-state">Загрузка…</div>`;
  drawer.classList.add('open'); scrim.classList.add('open'); drawer.setAttribute('aria-hidden', 'false');
  let data;
  try { data = await api('/admin/stats/user?device_id=' + encodeURIComponent(deviceId)); }
  catch (e) { bodyEl.innerHTML = errBox(e); return; }
  const d = data.device, lt = data.lifetime, lic = data.license;
  const licLine = lic
    ? `${LICENSE_LABEL[lic.type] || lic.type} · ${lic.status}${lic.expires_at ? ' · до ' + fmtDate(Date.parse(lic.expires_at)) : ''}`
    : (d.license_key ? 'ключ есть, деталей нет' : 'без лицензии');

  const daily = data.daily;
  const dailyLabels = daily.map((x) => x.day);
  bodyEl.innerHTML = `
    <div class="mini-kpis">
      <div class="mini-kpi"><div class="l">Использований</div><div class="v">${int(lt.uses)}</div></div>
      <div class="mini-kpi"><div class="l">API-вызовы (сервер)</div><div class="v">${int(lt.api_calls)}</div></div>
      <div class="mini-kpi"><div class="l">Расход API (сервер)</div><div class="v">${usd(lt.api_cost_usd)}</div>${(() => { const rr = rubEq(lt.api_cost_usd); return rr == null ? '' : `<div class="rub-eq">${rr}</div>`; })()}</div>
      <div class="mini-kpi"><div class="l">Оценка клиента${costFlag()}</div><div class="v">${usd(lt.cost_usd)}</div>${(() => { const rr = rubEq(lt.cost_usd); return rr == null ? '' : `<div class="rub-eq">${rr}</div>`; })()}</div>
      <div class="mini-kpi"><div class="l">Дней активн.</div><div class="v">${int(lt.active_days)}</div></div>
    </div>
    <dl class="kv">
      <dt>Устройство</dt><dd class="mono" style="font-size:11.5px">${esc(d.device_id)}</dd>
      <dt>Браузер</dt><dd><span class="badge ${d.browser || 'other'}">${BROWSER_LABEL[d.browser] || 'Другой'}</span> ${d.version ? 'v' + esc(d.version) : ''}</dd>
      <dt>Провайдер</dt><dd>${esc(d.provider || '—')}</dd>
      <dt>Лицензия</dt><dd>${esc(licLine)}</dd>
      <dt>Ключ</dt><dd class="mono" style="font-size:11.5px">${esc(d.license_key || '—')}</dd>
      <dt>Реф-код</dt><dd class="mono">${esc(data.referral_code || '—')}</dd>
      <dt>Первый визит</dt><dd>${fmtDate(d.first_seen)}</dd>
      <dt>Последний</dt><dd>${timeAgo(d.last_seen)}</dd>
      <dt>Токенов всего</dt><dd>${tokens(lt.tokens)}</dd>
    </dl>
    ${daily.length ? `<div><div class="panel-sub" style="margin-bottom:6px">Использования по дням (60 дн)</div><div class="chart" id="drawerChart"></div></div>` : ''}
    ${data.subjects.length ? `<div><div class="panel-sub" style="margin-bottom:6px">Предметы</div>${propBars(data.subjects.map((s) => ({ label: s.subject, value: s.n })))}</div>` : ''}
    <div><div class="panel-sub" style="margin-bottom:6px">Последние события (${data.recent.length})</div><div class="ev-list">${
      data.recent.map((ev) => `<div class="ev-row"><div><span class="ev-type">${esc(EV_LABEL[ev.type] || ev.type)}</span>${ev.subject ? ' · ' + esc(ev.subject) : ''}${ev.cost_usd ? ' · ' + usd(ev.cost_usd) + (rubEq(ev.cost_usd) ? ' / ' + rubEq(ev.cost_usd) : '') : ''}</div><div class="ev-when">${fmtDateTime(ev.ts)}</div></div>`).join('')
    }</div></div>`;
  if (daily.length) lineChart($('#drawerChart'), { labels: dailyLabels, series: [{ color: 'var(--accent)', values: daily.map((x) => x.uses) }] });
}
const EV_LABEL = { solve: 'Решение', test_solve: 'Тест', test_requestion: 'Перерешать', gdz_pull: 'ГДЗ', heartbeat: 'Активность', install: 'Установка', update: 'Обновление', error: 'Ошибка', ai_call: 'API-вызов (сервер)' };
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawerScrim').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); }

/* ---------- live AI routing ---------- */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function parseModelChain(value, label) {
  const models = [...new Set(String(value || '').split(',').map((x) => x.trim()).filter(Boolean))];
  if (!models.length || models.length > 8 || models.some((model) => !MODEL_ID_RE.test(model))) {
    throw new Error(`${label}: от 1 до 8 model id через запятую, без пробелов внутри id.`);
  }
  return models;
}

function rememberModelRate(model, inputUsdPerM, outputUsdPerM) {
  let rates = {};
  try { rates = JSON.parse($('#modelRates').value || '{}'); }
  catch { /* replace a malformed draft with the selected preset's known rate */ }
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) rates = {};
  rates[model] = { input_usd_per_m: inputUsdPerM, output_usd_per_m: outputUsdPerM };
  $('#modelRates').value = JSON.stringify(rates, null, 2);
}

function setModelConnection(online, text) {
  const el = $('#modelLiveStatus');
  el.classList.toggle('online', online);
  el.classList.toggle('offline', !online);
  el.innerHTML = `<i></i>${esc(text)}`;
  $('#modelDisconnect').hidden = !online;
}

function readModelForm() {
  const current = state.models.current;
  if (!current) throw new Error('Сначала подключите управление.');
  let rates;
  try { rates = JSON.parse($('#modelRates').value || '{}'); }
  catch { throw new Error('Цены: JSON не читается. Проверьте запятые и кавычки.'); }
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) {
    throw new Error('Цены должны быть JSON-объектом.');
  }
  return {
    limits: {
      requests_per_minute: Number($('#minuteLimit').value),
      frontier_per_license: Number($('#frontierLimit').value),
      standard_per_license: Number($('#standardLimit').value),
      global_daily: Number($('#globalLimit').value),
      force_standard: $('#forceStandard').checked
    },
    routes: {
      qwen: {
        label: current.config.routes.qwen.label,
        text: parseModelChain($('#qwenText').value, 'Think · текст'),
        vision: parseModelChain($('#qwenVision').value, 'Think · изображения'),
        reasoning_effort: $('#qwenReasoning').checked
      },
      deepseek: {
        label: current.config.routes.deepseek.label,
        text: parseModelChain($('#deepseekText').value, 'Auto · текст'),
        vision: parseModelChain($('#deepseekVision').value, 'Auto · изображения'),
        reasoning_effort: $('#deepseekReasoning').checked
      },
      standard: {
        label: current.config.routes.standard.label,
        text: parseModelChain($('#standardText').value, 'Дешёвая цепочка · текст'),
        vision: parseModelChain($('#standardVision').value, 'Дешёвая цепочка · изображения'),
        reasoning_effort: $('#standardReasoning').checked
      },
      pdf: {
        label: current.config.routes.pdf.label,
        models: parseModelChain($('#pdfModels').value, 'PDF')
      }
    },
    rates
  };
}

function updateModelDraftState() {
  const el = $('#modelDraftState');
  if (!state.models.current) return;
  try {
    const dirty = JSON.stringify(readModelForm()) !== JSON.stringify(state.models.current.config);
    el.className = `draft-state ${dirty ? 'dirty' : 'clean'}`;
    el.textContent = dirty ? 'есть несохранённый черновик' : 'нет черновика';
    $('#modelSaveError').textContent = '';
  } catch (error) {
    el.className = 'draft-state invalid';
    el.textContent = 'черновик с ошибкой';
    $('#modelSaveError').textContent = error.message;
  }
}

function renderModelHistory(history) {
  const el = $('#modelHistory');
  if (!history.length) {
    el.innerHTML = '<div class="empty-state compact">История появится после первого сохранения.</div>';
    return;
  }
  el.innerHTML = history.map((entry) => `<div class="history-row">
    <div><strong>Ревизия ${int(entry.revision)}</strong><span>${entry.updated_at ? fmtDateTime(Date.parse(entry.updated_at)) : 'стартовые настройки'} · ${esc(entry.reason || 'без причины')}</span></div>
    <button class="btn sm ghost" type="button" data-rollback="${entry.revision}">Вернуть эту версию</button>
  </div>`).join('');
}

function renderModelState(data) {
  state.models.current = data;
  $('#modelAuthPanel').hidden = true;
  $('#modelConfigForm').hidden = false;
  setModelConnection(true, data.config.limits.force_standard ? 'дешёвый режим включён' : 'VPS подключён');
  $('#modelRevision').textContent = `ревизия ${data.revision}`;
  $('#modelUpdated').textContent = data.updated_at ? fmtDateTime(Date.parse(data.updated_at)) : 'ещё не сохранялось';
  $('#modelSource').textContent = data.source === 'saved' ? 'файл на VPS' : 'env + безопасные defaults';
  const warning = $('#modelHealthWarning');
  warning.hidden = data.healthy !== false;
  warning.innerHTML = data.healthy === false
    ? '<div class="banner-title">VPS заблокировал новые AI-запросы</div>Файл конфигурации повреждён или не записывается. Исправьте поля и сохраните: успешная атомарная запись снова откроет маршрутизацию.'
    : '';

  const { limits, routes, rates } = data.config;
  $('#minuteLimit').value = limits.requests_per_minute;
  $('#frontierLimit').value = limits.frontier_per_license;
  $('#standardLimit').value = limits.standard_per_license;
  $('#globalLimit').value = limits.global_daily;
  $('#forceStandard').checked = limits.force_standard;
  $('#deepseekText').value = routes.deepseek.text.join(', ');
  $('#deepseekVision').value = routes.deepseek.vision.join(', ');
  $('#deepseekReasoning').checked = routes.deepseek.reasoning_effort;
  $('#qwenText').value = routes.qwen.text.join(', ');
  $('#qwenVision').value = routes.qwen.vision.join(', ');
  $('#qwenReasoning').checked = routes.qwen.reasoning_effort;
  $('#standardText').value = routes.standard.text.join(', ');
  $('#standardVision').value = routes.standard.vision.join(', ');
  $('#standardReasoning').checked = routes.standard.reasoning_effort;
  $('#pdfModels').value = routes.pdf.models.join(', ');
  $('#modelRates').value = JSON.stringify(rates, null, 2);
  $('#modelChangeReason').value = '';
  renderModelHistory(data.history || []);
  updateModelDraftState();
}

function showModelDisconnected(message = '') {
  state.models.current = null;
  $('#modelAuthPanel').hidden = false;
  $('#modelConfigForm').hidden = true;
  setModelConnection(false, 'не подключено');
  $('#modelKeyError').textContent = message;
}

async function loadModels() {
  if (!modelToken) { showModelDisconnected(); return; }
  setModelConnection(false, 'подключение…');
  try {
    renderModelState(await modelApi('GET'));
  } catch (error) {
    if (error.code === 'unauthorized') clearModelToken();
    showModelDisconnected(error.message);
  }
}

async function saveModels(event) {
  event.preventDefault();
  if (state.models.busy || !state.models.current) return;
  const errorEl = $('#modelSaveError');
  errorEl.textContent = '';
  let config;
  try { config = readModelForm(); }
  catch (error) { errorEl.textContent = error.message; updateModelDraftState(); return; }
  if (!window.confirm('Применить этот черновик? Все новые запросы после сохранения сразу возьмут новые модели и лимиты.')) return;
  state.models.busy = true;
  $('#modelSave').disabled = true;
  try {
    const data = await modelApi('PUT', {
      expected_revision: state.models.current.revision,
      reason: $('#modelChangeReason').value.trim(),
      config
    });
    renderModelState(data);
    toast(`Модели применены · ревизия ${data.revision}`);
  } catch (error) {
    errorEl.textContent = error.message;
    if (error.code === 'stale') await loadModels();
  } finally {
    state.models.busy = false;
    $('#modelSave').disabled = false;
  }
}

async function rollbackModels(revision) {
  if (state.models.busy || !state.models.current) return;
  if (!window.confirm(`Вернуть настройки ревизии ${revision}? Откат сохранится как новая ревизия и сразу пойдёт в работу.`)) return;
  state.models.busy = true;
  try {
    const data = await modelApi('PUT', {
      expected_revision: state.models.current.revision,
      rollback_revision: revision,
      reason: `откат к ревизии ${revision}`
    });
    renderModelState(data);
    toast(`Возвращена ревизия ${revision}`);
  } catch (error) {
    $('#modelSaveError').textContent = error.message;
    if (error.code === 'stale') await loadModels();
  } finally { state.models.busy = false; }
}

/* ---------- helpers ---------- */
function skeletonKpis(n) { return Array.from({ length: n }, () => `<div class="kpi"><div class="kpi-label skeleton">загрузка</div><div class="kpi-value skeleton">000</div></div>`).join(''); }
function errBox(e) { return `<div class="empty-state">Не удалось загрузить: ${esc(e.message)}</div>`; }
function iconMoney() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`; }
function iconChip() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>`; }
function iconUsers() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>`; }

const LOADERS = { overview: loadOverview, users: loadUsers, money: loadMoney, subjects: loadSubjects, retention: loadRetention, feedback: loadFeedback, errors: loadErrors, models: loadModels };
function showView(view, force) {
  state.view = view;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.panelview').forEach((p) => p.classList.toggle('active', p.dataset.view === view));
  if (force || !state.loaded[view]) { state.loaded[view] = true; LOADERS[view](); }
}
function reload(view) { state.loaded[view] = false; if (state.view === view) showView(view, true); }

/* ============================ boot ============================ */
function initTheme() {
  const saved = localStorage.getItem('smesh_dash_theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  $$('#themeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.pref === saved));
}
function bindChrome() {
  $('#nav').addEventListener('click', (e) => { const b = e.target.closest('.nav-btn'); if (b) showView(b.dataset.view); });
  $('#themeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const pref = b.dataset.pref;
    document.documentElement.setAttribute('data-theme', pref);
    localStorage.setItem('smesh_dash_theme', pref);
    $$('#themeSeg button').forEach((x) => x.classList.toggle('active', x === b));
  });
  // range segmented controls
  $$('.seg[data-range]').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const view = seg.dataset.range;
      state.range[view] = Number(b.dataset.days);
      $$('button', seg).forEach((x) => x.classList.toggle('active', x === b));
      if (view === 'users') state.users.offset = 0;
      reload(view);
    });
  });
  // users controls
  $('#userSort').addEventListener('change', (e) => { state.users.sort = e.target.value; state.users.offset = 0; reload('users'); });
  $('#userBrowser').addEventListener('change', (e) => { state.users.browser = e.target.value; state.users.offset = 0; reload('users'); });
  $('#userLicense').addEventListener('change', (e) => { state.users.license = e.target.value; state.users.offset = 0; reload('users'); });
  $('#userSearch').addEventListener('input', (e) => { clearTimeout(userSearchT); userSearchT = setTimeout(() => { state.users.q = e.target.value.trim(); state.users.offset = 0; reload('users'); }, 350); });
  $('#usersPrev').addEventListener('click', () => { state.users.offset = Math.max(0, state.users.offset - state.users.limit); reload('users'); });
  $('#usersNext').addEventListener('click', () => { state.users.offset += state.users.limit; reload('users'); });
  $('#usersBody').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-device]'); if (tr) openUser(tr.dataset.device); });
  // live model routing
  $('#modelKeyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = $('#modelKeyInput').value.trim();
    if (!value) { $('#modelKeyError').textContent = 'Введите MODEL_ADMIN_KEY.'; return; }
    $('#modelKeyError').textContent = '';
    saveModelToken(value);
    try {
      renderModelState(await modelApi('GET'));
      $('#modelKeyInput').value = '';
    } catch (error) {
      clearModelToken();
      showModelDisconnected(error.message);
    }
  });
  $('#modelDisconnect').addEventListener('click', () => {
    clearModelToken();
    $('#modelKeyInput').value = '';
    showModelDisconnected();
  });
  $('#modelConfigForm').addEventListener('submit', saveModels);
  $('#modelConfigForm').addEventListener('input', updateModelDraftState);
  $('#modelConfigForm').addEventListener('change', updateModelDraftState);
  $('#modelReload').addEventListener('click', () => {
    if (state.models.current) renderModelState(state.models.current);
  });
  $('#autoGlmPreset').addEventListener('click', () => {
    $('#deepseekText').value = 'glm-5.3-flash';
    $('#deepseekVision').value = 'glm-5.3-flash';
    $('#deepseekReasoning').checked = true;
    rememberModelRate('glm-5.3-flash', 0.075, 0.25);
    updateModelDraftState();
  });
  $('#autoDeepseekPreset').addEventListener('click', () => {
    $('#deepseekText').value = 'deepseek-v4-flash';
    $('#deepseekVision').value = 'glm-5.3-flash';
    $('#deepseekReasoning').checked = true;
    rememberModelRate('deepseek-v4-flash', 0.20, 0.40);
    rememberModelRate('glm-5.3-flash', 0.075, 0.25);
    updateModelDraftState();
  });
  $('#glmPreset').addEventListener('click', () => {
    $('#standardText').value = 'glm-5.3-flash';
    $('#standardVision').value = 'glm-5.3-flash';
    rememberModelRate('glm-5.3-flash', 0.075, 0.25);
    updateModelDraftState();
  });
  $('#modelHistory').addEventListener('click', (e) => {
    const button = e.target.closest('[data-rollback]');
    if (button) rollbackModels(Number(button.dataset.rollback));
  });
  // drawer
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerScrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  // Licence sync (POST /admin/backfill-licenses) is not here any more: it is an
  // ADMIN_SECRET route, and the worker refuses every admin request that carries
  // a browser Origin. It is a curl command from the machine that holds the
  // admin key — see README.
  $('#logoutBtn').addEventListener('click', logout);
}

async function enterApp() {
  $('#gate').style.display = 'none';
  $('#shell').hidden = false;
  // Live rate + capture-status first so the very first render is honest.
  await Promise.all([loadRate(), loadCaptured()]);
  // Stuck queues are shown on every view, not buried in one tab: "money taken,
  // key never delivered" should not wait to be looked for.
  loadWorklists();
  showView('overview', true);
}
function logout() {
  clearToken();
  clearModelToken();
  $('#shell').hidden = true;
  $('#gate').style.display = 'grid';
  $('#tokenInput').value = '';
  showModelDisconnected();
}

async function tryToken(t, remember) {
  let probe;
  try {
    probe = await fetch(API_BASE + '/admin/stats/overview?days=1', { headers: { [TOKEN_HEADER]: t } });
  } catch {
    throw new Error(`Нет соединения с ${API_BASE}. Проверьте сеть и что воркер задеплоен.`);
  }
  // A 401 has two indistinguishable causes from out here: the key is wrong, or
  // STATS_SECRET was never set on the worker (statsGuard returns false when it
  // is missing or shorter than 32 chars, so even a correct key fails). Name
  // both — the second one is not fixable by retyping anything.
  if (probe.status === 401) {
    throw new Error('Ключ отклонён. Нужен STATS_SECRET, не ADMIN_SECRET — и он должен быть задан на воркере: npx wrangler secret put STATS_SECRET');
  }
  // The worker caps failed attempts per IP per day in the same budget table
  // telemetry uses; say so instead of showing a bare status code.
  if (probe.status === 429) throw new Error('Слишком много попыток за сегодня — лимит воркера. Попробуйте завтра.');
  if (probe.status === 503) throw new Error('Сервер в режиме обслуживания или без D1 (503).');
  if (!probe.ok) throw new Error('Сервер недоступен (' + probe.status + ').');
  saveToken(t, remember);
  enterApp();
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  bindChrome();
  $('#gateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = $('#tokenInput').value.trim();
    const err = $('#gateErr');
    err.textContent = '';
    if (!t) { err.textContent = 'Введите ключ.'; return; }
    try { await tryToken(t, $('#rememberToken').checked); }
    catch (ex) { err.textContent = ex.message; }
  });
  // auto-enter if we already have a stored token that still works
  if (token) {
    tryToken(token, localStorage.getItem(TOKEN_KEY) ? true : false).catch(() => { clearToken(); });
  }
});
