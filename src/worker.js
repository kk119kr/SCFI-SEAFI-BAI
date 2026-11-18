// Cloudflare Worker: /api/collect 만 처리하고, 나머지 요청은 정적 파일(페이지·데이터)로 넘긴다.
// 브라우저는 지수 사이트에 직접 접속할 수 없으므로(보안 규칙), 이 코드가 대신 받아 JSON으로 돌려준다.
// 저장은 하지 않는다. 반환 형식: { SCFI:[["2026-11-13",3572.33],...], SEAFI:[...], BAI:[...], errors:{...} }
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

async function collect() {
  const out = { errors: {} };
  await Promise.all(
    Object.entries(JOBS).map(async ([k, fn]) => {
      try { out[k] = await fn(); } catch (e) { out.errors[k] = String(e.message || e); }
    })
  );
  return new Response(JSON.stringify(out), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/collect") return collect();
    return env.ASSETS.fetch(request);
  },
};
