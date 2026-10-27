#!/usr/bin/env python3
"""
reel_bot.py - multi-account Instagram Reel scheduler (unofficial, instagrapi).

Features
  * accounts.json: per-account daily cap, time windows, min/max gap, proxy, captions, hashtags
  * SQLite state: never posts the same video twice per account, survives restarts
  * session reuse (no fresh login each run), optional 2FA via TOTP secret
  * jitter + gaps + daily caps so posting looks human and stays under limits
  * error handling: challenge/login -> pause 12h, rate limit -> pause 1h, 3 fails -> quarantine file
  * videos from videos/<account>/ first, then videos/shared/

Usage
  python reel_bot.py init                  # create folders + example config
  python reel_bot.py login                 # test login for all accounts
  python reel_bot.py once acc1             # post one reel now for acc1 (test)
  python reel_bot.py run                   # scheduler loop (leave running)
  python reel_bot.py status                # today's counts + next post time
  python reel_bot.py run --dry-run         # simulate, no uploads
"""
import argparse
import hashlib
import json
import logging
import os
import random
import re
import shutil
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
SESSIONS = DATA / "sessions"
VIDEOS = BASE / "videos"
DONE = BASE / "done"
FAILED = BASE / "failed"
CONFIG = BASE / "accounts.json"
EXTS = {".mp4", ".mov", ".m4v"}
MAX_FAILS = 3

log = logging.getLogger("reelbot")


# ----------------------------------------------------------------- setup
def setup_logging():
    DATA.mkdir(exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    log.setLevel(logging.INFO)
    for h in (logging.StreamHandler(sys.stdout), logging.FileHandler(DATA / "bot.log", encoding="utf-8")):
        h.setFormatter(fmt)
        log.addHandler(h)


def connect():
    DATA.mkdir(exist_ok=True)
    conn = sqlite3.connect(DATA / "state.db")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS posts(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account TEXT NOT NULL, file_hash TEXT NOT NULL, file TEXT NOT NULL,
          status TEXT NOT NULL, fails INTEGER NOT NULL DEFAULT 0,
          media_pk TEXT, error TEXT, posted_at TEXT,
          UNIQUE(account, file_hash));
        CREATE TABLE IF NOT EXISTS state(
          account TEXT PRIMARY KEY, next_allowed TEXT, paused_until TEXT);
        """
    )
    return conn


def load_config():
    if not CONFIG.exists():
        sys.exit("accounts.json nahi mila. Pehle: python reel_bot.py init")
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    for a in cfg["accounts"]:
        a.setdefault("daily_cap", 3)
        a.setdefault("windows", ["10:00-13:00", "18:00-22:00"])
        a.setdefault("min_gap_min", 120)
        a.setdefault("max_gap_min", 300)
        a.setdefault("proxy", None)
        a.setdefault("captions", ["{Check|Watch|Look at} this"])
        a.setdefault("hashtags", [])
        a.setdefault("hashtags_per_post", 4)
    return cfg


# ----------------------------------------------------------------- helpers
def spin(text):
    """{a|b|c} -> random choice, so captions are never identical."""
    pat = re.compile(r"\{([^{}]*)\}")
    while pat.search(text):
        text = pat.sub(lambda m: random.choice(m.group(1).split("|")), text, count=1)
    return text


def build_caption(acc):
    cap = spin(random.choice(acc["captions"]))
    tags = acc["hashtags"]
    if tags:
        cap += "\n\n" + " ".join(random.sample(tags, min(acc["hashtags_per_post"], len(tags))))
    return cap


def file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_window(w):
    a, b = w.split("-")
    ah, am = map(int, a.split(":"))
    bh, bm = map(int, b.split(":"))
    return ah * 60 + am, bh * 60 + bm


def in_window(acc, now):
    m = now.hour * 60 + now.minute
    return any(s <= m <= e for s, e in map(parse_window, acc["windows"]))


def iso(dt):
    return dt.isoformat(timespec="seconds")


def parse_iso(s):
    return datetime.fromisoformat(s) if s else None


def posted_today(conn, name, now):
    day = now.strftime("%Y-%m-%d")
    r = conn.execute(
        "SELECT COUNT(*) c FROM posts WHERE account=? AND status='posted' AND posted_at LIKE ?",
        (name, day + "%"),
    ).fetchone()
    return r["c"]


def get_state(conn, name):
    r = conn.execute("SELECT * FROM state WHERE account=?", (name,)).fetchone()
    return (parse_iso(r["next_allowed"]), parse_iso(r["paused_until"])) if r else (None, None)


def set_state(conn, name, next_allowed=None, paused_until=None):
    cur_next, cur_pause = get_state(conn, name)
    na = next_allowed if next_allowed is not None else cur_next
    pu = paused_until if paused_until is not None else cur_pause
    conn.execute(
        "INSERT INTO state(account,next_allowed,paused_until) VALUES(?,?,?) "
        "ON CONFLICT(account) DO UPDATE SET next_allowed=excluded.next_allowed, paused_until=excluded.paused_until",
        (name, iso(na) if na else None, iso(pu) if pu else None),
    )
    conn.commit()


def pick_video(conn, acc):
    """First video (own folder, then shared) not yet posted/failed-out for this account."""
    folders = [VIDEOS / acc["name"], VIDEOS / "shared"]
    for folder in folders:
        if not folder.exists():
            continue
        for p in sorted(folder.iterdir()):
            if p.suffix.lower() not in EXTS:
                continue
            h = file_hash(p)
            r = conn.execute("SELECT status FROM posts WHERE account=? AND file_hash=?", (acc["name"], h)).fetchone()
            if r and r["status"] in ("posted", "quarantined"):
                continue
            return p, h
    return None, None


# ----------------------------------------------------------------- instagram
_clients = {}


def get_client(acc):
    from instagrapi import Client
    from instagrapi.exceptions import LoginRequired

    name = acc["name"]
    if name in _clients:
        return _clients[name]

    SESSIONS.mkdir(parents=True, exist_ok=True)
    sess_file = SESSIONS / f"{name}.json"
    password = os.environ.get(f"IG_PASS_{name.upper()}") or acc.get("password")
    if not password:
        raise RuntimeError(f"{name}: password missing (accounts.json ya env IG_PASS_{name.upper()})")

    cl = Client()
    cl.delay_range = [2, 6]  # random delay between internal API calls
    if acc.get("proxy"):
        cl.set_proxy(acc["proxy"])

    def do_login():
        code = ""
        if acc.get("totp_secret"):
            code = cl.totp_generate_code(acc["totp_secret"])
        cl.login(acc["username"], password, verification_code=code)

    logged_in = False
    if sess_file.exists():
        cl.load_settings(sess_file)
        try:
            do_login()  # reuses session cookies/device, avoids a fresh-device login
            cl.get_timeline_feed()  # cheap check that the session is alive
            logged_in = True
        except LoginRequired:
            log.warning("%s: session expired, fresh login with same device ids", name)
            old = cl.get_settings()
            cl.set_settings({})
            cl.set_uuids(old.get("uuids", {}))
    if not logged_in:
        do_login()
    cl.dump_settings(sess_file)
    _clients[name] = cl
    return cl


def classify(exc):
    from instagrapi.exceptions import (
        BadPassword, ChallengeRequired, LoginRequired, PleaseWaitFewMinutes, RateLimitError, TwoFactorRequired,
    )

    if isinstance(exc, (ChallengeRequired, LoginRequired, BadPassword, TwoFactorRequired)):
        return "auth", timedelta(hours=12)
    if isinstance(exc, (PleaseWaitFewMinutes, RateLimitError)):
        return "rate", timedelta(hours=1)
    return "other", timedelta(minutes=20)


def post_one(conn, acc, dry_run=False):
    """Upload exactly one reel for an account. Returns True if posted."""
    name = acc["name"]
    path, h = pick_video(conn, acc)
    if not path:
        log.info("%s: koi naya video nahi (videos/%s ya videos/shared mein daaliye)", name, name)
        return False
    caption = build_caption(acc)
    now = datetime.now()

    if dry_run:
        log.info("[dry-run] %s would post %s | caption: %s", name, path.name, caption.replace("\n", " "))
        return True

    try:
        cl = get_client(acc)
        media = cl.clip_upload(path, caption)
    except Exception as e:  # noqa: BLE001 - we classify below
        kind, wait = classify(e)
        prev = conn.execute("SELECT fails FROM posts WHERE account=? AND file_hash=?", (name, h)).fetchone()
        fails = (prev["fails"] if prev else 0) + (1 if kind == "other" else 0)
        status = "quarantined" if fails >= MAX_FAILS else "failed"
        conn.execute(
            "INSERT INTO posts(account,file_hash,file,status,fails,error) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(account,file_hash) DO UPDATE SET status=?, fails=?, error=?",
            (name, h, str(path), status, fails, str(e)[:300], status, fails, str(e)[:300]),
        )
        conn.commit()
        _clients.pop(name, None)
        set_state(conn, name, paused_until=now + wait)
        log.error("%s: upload fail (%s): %s -> pause %s", name, kind, str(e)[:200], wait)
        if status == "quarantined":
            FAILED.mkdir(exist_ok=True)
            shutil.move(str(path), FAILED / f"{name}_{path.name}")
            log.error("%s: %s quarantined (%d fails)", name, path.name, fails)
        return False

    conn.execute(
        "INSERT INTO posts(account,file_hash,file,status,media_pk,posted_at) VALUES(?,?,?,'posted',?,?) "
        "ON CONFLICT(account,file_hash) DO UPDATE SET status='posted', media_pk=excluded.media_pk, posted_at=excluded.posted_at",
        (name, h, str(path), str(media.pk), iso(now)),
    )
    conn.commit()

    # shared videos stay for other accounts; own-folder videos move to done/
    if path.parent.name != "shared":
        DONE.mkdir(exist_ok=True)
        shutil.move(str(path), DONE / f"{name}_{path.name}")

    gap = random.randint(acc["min_gap_min"], acc["max_gap_min"])
    set_state(conn, name, next_allowed=now + timedelta(minutes=gap))
    log.info("%s: POSTED %s (pk=%s). next in ~%d min", name, path.name, media.pk, gap)
    return True


# ----------------------------------------------------------------- commands
def cmd_init(_):
    for d in (DATA, SESSIONS, VIDEOS / "shared", DONE, FAILED):
        d.mkdir(parents=True, exist_ok=True)
    example = {
        "accounts": [
            {
                "name": "acc1",
                "username": "your_username",
                "password": "use env IG_PASS_ACC1 instead",
                "totp_secret": "",
                "proxy": None,
                "daily_cap": 3,
                "windows": ["10:00-13:00", "18:00-22:00"],
                "min_gap_min": 120,
                "max_gap_min": 300,
                "captions": ["{Wait for it|Watch till the end|You need to see this}", "{New|Fresh|Latest} reel"],
                "hashtags": ["#reels", "#viral", "#explore", "#trending", "#fyp"],
                "hashtags_per_post": 4,
            }
        ]
    }
    if not CONFIG.exists():
        CONFIG.write_text(json.dumps(example, indent=2), encoding="utf-8")
    print("Ready. accounts.json edit kijiye, videos videos/<account>/ ya videos/shared/ mein daaliye.")


def cmd_login(_):
    conn = connect()
    for acc in load_config()["accounts"]:
        try:
            get_client(acc)
            log.info("%s: login OK", acc["name"])
        except Exception as e:  # noqa: BLE001
            kind, wait = classify(e)
            set_state(conn, acc["name"], paused_until=datetime.now() + wait)
            log.error("%s: login fail (%s): %s", acc["name"], kind, str(e)[:200])


def cmd_once(args):
    conn = connect()
    acc = next((a for a in load_config()["accounts"] if a["name"] == args.account), None)
    if not acc:
        sys.exit("account naam galat")
    post_one(conn, acc, args.dry_run)


def cmd_status(_):
    conn = connect()
    now = datetime.now()
    for acc in load_config()["accounts"]:
        na, pu = get_state(conn, acc["name"])
        pending = sum(
            1
            for f in [*(VIDEOS / acc["name"]).glob("*"), *(VIDEOS / "shared").glob("*")]
            if f.suffix.lower() in EXTS
        )
        print(
            f"{acc['name']}: today {posted_today(conn, acc['name'], now)}/{acc['daily_cap']} | "
            f"next_allowed {na} | paused_until {pu} | videos in folders {pending}"
        )


def cmd_run(args):
    cfg = load_config()
    conn = connect()
    log.info("scheduler start (%d accounts)%s", len(cfg["accounts"]), " [dry-run]" if args.dry_run else "")
    while True:
        now = datetime.now()
        accounts = cfg["accounts"][:]
        random.shuffle(accounts)  # no fixed account order
        for acc in accounts:
            name = acc["name"]
            na, pu = get_state(conn, name)
            if pu and now < pu:
                continue
            if posted_today(conn, name, now) >= acc["daily_cap"]:
                continue
            if not in_window(acc, now):
                continue
            if na and now < na:
                continue
            post_one(conn, acc, args.dry_run)
            time.sleep(random.randint(20, 90))  # spacing between accounts
        time.sleep(60)


def main():
    setup_logging()
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init").set_defaults(fn=cmd_init)
    sub.add_parser("login").set_defaults(fn=cmd_login)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    p = sub.add_parser("once")
    p.add_argument("account")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(fn=cmd_once)
    p = sub.add_parser("run")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(fn=cmd_run)
    args = ap.parse_args()
    try:
        args.fn(args)
    except KeyboardInterrupt:
        log.info("stopped")


if __name__ == "__main__":
    main()
