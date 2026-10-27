#!/usr/bin/env python3
"""
reel_bot.py (Koyeb version) - Instagram Reel auto-poster using instagrapi (unofficial).

Runs as a background process next to the Node web service (see start.sh).
  * Config:   env ACCOUNTS_JSON (+ IG_PASS_<NAME> or IG_SESSIONID_<NAME>)
  * State:    Postgres (same DATABASE_URL), tables rb_posts / rb_state / rb_sessions
  * Videos:   the existing `library` table (Telegram uploads or video_url), downloaded just before posting
  * Keepalive: pings APP_BASE_URL/api/health so the free instance does not scale to zero

ACCOUNTS_JSON example:
{"unique_across_accounts": true,
 "accounts": [{"name":"acc1","username":"my_ig_name","daily_cap":2,
   "windows":["10:00-13:00","18:00-22:00"],"min_gap_min":120,"max_gap_min":300,
   "captions":["{Watch|Look at} this","{New|Fresh} reel"],
   "hashtags":["#reels","#viral","#explore"],"hashtags_per_post":2}]}

Optional env: REELBOT_DRY_RUN=true (log only, no upload), POST_TZ=Asia/Kolkata, TELEGRAM_BOT_TOKEN
Commands: run | check
"""
import argparse
import json
import logging
import os
import random
import re
import shutil
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo(os.environ.get("POST_TZ") or "Asia/Kolkata")
MAX_FAILS = 3
MAX_BYTES = 60 * 1024 * 1024
DRY_RUN = os.environ.get("REELBOT_DRY_RUN", "").strip().lower() in ("1", "true", "yes")
log = logging.getLogger("reelbot")

STATE = {}  # account -> {"next": datetime|None, "paused": datetime|None}   (in memory, saved to DB on change)
COUNT = {}  # account -> (YYYY-MM-DD, posts today)
_clients = {}


# ----------------------------------------------------------------- utils
_TOKEN_RE = re.compile(r"bot\d+:[A-Za-z0-9_-]+")


def redact(s):
    """Never let the Telegram bot token reach logs or the database."""
    return _TOKEN_RE.sub("bot[redacted]", str(s))


def spin(text):
    pat = re.compile(r"\{([^{}]*)\}")
    while pat.search(text):
        text = pat.sub(lambda m: random.choice(m.group(1).split("|")), text, count=1)
    return text


def build_caption(acc):
    cap = spin(random.choice(acc["captions"]))
    tags = [t if t.startswith("#") else "#" + t for t in acc["hashtags"]]  # "#" optional in config
    if tags:
        cap += "\n\n" + " ".join(random.sample(tags, min(acc["hashtags_per_post"], len(tags))))
    return cap


def parse_window(w):
    a, b = w.split("-")
    ah, am = map(int, a.strip().split(":"))
    bh, bm = map(int, b.strip().split(":"))
    return ah * 60 + am, bh * 60 + bm


def in_window(acc, now):
    m = now.hour * 60 + now.minute
    return any(s <= m <= e for s, e in map(parse_window, acc["windows"]))


# ----------------------------------------------------------------- config
def load_accounts():
    raw = os.environ.get("ACCOUNTS_JSON", "").strip()
    if len(raw) > 1 and raw[0] in "'\"" and raw[-1] == raw[0]:
        raw = raw[1:-1]  # Koyeb values often get pasted with quotes
    if not raw:
        sys.exit("ACCOUNTS_JSON env missing")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.exit(
            f"ACCOUNTS_JSON galat hai ({e.msg} at char {e.pos}, value ki lambai {len(raw)}). "
            "Value ek hi line mein, { se shuru aur } par khatam, aur '#' ya line break ke bina honi chahiye."
        )
    if isinstance(data, list):
        data = {"accounts": data}
    accounts = data["accounts"]
    for a in accounts:
        a.setdefault("daily_cap", 2)
        a.setdefault("windows", ["10:00-13:00", "18:00-22:00"])
        a.setdefault("min_gap_min", 120)
        a.setdefault("max_gap_min", 300)
        a.setdefault("proxy", None)
        a.setdefault("captions", ["{Check|Watch|Look at} this"])
        a.setdefault("hashtags", [])
        a.setdefault("hashtags_per_post", 3)
        a.setdefault("user_id", None)  # optional: only use library rows of this app user
    return accounts, bool(data.get("unique_across_accounts", True))


# ----------------------------------------------------------------- database
@contextmanager
def db():
    """Short-lived connection per operation (the free Postgres sleeps when idle)."""
    import psycopg2

    url = os.environ["DATABASE_URL"].strip().strip("\"'")
    kw = {"sslmode": "require"} if os.environ.get("DATABASE_SSL", "").strip().lower() == "true" else {}
    conn = psycopg2.connect(url, connect_timeout=30, **kw)
    try:
        with conn:
            with conn.cursor() as cur:
                yield cur
    finally:
        conn.close()


def init_db():
    with db() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS rb_posts(
              id SERIAL PRIMARY KEY,
              account TEXT NOT NULL, library_id TEXT NOT NULL, status TEXT NOT NULL,
              fails INT NOT NULL DEFAULT 0, media_pk TEXT, error TEXT, posted_at TIMESTAMPTZ,
              UNIQUE(account, library_id));
            CREATE TABLE IF NOT EXISTS rb_state(
              account TEXT PRIMARY KEY, next_allowed TIMESTAMPTZ, paused_until TIMESTAMPTZ);
            CREATE TABLE IF NOT EXISTS rb_sessions(
              account TEXT PRIMARY KEY, settings TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
            """
        )


def load_state(accounts):
    now = datetime.now(TZ)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    with db() as cur:
        cur.execute("SELECT account, next_allowed, paused_until FROM rb_state")
        for name, na, pu in cur.fetchall():
            STATE[name] = {"next": na, "paused": pu}
        cur.execute(
            "SELECT account, COUNT(*) FROM rb_posts WHERE status='posted' AND posted_at >= %s GROUP BY account",
            (day_start,),
        )
        for name, n in cur.fetchall():
            COUNT[name] = (now.strftime("%Y-%m-%d"), int(n))
    for a in accounts:
        STATE.setdefault(a["name"], {"next": None, "paused": None})
    if os.environ.get("REELBOT_CLEAR_PAUSE", "").strip().lower() in ("1", "true", "yes"):
        for st in STATE.values():
            st["paused"] = None
        with db() as cur:
            cur.execute("UPDATE rb_state SET paused_until = NULL")
        log.info("pauses cleared (REELBOT_CLEAR_PAUSE) - ab variable hata dijiye")


def save_state(name):
    st = STATE[name]
    with db() as cur:
        cur.execute(
            "INSERT INTO rb_state(account,next_allowed,paused_until) VALUES(%s,%s,%s) "
            "ON CONFLICT(account) DO UPDATE SET next_allowed=EXCLUDED.next_allowed, paused_until=EXCLUDED.paused_until",
            (name, st["next"], st["paused"]),
        )


def today_count(name, now):
    day, n = COUNT.get(name, ("", 0))
    return n if day == now.strftime("%Y-%m-%d") else 0


def load_session(name):
    with db() as cur:
        cur.execute("SELECT settings FROM rb_sessions WHERE account=%s", (name,))
        r = cur.fetchone()
    return json.loads(r[0]) if r else None


def save_session(name, settings):
    with db() as cur:
        cur.execute(
            "INSERT INTO rb_sessions(account,settings) VALUES(%s,%s) "
            "ON CONFLICT(account) DO UPDATE SET settings=EXCLUDED.settings, updated_at=now()",
            (name, json.dumps(settings)),
        )


def pick_video(acc, unique):
    q = """
      SELECT k.id::text, k.tg_file_id, k.video_url FROM library k
      WHERE (k.tg_file_id IS NOT NULL OR k.video_url IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM rb_posts p
          WHERE p.library_id = k.id::text AND p.status IN ('posted','quarantined')
            {acc_filter})
        {user_filter}
      ORDER BY k.created_at LIMIT 1"""
    params = []
    acc_filter = "" if unique else "AND p.account = %s"
    if not unique:
        params.append(acc["name"])
    user_filter = ""
    if acc.get("user_id"):
        user_filter = "AND k.user_id::text = %s"
        params.append(str(acc["user_id"]))
    with db() as cur:
        cur.execute(q.format(acc_filter=acc_filter, user_filter=user_filter), params)
        return cur.fetchone()


def record_fail(name, lib_id, inc, err):
    with db() as cur:
        cur.execute("SELECT fails FROM rb_posts WHERE account=%s AND library_id=%s", (name, lib_id))
        r = cur.fetchone()
        fails = (r[0] if r else 0) + inc
        status = "quarantined" if fails >= MAX_FAILS else "failed"
        cur.execute(
            "INSERT INTO rb_posts(account,library_id,status,fails,error) VALUES(%s,%s,%s,%s,%s) "
            "ON CONFLICT(account,library_id) DO UPDATE SET status=EXCLUDED.status, fails=EXCLUDED.fails, error=EXCLUDED.error",
            (name, lib_id, status, fails, redact(err)[:300]),
        )
    return status


# ----------------------------------------------------------------- download
def download(lib_id, tg_file_id, video_url, dest_dir):
    import requests

    if tg_file_id:
        token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
        if not token:
            raise RuntimeError("TELEGRAM_BOT_TOKEN missing (needed to download Telegram videos)")
        r = requests.post(f"https://api.telegram.org/bot{token}/getFile", json={"file_id": tg_file_id}, timeout=30)
        data = r.json()
        if not data.get("ok"):
            raise RuntimeError(f"Telegram getFile failed: {data.get('description')}")
        url = f"https://api.telegram.org/file/bot{token}/{data['result']['file_path']}"
    else:
        url = video_url
    dest = Path(dest_dir) / f"{lib_id}.mp4"
    size = 0
    with requests.get(url, stream=True, timeout=60) as resp:
        resp.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in resp.iter_content(1 << 20):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise RuntimeError("video too large")
                f.write(chunk)
    return dest


# ----------------------------------------------------------------- instagram
def make_client(acc):
    from instagrapi import Client

    name = acc["name"]
    cl = Client()
    cl.delay_range = [2, 6]
    password = os.environ.get(f"IG_PASS_{name.upper()}", "").strip()
    sessionid = os.environ.get(f"IG_SESSIONID_{name.upper()}", "").strip()

    settings = load_session(name)
    ok = False
    if settings:
        cl.set_settings(settings)
        if acc.get("proxy"):
            cl.set_proxy(acc["proxy"])
        try:
            cl.get_timeline_feed()  # cheap check that the stored session still works
            ok = True
        except Exception as e:  # noqa: BLE001
            log.warning("%s: stored session invalid (%s), logging in again", name, redact(e)[:120])
            old = cl.get_settings()
            cl.set_settings({})
            cl.set_uuids(old.get("uuids", {}))
    if not ok:
        if acc.get("proxy"):
            cl.set_proxy(acc["proxy"])
        if sessionid:
            cl.login_by_sessionid(sessionid)
        elif password:
            code = cl.totp_generate_code(acc["totp_secret"]) if acc.get("totp_secret") else ""
            cl.login(acc["username"], password, verification_code=code)
        else:
            raise RuntimeError(f"{name}: set IG_PASS_{name.upper()} or IG_SESSIONID_{name.upper()}")
    save_session(name, cl.get_settings())
    return cl


def get_client(acc):
    if acc["name"] not in _clients:
        _clients[acc["name"]] = make_client(acc)
    return _clients[acc["name"]]


def classify(exc):
    from instagrapi.exceptions import (
        BadPassword, ChallengeRequired, LoginRequired, PleaseWaitFewMinutes, RateLimitError, TwoFactorRequired,
    )

    if isinstance(exc, (ChallengeRequired, LoginRequired, BadPassword, TwoFactorRequired)):
        return "auth", timedelta(hours=12)
    if isinstance(exc, (PleaseWaitFewMinutes, RateLimitError)):
        return "rate", timedelta(hours=1)
    return "other", timedelta(minutes=20)


# ----------------------------------------------------------------- posting
def post_one(acc, unique):
    name = acc["name"]
    st = STATE[name]
    now = datetime.now(TZ)

    row = pick_video(acc, unique)
    if not row:
        st["next"] = now + timedelta(minutes=15)  # memory only: do not wake the DB every minute
        log.info("%s: library mein koi naya video nahi (Telegram bot se video bhejiye)", name)
        return
    lib_id, tg_file_id, video_url = row
    caption = build_caption(acc)

    if DRY_RUN:
        st["next"] = now + timedelta(minutes=random.randint(acc["min_gap_min"], acc["max_gap_min"]))
        log.info("[dry-run] %s would post library %s | caption: %s", name, lib_id, caption.replace("\n", " "))
        return

    tmp = tempfile.mkdtemp(prefix="rb_")
    try:
        path = download(lib_id, tg_file_id, video_url, tmp)
        cl = get_client(acc)
        media = cl.clip_upload(path, caption)
    except Exception as e:  # noqa: BLE001
        kind, wait = classify(e)
        _clients.pop(name, None)
        msg = redact(e)
        status = record_fail(name, lib_id, 1 if kind == "other" else 0, msg)
        st["paused"] = now + wait
        save_state(name)
        log.error("%s: upload fail (%s): %s -> pause %s [%s]", name, kind, msg[:200], wait, status)
        return
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    with db() as cur:
        cur.execute(
            "INSERT INTO rb_posts(account,library_id,status,media_pk,posted_at) VALUES(%s,%s,'posted',%s,%s) "
            "ON CONFLICT(account,library_id) DO UPDATE SET status='posted', media_pk=EXCLUDED.media_pk, posted_at=EXCLUDED.posted_at",
            (name, lib_id, str(media.pk), now),
        )
    day = now.strftime("%Y-%m-%d")
    COUNT[name] = (day, today_count(name, now) + 1)
    gap = random.randint(acc["min_gap_min"], acc["max_gap_min"])
    st["next"] = now + timedelta(minutes=gap)
    save_state(name)
    log.info("%s: POSTED library %s (pk=%s). next in ~%d min", name, lib_id, media.pk, gap)


def due(acc, now):
    st = STATE[acc["name"]]
    if st["paused"] and now < st["paused"]:
        return False
    if today_count(acc["name"], now) >= acc["daily_cap"]:
        return False
    if not in_window(acc, now):
        return False
    if st["next"] and now < st["next"]:
        return False
    return True


def keepalive():
    import requests

    base = os.environ.get("APP_BASE_URL", "").strip().strip("\"'").rstrip("/")
    if not base.startswith("https://"):
        return
    while True:
        time.sleep(240)
        try:
            requests.get(base + "/api/health", timeout=15)
        except Exception:  # noqa: BLE001
            pass


# ----------------------------------------------------------------- commands
def cmd_check(_):
    accounts, unique = load_accounts()
    init_db()
    with db() as cur:
        cur.execute("SELECT COUNT(*) FROM library")
        n = cur.fetchone()[0]
    print(f"OK: {len(accounts)} account(s), unique_across_accounts={unique}, library rows={n}, tz={TZ}")


def cmd_run(_):
    accounts, unique = load_accounts()
    init_db()
    load_state(accounts)
    threading.Thread(target=keepalive, daemon=True).start()
    log.info("reelbot start: %d account(s), tz=%s%s", len(accounts), TZ, " [DRY-RUN]" if DRY_RUN else "")
    while True:
        try:
            now = datetime.now(TZ)
            random.shuffle(accounts)
            for acc in accounts:
                if due(acc, now):
                    post_one(acc, unique)
                    time.sleep(random.randint(20, 90))
        except Exception as e:  # noqa: BLE001 - never let the loop die
            log.error("loop error: %s", redact(e)[:300])
            time.sleep(120)
        time.sleep(60)


def main():
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(asctime)s %(levelname)s %(message)s")
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run").set_defaults(fn=cmd_run)
    sub.add_parser("check").set_defaults(fn=cmd_check)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
