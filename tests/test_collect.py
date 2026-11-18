"""수집 프로그램 시험. 실제 사이트 응답(2026-11-18 확인) 구조를 본뜬 가짜 응답으로 저장 규칙을 확인한다.
실행: python tests/test_collect.py"""
import csv, shutil, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import collect

SRC = Path(__file__).resolve().parent.parent / "data"

def sse(cur_date, cur, last_date, last, key):
    return {"status": 1, "data": {"currentDate": cur_date, "lastDate": last_date, "lineDataList": [
        {"currentContent": cur, "lastContent": last, "dataItemTypeName": key},
        {"currentContent": None, "lastContent": None, "dataItemTypeName": key[:-2] + "_X"}]}}
def bai(date, price):
    return {"results": [{"routes": [{"code": "BAI00", "index_value": {"date": date, "price": price}}]}]}

class T(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()); shutil.copytree(SRC, self.tmp / "data")
        collect.DATA = self.tmp / "data"
        collect.VALUES, collect.INDICES, collect.LOG = [collect.DATA / n for n in ("index_values.csv", "indices.csv", "collect_log.csv")]
        self.resp = {"scfi": sse("2026-11-13", 3572.3268, "2026-11-06", 3633.4483, "SCFI_T"),
                     "seafi": sse("2026-11-13", 5665.0115, "2026-11-06", 5699.6285, "SEAFI_T"),
                     "bai": bai("2026-11-16", "2880.00")}
        def fake(url, tries=3):
            for k, v in self.resp.items():
                if k in url.lower(): 
                    if isinstance(v, Exception): raise v
                    return v
        collect.get_json = fake
        sys.argv = ["collect.py"]
    def rows(self): return collect.read_csv(collect.VALUES)
    def log(self): return collect.read_csv(collect.LOG)
    def drop(self, code, date):
        r = [x for x in self.rows() if not (x["index_code"] == code and x["date"] == date)]; collect.write_values(r)

    def test_이미_있으면_건너뜀(self):
        n0 = len(self.rows()); self.assertEqual(collect.main(), 0)
        self.assertEqual(len(self.rows()), n0)
        self.assertEqual({l["status"] for l in self.log()}, {"건너뜀"})

    def test_새_날짜_추가와_중복방지(self):
        self.drop("BAI", "2026-11-16"); self.drop("SCFI", "2026-11-13")
        self.assertEqual(collect.main(), 0)
        r = {(x["index_code"], x["date"]): x for x in self.rows()}
        self.assertEqual(r[("BAI", "2026-11-16")]["value"], "2880")
        self.assertEqual(r[("SCFI", "2026-11-13")]["value"], "3572.33")
        self.assertEqual(r[("BAI", "2026-11-16")]["origin"], "자동")
        n1 = len(self.rows()); collect.main()                       # 한 번 더 실행해도 중복 없음
        self.assertEqual(len(self.rows()), n1)
        keys = [(x["index_code"], x["date"]) for x in self.rows()]; self.assertEqual(len(keys), len(set(keys)))

    def test_지난주_빠진_값_채움(self):
        self.drop("SCFI", "2026-11-06"); self.drop("SCFI", "2026-11-13")
        collect.main()
        d = {x["date"] for x in self.rows() if x["index_code"] == "SCFI"}
        self.assertTrue({"2026-11-06", "2026-11-13"} <= d)

    def test_값이_다르면_덮어쓰지_않고_경고(self):
        self.resp["bai"] = bai("2026-11-16", "2999.00")
        self.assertEqual(collect.main(), 1)
        v = [x["value"] for x in self.rows() if x["index_code"] == "BAI" and x["date"] == "2026-11-16"]
        self.assertEqual(v, ["2880"])
        self.assertIn("경고", [l["status"] for l in self.log()])

    def test_큰_변동은_저장하되_확인필요(self):
        self.drop("BAI", "2026-11-16"); self.resp["bai"] = bai("2026-11-16", "4500.00")
        self.assertEqual(collect.main(), 1)
        x = [x for x in self.rows() if x["index_code"] == "BAI" and x["date"] == "2026-11-16"][0]
        self.assertEqual((x["value"], x["flag"]), ("4500", "확인필요"))

    def test_한_지수_실패해도_나머지_수집(self):
        self.drop("SCFI", "2026-11-13"); self.drop("SEAFI", "2026-11-13"); self.resp["bai"] = RuntimeError("접속 실패")
        self.assertEqual(collect.main(), 1)
        st = {l["index_code"]: l["status"] for l in self.log()}
        self.assertEqual((st["BAI"], st["SCFI"], st["SEAFI"]), ("실패", "성공", "성공"))

    def test_응답_구조가_바뀌면_실패로_기록(self):
        self.resp["scfi"] = {"status": 1, "data": {"currentDate": "2026-11-13", "lastDate": "2026-11-06", "lineDataList": []}}
        self.assertEqual(collect.main(), 1)
        l = [l for l in self.log() if l["index_code"] == "SCFI"][0]; self.assertEqual(l["status"], "실패"); self.assertIn("SCFI_T", l["message"])

    def test_수기입력(self):
        sys.argv = ["collect.py", "--manual", "BAI", "2026-11-23", "2950"]; self.assertEqual(collect.main(), 0)
        x = [x for x in self.rows() if x["date"] == "2026-11-23"][0]; self.assertEqual((x["origin"], x["value"]), ("수기", "2950"))

    def test_파일형식_유지(self):
        collect.main()
        raw = collect.VALUES.read_bytes(); self.assertTrue(raw.startswith(b"\xef\xbb\xbf"))
        rows = self.rows(); self.assertEqual(rows, sorted(rows, key=lambda r: (r["index_code"], r["date"])))

if __name__ == "__main__":
    unittest.main(verbosity=2)
