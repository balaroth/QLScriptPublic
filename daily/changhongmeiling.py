# 微信小程序：长虹智慧家居（防重放硬化候选）
# 环境变量 chmlck：兼容旧 token#备注，多账号换行。
# 默认优先通过 collector 自动执行 wx.login → getTokenByJsCode；旧变量仅作失败回退。
#
# 防重放契约（与 xmsq/maopu 硬化对齐，按本接口适配）：
# - 读写分离：discover/aggregationCheck/aggregationInfo 为只读读；POST /aggr/signin 为唯一写。
# - 写前落盘 attempting（tmp+rename+回读），回读失败阻写出网。
# - 出网后任何异常 / 非2xx / 非JSON / 未知结构 → WriteUnknownError retryable=0，当日不再写。
# - 明确业务拒绝 → failed，retryable=0，进入冷却+双权威恢复门，总写硬上限 2/日不豁免。
# - 权威已签（isSignin=1）→ success 收敛，零写。
# - state/cache 用 fcntl.flock 文件级互斥覆盖 读->merge->rename->回读；竞争 fail-closed 阻写。
# - READ_ONLY=1：只跑权威只读链，任何 /aggr/signin 都不发。

import calendar
import os
import re
import fcntl
import json
import time
import random
import tempfile
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Tuple

import requests

try:
    from notify import send
except Exception:
    def send(title, content):
        print(f"\n===== {title} =====\n{content}")

APPID = os.getenv("CHML_APPID", "wx36c3413e8fe39263").strip()
WX_SERVER_URL = os.getenv("wx_server_url", "http://d4.dqf.cc.cd:8787").rstrip("/")
WX_AUTH = os.getenv("wx_auth", "").strip()
DISABLE_COLLECTOR = os.getenv("CHML_DISABLE_COLLECTOR", "") == "1"
BASE_URL = "https://hongke.changhong.com/gw/applet"
AGGR_ID_OVERRIDE = os.getenv("CHML_AGGR_ID", "").strip()
TIMEOUT = max(5, min(60, int(os.getenv("CHML_HTTP_TIMEOUT", "20"))))
USER_AGENT = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Mobile MicroMessenger/8.0.49 MiniProgramEnv/android"
READ_ONLY = os.getenv("CHML_READ_ONLY", "") == "1"

STATE_FILE = os.getenv("CHML_STATE_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "changhongmeiling_state.json"))
CACHE_FILE = os.getenv("CHML_CACHE_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "changhongmeiling_cache.json"))
STATE_LOCK = STATE_FILE + ".lock"
CACHE_LOCK = CACHE_FILE + ".lock"
DAILY_WRITE_LIMIT = 2          # 当日总写硬上限（任何 outcome 不豁免）
RECOVERY_COOLDOWN_SEC = 15 * 60  # 冷却后才允许一次恢复写


class ChanghongError(RuntimeError):
    """业务/协议错误基类。"""


class WriteUnknownError(ChanghongError):
    """写后结果未知：出网后任何异常/非2xx/非JSON/未知结构。retryable=0。"""


class ActivityUnavailable(ChanghongError):
    """服务端权威判定当前活动不可用（isCan!=1）。非瞬态，retryable=0。"""


class StructureError(ChanghongError):
    """权威响应结构未知（缺字段/枚举越界/非预期类型）。fail-closed，retryable=0。"""


@dataclass
class Account:
    token: str
    note: str = ""
    source: str = "legacy"


# ---------------- 安全通知 / 脱敏 ----------------
def safe_notify(title: str, content: str) -> None:
    try:
        send(title, content)
    except Exception as exc:
        print(f"[通知] 发送异常已隔离: {type(exc).__name__}: {exc}")


def mask_phone(value: str) -> str:
    return re.sub(r"(\d{3})\d{4}(\d{4})", r"\1****\2", str(value or ""))


def today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() + 8 * 3600))


# ---------------- 文件锁 + 原子合并 ----------------
class FileMutex:
    """fcntl.flock 排他锁，覆盖 读->merge->rename->回读 全程；竞争 fail-closed。"""

    def __init__(self, lock_path: str):
        self.lock_path = lock_path
        self.fd = None

    def __enter__(self):
        self.fd = open(self.lock_path, "a+")
        try:
            fcntl.flock(self.fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.fd.close()
            self.fd = None
            raise ChanghongError("共享文件锁被占用，阻写")
        return self.fd

    def __exit__(self, exc_type, exc, tb):
        if self.fd is not None:
            try:
                fcntl.flock(self.fd.fileno(), fcntl.LOCK_UN)
            finally:
                self.fd.close()
                self.fd = None


def _strict_state(data) -> bool:
    if not isinstance(data, dict):
        return False
    for key, entry in data.items():
        if not isinstance(key, str) or not isinstance(entry, dict):
            return False
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(entry.get("date") or "")):
            return False
        if entry.get("outcome") not in ("success", "failed", "unknown", "attempting"):
            return False
        if not isinstance(entry.get("attempts", 0), int) or entry["attempts"] < 0:
            return False
    return True


def read_state_strict(path: str) -> dict:
    """FileNotFoundError -> {}；存在但 JSON 坏/schema 坏/权限坏 -> raise，阻写。"""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {}
    except Exception as exc:
        raise ChanghongError(f"状态文件不可读：{exc}")
    if not _strict_state(data):
        raise ChanghongError("状态文件 schema 校验失败")
    return data


def atomic_write_json(path: str, payload: dict) -> None:
    """tmp+rename+回读校验；回读不一致抛错阻写。"""
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        dfd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
        with open(path, "r", encoding="utf-8") as fh:
            back = json.load(fh)
        if back != payload:
            raise ChanghongError("状态原子回读不一致")
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def update_state(account_key: str, **fields) -> dict:
    with FileMutex(STATE_LOCK):
        try:
            state = read_state_strict(STATE_FILE)
            key = f"chml::{account_key}"
            entry = state.get(key) or {"date": "", "outcome": "unknown", "attempts": 0}
            if entry.get("date") != today():
                entry = {"date": today(), "outcome": "unknown", "attempts": 0,
                         "history": list(entry.get("history", [])) + ([dict(entry, history=[])] if entry.get("date") else [])}
            entry.update({k: v for k, v in fields.items() if v is not None})
            state[key] = entry
            atomic_write_json(STATE_FILE, state)
            return dict(entry)
        except ChanghongError:
            raise
        except Exception as exc:
            raise ChanghongError(f"状态原子写入失败：{exc}")


def read_state(account_key: str) -> dict:
    with FileMutex(STATE_LOCK):
        state = read_state_strict(STATE_FILE)
        return dict(state.get(f"chml::{account_key}") or {})


def action_lock_path(account_key: str) -> str:
    return STATE_FILE + f".action.{re.sub(r'[^A-Za-z0-9_-]', '_', account_key)}.lock"


def read_cache() -> dict:
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def update_cache_entry(account_key: str, entry: dict) -> None:
    with FileMutex(CACHE_LOCK):
        cache = read_cache()
        cache[account_key] = entry
        atomic_write_json(CACHE_FILE, cache)


# ---------------- 账号解析 ----------------
def parse_accounts(raw: str) -> List[Account]:
    accounts: List[Account] = []
    for index, line in enumerate(str(raw or "").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        token, sep, note = line.partition("#")
        if not token.strip():
            raise ChanghongError(f"账号[{index}] chmlck 缺少 token")
        accounts.append(Account(token.strip(), note.strip() if sep else f"旧变量账号{index}"))
    return accounts


def fetch_collector_session(http=requests, auth: Optional[str] = None, url: Optional[str] = None,
                            appid: Optional[str] = None, timeout: int = 180) -> Account:
    collector_auth = WX_AUTH if auth is None else str(auth or "")
    if not collector_auth:
        raise ChanghongError("未配置 wx_auth")
    # The current upstream accepts fresh normal /wx/code, whereas legacy
    # runtime-bound codes are rejected; do not use shared WxRequest callbacks.
    response = http.post(
        (url or WX_SERVER_URL).rstrip("/") + "/wx/code",
        json={"appid": appid or APPID, "openid": "ql"},
        headers={"auth": collector_auth, "Content-Type": "application/json"},
        timeout=timeout,
    )
    body = response.json()
    code = body.get("code") or (body.get("data") or {}).get("code")
    if response.status_code != 200 or body.get("status") is not True or not isinstance(code, str) or not code:
        raise ChanghongError("长虹新鲜登录code获取失败")
    exchange = http.post(
        BASE_URL + "/appletUser/getTokenByJsCode",
        json={"jsCode": code, "invitation": "", "userName": "", "system": "Android", "sex": "未知", "avatarUrl": ""},
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        timeout=TIMEOUT,
    )
    body = exchange.json()
    data = body.get("data") or {}
    if exchange.status_code != 200 or str(body.get("code")) != "200" or not isinstance(data, dict) or not data.get("token"):
        raise ChanghongError(f"长虹登录兑换失败 HTTP {exchange.status_code} code={body.get('code')}")
    phone = mask_phone(data.get("userPhone") or "")
    return Account(str(data["token"]), f"collector:{phone}" if phone else "collector", "fresh-code-direct-exchange")


class Task:
    def __init__(self, account: Account, http=requests, logger: Callable[[str], None] = print):
        self.account = account
        self.http = http
        self.logger = logger
        self.key = re.sub(r"[^A-Za-z0-9_-]", "_", account.note or account.source)[:64]

    @property
    def headers(self):
        t = self.account.token
        return {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
            "Token": t, "token": t, "smarthome": t,
        }

    # ---- 只读读（可重试瞬态）----
    def request_read(self, method: str, path: str, *, params=None, json_body=None):
        last = None
        for attempt in range(3):
            try:
                response = self.http.request(method, BASE_URL + path, params=params, json=json_body,
                                             headers=self.headers, timeout=TIMEOUT)
                if response.status_code != 200:
                    raise ChanghongError(f"{path} HTTP {response.status_code}")
                body = response.json()
            except (ChanghongError, ValueError, requests.RequestException) as exc:
                last = exc
                time.sleep(1.0 + attempt)
                continue
            if str(body.get("code")) != "200":
                raise ChanghongError(f"{path} 失败：{body.get('message') or body.get('msg') or body.get('code')}")
            return body
        raise ChanghongError(f"{path} 读失败：{last}")

    def discover_activity_id(self) -> str:
        if AGGR_ID_OVERRIDE:
            return AGGR_ID_OVERRIDE
        body = self.request_read("POST", "/homePage/getShortcutMenuList", params={"type": 1}, json_body={})
        items = body.get("data") or []
        if not isinstance(items, list):
            raise ChanghongError("菜单列表结构异常")
        for item in items:
            if not isinstance(item, dict):
                continue
            if item.get("name", "").strip() != "签到打卡":
                continue
            match = re.search(r"activityData=([^,&]+)", str(item.get("webUrl") or ""))
            if match:
                return match.group(1)
        raise ChanghongError("首页未发现当前有效的“签到打卡”活动")

    def activity_signed_state(self, aggr_id: str) -> bool:
        """严格 schema。isCan!=1 -> ActivityUnavailable（非瞬态）；结构缺/越界 -> StructureError。"""
        check = self.request_read("GET", "/aggr/aggregationCheck", params={"aggrId": aggr_id})
        check_data = check.get("data")
        if not isinstance(check_data, dict):
            raise StructureError("aggregationCheck data 非对象")
        if "isCan" not in check_data:
            raise StructureError("aggregationCheck 缺 isCan 字段")
        try:
            is_can = int(check_data.get("isCan"))
        except (TypeError, ValueError):
            raise StructureError("aggregationCheck isCan 非整数枚举")
        if is_can != 1:
            raise ActivityUnavailable(f"签到活动当前不可用 isCan={is_can}")
        info = self.request_read("GET", "/aggr/aggregationInfo", params={"aggrId": aggr_id})
        info_data = info.get("data")
        if not isinstance(info_data, dict):
            raise StructureError("aggregationInfo data 非对象")
        assemblies = info_data.get("aggrAssemblyList")
        if not isinstance(assemblies, list) or not assemblies:
            raise StructureError("aggrAssemblyList 缺失或空")
        signed_any = False
        for assembly in assemblies:
            if not isinstance(assembly, dict):
                raise StructureError("aggrAssemblyList 元素非对象")
            signin = assembly.get("aggrAssemblySignin")
            if not isinstance(signin, dict):
                raise StructureError("assembly 缺 aggrAssemblySignin 块")
            if "isSignin" not in signin:
                raise StructureError("aggrAssemblySignin 缺 isSignin")
            try:
                flag = int(signin.get("isSignin"))
            except (TypeError, ValueError):
                raise StructureError("isSignin 非整数枚举")
            if flag not in (0, 1):
                raise StructureError(f"isSignin 越界枚举 {flag}")
            if flag == 1:
                signed_any = True
        return signed_any

    # ---- 唯一写 ----
    def sign_write(self, aggr_id: str) -> dict:
        """出网写。任何异常一律 WriteUnknownError retryable=0。"""
        try:
            response = self.http.request("POST", BASE_URL + "/aggr/signin", params={"aggrId": aggr_id},
                                          json={}, headers=self.headers, timeout=TIMEOUT)
        except requests.RequestException as exc:
            raise WriteUnknownError(f"signin 出网异常：{type(exc).__name__}")
        if response.status_code != 200:
            raise WriteUnknownError(f"signin HTTP {response.status_code}")
        try:
            body = response.json()
        except Exception as exc:
            raise WriteUnknownError(f"signin 非 JSON：{response.text[:120]}") from exc
        if str(body.get("code")) != "200":
            # 明确业务拒绝 = failed（retryable=0，进冷却+双权威恢复门）
            raise ChanghongError(f"signin 业务拒绝：{body.get('message') or body.get('code')}")
        return body

    def run(self):
        label = self.account.note or self.account.source
        try:
            aggr_id = self.discover_activity_id()
        except Exception as exc:
            self.logger(f"❌ {label}：执行失败 - {exc}")
            return {"ok": False, "error": str(exc), "retryable": True}

        # 单账号+动作单 flight 锁：权威读 -> 门控 -> 落盘 -> 网络写 -> 收敛 全程持锁
        try:
            lock = FileMutex(action_lock_path(self.key))
            lock.__enter__()
        except ChanghongError as exc:
            self.logger(f"⛔ {label}：同账号写窗口被占用，阻写：{exc}")
            return {"ok": False, "error": f"action-lock: {exc}", "retryable": False}

        try:
            # 权威只读
            try:
                already = self.activity_signed_state(aggr_id)
            except ActivityUnavailable as exc:
                self.logger(f"{label}：{exc}，服务端当前无合法可执行活动")
                return {"ok": True, "unavailable": True, "reason": "activity_unavailable", "error": str(exc), "retryable": False}
            except StructureError as exc:
                self.logger(f"⛔ {label}：权威结构未知，阻写：{exc}")
                return {"ok": False, "error": f"structure-unknown: {exc}", "retryable": False}
            except Exception as exc:
                self.logger(f"❌ {label}：权威读取瞬态失败 - {exc}")
                return {"ok": False, "error": f"权威读取失败: {exc}", "retryable": True}

            if READ_ONLY:
                self.logger(f"只读权威验证：{'已签到' if already else '未签到'}，零签到写")
                return {"ok": True, "readonly": True, "already": already, "aggrId": aggr_id}
            if already:
                try:
                    update_state(self.key, outcome="success",
                                 confirmedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
                except ChanghongError as exc:
                    self.logger(f"⛔ {label}：状态文件损坏，阻写：{exc}")
                    return {"ok": False, "error": f"state-corrupt: {exc}", "retryable": False}
                self.logger(f"✅ {label}：今日已签到（服务端活动状态确认，{aggr_id}）")
                return {"ok": True, "already": True, "aggrId": aggr_id}

            if READ_ONLY:
                self.logger(f"🔍 {label}：READ_ONLY=1，权威未签但阻写（{aggr_id}）")
                return {"ok": True, "readonly": True, "aggrId": aggr_id}

            # ---- 写前门控 ----
            try:
                entry = read_state(self.key)
            except ChanghongError as exc:
                self.logger(f"⛔ {label}：状态文件损坏，阻写：{exc}")
                return {"ok": False, "error": f"state-corrupt: {exc}", "retryable": False}
            attempts = entry.get("attempts") or 0
            outcome = entry.get("outcome") or "unknown"
            if entry.get("date") != today():
                entry = {"date": today(), "outcome": "unknown", "attempts": 0}
                attempts, outcome = 0, "unknown"

            if attempts >= DAILY_WRITE_LIMIT:
                self.logger(f"⛔ {label}：当日写硬上限 {DAILY_WRITE_LIMIT} 已达，阻写")
                return {"ok": False, "error": "daily-write-limit", "retryable": False}

            # attempting 残留（上次崩溃在写窗口内）：fail-closed，阻写
            if outcome == "attempting":
                self.logger(f"⛔ {label}：存在未收敛 attempting 残留，阻写")
                return {"ok": False, "error": "stale-attempting", "retryable": False}

            # unknown：当日已发生过未知写，只读权威收敛阻写
            if outcome == "unknown" and attempts >= 1:
                last = entry.get("lastAttemptAt") or ""
                self.logger(f"⛔ {label}：写后结果未知，只读权威收敛，阻写（last={last}）")
                return {"ok": False, "error": "write-unknown", "retryable": False}

            # failed：冷却期内 fail-closed 阻写；lastAttemptAt 畸形也按冷却未过处理
            if outcome == "failed" and attempts >= 1:
                last = entry.get("lastAttemptAt") or ""
                try:
                    elapsed = time.time() - calendar.timegm(time.strptime(last, "%Y-%m-%dT%H:%M:%SZ"))
                except Exception:
                    elapsed = 0  # 畸形 -> fail-closed 按冷却未过
                if elapsed < RECOVERY_COOLDOWN_SEC:
                    self.logger(f"⛔ {label}：业务失败冷却期内或时间戳畸形，阻写（elapsed={int(elapsed)}s）")
                    return {"ok": False, "error": "recovery-cooldown", "retryable": False}

            # 写前落盘 attempting（原子回读）
            try:
                entry = update_state(self.key, outcome="attempting", attempts=attempts + 1,
                                     lastAttemptAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
            except ChanghongError as exc:
                self.logger(f"⛔ {label}：状态落盘失败，阻写：{exc}")
                return {"ok": False, "error": f"state-write-fail: {exc}", "retryable": False}

            # 出网写
            try:
                self.sign_write(aggr_id)
            except WriteUnknownError as exc:
                update_state(self.key, outcome="unknown", attempts=attempts + 1)
                self.logger(f"⚠️ {label}：写后结果未知，只读收敛：{exc}")
                return {"ok": False, "error": str(exc), "retryable": False}
            except ChanghongError as exc:
                update_state(self.key, outcome="failed", attempts=attempts + 1)
                self.logger(f"❌ {label}：业务失败：{exc}")
                return {"ok": False, "error": str(exc), "retryable": False}

            # 写后权威回查
            try:
                after = self.activity_signed_state(aggr_id)
            except Exception as exc:
                update_state(self.key, outcome="unknown", attempts=attempts + 1)
                self.logger(f"⚠️ {label}：写后回查异常，按未知只读收敛：{exc}")
                return {"ok": False, "error": f"post-verify: {exc}", "retryable": False}

            if not after:
                update_state(self.key, outcome="unknown", attempts=attempts + 1)
                self.logger(f"⚠️ {label}：签到接口已返回，但活动状态回查仍为未签到（按未知收敛）")
                return {"ok": False, "error": "post-verify-not-signed", "retryable": False}

            update_state(self.key, outcome="success", attempts=attempts + 1,
                         confirmedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
            self.logger(f"✅ {label}：签到成功（已回查确认，{aggr_id}）")
            return {"ok": True, "already": False, "aggrId": aggr_id}
        finally:
            lock.__exit__(None, None, None)


def main(*, raw: Optional[str] = None, auto_login: Optional[bool] = None, collector_http=requests,
         collector_auth: Optional[str] = None, collector_url: Optional[str] = None,
         collector_appid: Optional[str] = None, http=requests,
         logger: Callable[[str], None] = print, emit_result: bool = True):
    legacy = parse_accounts(os.getenv("chmlck", "") if raw is None else raw)
    accounts: List[Account] = []
    enabled = (not DISABLE_COLLECTOR and bool(WX_AUTH)) if auto_login is None else auto_login
    if enabled:
        try:
            account = fetch_collector_session(collector_http, auth=collector_auth, url=collector_url, appid=collector_appid)
            accounts.append(account)
            logger(f"collector 自动登录成功（{account.source}），已取得最新长虹业务 token")
        except Exception as exc:
            logger(f"collector 自动登录失败：{exc}{'；将回退旧 chmlck 变量' if legacy else ''}")
    if not accounts:
        accounts.extend(legacy)
    if not accounts:
        logger("未取得可用账号：请配置 wx_auth，或临时保留 chmlck")
        if emit_result:
            logger("[QLRUN_RESULT] FAILURE reason=changhong_no_account retryable=0")
        return []

    logger(f"共找到 {len(accounts)} 个账号")
    results = [Task(account, http=http, logger=logger).run() for account in accounts]
    if emit_result:
        if results and all(x.get("ok") for x in results):
            logger("[QLRUN_RESULT] SUCCESS")
        else:
            retryable = 1 if any(x.get("retryable") for x in results) else 0
            logger(f"[QLRUN_RESULT] FAILURE reason=changhong_signin_unverified retryable={retryable}")
    return results


if __name__ == "__main__":
    print("☞☞☞ 长虹智慧家居每日签到 ☜☜☜\n")
    lines: List[str] = []
    rc = 0
    try:
        results = main(logger=lambda message: (print(message), lines.append(message))[0])
        if not (results and all(x.get("ok") for x in results)):
            rc = 1
    except Exception as exc:
        message = f"❌ 主流程异常：{exc}"
        print(message)
        print("[QLRUN_RESULT] FAILURE reason=changhong_main_exception retryable=0")
        lines.extend([message, "[QLRUN_RESULT] FAILURE reason=changhong_main_exception retryable=0"])
        rc = 1
    safe_notify("长虹智慧家居每日签到", "\n".join(lines) if lines else "无账号执行")
    raise SystemExit(rc)
