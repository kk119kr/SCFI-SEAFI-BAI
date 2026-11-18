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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/collect") return collect(env);
    if (url.pathname === "/api/history") return history(env);
    return env.ASSETS.fetch(request);
  },
  // 정해진 시각에 사람이 열지 않아도 자동으로 수집해 저장소에 쌓는다.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAll().then((d) => persist(env, d, "cron")));
  },
};
