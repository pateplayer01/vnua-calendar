"""
VNUA Schedule → Google Calendar (.ics + .json)
pip install requests icalendar
"""
import os, json, base64, hashlib
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from icalendar import Calendar, Event
import requests

BASE_URL = "https://daotao.vnua.edu.vn"
USERNAME = os.environ.get("SCHOOL_USER", "")
PASSWORD = os.environ.get("SCHOOL_PASS", "")
OUTPUT_TKB = "docs/schedule.ics"
OUTPUT_EXAM = "docs/exams.ics"

S = requests.Session()
S.headers.update({"User-Agent": "Mozilla/5.0", "Referer": BASE_URL})


# ── Login ────────────────────────────────────────────────────────────────
def login():
    from urllib.parse import parse_qs
    code = base64.b64encode(json.dumps({
        "username": USERNAME,
        "password": PASSWORD,
        "uri": f"{BASE_URL}/#/home"
    }).encode()).decode()
    resp = S.get(f"{BASE_URL}/api/pn-signin", params={
        "code": code, "gopage": "", "mgr": "1"
    }, allow_redirects=False)
    location = resp.headers.get("Location", "")
    fragment = location.split("#")[-1]
    query = fragment.split("?")[-1]
    params = parse_qs(query)
    curr_b64 = params.get("CurrUser", [""])[0]
    curr_b64 += "=" * (-len(curr_b64) % 4)
    user_data = json.loads(base64.b64decode(curr_b64))
    access_token = user_data["access_token"]
    S.headers.update({
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json, text/plain, */*",
        "Idpc": "0",
        "X-Requested-With": "XMLHttpRequest",
    })
    print("Login OK | Token:", access_token[:30], "...")
    return True


# ── Lấy học kì hiện tại ─────────────────────────────────────────────────
def get_current_hocky():
    resp = S.post(f"{BASE_URL}/api/sch/w-locdshockytkbuser", json={})
    data = resp.json()["data"]
    return data["hoc_ky_theo_ngay_hien_tai"]


# ── Lấy TKB toàn học kì ───────────────────────────────────────────────────
def get_tkb(hoc_ky_id):
    resp = S.post(f"{BASE_URL}/api/sch/w-locdstkbtuanusertheohocky", json={
        "filter": {"hoc_ky": hoc_ky_id, "ten_hoc_ky": ""},
        "additional": {
            "paging": {"limit": 100, "page": 1},
            "ordering": [{"name": None, "order_type": None}]
        }
    })
    return resp.json()["data"]


# ── Lấy lịch thi ──────────────────────────────────────────────────────────
def get_exams(hoc_ky_id):
    resp = S.post(f"{BASE_URL}/api/epm/w-locdslichthisvtheohocky", json={
        "filter": {"hoc_ky": hoc_ky_id, "is_giua_ky": False},
        "additional": {
            "paging": {"limit": 100, "page": 1},
            "ordering": [{"name": None, "order_type": None}]
        }
    })
    return resp.json()["data"]


# ── Gộp buổi học liên tiếp cùng lớp/phòng/tiết thành từng chuỗi tuần ──────
# key = 1 lớp học phần cố định (môn + nhóm + tiết bắt đầu/kết thúc + phòng).
# runs: các đoạn ngày cách nhau đúng 7 ngày liên tục -> 1 RRULE weekly.
# Đứt quãng (nghỉ lễ, nghỉ Tết...) tự tách thành chuỗi RRULE mới, không nối bậy.
def _group_runs(data):
    tiet_map = {t["tiet"]: (t["gio_bat_dau"], t["gio_ket_thuc"])
                for t in data["ds_tiet_trong_ngay"]}

    groups = defaultdict(list)
    for tuan in data["ds_tuan_tkb"]:
        for tkb in tuan["ds_thoi_khoa_bieu"]:
            if tkb.get("is_nghi_day"):
                continue
            tiet_bd = tkb["tiet_bat_dau"]
            tiet_kt = min(tiet_bd + tkb["so_tiet"] - 1, max(tiet_map.keys()))
            if tiet_bd not in tiet_map:
                continue
            ngay = datetime.fromisoformat(tkb["ngay_hoc"]).date()
            key = (tkb["ten_mon"], tkb["ma_nhom"], tiet_bd, tiet_kt, tkb["ma_phong"])
            groups[key].append((ngay, tkb, tiet_bd, tiet_kt))

    all_runs = []  # list of (key, run=[(ngay, tkb, tiet_bd, tiet_kt), ...])
    for key, items in groups.items():
        items.sort(key=lambda x: x[0])
        runs, run = [], [items[0]]
        for prev, cur in zip(items, items[1:]):
            if (cur[0] - prev[0]).days == 7:
                run.append(cur)
            else:
                runs.append(run)
                run = [cur]
        runs.append(run)
        for run in runs:
            all_runs.append((key, run))

    return tiet_map, all_runs


def _stable_uid(hoc_ky_id, key, ngay0):
    raw = str(hoc_ky_id) + "|" + "|".join(str(k) for k in key) + "|" + str(ngay0)
    return hashlib.sha1(raw.encode()).hexdigest() + "@vnua-calendar"


# FIX: lịch thi trước đây dùng uuid.uuid4() -> UID đổi mỗi lần build script
# chạy -> Apps Script (so theo UID) tưởng môn thi cũ là môn mới -> insert
# trùng mỗi lần sync. Hash ổn định theo (học kỳ, môn, ngày, giờ, phòng) ->
# cùng 1 kỳ thi build lại nhiều lần vẫn ra đúng 1 UID -> Apps Script match
# đúng, giữ nguyên (kept), không đẻ trùng.
def _stable_exam_uid(hoc_ky_id, ten_mon, ngay_thi, gio_bd, phong):
    raw = f"{hoc_ky_id}|{ten_mon}|{ngay_thi}|{gio_bd}|{phong}"
    return hashlib.sha1(raw.encode()).hexdigest() + "@vnua-exam"


# ── Build TKB .ics (1 chuỗi RRULE weekly cho mỗi run liên tiếp) ───────────
def build_ics(data, hoc_ky_id):
    tiet_map, all_runs = _group_runs(data)

    cal = Calendar()
    cal.add("prodid", "-//VNUA Schedule//VN")
    cal.add("version", "2.0")
    cal.add("X-WR-CALNAME", "Lịch học VNUA")
    cal.add("X-WR-TIMEZONE", "Asia/Ho_Chi_Minh")
    cal.add("X-HOCKY", str(hoc_ky_id))  # Apps Script đọc field này để gate sync-1-lần/học-kì

    now_utc = datetime.now(tz=timezone.utc)
    n_series, n_occ = 0, 0

    for key, run in all_runs:
        ngay0, tkb0, tiet_bd, tiet_kt = run[0]
        dt_start = datetime.strptime(f"{ngay0} {tiet_map[tiet_bd][0]}", "%Y-%m-%d %H:%M")
        dt_end = datetime.strptime(f"{ngay0} {tiet_map[tiet_kt][1]}", "%Y-%m-%d %H:%M")
        phong = tkb0["ma_phong"].split("-")[0].strip()

        ev = Event()
        ev.add("dtstamp", now_utc)
        ev.add("uid", _stable_uid(hoc_ky_id, key, ngay0))  # ổn định -> re-run update-in-place, không đẻ trùng
        ev.add("summary", tkb0["ten_mon"])
        ev.add("dtstart", dt_start)
        ev.add("dtend", dt_end)
        ev.add("location", phong)
        ev.add("description", (
            f"GV: {tkb0['ten_giang_vien']}\n"
            f"{phong}\n"
            f"Tiết {tiet_bd}–{tiet_kt} | Nhóm {tkb0['ma_nhom']}"
        ))
        if len(run) > 1:
            ev.add("rrule", {"freq": "weekly", "count": len(run)})

        cal.add_component(ev)
        n_series += 1
        n_occ += len(run)

    print(f"TKB: {n_series} chuỗi sự kiện (gộp từ {n_occ} buổi học)")
    return cal.to_ical()


# ── Build Exam .ics ────────────────────────────────────────────────────────
def build_exam_ics(data, hoc_ky_id):
    cal = Calendar()
    cal.add("prodid", "-//VNUA Exams//VN")
    cal.add("version", "2.0")
    cal.add("X-WR-CALNAME", "Lịch thi VNUA")
    cal.add("X-WR-TIMEZONE", "Asia/Ho_Chi_Minh")
    cal.add("X-HOCKY", str(hoc_ky_id))

    now_utc = datetime.now(tz=timezone.utc)
    count = 0

    ds = data.get("ds_lich_thi") or data.get("data") or data
    if isinstance(ds, dict):
        ds = list(ds.values())[0]

    for thi in ds:
        try:
            ngay_thi = thi.get("ngay_thi") or thi.get("ngay")
            gio_bd = thi.get("gio_bat_dau") or thi.get("gio_thi") or "00:00"
            ten_mon = thi.get("ten_mon") or thi.get("mon_hoc") or "Thi"
            phong_thi = thi.get("phong_thi") or thi.get("ma_phong") or ""
            phong_str = phong_thi.split("-")[0].strip() if phong_thi else ""

            ngay = datetime.strptime(ngay_thi, "%d/%m/%Y").date()
            dt_start = datetime.strptime(f"{ngay} {gio_bd[:5]}", "%Y-%m-%d %H:%M")
            dt_end = dt_start + timedelta(minutes=int(thi.get("so_phut", 60)))

            desc_parts = []
            if thi.get("hinh_thuc_thi"):
                desc_parts.append(f"Hình thức: {thi['hinh_thuc_thi']}")
            if phong_str:
                desc_parts.append(phong_str)

            ev = Event()
            ev.add("dtstamp", now_utc)
            ev.add("uid", _stable_exam_uid(hoc_ky_id, ten_mon, ngay_thi, gio_bd, phong_str))
            ev.add("summary", f"🔴 THI: {ten_mon}")
            ev.add("dtstart", dt_start)
            ev.add("dtend", dt_end)
            ev.add("location", phong_str)
            ev.add("description", "\n".join(desc_parts))

            cal.add_component(ev)
            count += 1
        except Exception as e:
            print(f"Skip exam entry: {e} | data: {thi}")

    print(f"Lịch thi: {count} sự kiện")
    return cal.to_ical()


# ── Main ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    assert login(), "Login thất bại"

    hk_id = get_current_hocky()
    print(f"Học kì: {hk_id}")

    os.makedirs("docs", exist_ok=True)

    tkb_data = get_tkb(hk_id)
    with open(OUTPUT_TKB, "wb") as f:
        f.write(build_ics(tkb_data, hk_id))
    print(f"Saved: {OUTPUT_TKB}")

    exam_data = get_exams(hk_id)
    with open(OUTPUT_EXAM, "wb") as f:
        f.write(build_exam_ics(exam_data, hk_id))
    print(f"Saved: {OUTPUT_EXAM}")
