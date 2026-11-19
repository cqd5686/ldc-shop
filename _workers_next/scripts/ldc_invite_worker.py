"""Qinglong task for paid LDC orders. Only this host uses the Linux DO sessions."""

import datetime as dt
import email.utils
import fcntl
import os
from pathlib import Path
import re
import sqlite3
import sys
import time

import requests


LDO = "https://linux.do"
SHOP = "https://shop.5881552.xyz/api/internal/invite-jobs"
DATA = Path(os.environ.get("LDC_INVITE_DATA", "/ql/data/db/ldc-invite"))
DAY = 24 * 60 * 60
COOLDOWN = 72 * 60 * 60
ACCOUNTS = ("A", "B", "C", "D")
LINK = re.compile(r"https://linux\.do/invites/[A-Za-z0-9_-]+(?:\?[^\s#]*)?")
TIMEOUT = (8, 20)


class InviteUncertain(Exception):
    """The site may already have created the invitation."""


class AccountUnavailable(Exception):
    def __init__(self, retry_after=0):
        super().__init__()
        self.retry_after = retry_after


class JobClosed(Exception):
    """The shop has already ended this claim."""


def api(token, action, **data):
    response = requests.post(
        SHOP, json={"action": action, **data},
        headers={"Authorization": f"Bearer {token}"},
        timeout=TIMEOUT, allow_redirects=False,
    )
    if response.status_code == 409:
        raise JobClosed
    response.raise_for_status()
    if response.status_code != 200:
        raise RuntimeError("unexpected shop HTTP status")
    return response.json()


def cooldown_seconds(response, payload):
    extras = payload.get("extras")
    values = [response.headers.get("Retry-After")]
    if isinstance(extras, dict):
        values.append(extras.get("wait_seconds"))
    seconds = []
    for value in values:
        try:
            seconds.append(int(value))
            continue
        except (TypeError, ValueError):
            pass
        if isinstance(value, str):
            try:
                seconds.append(int(email.utils.parsedate_to_datetime(value).timestamp() - time.time()))
            except (TypeError, ValueError, OverflowError):
                pass
    return max(1, *seconds) if seconds else COOLDOWN


def valid_session(cookie):
    session = requests.Session()
    for part in cookie.split(";"):
        name, separator, value = part.strip().partition("=")
        if separator and name:
            session.cookies.set(name, value, domain="linux.do", path="/")
    session.headers.update({
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": f"{LDO}/",
    })
    try:
        response = session.get(f"{LDO}/session/csrf", timeout=TIMEOUT, allow_redirects=False)
        if response.status_code == 429:
            session.close()
            raise AccountUnavailable(cooldown_seconds(response, {}))
        csrf = response.json().get("csrf") if response.status_code == 200 else None
        if csrf:
            session.headers["X-CSRF-Token"] = csrf
            return session
    except (requests.RequestException, ValueError, AttributeError):
        pass
    session.close()
    raise AccountUnavailable


def generate(session):
    requested_expiry = int(time.time()) + DAY
    expiry_param = dt.datetime.fromtimestamp(requested_expiry, dt.timezone.utc).isoformat(timespec="seconds")
    try:
        response = session.post(
            f"{LDO}/invites", timeout=TIMEOUT, allow_redirects=False,
            headers={"Origin": LDO, "Discourse-Present": "true", "Discourse-Logged-In": "true"},
            data={"max_redemptions_allowed": "1", "expires_at": expiry_param},
        )
    except requests.RequestException as exc:
        raise InviteUncertain from exc
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    if response.status_code == 429:
        raise AccountUnavailable(cooldown_seconds(response, payload))
    if response.status_code in (301, 302, 303, 307, 308, 401, 403, 422):
        raise AccountUnavailable
    if not response.ok:
        raise InviteUncertain

    link = payload.get("link")
    try:
        actual_expiry = dt.datetime.fromisoformat(payload["expires_at"].replace("Z", "+00:00"))
        expires_at = min(requested_expiry * 1000, int(actual_expiry.timestamp() * 1000))
    except (KeyError, ValueError, AttributeError, OverflowError) as exc:
        raise InviteUncertain from exc
    if not isinstance(link, str) or not LINK.fullmatch(link) or expires_at <= time.time() * 1000:
        raise InviteUncertain
    return link, expires_at


def remember_cooldown(db, account, seconds):
    db.execute("INSERT OR REPLACE INTO cooldowns VALUES (?, ?)", (account, int(time.time()) + seconds))


def save_report(db, job, kind, link=None, expiry=None):
    db.execute(
        "INSERT OR REPLACE INTO reports VALUES (?, ?, ?, ?, ?)",
        (job["orderId"], job["lease"], kind, link, expiry),
    )


def flush_reports(db, token):
    rows = db.execute("SELECT order_id, lease, kind, link, expires_at FROM reports").fetchall()
    for order_id, lease, kind, link, expiry in rows:
        job = {"orderId": order_id, "lease": lease}
        try:
            if kind == "deliver" and expiry > time.time() * 1000:
                try:
                    api(token, "deliver", **job, link=link, expiresAt=expiry)
                except requests.HTTPError as exc:
                    if exc.response.status_code != 422:
                        raise
                    api(token, "manual", **job, reason="uncertain")
            else:
                api(token, "manual", **job, reason="unavailable" if kind == "unavailable" else "uncertain")
        except JobClosed:
            pass
        db.execute("DELETE FROM reports WHERE order_id = ?", (order_id,))
        db.commit()


def work(db, token):
    flush_reports(db, token)
    job = api(token, "claim").get("job")
    if not job:
        return
    cooldowns = dict(db.execute("SELECT account, until_at FROM cooldowns"))
    for account in ACCOUNTS:
        cookie = os.environ.get(f"LINUXDO_COOKIE_{account}", "").strip()
        if not cookie or cooldowns.get(account, 0) > time.time():
            continue
        try:
            session = valid_session(cookie)
        except AccountUnavailable as exc:
            if exc.retry_after:
                remember_cooldown(db, account, exc.retry_after)
                db.commit()
            continue
        with session:
            try:
                api(token, "start", **job)
            except JobClosed:
                return
            save_report(db, job, "uncertain")
            db.commit()
            try:
                link, expiry = generate(session)
            except AccountUnavailable as exc:
                if exc.retry_after:
                    remember_cooldown(db, account, exc.retry_after)
                db.execute("DELETE FROM reports WHERE order_id = ?", (job["orderId"],))
                db.commit()
                continue
            except InviteUncertain:
                break
            remember_cooldown(db, account, COOLDOWN)
            save_report(db, job, "deliver", link, expiry)
            db.commit()
            break
    else:
        save_report(db, job, "unavailable")
        db.commit()
    flush_reports(db, token)


def main():
    os.umask(0o077)
    DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
    token = (DATA / "token").read_text(encoding="ascii").strip()
    if "--check" in sys.argv:
        api(token, "status")
        configured = sum(bool(os.environ.get(f"LINUXDO_COOKIE_{a}", "").strip()) for a in ACCOUNTS)
        print(f"Shop connection verified. Qinglong account variables: {configured}/{len(ACCOUNTS)}")
        return
    with (DATA / "lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        with sqlite3.connect(DATA / "worker.sqlite3") as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS cooldowns (account TEXT PRIMARY KEY, until_at INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS reports (
                    order_id TEXT PRIMARY KEY, lease TEXT NOT NULL, kind TEXT NOT NULL,
                    link TEXT, expires_at INTEGER
                );
            """)
            work(db, token)


if __name__ == "__main__":
    try:
        main()
    except (OSError, requests.RequestException, RuntimeError, ValueError, sqlite3.Error) as error:
        # Exception bodies can include provider data. Leave secrets out of Qinglong logs.
        print(f"Invite task failed ({type(error).__name__})", file=sys.stderr)
        sys.exit(1)
