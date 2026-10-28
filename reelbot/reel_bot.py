#!/usr/bin/env python3
"""
reel_bot.py (Koyeb, Session-ID mode) - posts the dashboard's scheduled Reels with instagrapi (unofficial).

How it fits together
  * Dashboard "Session ID se connect karo" saves the cookie ENCRYPTED in instagram_accounts (auth_type='session', status='pending').
  * This worker verifies it, fills in the real username and sets status='active'  -> the account shows on the home page.
  * The normal Posting Plan / Telegram library / caption / cover create rows in `reels` (status 'scheduled').
    The official Node publisher ignores session accounts; this worker posts them:
        download video from Telegram (or video_url) -> clip_upload -> mark published/failed.
  * Everything lives in Postgres (same DATABASE_URL), nothing on the container disk except temp files.

Env used: DATABASE_URL, DATABASE_SSL, TOKEN_ENCRYPTION_KEY, TELEGRAM_BOT_TOKEN (same as the web app),
          optional: IG_DAILY_POST_CAP (default 10), IG_PROXY, APP_BASE_URL (keep-alive ping)
Commands: run | check
"""
import argparse
import base64
import hashlib
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
from pathlib import Path

log = logging.getLogger("reelbot")

MAX_BYTES = 60 * 1024 * 1024
MAX_ATTEMPTS = 3
TICK_SECONDS = 15
JOBS_PER_TICK = 3


def _int_env(name, default, lo, hi):
    try:
        v = int(float(os.environ.get(name, "") or default))
    except ValueError:
        v = default
    return max(lo, min(hi, v))


DAILY_CAP = _int_env("IG_DAILY_POST_CAP", 10, 1, 25)

_clients = {}  # account id -> instagrapi Client


# ----------------------------------------------------------------- utils
_SECRET_PATTERNS = [
    re.compile(r"bot\d+:[A-Za-z0-9_-]+"),  # Telegram bot token inside URLs
    re.compile(r"\d{5,}(?:%3A|:)[A-Za-z0-9_.%-]{20,}"),  # Instagram sessionid
    re.compile(r"sessionid=[^;\s'\"]+", re.I),
]


def redact(value):
    """Never let tokens or session ids reach logs or the database."""
    s = str(value)
    for p in _SECRET_PATTERNS:
        s = p.sub("[redacted]", s)
    return s


def spin(text):
    """{a|b|c} -> random choice, so captions can vary."""
    pat = re.compile(r"\{([^{}]*)\}")
    while pat.search(text):
        text = pat.sub(lambda m: random.choice(m.group(1).split("|")), text, count=1)
    return text


# ----------------------------------------------------------------- database
@contextmanager
def db():
    """Short-lived connection per operation (works well with a sleepy free Postgres)."""
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
            """CREATE TABLE IF NOT EXISTS rb_sessions(
                 account TEXT PRIMARY KEY, settings TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())"""
        )
        # This worker is the only one posting session accounts. After a restart nothing is really in flight,
        # so leftovers are marked failed (NOT retried: they may have been posted, never risk a duplicate).
        cur.execute(
            """UPDATE reels SET status = 'failed',
                 error = 'Restart ke dauran interrupt hua. Instagram profile check karo, dobara auto-post nahi kiya.'
               WHERE status = 'publishing'
                 AND instagram_account_id IN (SELECT id FROM instagram_accounts WHERE auth_type = 'session')"""
        )


def decrypt_token(payload):
    """Same format as the web app's encryptToken(): v1:iv:tag:ciphertext (AES-256-GCM, scrypt key)."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key = hashlib.scrypt(
        os.environ["TOKEN_ENCRYPTION_KEY"].encode("utf-8"),
        salt=b"reel-scheduler-token-key-v1",
        n=16384, r=8, p=1, dklen=32, maxmem=64 * 1024 * 1024,
    )
    v, iv, tag, ct = payload.split(":")
    if v != "v1":
        raise ValueError("bad token payload")
    b = base64.b64decode
    return AESGCM(key).decrypt(b(iv), b(ct) + b(tag), None).decode("utf-8")


def load_settings(acc_id):
    with db() as cur:
        cur.execute("SELECT settings FROM rb_sessions WHERE account = %s", (acc_id,))
        r = cur.fetchone()
    return json.loads(r[0]) if r else None


def save_settings(acc_id, settings):
    with db() as cur:
        cur.execute(
            "INSERT INTO rb_sessions(account, settings) VALUES (%s, %s) "
            "ON CONFLICT (account) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()",
            (acc_id, json.dumps(settings)),
        )


# ----------------------------------------------------------------- instagram
AUTH_ERRORS = {
    "LoginRequired", "ChallengeRequired", "BadPassword", "TwoFactorRequired", "ClientLoginRequired",
    "ChallengeUnknownStep", "SelectContactPointRecoveryForm", "RecaptchaChallengeForm",
    "ReloginAttemptExceeded", "CheckpointRequired", "ConsentRequired",
}
RATE_ERRORS = {"PleaseWaitFewMinutes", "RateLimitError", "FeedbackRequired", "ClientThrottledError"}


def classify(exc):
    names = {c.__name__ for c in type(exc).__mro__}
    text = str(exc).lower()
    if names & AUTH_ERRORS or "login_required" in text or "checkpoint_required" in text or "challenge_required" in text:
        return "auth"
    if names & RATE_ERRORS or "please wait a few minutes" in text or "rate limit" in text:
        return "rate"
    return "other"


AUTH_MESSAGE = "Session ID expire ho gaya ya Instagram ne verification maanga. Instagram app/browser mein check karke naya session ID daalo."


def make_client(acc_id, sessionid):
    from instagrapi import Client

    proxy = os.environ.get("IG_PROXY", "").strip()

    def fresh():
        c = Client()
        c.delay_range = [2, 6]
        return c

    cl = fresh()
    ok = False
    settings = load_settings(acc_id)
    if settings:
        try:
            cl.set_settings(settings)
            if proxy:
                cl.set_proxy(proxy)
            cl.get_timeline_feed()  # cheap check that the stored session still works
            ok = True
        except Exception as e:  # noqa: BLE001
            log.warning("%s: stored session not valid (%s), using the saved Session ID again", acc_id[:8], redact(e)[:120])
            old = cl.get_settings()
            cl = fresh()
            cl.set_uuids(old.get("uuids", {}))
    if not ok:
        if proxy:
            cl.set_proxy(proxy)
        cl.login_by_sessionid(sessionid)
    save_settings(acc_id, cl.get_settings())
    return cl


def get_client(acc_id, sessionid):
    if acc_id not in _clients:
        _clients[acc_id] = make_client(acc_id, sessionid)
    return _clients[acc_id]


def account_secret(acc_id):
    with db() as cur:
        cur.execute("SELECT access_token_encrypted, username FROM instagram_accounts WHERE id = %s::uuid", (acc_id,))
        r = cur.fetchone()
    if not r:
        raise RuntimeError("account removed")
    return decrypt_token(r[0]), r[1]


def mark_account(acc_id, status, message):
    with db() as cur:
        cur.execute(
            "UPDATE instagram_accounts SET status = %s, last_error = %s WHERE id = %s::uuid AND status IN ('active', 'pending')",
            (status, message[:400], acc_id),
        )


# ----------------------------------------------------------------- verify new Session IDs
def verify_pending():
    import psycopg2.errors

    with db() as cur:
        cur.execute(
            "SELECT id::text, access_token_encrypted FROM instagram_accounts "
            "WHERE auth_type = 'session' AND status = 'pending' ORDER BY connected_at LIMIT 3"
        )
        rows = cur.fetchall()
    for acc_id, enc in rows:
        try:
            sid = decrypt_token(enc)
            cl = make_client(acc_id, sid)
            try:
                info = cl.account_info()
                username, pk = info.username, str(info.pk)
            except Exception as e:  # noqa: BLE001 - some profiles fail model validation; fall back
                if classify(e) == "auth":
                    raise
                pk = str(cl.user_id)
                username = cl.user_info_v1(int(pk)).username
        except Exception as e:  # noqa: BLE001
            kind = classify(e)
            msg = AUTH_MESSAGE if kind == "auth" else f"Session verify nahi hua: {redact(e)[:200]}"
            log.error("%s: verify failed (%s): %s", acc_id[:8], kind, redact(e)[:200])
            mark_account(acc_id, "expired", msg)
            continue
        try:
            with db() as cur:
                cur.execute(
                    "UPDATE instagram_accounts SET instagram_user_id = %s, username = %s, status = 'active', "
                    "last_error = NULL, connected_at = now() WHERE id = %s::uuid AND status = 'pending'",
                    (pk, username, acc_id),
                )
            _clients[acc_id] = cl
            log.info("session account verified: @%s", username)
        except psycopg2.errors.UniqueViolation:
            mark_account(acc_id, "revoked", f"@{username} pehle se connected hai. Purana account disconnect karke dobara try karo.")


# ----------------------------------------------------------------- posting
def download(url, dest):
    import requests

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


def fetch_video(reel_id, tg_file_id, video_url, tmp):
    import requests

    if tg_file_id:
        token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
        if not token:
            raise RuntimeError("TELEGRAM_BOT_TOKEN missing")
        r = requests.post(f"https://api.telegram.org/bot{token}/getFile", json={"file_id": tg_file_id}, timeout=30).json()
        if not r.get("ok"):
            raise RuntimeError(f"Telegram getFile failed: {r.get('description')}")
        url = f"https://api.telegram.org/file/bot{token}/{r['result']['file_path']}"
    elif video_url:
        url = video_url
    else:
        raise RuntimeError("This post has no video attached.")
    return download(url, Path(tmp) / f"{reel_id}.mp4")


def fetch_cover(cover_url, tmp):
    """The dashboard's fixed cover (JPG). Optional: any problem just means Instagram picks its own frame."""
    if not cover_url:
        return None
    try:
        return download(cover_url, Path(tmp) / "cover.jpg")
    except Exception as e:  # noqa: BLE001
        log.warning("cover skipped: %s", redact(e)[:120])
        return None


def claim_next():
    with db() as cur:
        cur.execute(
            """UPDATE reels r SET status = 'publishing', attempts = r.attempts + 1, error = NULL
               WHERE r.id = (
                 SELECT r2.id FROM reels r2
                 JOIN instagram_accounts a ON a.id = r2.instagram_account_id
                 WHERE a.auth_type = 'session' AND a.status = 'active'
                   AND r2.status = 'scheduled' AND r2.scheduled_at <= now()
                   AND NOT EXISTS (SELECT 1 FROM reels x WHERE x.instagram_account_id = r2.instagram_account_id AND x.status = 'publishing')
                 ORDER BY r2.scheduled_at, r2.created_at
                 LIMIT 1
                 FOR UPDATE OF r2 SKIP LOCKED)
               RETURNING r.id::text, r.instagram_account_id::text, r.tg_file_id, r.video_url, r.cover_url, r.caption, r.attempts"""
        )
        return cur.fetchone()


def requeue(reel_id, delay_s, burn_attempt, reason):
    with db() as cur:
        cur.execute(
            """UPDATE reels SET status = 'scheduled', scheduled_at = now() + make_interval(secs => %s),
                 attempts = GREATEST(attempts - %s, 0), error = %s
               WHERE id = %s::uuid AND status = 'publishing'""",
            (int(delay_s), 0 if burn_attempt else 1, redact(reason)[:400], reel_id),
        )


def fail_job(reel_id, message):
    with db() as cur:
        cur.execute(
            "UPDATE reels SET status = 'failed', error = %s WHERE id = %s::uuid AND status <> 'published'",
            (redact(message)[:500], reel_id),
        )


def push_account_back(acc_id, minutes):
    with db() as cur:
        cur.execute(
            """UPDATE reels SET scheduled_at = GREATEST(scheduled_at, now() + make_interval(mins => %s))
               WHERE instagram_account_id = %s::uuid AND status = 'scheduled'""",
            (int(minutes), acc_id),
        )


def published_last_24h(acc_id):
    with db() as cur:
        cur.execute(
            "SELECT count(*) FROM reels WHERE instagram_account_id = %s::uuid AND status = 'published' "
            "AND published_at > now() - interval '24 hours'",
            (acc_id,),
        )
        return cur.fetchone()[0]


def mark_published(reel_id, acc_id, media_pk):
    last = None
    for _ in range(3):  # the post is already live: make sure the result gets saved
        try:
            with db() as cur:
                cur.execute(
                    "UPDATE reels SET status = 'published', ig_media_id = %s, published_at = now(), error = NULL WHERE id = %s::uuid",
                    (str(media_pk), reel_id),
                )
                cur.execute(
                    "UPDATE instagram_accounts SET last_used_at = now(), last_error = NULL WHERE id = %s::uuid", (acc_id,)
                )
            return
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(3)
    log.error("POSTED but could not save result for reel %s: %s", reel_id, redact(last)[:200])


def run_job(job):
    reel_id, acc_id, tg_file_id, video_url, cover_url, caption, attempts = job

    if published_last_24h(acc_id) >= DAILY_CAP:
        requeue(reel_id, 3600, False, "Daily posting limit reached; will try again later.")
        log.info("%s: daily cap (%d) reached, waiting", acc_id[:8], DAILY_CAP)
        return

    tmp = tempfile.mkdtemp(prefix="rb_")
    phase = "prepare"
    try:
        sid, username = account_secret(acc_id)
        video = fetch_video(reel_id, tg_file_id, video_url, tmp)
        thumb = fetch_cover(cover_url, tmp)
        cl = get_client(acc_id, sid)
        phase = "upload"
        media = cl.clip_upload(video, spin(caption or ""), thumbnail=thumb)
    except Exception as e:  # noqa: BLE001
        kind = classify(e)
        msg = redact(e)
        _clients.pop(acc_id, None)
        if kind == "auth":
            mark_account(acc_id, "expired", AUTH_MESSAGE)
            requeue(reel_id, 60, False, "Waiting for a new Session ID.")
            log.error("%s: session problem: %s", acc_id[:8], msg[:200])
        elif kind == "rate":
            push_account_back(acc_id, 30)
            requeue(reel_id, 30 * 60, False, "Instagram rate limit; will try again later.")
            log.error("%s: rate limited: %s -> pause 30 min", acc_id[:8], msg[:200])
        elif phase == "prepare":
            if attempts < MAX_ATTEMPTS:
                delay = min(1800, 120 * 2 ** max(attempts - 1, 0))
                requeue(reel_id, delay, True, f"Temporary problem, retrying: {msg[:200]}")
            else:
                fail_job(reel_id, msg)
            log.error("%s: prepare failed (attempt %d): %s", acc_id[:8], attempts, msg[:200])
        else:
            # Outcome of the upload is unknown: it may be live. Never retry automatically.
            fail_job(reel_id, f"Instagram ne confirm nahi kiya, dobara try nahi kiya (duplicate se bachne ke liye). Profile check karo. ({msg[:150]})")
            log.error("%s: upload outcome unknown: %s", acc_id[:8], msg[:200])
        return
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    mark_published(reel_id, acc_id, media.pk)
    log.info("@%s: POSTED reel %s (pk=%s)", username, reel_id[:8], media.pk)


def process_due():
    for _ in range(JOBS_PER_TICK):
        job = claim_next()
        if not job:
            break
        run_job(job)
        time.sleep(random.randint(5, 20))


# ----------------------------------------------------------------- housekeeping + commands
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


def cmd_check(_):
    init_db()
    with db() as cur:
        cur.execute("SELECT status, count(*) FROM instagram_accounts WHERE auth_type = 'session' GROUP BY status")
        accs = dict(cur.fetchall())
        cur.execute(
            "SELECT count(*) FROM reels r JOIN instagram_accounts a ON a.id = r.instagram_account_id "
            "WHERE a.auth_type = 'session' AND r.status = 'scheduled'"
        )
        waiting = cur.fetchone()[0]
    print(f"OK: session accounts={accs or 0}, scheduled reels waiting={waiting}, daily cap={DAILY_CAP}")


def cmd_run(_):
    init_db()
    threading.Thread(target=keepalive, daemon=True).start()
    log.info("reelbot start (session-ID mode), daily cap %d/account", DAILY_CAP)
    while True:
        try:
            verify_pending()
            process_due()
        except Exception as e:  # noqa: BLE001 - never let the loop die
            log.error("loop error: %s", redact(e)[:300])
            time.sleep(60)
        time.sleep(TICK_SECONDS)


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
