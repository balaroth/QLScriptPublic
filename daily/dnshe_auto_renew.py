#!/usr/bin/env python3
"""DNSHE one-shot renewal task for QingLong/qlrun.

No scheduler and no notification code lives here. qlrun owns retries and final-failure mail.
"""
import argparse
import fcntl
import json
import os
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

DATE_FORMAT = "%Y-%m-%d %H:%M"
DATETIME_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M")
API_BASE = "https://api005.dnshe.com/index.php?m=domain_hub"
DEFAULT_CONFIG_DIR = Path("/ql/data/config/dnshe-auto-renew")
DEFAULT_STATE_DIR = Path("/ql/data/scripts/dnshe-auto-renew/state")


@dataclass
class ManagedDomain:
    domain: str
    expires_at: datetime
    renew_before_days: int

    @property
    def renew_at(self) -> datetime:
        return self.expires_at - timedelta(days=self.renew_before_days)


class DNSHEClient:
    def __init__(self, api_key: str, api_secret: str, timeout: int = 30) -> None:
        self.timeout = timeout
        self.headers = {
            "X-API-Key": api_key,
            "X-API-Secret": api_secret,
            "Content-Type": "application/json",
            "User-Agent": "dnshe-auto-renew/2.0-qinglong",
        }

    def _request(self, endpoint: str, action: str, method: str = "GET", payload: Dict[str, Any] | None = None) -> Dict[str, Any]:
        url = f"{API_BASE}&endpoint={endpoint}&action={action}"
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(url, headers=self.headers, data=data, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
                if not isinstance(body, dict):
                    raise RuntimeError("DNSHE response is not an object")
                return body
        except urllib.error.HTTPError as exc:
            # Avoid echoing response bodies: providers may include account data.
            raise RuntimeError(f"DNSHE HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"DNSHE network error: {exc.reason}") from exc

    def list_subdomains(self) -> List[Dict[str, Any]]:
        response = self._request("subdomains", "list")
        if not response.get("success"):
            raise RuntimeError(f"DNSHE list failed: {response.get('message') or response.get('error') or 'unknown'}")
        items = response.get("subdomains", [])
        if not isinstance(items, list):
            raise RuntimeError("DNSHE list response has invalid subdomains")
        return items

    def renew_subdomain(self, subdomain_id: int) -> Dict[str, Any]:
        response = self._request("subdomains", "renew", method="POST", payload={"subdomain_id": subdomain_id})
        if not response.get("success"):
            raise RuntimeError(f"DNSHE renew failed: {response.get('message') or response.get('error') or 'unknown'}")
        return response


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="DNSHE one-shot renewal check (scheduled externally by QingLong).")
    parser.add_argument("--config-dir", default=str(DEFAULT_CONFIG_DIR))
    parser.add_argument("--state", default=str(DEFAULT_STATE_DIR / "domains-state.json"))
    parser.add_argument("--backup-dir", default=str(DEFAULT_STATE_DIR / "backups"))
    parser.add_argument("--lock", default=str(DEFAULT_STATE_DIR / "renew.lock"))
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def read_secret(config_dir: Path, env_name: str, filename: str) -> str:
    value = os.getenv(env_name, "").strip()
    if value:
        return value
    path = config_dir / filename
    if not path.is_file():
        raise RuntimeError(f"Missing private config: {filename}")
    value = path.read_text(encoding="utf-8").strip()
    if not value:
        raise RuntimeError(f"Private config is empty: {filename}")
    return value


def parse_domains(config_dir: Path) -> List[str]:
    raw = os.getenv("DNSHE_DOMAINS", "")
    if not raw:
        path = config_dir / "domains.txt"
        if not path.is_file():
            raise RuntimeError("Missing private config: domains.txt")
        raw = path.read_text(encoding="utf-8")
    domains = [line.strip() for line in raw.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    if not domains:
        raise RuntimeError("DNSHE domains list is empty")
    if len(domains) != len(set(domains)):
        raise RuntimeError("DNSHE domains list contains duplicates")
    return domains


def parse_datetime(value: str) -> datetime:
    for fmt in DATETIME_FORMATS:
        try:
            return datetime.strptime(value.strip(), fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    raise ValueError(f"Unsupported datetime format: {value}")


def load_state(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {"domains": {}}
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not isinstance(raw.get("domains", {}), dict):
        raise RuntimeError("DNSHE state file has invalid structure")
    return raw


def atomic_write(path: Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def save_state(path: Path, raw_state: Dict[str, Any]) -> None:
    atomic_write(path, json.dumps(raw_state, ensure_ascii=False, indent=2) + "\n")


def backup_state(state_path: Path, backup_dir: Path) -> Path | None:
    if not state_path.is_file():
        return None
    backup_dir.mkdir(parents=True, exist_ok=True)
    target = backup_dir / f"domains-state-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    shutil.copy2(state_path, target)
    target.chmod(0o600)
    return target


def find_subdomain_map(items: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return {str(item.get("full_domain")): item for item in items if item.get("full_domain")}


def build_managed_domains(domain_names: List[str], subdomain_map: Dict[str, Dict[str, Any]], state: Dict[str, Any]) -> Tuple[List[ManagedDomain], bool]:
    managed: List[ManagedDomain] = []
    changed = False
    stored = state.setdefault("domains", {})
    for name in domain_names:
        matched = subdomain_map.get(name)
        if not matched:
            raise RuntimeError(f"Domain not found in DNSHE account: {name}")
        item = stored.get(name, {})
        if item.get("expires_at"):
            expires = parse_datetime(item["expires_at"])
        else:
            created = matched.get("created_at")
            if not created:
                raise RuntimeError(f"DNSHE response missing created_at for {name}")
            expires = parse_datetime(created) + timedelta(days=365)
            item = {"expires_at": expires.strftime(DATE_FORMAT), "renew_before_days": int(item.get("renew_before_days", 175)), "source": "created_at_plus_365_days"}
            stored[name] = item
            changed = True
        before_days = int(item.get("renew_before_days", 175))
        if before_days < 1 or before_days > 364:
            raise RuntimeError(f"Invalid renew_before_days for {name}: {before_days}")
        item["renew_before_days"] = before_days
        managed.append(ManagedDomain(name, expires, before_days))
    for stale in set(stored) - set(domain_names):
        del stored[stale]
        changed = True
    return managed, changed


def main() -> int:
    args = parse_args()
    config_dir = Path(args.config_dir).resolve()
    state_path = Path(args.state).resolve()
    backup_dir = Path(args.backup_dir).resolve()
    lock_path = Path(args.lock).resolve()
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    with lock_path.open("a+", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("Another DNSHE renewal run is active") from exc

        api_key = read_secret(config_dir, "DNSHE_API_KEY", "dnshe_api_key.secret")
        api_secret = read_secret(config_dir, "DNSHE_API_SECRET", "dnshe_api_secret.secret")
        domains = parse_domains(config_dir)
        client = DNSHEClient(api_key, api_secret)
        now = datetime.now(timezone.utc)
        state = load_state(state_path)
        subdomain_map = find_subdomain_map(client.list_subdomains())
        managed, updated = build_managed_domains(domains, subdomain_map, state)
        renewed = 0

        print(f"UTC now: {now.strftime(DATE_FORMAT)}")
        for item in managed:
            matched = subdomain_map[item.domain]
            print(f"[CHECK] {item.domain} expires_at={item.expires_at.strftime(DATE_FORMAT)} renew_at={item.renew_at.strftime(DATE_FORMAT)}")
            if now < item.renew_at:
                print(f"[SKIP] {item.domain} has not entered renewal window yet.")
                continue
            if args.dry_run:
                print(f"[DRY-RUN] Would renew {item.domain}.")
                continue
            result = client.renew_subdomain(int(matched["id"]))
            new_expiry = result.get("new_expires_at")
            if not new_expiry:
                raise RuntimeError(f"Renew response missing new_expires_at for {item.domain}")
            # Validate before touching state.
            parse_datetime(str(new_expiry))
            entry = state.setdefault("domains", {}).setdefault(item.domain, {})
            entry.update({"expires_at": str(new_expiry), "source": "dnshe_renew_response", "renew_before_days": int(entry.get("renew_before_days", 175))})
            updated = True
            renewed += 1
            print(f"[RENEWED] {item.domain} new_expires_at={new_expiry} remaining_days={result.get('remaining_days')}")

        if updated and not args.dry_run:
            backup_state(state_path, backup_dir)
            save_state(state_path, state)
            print(f"[WRITE] Updated {state_path}")
        print(f"[DONE] checked={len(managed)} renewed={renewed} dry_run={int(args.dry_run)}")
        print(f"[QLRUN_RESULT] SUCCESS checked={len(managed)} renewed={renewed}")
        return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[FATAL] {exc}", file=sys.stderr)
        print(f"[QLRUN_RESULT] FAILURE retryable=1 reason=dnshe_one_shot_failed detail={exc}")
        raise SystemExit(1)
