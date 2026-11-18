# 운임지수 현황 (BAI · SCFI · SEAFI)

매주 BAI·SCFI·SEAFI 최신값을 자동으로 모아 `data/`에 쌓고, `index.html`이 그 데이터로 추이 화면을 보여줍니다.
서버가 없고, GitHub 저장소 하나로 돌아갑니다. 열람하는 사람은 링크만 열면 됩니다.

## 파일 구성

| 경로 | 역할 |
|---|---|
| `index.html` | 커버리포트 화면(기간·단위 선택, 카드, 그래프, 표, CSV 내려받기) |
| `data/index_values.csv` | 지수 값 전체(날짜 · 지수 · 값). 이 파일이 원본 |
| `data/indices.csv` | 지수 안내(이름, 출처, 경고 기준 %, 색). `auto_collect`가 N이면 자동 수집 제외 |
| `data/collect_log.csv` | 자동 수집 기록(성공·건너뜀·경고·실패) |
| `scripts/collect.py` | 수집 프로그램 |
| `.github/workflows/collect.yml` | 자동 실행 설정(화·수·금·토) |
| `tools/migrate.py` | 기존 엑셀 → CSV 이관에 한 번 쓴 도구(다시 쓸 일 없음) |

## 처음 한 번 설치 (약 10분)

1. GitHub에서 새 저장소를 만든다. 이름 예: `freight-index`, **Public**.
2. 이 폴더의 모든 파일을 저장소에 올린다. `.github` 폴더는 숨김 폴더라 웹 업로드에서 빠지기 쉬우니 반드시 올라갔는지 확인한다. 터미널에서는 다음과 같이 한다.
   ```
   git init && git add -A && git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/<계정>/freight-index.git
   git push -u origin main
   ```
3. 저장소 **Settings → Pages**: Source를 `Deploy from a branch`, Branch를 `main` / `/ (root)`로 저장한다. 잠시 뒤 `https://<계정>.github.io/freight-index/` 주소가 생긴다.
4. 저장소 **Settings → Actions → General → Workflow permissions**: `Read and write permissions`를 선택하고 저장한다. (수집 결과를 저장소에 다시 저장하려면 필요)
5. **Actions** 탭 → `collect-freight-index` → **Run workflow**로 한 번 실행해 본다. 성공하면 `data/collect_log.csv`에 줄이 생기고 화면의 '수집 현황'에 표시된다.
6. 실패 알림: GitHub 프로필의 **Settings → Notifications → Actions**에서 실패한 실행의 메일 알림이 켜져 있는지 확인한다.

## 매주 확인할 것 (1분)

1. 리포트 상단 `데이터 최신 기준일`이 이번 주 날짜인지 본다.
2. 맨 아래 '수집 현황'에 `실패`·`경고`가 없는지 본다.

## 문제가 생겼을 때

**수집이 실패하거나 경고가 나왔을 때**

- `data/collect_log.csv` 마지막 줄의 메시지를 읽는다.
- 사이트 화면이 바뀌어 값을 못 읽는 경우가 가장 흔하다. 이때는 메시지와 `scripts/collect.py`를 ChatGPT나 Claude에 붙여 넣고 "이 사이트에서 최신 지수값을 읽는 부분이 실패한다. 고쳐 달라"고 요청한다. 고칠 곳은 `fetch_*`·`parse_*` 함수뿐이다.
- 급한 경우 값을 직접 넣는다.
  - 터미널: `python scripts/collect.py --manual BAI 2026-11-23 2950`
  - 웹: 저장소의 `data/index_values.csv`를 열어 연필 아이콘으로 맨 아래에 한 줄(`날짜,지수코드,값,W,수기,정상,`) 추가하고 Commit한다.

**'예약 실행이 중지되었다'는 표시가 Actions 탭에 보일 때**

- 공개 저장소는 60일 동안 활동이 없으면 예약 실행이 꺼진다. 이 저장소는 실행할 때마다 기록 파일을 저장하므로 보통 해당되지 않지만, 표시가 보이면 `Enable workflow`를 누른다.

**잘못 저장된 값이 있을 때**

- `data/index_values.csv`에서 해당 줄을 고쳐 Commit한다. 저장소의 변경 이력(History)에서 언제든 되돌릴 수 있다.

## 데이터 규칙

- 한 줄은 `날짜 · 지수 · 값`이다. 같은 날짜·지수 조합은 하나만 둔다.
- 값은 사이트에 표시된 값 그대로 저장한다(소수 둘째 자리까지). 증감율·평균은 저장하지 않고 화면이 계산한다.
- `flag`가 `확인필요`인 줄은 화면 표에 ⚠로 표시된다. 원인은 `note`에 적혀 있다. 확인한 뒤 `정상`으로 바꾼다.
- 직전 값보다 30%(`indices.csv`의 `warn_pct`) 넘게 변하면 저장은 하되 `확인필요`로 표시하고 경고를 남긴다.
- 이미 저장된 날짜의 값이 사이트 값과 다르면 덮어쓰지 않고 경고만 남긴다.

## 수집 주소 (2026-11-18 확인)

| 지수 | 주소 | 읽는 위치 |
|---|---|---|
| SCFI | `https://en.sse.net.cn/currentIndex?indexName=scfi` | `data.lineDataList` 중 `SCFI_T`의 `currentContent`, 날짜는 `data.currentDate` |
| SEAFI | `https://en.sse.net.cn/currentIndex?indexName=seafi` | `SEAFI_T`의 `currentContent`, 날짜는 `data.currentDate` |
| BAI | `https://api.tacindex.com/bai/?currency=USD` | `results[].routes[]` 중 `BAI00`의 `index_value.price`, `index_value.date` |

위 주소는 각 사이트 화면이 내부에서 부르는 주소다. 공식으로 공개된 API가 아니라서 예고 없이 바뀔 수 있다.
