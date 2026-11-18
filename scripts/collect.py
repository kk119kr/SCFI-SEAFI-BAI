#!/usr/bin/env python3
"""운임지수(BAI·SCFI·SEAFI) 최신값 자동 수집.

사용법
  python scripts/collect.py                       # 3개 지수 수집 후 data/ 갱신
  python scripts/collect.py --dry-run             # 저장하지 않고 가져온 값만 출력
  python scripts/collect.py --manual BAI 2026-11-23 2950   # 손으로 한 줄 추가(자동 수집이 막힌 주)

수집 주소 (2026-11-18 브라우저로 직접 확인한 것)
  SCFI  https://en.sse.net.cn/currentIndex?indexName=scfi
  SEAFI https://en.sse.net.cn/currentIndex?indexName=seafi
  BAI   https://api.tacindex.com/bai/?currency=USD   (results → routes → BAI00 → index_value)
위 주소는 각 사이트 화면이 내부적으로 쓰는 주소라 사이트가 바꾸면 끊길 수 있다. 끊기면 이 파일의 fetch_* 함수만 고치면 된다.

종료 코드: 모두 정상이면 0, 실패·경고가 하나라도 있으면 1 (GitHub Actions가 실패로 표시하고 알림을 보낸다).
"""
import argparse, csv, datetime as dt, json, sys, time, urllib.request
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
VALUES, INDICES, LOG = DATA / "index_values.csv", DATA / "indices.csv", DATA / "collect_log.csv"
UA = "Mozilla/5.0 (compatible; freight-index-bot/1.0)"
KST = dt.timezone(dt.timedelta(hours=9))
STALE_DAYS = 15  # 주간 지수가 이 기간 넘게 새 값이 없으면 경고
FIELDS = ["date", "index_code", "value", "frequency", "origin", "flag", "note"]


# ───────── 가져오기 (사이트가 바뀌면 여기만 고친다) ─────────
def get_json(url, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # 네트워크 오류는 잠시 뒤 다시 시도
            last = e
            time.sleep(3 * (i + 1))
    raise RuntimeError(f"접속 실패: {url} ({last})")


def parse_sse(j, name):
    """SSE currentIndex 응답 → [(기준일, 값), ...] (이번 주, 지난 주)"""
    if j.get("status") != 1:
        raise RuntimeError(f"SSE 응답 상태 이상: {j.get('msg')}")
    d = j["data"]
    key = name.upper() + "_T"  # 종합지수 행(SCFI_T, SEAFI_T)
    item = next((x for x in d["lineDataList"] if x.get("dataItemTypeName") == key), None)
    if item is None:
        raise RuntimeError(f"{key} 행을 찾지 못함(응답 구조가 바뀐 듯)")
    out = []
    if item.get("currentContent") is not None:
        out.append((d["currentDate"], float(item["currentContent"])))
    if item.get("lastContent") is not None and d.get("lastDate"):
        out.append((d["lastDate"], float(item["lastContent"])))
    if not out:
        raise RuntimeError("값이 비어 있음")
    return out


def parse_bai(j):
    """TAC bai 응답 → [(기준일, 값)]"""
    for grp in j["results"]:
        for r in grp["routes"]:
            if r.get("code") == "BAI00":
                iv = r["index_value"]
                return [(iv["date"], float(iv["price"]))]
    raise RuntimeError("BAI00 항목을 찾지 못함(응답 구조가 바뀐 듯)")


FETCH = {
    "SCFI": lambda: parse_sse(get_json("https://en.sse.net.cn/currentIndex?indexName=scfi"), "scfi"),
    "SEAFI": lambda: parse_sse(get_json("https://en.sse.net.cn/currentIndex?indexName=seafi"), "seafi"),
    "BAI": lambda: parse_bai(get_json("https://api.tacindex.com/bai/?currency=USD")),
}


# ───────── 파일 읽기/쓰기 ─────────
def read_csv(p):
    with open(p, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def write_values(rows):
    rows.sort(key=lambda r: (r["index_code"], r["date"]))
    with open(VALUES, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows)


def fmtv(x):
    x = round(float(x), 2)
    return str(int(x)) if x == int(x) else repr(x)


def append_log(entries):
    new = not LOG.exists() or LOG.stat().st_size == 0
    with open(LOG, "a", newline="", encoding="utf-8-sig" if new else "utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["run_at", "index_code", "status", "rows_added", "message"])
        w.writerows(entries)


# ───────── 저장 규칙 ─────────
def add_points(rows, code, points, warn_pct, origin="자동"):
    """새 날짜만 추가. 같은 날짜가 이미 있으면 건너뛰고, 값이 다르면 경고만 남긴다(덮어쓰지 않음)."""
    existing = {r["date"]: r for r in rows if r["index_code"] == code}
    series = sorted((r["date"], float(r["value"])) for r in existing.values())
    added, notes, status = 0, [], "성공"
    for date, val in sorted(points):
        if not val > 0:
            raise RuntimeError(f"값이 이상함: {date} {val}")
        if date in existing:
            old = float(existing[date]["value"])
            if abs(old - round(val, 2)) > 0.011:
                status = "경고"
                notes.append(f"{date} 이미 저장된 값({old})과 사이트 값({round(val, 2)})이 다름 — 덮어쓰지 않음")
            continue
        flag, note = "정상", ""
        prev = [v for d, v in series if d < date]
        if prev and prev[-1] > 0 and abs(val / prev[-1] - 1) * 100 > warn_pct:
            flag, note = "확인필요", f"직전 값({prev[-1]}) 대비 {warn_pct:g}% 넘게 변동 — 사이트 값 확인 필요"
            status = "경고"
            notes.append(f"{date} {note}")
        rows.append(dict(date=date, index_code=code, value=fmtv(val), frequency="W", origin=origin, flag=flag, note=note))
        series.append((date, val))
        series.sort()
        added += 1
    if added == 0 and status == "성공":
        status = "건너뜀"
        notes.append("새 날짜 없음")
    return added, status, "; ".join(notes)


def stale_check(rows, code, today):
    last = max((r["date"] for r in rows if r["index_code"] == code), default=None)
    if last and (today - dt.date.fromisoformat(last)).days > STALE_DAYS:
        return f"마지막 데이터가 {last}로 {STALE_DAYS}일 넘게 갱신되지 않음"
    return ""


# ───────── 실행 ─────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--manual", nargs=3, metavar=("CODE", "DATE", "VALUE"))
    a = ap.parse_args()
    rows = read_csv(VALUES)
    idx = {r["index_code"]: r for r in read_csv(INDICES)}
    now = dt.datetime.now(KST)
    run_at = now.strftime("%Y-%m-%d %H:%M")

    if a.manual:
        code, date, val = a.manual
        dt.date.fromisoformat(date)
        n, st, msg = add_points(rows, code, [(date, float(val))], float(idx.get(code, {}).get("warn_pct", 30)), origin="수기")
        write_values(rows)
        append_log([(run_at, code, st, n, "수기 입력 " + msg)])
        print(code, date, val, "→", st, msg)
        return 0

    log, problems = [], 0
    for code, fetch in FETCH.items():
        if idx.get(code, {}).get("auto_collect", "Y") != "Y":
            continue
        try:
            pts = fetch()
            print(code, "가져온 값:", pts)
            if a.dry_run:
                continue
            n, st, msg = add_points(rows, code, pts, float(idx[code].get("warn_pct", 30)))
            stale = stale_check(rows, code, now.date())
            if stale:
                st, msg = "경고", (msg + "; " if msg else "") + stale
            log.append((run_at, code, st, n, msg))
            problems += st == "경고"
        except Exception as e:
            log.append((run_at, code, "실패", 0, str(e)[:200]))
            problems += 1
            print(code, "실패:", e, file=sys.stderr)
    if not a.dry_run:
        write_values(rows)
        append_log(log)
        for l in log:
            print(*l, sep=" | ")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
