"""TimeTree予定Relayを利用するローカルstdio MCP。

RelayのHTTP APIだけを呼び出す。認証値・Cookie・CSRFトークンは扱わない。
追加・削除はIdempotency-Keyで管理され、失敗・結果不明の操作を新しいキーで再送しない。
"""

import json
import os
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations

REPOSITORY = Path(__file__).resolve().parents[1]
SERVER_PACKAGE = REPOSITORY / "packages" / "server"
DEFAULT_TIMEZONE = "Asia/Tokyo"

READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)
DELETE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=True, openWorldHint=False)

mcp = FastMCP(
    "timetree-relay",
    instructions=(
        "TimeTreeの予定追加・削除・一覧のためのMCP。最初にtimetree_statusで接続とアカウントを確認する。"
        "追加・削除はユーザーの明示的な依頼があるときだけ行う。"
        "共有カレンダーへ追加するときは出席者とラベルを確認し、ラベルはlabelIdかラベル名、"
        "出席者はメンバー名かユーザーIDで指定する。"
        "削除はイベントIDかタイトルと日付で対象を一意に特定し、繰り返し予定はユーザーの確認が必要。"
        "処理中・結果不明の操作は同じ操作IDで状態を確認し、新しいキーで再送しない。"
        "ログイン・パスワード入力・2FA・アカウント設定の自動化は提供しない。"
    ),
    log_level="ERROR",
)


def _settings() -> dict[str, Any]:
    path = os.environ.get("TIMETREE_RELAY_SETTINGS")
    candidates = (
        [Path(path)]
        if path
        else [SERVER_PACKAGE / "settings.json", REPOSITORY / "settings.json"]
    )
    for candidate in candidates:
        if candidate.is_file():
            try:
                return json.loads(candidate.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                break
    raise ToolError("settings.jsonを読み込めません。Relayリポジトリの設定を確認してください")


def _port() -> int:
    try:
        return int(_settings().get("port", 3100))
    except (TypeError, ValueError):
        return 3100


def _token() -> str:
    token = os.environ.get("TIMETREE_RELAY_API_TOKEN", "")
    if not token:
        raise ToolError("環境変数 TIMETREE_RELAY_API_TOKEN が設定されていません")
    return token


def _health_ok() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{_port()}/health", timeout=5) as response:
            return response.status == 200
    except Exception:
        return False


def _ensure_relay() -> None:
    if _health_ok():
        return
    try:
        subprocess.Popen(
            ["pnpm", "start:relay"],
            cwd=str(SERVER_PACKAGE),
            shell=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        raise ToolError("Relayを起動できません。手動で pnpm start:relay を実行してください") from None
    deadline = time.time() + 60
    while time.time() < deadline:
        if _health_ok():
            return
        time.sleep(1)
    raise ToolError("Relayが起動しませんでした。ビルド・設定・セッションを確認してください")


def _request(method: str, endpoint: str, profile: str = "", key: str = "", payload: dict | None = None) -> dict:
    _ensure_relay()
    url = f"http://127.0.0.1:{_port()}/{endpoint}"
    headers = {"Authorization": f"Bearer {_token()}"}
    if profile:
        headers["x-profile-name"] = profile
    if key:
        headers["Idempotency-Key"] = key
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise ToolError(f"RelayがHTTP {error.code}を返しました: {detail}") from None
    except Exception:
        raise ToolError("Relayへの接続に失敗しました。起動状態を確認してください") from None


def _profile(explicit: str) -> str:
    listing = _request("GET", "v1/accounts")["data"]
    profile = explicit or (listing.get("selected") or {}).get("profile")
    if not profile:
        profiles = [account["profile"] for account in listing.get("accounts", [])]
        if len(profiles) == 1:
            return profiles[0]
        raise ToolError("アカウントを一意に特定できません。アカウントを選択するか profile を指定してください")
    if not any(account["profile"] == profile for account in listing.get("accounts", [])):
        raise ToolError("指定されたプロファイルは登録されていません")
    return profile


def _resolve_calendar(calendar: str, profile: str) -> dict[str, Any]:
    calendars = _request("GET", "v1/calendars", profile)["data"]["items"]
    for item in calendars:
        if item["id"] == calendar or item["name"] == calendar:
            return item
    raise ToolError(f"カレンダーが見つかりません: {calendar}")


def _resolve_label(calendar_item: dict[str, Any], label: str) -> int:
    labels = calendar_item.get("labels", [])
    for item in labels:
        if str(item["id"]) == str(label) or item["name"] == label:
            return int(item["id"])
    available = ", ".join(f"{item['id']}:{item['name'] or '(無名)'}" for item in labels)
    raise ToolError(f"ラベルが見つかりません: {label} (利用可能: {available})")


def _resolve_attendees(calendar_item: dict[str, Any], attendees: list[str]) -> list[int]:
    members = calendar_item.get("members", [])
    resolved: list[int] = []
    for attendee in attendees:
        for member in members:
            if str(member["userId"]) == str(attendee) or member["name"] == attendee:
                resolved.append(int(member["userId"]))
                break
        else:
            available = ", ".join(f"{member['userId']}:{member['name']}" for member in members)
            raise ToolError(f"出席者が見つかりません: {attendee} (利用可能: {available})")
    return resolved


def _wait_job(job_id: str, timeout_seconds: int = 60) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        job = _request("GET", f"v1/event-jobs/{job_id}")["data"]
        if job["state"] in {"created", "deleted", "failed", "unknown"}:
            return job
        time.sleep(1)
    raise ToolError("操作が完了しませんでした。GET /v1/event-jobs/{id} で同じ操作IDを確認してください")


def _event_local_date(event: dict[str, Any], tz: str) -> str:
    start = datetime.fromisoformat(event["startAt"].replace("Z", "+00:00"))
    try:
        return start.astimezone(ZoneInfo(tz)).strftime("%Y-%m-%d")
    except Exception:
        return start.astimezone(ZoneInfo(DEFAULT_TIMEZONE)).strftime("%Y-%m-%d")


@mcp.tool(title="TimeTreeの接続とアカウント確認", annotations=READ)
def timetree_status() -> dict:
    """Relayの接続、登録アカウント、選択中のアカウントを確認する。最初に必ず実行する。"""
    listing = _request("GET", "v1/accounts")["data"]
    return {
        "accounts": [
            {
                "profile": account["profile"],
                "state": account["state"],
                "accountId": account["accountId"],
                "accountName": account["accountName"],
            }
            for account in listing["accounts"]
        ],
        "selected": listing.get("selected"),
    }


@mcp.tool(title="TimeTreeのカレンダー一覧", annotations=READ)
def timetree_list_calendars(profile: str = "") -> dict:
    """操作できるカレンダーの一覧を返す。"""
    return _request("GET", "v1/calendars", _profile(profile))


@mcp.tool(title="TimeTreeの予定一覧", annotations=READ)
def timetree_list_events(calendar: str, days: int = 14, profile: str = "") -> dict:
    """カレンダーの予定を今日以降指定日数分だけ返す。calendar は名前でもIDでも指定できる。
    共有カレンダーの予定には出席者とラベル名も付ける。"""
    resolved_profile = _profile(profile)
    resolved = _resolve_calendar(calendar, resolved_profile)
    now = datetime.now(timezone.utc)
    params = (
        f"calendarId={urllib.parse.quote(resolved['id'])}"
        f"&from={now.isoformat()}"
        f"&to={(now + timedelta(days=days)).isoformat()}"
    )
    result = _request("GET", f"v1/events?{params}", resolved_profile)
    label_names = {str(item["id"]): item["name"] for item in resolved.get("labels", [])}
    events = []
    for event in result["data"]["items"]:
        item = dict(event)
        item["labelName"] = label_names.get(str(event.get("labelId")), None)
        events.append(item)
    return {
        "calendar": {"id": resolved["id"], "name": resolved["name"]},
        "events": events,
    }


@mcp.tool(title="TimeTreeへ予定を追加", annotations=WRITE)
def timetree_add_event(
    calendar: str,
    title: str,
    date: str,
    start_time: str = "",
    end_time: str = "",
    all_day: bool = False,
    note: str = "",
    location: str = "",
    timezone: str = DEFAULT_TIMEZONE,
    label: str = "",
    attendees: list[str] | None = None,
    profile: str = "",
) -> dict:
    """予定を1件追加する。時刻はHH:MM形式。all_day か start_time がない場合は終日予定にする。
    label はラベル名かID、attendees は共有カレンダーのメンバー名かユーザーIDで指定する。
    ユーザーの明示的な依頼があるときだけ呼ぶ。同じ内容の再追加には同じ操作IDを使う。"""
    resolved_profile = _profile(profile)
    resolved = _resolve_calendar(calendar, resolved_profile)
    if all_day or not start_time:
        start: dict[str, Any] = {"date": date}
        end: dict[str, Any] | None = None
    else:
        if len(start_time) != 5 or start_time[2] != ":":
            raise ToolError("start_time は HH:MM 形式で指定してください")
        zone = ZoneInfo(timezone)
        begin = datetime.fromisoformat(f"{date}T{start_time}:00").replace(tzinfo=zone)
        if end_time:
            if len(end_time) != 5 or end_time[2] != ":":
                raise ToolError("end_time は HH:MM 形式で指定してください")
            finish = datetime.fromisoformat(f"{date}T{end_time}:00").replace(tzinfo=zone)
        else:
            finish = begin + timedelta(hours=1)
        start = {"dateTime": begin.isoformat()}
        end = {"dateTime": finish.isoformat()}
    payload: dict[str, Any] = {
        "calendarId": resolved["id"],
        "title": title,
        "allDay": all_day or not start_time,
        "start": start,
        "timezone": timezone,
    }
    if end is not None:
        payload["end"] = end
    if note:
        payload["note"] = note
    if location:
        payload["location"] = location
    if label:
        payload["labelId"] = _resolve_label(resolved, label)
    if attendees:
        payload["attendees"] = _resolve_attendees(resolved, attendees)
    key = str(uuid.uuid4())
    job = _request("POST", "v1/events", resolved_profile, key, payload)["data"]
    job = _wait_job(job["id"])
    return {
        "jobId": job["id"],
        "state": job["state"],
        "eventId": job.get("eventId"),
        "failure": job.get("failure"),
    }


@mcp.tool(title="TimeTreeの予定を削除", annotations=DELETE)
def timetree_delete_event(
    calendar: str,
    event_id: str = "",
    title: str = "",
    date: str = "",
    allow_series: bool = False,
    timezone: str = DEFAULT_TIMEZONE,
    profile: str = "",
) -> dict:
    """予定を1件削除する。event_id か、title と date（YYYY-MM-DD）の組合せで対象を指定する。
    複数候補や繰り返し予定は確認なしには削除しない。ユーザーの明示的な依頼があるときだけ呼ぶ。"""
    resolved_profile = _profile(profile)
    resolved = _resolve_calendar(calendar, resolved_profile)
    target_id = event_id
    if not target_id:
        if not title or not date:
            raise ToolError("event_id か、title と date の両方を指定してください")
        params = (
            f"calendarId={urllib.parse.quote(resolved['id'])}"
            f"&from={(datetime.now(timezone.utc) - timedelta(days=365)).isoformat()}"
            f"&to={(datetime.now(timezone.utc) + timedelta(days=365)).isoformat()}"
        )
        events = _request("GET", f"v1/events?{params}", resolved_profile)["data"]["items"]
        matches = [event for event in events if event["title"] == title and _event_local_date(event, timezone) == date]
        if not matches:
            raise ToolError(f"対象の予定が見つかりません: {title} ({date})")
        if len(matches) > 1:
            raise ToolError(
                "同じタイトルと日付の予定が複数あります。event_id で指定してください: "
                + ", ".join(event["id"] for event in matches)
            )
        target_id = matches[0]["id"]
    payload = {"calendarId": resolved["id"], "eventId": target_id, "allowSeries": allow_series}
    key = str(uuid.uuid4())
    job = _request("POST", "v1/events/delete", resolved_profile, key, payload)["data"]
    job = _wait_job(job["id"])
    return {
        "jobId": job["id"],
        "state": job["state"],
        "eventId": target_id,
        "failure": job.get("failure"),
    }


if __name__ == "__main__":
    mcp.run()
