"""기존 엑셀(읽기 전용)에서 날짜·값만 꺼내 새 CSV 구조로 옮긴다. 수식·차트·서식은 가져오지 않는다."""
import sys, csv, datetime as dt, collections
import openpyxl

SRC = sys.argv[1]
OUT = sys.argv[2]
FRED = "23-01,1.26;23-02,1.28;23-03,1.32;23-04,1.31;23-05,1.32;23-06,1.32;23-07,1.32;23-08,1.33;23-09,1.33;23-10,1.35;23-11,1.36;23-12,1.38;24-01,1.39;24-02,1.39;24-03,1.39;24-04,1.40;24-05,1.40;24-06,1.42;24-07,1.41;24-08,1.43;24-09,1.42;24-10,1.41;24-11,1.41;24-12,1.39;25-01,1.40;25-02,1.41;25-03,1.38;25-04,1.38;25-05,1.40;25-06,1.39;25-07,1.38;25-08,1.37;25-09,1.38;25-10,1.38;25-11,1.38;25-12,1.38;26-01,1.39;26-02,1.38;26-03,1.36;26-04,1.37;26-05,1.36;26-06,1.36;26-07,1.38;26-08,1.36;26-09,1.35"
fred = {("20"+k[:2]+"-"+k[3:5]+"-01"): float(v) for k, v in (x.split(",") for x in FRED.split(";"))}

ws = openpyxl.load_workbook(SRC).worksheets[0]
rows, converted = [], []

def add(date, code, val, freq, flag="정상", note=""):
    rows.append(dict(date=date, index_code=code, value=val, frequency=freq, origin="이관", flag=flag, note=note))

def to_date(v, where):
    if isinstance(v, dt.datetime):
        return v.date().isoformat()
    s = str(v).strip().replace(".", "-")
    d = dt.date.fromisoformat(s)
    converted.append((where, str(v), d.isoformat()))
    return d.isoformat()

def fmt(x):
    x = round(float(x), 2)
    return str(int(x)) if x == int(x) else repr(x)

# BAI (A,B) 9~206
for r in range(9, 207):
    if ws.cell(r, 1).value is None: continue
    d = to_date(ws.cell(r, 1).value, f"BAI 행{r}")
    if d == "2026-04-20" and any(x["date"] == d and x["index_code"] == "BAI" for x in rows):
        # 원본에 같은 날짜가 두 줄. 앞뒤 간격상 04-27이 비어 있어 두 번째 줄을 04-27로 옮기되 추정임을 표시한다.
        add("2026-04-27", "BAI", fmt(ws.cell(r, 2).value), "W", "확인필요",
            f"원본(엑셀 행{r})에 2026-04-20이 2줄 있어 두 번째 줄을 04-27로 옮김(추정). 사이트 값과 확인 필요")
        continue
    add(d, "BAI", fmt(ws.cell(r, 2).value), "W")
# SCFI (I,J) 9~196
for r in range(9, 197):
    if ws.cell(r, 9).value is None: continue
    add(to_date(ws.cell(r, 9).value, f"SCFI 행{r}"), "SCFI", fmt(ws.cell(r, 10).value), "W")
# SEAFI (E,F) 9~85 : 2025-09-01 이전 월간, 이후 주간
for r in range(9, 86):
    if ws.cell(r, 5).value is None: continue
    d = to_date(ws.cell(r, 5).value, f"SEAFI 행{r}")
    freq = "M" if d <= "2025-09-01" else "W"
    flag, note = "정상", ""
    if d in ("2025-09-01", "2025-10-10"):
        flag, note = "확인필요", "월간→주간 전환 경계: 두 구간이 같은 지수·산식인지 확인 필요"
    add(d, "SEAFI", fmt(ws.cell(r, 6).value), freq, flag, note)
# RIR (M,N) 9~45
mism = 0
for r in range(9, 46):
    if ws.cell(r, 13).value is None: continue
    d = to_date(ws.cell(r, 13).value, f"RIR 행{r}")
    v = float(ws.cell(r, 14).value)
    flag, note = "정상", ""
    if d in fred and abs(fred[d] - v) > 0.0049:
        flag, note = "확인필요", f"FRED 현재값 {fred[d]}와 다름(엑셀 {v})"; mism += 1
    add(d, "RIR", repr(v), "M", flag, note)

# 2026-11-18 사이트에서 직접 확인한 최신값(엑셀에 아직 없던 것)
add("2026-11-16", "BAI", "2880", "W"); rows[-1].update(origin="수기", note="2026-11-18 TAC 대시보드에서 확인")
add("2026-11-13", "SCFI", "3572.33", "W"); rows[-1].update(origin="수기", note="2026-11-18 SSE에서 확인(3572.3268)")

rows.sort(key=lambda x: (x["index_code"], x["date"]))
seen = collections.Counter((x["date"], x["index_code"]) for x in rows)
dups = [k for k, c in seen.items() if c > 1]
with open(OUT, "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=["date","index_code","value","frequency","origin","flag","note"])
    w.writeheader(); w.writerows(rows)
cnt = collections.Counter(x["index_code"] for x in rows)
print("행 수:", dict(cnt)); print("중복:", dups); print("문자 날짜 변환:", converted)
print("RIR FRED 불일치 행:", mism, "/ 37")
