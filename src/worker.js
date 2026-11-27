// Cloudflare Worker: /api/collect 만 처리하고, 나머지 요청은 정적 파일(페이지·데이터)로 넘긴다.
// 브라우저는 지수 사이트에 직접 접속할 수 없으므로(보안 규칙), 이 코드가 대신 받아 JSON으로 돌려준다.
// 받은 값은 Cloudflare 저장소(KV)에 쌓는다. 반환 형식: { SCFI:[["2026-11-13",3572.33],...], SEAFI:[...], BAI:[...], errors:{...} }
const UA = "Mozilla/5.0 (compatible; freight-index-report)";

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

function parseSse(j, name) {
  if (j.status !== 1) throw new Error("응답 상태 이상: " + j.msg);
  const d = j.data, key = name.toUpperCase() + "_T";
  const item = (d.lineDataList || []).find((x) => x.dataItemTypeName === key);
  if (!item) throw new Error(key + " 행을 찾지 못함(응답 구조가 바뀐 듯)");
  const out = [];
  if (item.currentContent != null) out.push([d.currentDate, Number(item.currentContent)]);
  if (item.lastContent != null && d.lastDate) out.push([d.lastDate, Number(item.lastContent)]);
  if (!out.length) throw new Error(key + " 값이 비어 있음");
  return out;
}

function parseBai(j) {
  for (const g of j.results || [])
    for (const r of g.routes || [])
      if (r.code === "BAI00") return [[r.index_value.date, Number(r.index_value.price)]];
  throw new Error("BAI00 항목을 찾지 못함(응답 구조가 바뀐 듯)");
}

const JOBS = {
  SCFI: async () => parseSse(await getJson("https://en.sse.net.cn/currentIndex?indexName=scfi"), "scfi"),
  SEAFI: async () => parseSse(await getJson("https://en.sse.net.cn/currentIndex?indexName=seafi"), "seafi"),
  BAI: async () => parseBai(await getJson("https://api.tacindex.com/bai/?currency=USD")),
};

const CODES = ["BAI", "SCFI", "SEAFI"];
const jget = async (env, k, d) => { try { return JSON.parse((await env.HISTORY.get(k)) || d); } catch (e) { return JSON.parse(d); } };

async function fetchAll() {
  const out = { errors: {} };
  await Promise.all(
    Object.entries(JOBS).map(async ([k, fn]) => {
      try { out[k] = await fn(); } catch (e) { out.errors[k] = String(e.message || e); }
    })
  );
  return out;
}

// 새 날짜의 값만 저장소에 추가한다(이미 있는 날짜는 건드리지 않음). 쓰기 횟수를 아끼려 변화가 있을 때만 쓴다.
async function persist(env, data, source) {
  if (!env.HISTORY) return { added: 0, stored: false };
  const series = await jget(env, "series", "[]");
  const have = new Set(series.map((r) => r.code + "|" + r.date));
  const addedBy = {};
  for (const code of CODES)
    for (const [date, v] of data[code] || []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(v) || have.has(code + "|" + date)) continue;
      series.push({ date, code, value: v }); have.add(code + "|" + date); addedBy[code] = (addedBy[code] || 0) + 1;
    }
  const added = Object.values(addedBy).reduce((a, b) => a + b, 0);
  if (added) await env.HISTORY.put("series", JSON.stringify(series));
  // 기록은 자동 실행이거나, 새 값이 생겼거나, 실패가 있을 때만 남긴다
  const bad = Object.keys(data.errors || {});
  if (source === "cron" || added || bad.length) {
    const log = await jget(env, "log", "[]"), at = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
    for (const code of CODES) {
      const err = data.errors && data.errors[code];
      log.push({ run_at: at, index_code: code, status: err ? "실패" : "정상", rows_added: addedBy[code] || 0, message: (err ? err : "") + (source === "cron" ? " (자동 실행)" : " (페이지 열림)") });
    }
    await env.HISTORY.put("log", JSON.stringify(log.slice(-60)));
  }
  return { added, stored: true };
}

async function collect(env) {
  const data = await fetchAll();
  const r = await persist(env, data, "page");
  return new Response(JSON.stringify({ ...data, saved: r }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function history(env) {
  const body = env.HISTORY ? { series: await jget(env, "series", "[]"), log: await jget(env, "log", "[]") } : { series: [], log: [] };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

// ───────── 게시용 카드 (/api/cards, /api/card.svg) ─────────
const CARDS = [
  { code: "BAI", sub: "Baltic Air Freight Index", color: "#003766", src: "TAC Index", url: "https://dashboard.tacindex.com/detail?route=BAI00&routeType=basket", freq: "W", dec: 0 },
  { code: "SCFI", sub: "Shanghai Containerized Freight Index", color: "#5BB3E5", src: "상하이항운교역소(SSE)", url: "https://en.sse.net.cn/indices/scfinew.jsp", freq: "W", dec: 2 },
  { code: "SEAFI", sub: "Southeast Asia Freight Index", color: "#E07B00", src: "상하이항운교역소(SSE)", url: "https://en.sse.net.cn/indices/seafinew2.jsp", freq: "W", dec: 2 },
  { code: "RIR", sub: "미국 소매 재고/매출 비율 (참고)", color: "#7A7A7A", src: "FRED", url: "https://fred.stlouisfed.org/data/RETAILIRSA", freq: "M", dec: 2 },
];
const CORS = { "access-control-allow-origin": "*" };

function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const rows = []; let f = "", r = [], q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { r.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; r.push(f); f = ""; rows.push(r); r = []; }
    else f += c;
  }
  if (f || r.length) { r.push(f); rows.push(r); }
  return rows;
}

// 엑셀에서 옮긴 이력(정적 CSV)과 저장소(KV)에 쌓인 새 값을 합쳐 지수별 시계열을 만든다.
async function loadSeries(env, origin) {
  const by = {};
  const put = (code, date, v, flag) => { if (!Number.isFinite(v)) return; (by[code] = by[code] || new Map()).set(date, { date, v, flag: flag || "" }); };
  const res = await env.ASSETS.fetch(new Request(new URL("/data/index_values.csv", origin)));
  const rows = parseCsv(await res.text()), h = rows[0] || [];
  const ix = (n) => h.indexOf(n);
  for (const r of rows.slice(1)) if (r.length > 3) put(r[ix("index_code")], r[ix("date")], Number(r[ix("value")]), r[ix("flag")]);
  if (env.HISTORY) for (const r of await jget(env, "series", "[]")) if (!(by[r.code] && by[r.code].has(r.date))) put(r.code, r.date, Number(r.value), "");
  const out = {};
  for (const [c, m] of Object.entries(by)) out[c] = [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

const DAYMS = 86400000, tms = (d) => Date.parse(d + "T00:00:00Z");
const pctOf = (a, b) => (b ? (a / b - 1) * 100 : null);
function nearest(arr, ms, tol) {
  let b = null;
  for (const p of arr) { const d = Math.abs(tms(p.date) - ms); if (d <= tol && (!b || d < Math.abs(tms(b.date) - ms))) b = p; }
  return b;
}

function buildCard(def, arr) {
  if (!arr || !arr.length) return { ...def, empty: true };
  const last = arr[arr.length - 1], i = arr.length - 1, W = def.freq === "W";
  const prev = arr[i - 1];
  const pts = [];
  if (W) {
    pts.push(["전주", prev ? pctOf(last.v, prev.v) : null]);
    const a4 = nearest(arr.slice(0, -1), tms(last.date) - 28 * DAYMS, 4 * DAYMS), a52 = nearest(arr.slice(0, -1), tms(last.date) - 364 * DAYMS, 6 * DAYMS);
    pts.push(["4주 전", a4 ? pctOf(last.v, a4.v) : null], ["1년 전", a52 ? pctOf(last.v, a52.v) : null]);
  } else {
    pts.push(["전월", prev ? pctOf(last.v, prev.v) : null], ["3개월 전", arr[i - 3] ? pctOf(last.v, arr[i - 3].v) : null], ["1년 전", arr[i - 12] ? pctOf(last.v, arr[i - 12].v) : null]);
  }
  const win = arr.slice(W ? -52 : -24);
  const hi = win.reduce((a, b) => (b.v > a.v ? b : a)), lo = win.reduce((a, b) => (b.v < a.v ? b : a));
  const { color, code, sub, src, url, freq, dec } = def;
  return { code, sub, color, src, url, freq, dec, asof: last.date, value: last.v, chg: pts[0][1], deltas: pts.map(([l, p]) => ({ l, p })),
    span: W ? "최근 52주" : "최근 24개월", hi: { v: hi.v, date: hi.date }, lo: { v: lo.v, date: lo.date }, spark: win.map((p) => p.v), flag: last.flag };
}

async function cards(env, url) {
  if (url.searchParams.get("fresh") === "1") { try { await persist(env, await fetchAll(), "page"); } catch (e) {} }
  const s = await loadSeries(env, url.origin);
  const body = { generated: new Date().toISOString(), cards: CARDS.map((d) => buildCard(d, s[d.code])) };
  return new Response(JSON.stringify(body), { headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" } });
}

const xesc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const nf = (v, d) => Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const dirOf = (p) => (p == null ? "flat" : p > 0.005 ? "up" : p < -0.005 ? "down" : "flat");
const DCOL = { up: "#b3261e", down: "#1b5e9b", flat: "#66727f" };
const pctTxt = (p) => (p == null ? "-" : (p > 0.005 ? "▲ +" : p < -0.005 ? "▼ " : "– ") + p.toFixed(1) + "%");

function cardSvg(c) {
  const W = 720, H = 200;
  let g = `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="#fff" stroke="#dfe5ec"/><rect x="0.5" y="0.5" width="7" height="${H - 1}" rx="3.5" fill="${c.color}"/>`;
  g += `<text x="26" y="36" font-size="19" font-weight="700" fill="#1c2733">${xesc(c.code)}</text><text x="26" y="54" font-size="11" fill="#66727f">${xesc(c.sub)}</text>`;
  if (c.empty) g += `<text x="26" y="110" font-size="14" fill="#66727f">데이터 없음</text>`;
  else {
    const d = dirOf(c.chg), col = DCOL[d];
    g += `<text x="26" y="108" font-size="44" font-weight="700" fill="${col}">${nf(c.value, c.dec)}</text>`;
    g += `<text x="26" y="134" font-size="14" font-weight="700" fill="${col}">${pctTxt(c.chg)} <tspan font-weight="400" fill="#66727f" font-size="11.5">${xesc(c.deltas[0].l)} 대비</tspan></text>`;
    c.deltas.slice(1).forEach((x, i) => { g += `<text x="${26 + i * 150}" y="174" font-size="12" fill="#66727f">${xesc(x.l)} <tspan font-weight="700" fill="${DCOL[dirOf(x.p)]}">${pctTxt(x.p)}</tspan></text>`; });
    g += `<text x="${W - 22}" y="34" font-size="11.5" text-anchor="end" fill="#66727f">${xesc(c.asof)}${c.flag === "확인필요" ? " ⚠" : ""} 기준</text>`;
    const sp = c.spark, x0 = 340, x1 = W - 26, y0 = 52, y1 = 142, mn = Math.min(...sp), mx = Math.max(...sp), rg = mx - mn || 1;
    if (sp.length > 1) {
      const pts = sp.map((v, i) => `${(x0 + (x1 - x0) * (i / (sp.length - 1))).toFixed(1)},${(y1 - ((v - mn) / rg) * (y1 - y0)).toFixed(1)}`);
      g += `<polyline points="${pts.join(" ")}" fill="none" stroke="${c.color}" stroke-width="2" stroke-linejoin="round"/><circle cx="${pts[pts.length - 1].split(",")[0]}" cy="${pts[pts.length - 1].split(",")[1]}" r="3.5" fill="${c.color}"/>`;
    }
    g += `<text x="340" y="170" font-size="11" fill="#8a96a3">${xesc(c.span)} 최고 ${nf(c.hi.v, c.dec)} (${xesc(c.hi.date)})</text><text x="340" y="186" font-size="11" fill="#8a96a3">${xesc(c.span)} 최저 ${nf(c.lo.v, c.dec)} (${xesc(c.lo.date)})</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="'Noto Sans KR','Malgun Gothic','Apple SD Gothic Neo',Arial,sans-serif">${g}</svg>`;
}

async function cardImage(env, url) {
  const s = await loadSeries(env, url.origin), code = (url.searchParams.get("i") || "").toUpperCase();
  const def = CARDS.find((d) => d.code === code);
  if (!def) return new Response("unknown index", { status: 404, headers: CORS });
  return new Response(cardSvg(buildCard(def, s[code])), { headers: { ...CORS, "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=1800" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/collect") return collect(env);
    if (url.pathname === "/api/history") return history(env);
    if (url.pathname === "/api/cards") return cards(env, url);
    if (url.pathname === "/api/card.svg") return cardImage(env, url);
    return env.ASSETS.fetch(request);
  },
  // 정해진 시각에 사람이 열지 않아도 자동으로 수집해 저장소에 쌓는다.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAll().then((d) => persist(env, d, "cron")));
  },
};
