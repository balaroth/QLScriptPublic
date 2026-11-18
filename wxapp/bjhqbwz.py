#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 北京环球度假区互动福利站 - 每日签到 (连续签到可获抽奖门票机会)
# 入口: 微信小程序「北京环球度假区互动福利站」-> 签到
# 说明: 通过 wx_server(smallcat) 用 openid 换取 wx.login code 自动登录, 完成每日签到。
#       连续签到达标后会获得抽奖机会, 但抽奖属于领奖动作, 本脚本不自动触发, 仅完成签到。
# 账号变量名:bjhqbwz  (填写 wx_server 中的 openid, 多账号用换行或 & 分割, 可选 #备注)
# 需要配置 wx_server_url、wx_auth, 用于获取 wx.login code
#new Env("北京环球签到")
#cron 15 9 * * *

import base64
import fcntl
import tempfile
import hashlib
import hmac
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from email.utils import formatdate
from pathlib import Path

import requests

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

try:
    from notify import send
except Exception:
    def send(title, content):
        print(f"\n===== {title} =====\n{content}")

# ---------------------------------------------------------------------------
# 常量 (均来自小程序反编译源码, 非机密)
# ---------------------------------------------------------------------------
MINI_APP_ID = "wx21f6790118783b83"
BASE_URL = "https://bmp.app.universalbeijingresort.com"
PATH_PREFIX = "/2026_ubr_yunyingqiu"                 # app.js 路径前缀 (小写)
ACTIVITY_CODE = "2026_UBR_YUNYINGQIU"                # app.js activityCode (大写)
# HTTP-Signatures 签名密钥 (客户端内置, 生产环境; 非 appsecret)
HMAC_USERNAME = "ubr-bmp"
HMAC_SECRET = "aK@AtX5#Ck5x"
SUCCESS_CODE = 200
SESSION_CODES = (401, 403)                           # 会话失效 -> 需重新登录
NEED_GOV_CODE = 60002                                # 需补充身份证/实名
NEED_CERT_CODE = 60003                               # 需完成实名认证
MEMBER_IDENTITIES = ("NORMAL_MEMBER", "ANNUAL_CARD_MEMBER")
# 「连续签到5天抽门票」玩法(Surprise5)开启时, 首签前需选一个抽奖奖池(小程序内
# 为二次确认弹窗)。本脚本按用户授权的 bjhqbwz_pool 自动选定一次(幂等: 已选过/无
# 门槛则不重复选); 若置空/none 则不自动选, 仅如实上报由用户在小程序内手动选。
POOL_GATE_HINT = "奖池"
# 奖池自动选择(用户授权): ticket1=指定日门票5折 / ticket2=门票+优速通套餐5折 /
# hotel=酒店5折。默认 ticket2(门票+优速通)。置空或 none/off 关闭自动选。
# No implicit prize selection. Local account settings are never committed.
try:
    _settings = json.loads(Path(__file__).with_name(".bjhqbwz_settings.json").read_text())
except FileNotFoundError:
    _settings = {}
POOL_CHOICE = os.getenv("bjhqbwz_pool", _settings.get("pool", "")).strip().lower()
POOL_LABELS = {
    "ticket1": "指定日门票5折优惠券",
    "ticket2": "门票+环球优速通套餐5折优惠券",
    "hotel": "度假区酒店5折优惠券",
}
POOL_GATE_MSG = (
    "本期开启了『连续签到5天抽门票』玩法, 首次签到前需选择一个奖池"
    "(①指定日门票5折 ②门票+优速通套餐5折 ③酒店5折)。当前未启用自动选池"
    "(bjhqbwz_pool 为空), 请在小程序「北京环球度假区互动福利站」首页弹窗中"
    "选定奖池后再运行, 或设置环境变量 bjhqbwz_pool=ticket2 由脚本自动选定。"
)

# smallcat / wx_server 配置 (机密, 从环境变量读取, 绝不硬编码)
WX_SERVER_URL = os.getenv("wx_server_url", "http://192.168.31.196:8787").rstrip("/")
WX_AUTH = os.getenv("wx_auth", "")

TOKEN_CACHE_PATH = Path(__file__).with_name("bjhqbwz_token_cache.json")
DEFAULT_UA = (
    "Mozilla/5.0 (Linux; Android 13; SM-G9910 Build/TP1A.220624.014) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 "
    "MicroMessenger/8.0.49.2600(0x28003137) NetType/WIFI Language/zh_CN "
    "miniProgram/" + MINI_APP_ID
)

session = requests.Session()


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def bj_now():
    return datetime.now(timezone(timedelta(hours=8)))


def mask(value):
    if not value:
        return ""
    value = str(value)
    if len(value) <= 12:
        return value[:2] + "***"
    return f"{value[:6]}***{value[-4:]}"


def read_token_cache():
    try:
        if not TOKEN_CACHE_PATH.exists():
            return {}
        return json.loads(TOKEN_CACHE_PATH.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def write_token_cache(cache):
    if READ_ONLY:
        return
    try:
        TOKEN_CACHE_PATH.write_text(
            json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception as e:
        print(f"⚠️ 写入token缓存失败: {e}")


def get_cached_entity(account_id):
    return read_token_cache().get(account_id) or {}


def save_cached_entity(account_id, entity):
    cache = read_token_cache()
    cache[account_id] = {
        "token": entity.get("token"),
        "id": entity.get("id"),
        "uid": entity.get("uid"),
        "identity": entity.get("identity"),
        "identityCard": entity.get("identityCard"),
        "updatedAt": int(time.time()),
    }
    write_token_cache(cache)


def remove_cached_entity(account_id):
    cache = read_token_cache()
    if account_id in cache:
        del cache[account_id]
        write_token_cache(cache)


# ---------------------------------------------------------------------------
# smallcat: openid -> wx.login code
# ---------------------------------------------------------------------------
def get_wx_code(account_id):
    if not WX_AUTH:
        raise RuntimeError("缺少 wx_auth, 无法从 wx_server 获取 code")
    headers = {"Accept": "application/json", "Content-Type": "application/json",
               "auth": WX_AUTH}
    body = json.dumps({"appid": MINI_APP_ID, "openid": account_id})
    last_msg = ""
    for attempt in range(4):
        if attempt:
            # smallcat 偶发 "获取失败"(会话抖动), 刷新会话后间隔重试
            try:
                session.post(f"{WX_SERVER_URL}/wx/refresh", data=body,
                             headers=headers, timeout=30)
            except Exception:
                pass
            time.sleep(3)
        resp = session.post(f"{WX_SERVER_URL}/wx/code", data=body,
                            headers=headers, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, dict) and data.get("status") is False:
            last_msg = data.get("message") or "获取失败"
            continue
        code = data.get("code") or (data.get("data") or {}).get("code")
        if code:
            return code
        last_msg = "wx_server 未返回 code"
    raise RuntimeError(f"wx_server 获取 code 失败(已重试): {last_msg}")


# ---------------------------------------------------------------------------
# 北京环球 API (复刻 599C3084...js 的 HTTP-Signatures 签名)
# ---------------------------------------------------------------------------
def sign_headers(body_str, token=None, user_id=None):
    """复刻请求签名: digest=SHA-256(base64), 签名串 hmac-sha1(base64)。"""
    x_date = formatdate(usegmt=True)  # 对应 JS new Date().toUTCString()
    digest = "SHA-256=" + base64.b64encode(
        hashlib.sha256(body_str.encode("utf-8")).digest()
    ).decode("ascii")
    signing_string = f"x-date: {x_date}\ndigest: {digest}"
    signature = base64.b64encode(
        hmac.new(HMAC_SECRET.encode("utf-8"), signing_string.encode("utf-8"),
                 hashlib.sha1).digest()
    ).decode("ascii")
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-date": x_date,
        "Digest": digest,
        "Authorization": (
            f'hmac username="{HMAC_USERNAME}", algorithm="hmac-sha1", '
            f'headers="x-date digest", signature="{signature}"'
        ),
        "User-Agent": DEFAULT_UA,
        "Referer": f"https://servicewechat.com/{MINI_APP_ID}/0/page-frame.html",
    }
    if token is not None:
        headers["ArrowAuthorization"] = token or ""
        headers["userId"] = str(user_id if user_id is not None else "")
    return headers


def api_post(path, body, token=None, user_id=None):
    """POST 业务接口: body 序列化后同时用于签名与请求体 (必须一致)。"""
    body_str = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
    headers = sign_headers(body_str, token=token, user_id=user_id)
    resp = session.post(f"{BASE_URL}{path}", data=body_str.encode("utf-8"),
                        headers=headers, timeout=30)
    # 会话失效时服务端是用 HTTP 401/403 表达的, 不是 JSON 信封里的 code。
    # raise_for_status() 会在 run_account 的重登重放分支之前就把它抛成异常
    # (实测缓存 token 过期后直接报 "401 Client Error", 整个账号失败),
    # 所以这里把它翻译成带 code 的信封, 交给调用方去重登。
    if resp.status_code in SESSION_CODES:
        try:
            data = resp.json()
        except Exception:
            data = {}
        if not isinstance(data, dict):
            data = {}
        data["code"] = resp.status_code
        return data
    resp.raise_for_status()
    return resp.json()


def envelope_entity(resp):
    data = resp.get("data") if isinstance(resp, dict) else None
    if isinstance(data, dict) and isinstance(data.get("entity"), dict):
        return data["entity"]
    if isinstance(resp, dict) and isinstance(resp.get("entity"), dict):
        return resp["entity"]
    return {}


def resp_code(resp):
    for k in ("code", "status"):
        v = (resp or {}).get(k)
        if v is not None:
            try:
                return int(v)
            except (TypeError, ValueError):
                pass
    return -1


# ---------------------------------------------------------------------------
# 登录 / 会话
# ---------------------------------------------------------------------------
def is_member(entity):
    """源码: uid 非空 <=> 已完成手机号授权注册的会员 (isAuth/hasPhone 均以 uid 判定)。"""
    return bool(entity) and str(entity.get("id", "-1")) != "-1" and bool(entity.get("uid"))


def login(account_id):
    """wx.login code -> user/login (postNoAuth, 无 ArrowAuthorization) -> entity。

    无有效会员实体时，通过同一 runtime 的标准手机号授权包恢复既有会员会话。
    空 data 不是“从未注册”的证据；恢复失败明确报错，不包装为成功。
    """
    code = get_wx_code(account_id)
    body = {"code": code, "registerSource": "", "activityCode": ACTIVITY_CODE}
    # 登录接口 postNoAuth: 仍签名, 但不带 ArrowAuthorization/userId
    resp = api_post(f"{PATH_PREFIX}/ubr/user/login", body)
    if resp_code(resp) not in (SUCCESS_CODE, 50001):
        raise RuntimeError(f"登录失败 code={resp_code(resp)}")
    entity = envelope_entity(resp)
    # An empty response does not establish that an existing member is unregistered.
    # Use the official, same-runtime phone/login bundle to renew membership.
    if not is_member(entity):
        bundle = session.post(f"{WX_SERVER_URL}/wx/phone-login-bundle",
                              json={"appid": MINI_APP_ID, "openid": account_id},
                              headers={"auth": WX_AUTH}, timeout=90)
        bundle.raise_for_status()
        package = bundle.json()
        data = package.get("data") or {}
        fresh = data.get("loginCode") or package.get("loginCode")
        phone = data.get("phoneCode") or package.get("phoneCode")
        if package.get("status") is not True or not fresh or not phone:
            raise RuntimeError("member_session_restore_failed")
        restored = api_post(f"{PATH_PREFIX}/ubr/user/wechatLogin",
                            {"code": fresh, "acceptPushProvisions": False,
                             "activityCode": ACTIVITY_CODE, "phoneCode": phone,
                             "id": str(entity.get("id", "-1"))},
                            token=entity.get("token", ""), user_id=entity.get("id", "-1"))
        entity = envelope_entity(restored)
        if resp_code(restored) != SUCCESS_CODE or not is_member(entity) or not entity.get("token"):
            raise RuntimeError("member_session_restore_rejected")
    return entity


def get_entity_for_account(account_id, index, force=False):
    if not force:
        cached = get_cached_entity(account_id)
        if cached.get("token") and is_member(cached):
            print(f"账号 {index} 使用缓存 token: {mask(cached.get('token'))}")
            return cached
    entity = login(account_id)
    if is_member(entity):
        save_cached_entity(account_id, entity)
        print(f"账号 {index} code 登录成功: 会员 {mask(entity.get('token'))}")
    else:
        remove_cached_entity(account_id)
        print(f"账号 {index} code 登录成功: 未注册会员 (NONMEMBER)")
    return entity


# ---------------------------------------------------------------------------
# 签到业务
# ---------------------------------------------------------------------------
def activity_detail(token, user_id):
    return api_post(f"{PATH_PREFIX}/business/activityRecord/detail",
                    {"userId": user_id, "activityCode": ACTIVITY_CODE,
                     "prePrizeIds": []}, token=token, user_id=user_id)


def sign_in_record(token, user_id, month):
    return api_post(f"{PATH_PREFIX}/business/yunyingqiu/signInRecord",
                    {"userId": user_id, "activityCode": ACTIVITY_CODE,
                     "month": month}, token=token, user_id=user_id)


def complete_quest(token, user_id, quest_template_id):
    return api_post(f"{PATH_PREFIX}/business/activityRecord/completeQuest",
                    {"userId": user_id, "activityCode": ACTIVITY_CODE,
                     "questTemplateId": quest_template_id},
                    token=token, user_id=user_id)


def select_surprise5_pool(token, user_id, prize):
    """一次性选择「连续签到5天」抽奖奖池 (surprise5select)。

    复刻小程序确认弹窗的提交: POST /business/surpriseFivePhase/selectedPrize
    body {selectedPrize:[prize], userId}, 成功 code==200。prize ∈ ticket1/ticket2/hotel。
    仅在检测到奖池门槛且用户已授权(bjhqbwz_pool)时调用一次, 服务端按活动/期次判定,
    已选过则再次签到不会触发门槛, 故天然幂等。
    """
    return api_post(f"{PATH_PREFIX}/business/surpriseFivePhase/selectedPrize",
                    {"selectedPrize": [prize], "userId": user_id},
                    token=token, user_id=user_id)


def find_sign_in_template_id(detail_resp):
    entity = envelope_entity(detail_resp)
    for quest in entity.get("questList") or []:
        if quest.get("templateCode") == "SIGN_IN":
            return quest.get("templateId")
    return None


def already_signed_today(record_resp):
    entity = envelope_entity(record_resp)
    today = bj_now().strftime("%Y-%m-%d")
    for info in entity.get("signInInfos") or []:
        if info.get("day") == today and info.get("signIn"):
            return True
    return False


READ_ONLY = os.getenv("BJHQBWZ_READ_ONLY") == "1" or os.getenv("QL_READ_ONLY") == "1"
WRITE_STATE_PATH = Path(__file__).with_name(".bjhqbwz_write_state.json")
LOCK_PATH = Path(__file__).with_name(".bjhqbwz_write.lock")

def read_write_state():
    try:
        data = json.loads(WRITE_STATE_PATH.read_text())
    except FileNotFoundError:
        return {}
    if not isinstance(data, dict):
        raise RuntimeError("write_state_invalid")
    return data

def persist_write_state(key, entry):
    state = read_write_state()
    state[key] = entry
    payload = json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode()
    fd, tmp = tempfile.mkstemp(dir=str(WRITE_STATE_PATH.parent), prefix=WRITE_STATE_PATH.name + ".tmp.")
    try:
        with os.fdopen(fd, "wb") as f:
            if f.write(payload) != len(payload):
                raise RuntimeError("state_short_write")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, WRITE_STATE_PATH)
        dfd = os.open(str(WRITE_STATE_PATH.parent), os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
        if WRITE_STATE_PATH.read_bytes() != payload:
            raise RuntimeError("state_readback_failed")
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

def authority(entity):
    r = sign_in_record(entity["token"], entity["id"], bj_now().strftime("%Y-%m"))
    if resp_code(r) != SUCCESS_CODE:
        raise RuntimeError("sign_record_unavailable")
    rows = envelope_entity(r).get("signInInfos")
    if not isinstance(rows, list):
        raise RuntimeError("sign_record_fields_invalid")
    today = bj_now().strftime("%Y-%m-%d")
    current = [x for x in rows if isinstance(x, dict) and x.get("day") == today]
    if len(current) != 1 or not isinstance(current[0].get("signIn"), bool):
        raise RuntimeError("sign_record_today_invalid")
    return current[0]["signIn"]

def run_account(account_id, index):
    entity = get_entity_for_account(account_id, index)
    if not is_member(entity) or not entity.get("token"):
        raise RuntimeError("member_session_unavailable")
    detail = activity_detail(entity["token"], entity["id"])
    if resp_code(detail) in SESSION_CODES:
        entity = get_entity_for_account(account_id, index, force=True)
        detail = activity_detail(entity["token"], entity["id"])
    if resp_code(detail) != SUCCESS_CODE:
        raise RuntimeError("activity_detail_rejected")
    template = find_sign_in_template_id(detail)
    if not template:
        raise RuntimeError("sign_template_missing")
    if authority(entity):
        return f"【账号 {index}】今日已签到（服务端确认）", True
    if READ_ONLY:
        return f"【账号 {index}】只读：今日未签，零业务写", True
    fd = os.open(str(LOCK_PATH), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if authority(entity):
            return f"【账号 {index}】今日已签（写前确认）", True
        key = hashlib.sha256(account_id.encode()).hexdigest() + "|" + bj_now().strftime("%Y-%m-%d") + "|" + str(template)
        previous = read_write_state().get(key) or {}
        attempts = previous.get("attempts", 0)
        if not isinstance(attempts, int) or attempts < 0 or attempts >= 2:
            return f"【账号 {index}】写入次数上限或状态错误", False
        if previous:
            if previous.get("status") not in ("unknown", "attempting") or time.time() - previous.get("at", time.time()) < 600:
                return f"【账号 {index}】已有写记录或冷却未结束，不自动重放", False
            # This is the second independent authority read after cooldown.
            if authority(entity):
                return f"【账号 {index}】已签（恢复前权威确认）", True
        pool = api_post(f"{PATH_PREFIX}/business/surpriseFivePhase/detail", {"userId": entity["id"]}, token=entity["token"], user_id=entity["id"])
        data = pool.get("data") or {}
        if resp_code(pool) != SUCCESS_CODE or not isinstance(data.get("selectedPrize"), list):
            raise RuntimeError("pool_state_unavailable")
        if data.get("phaseState") == 1 and not data["selectedPrize"]:
            if POOL_CHOICE not in POOL_LABELS:
                raise RuntimeError("pool_choice_required")
            poolKey = hashlib.sha256(account_id.encode()).hexdigest() + "|pool|" + str(data.get("phaseNo"))
            if read_write_state().get(poolKey):
                raise RuntimeError("pool_write_unconfirmed_no_replay")
            persist_write_state(poolKey, {"status": "attempting", "choice": POOL_CHOICE, "at": time.time()})
            select_surprise5_pool(entity["token"], entity["id"], POOL_CHOICE)
            check = api_post(f"{PATH_PREFIX}/business/surpriseFivePhase/detail", {"userId": entity["id"]}, token=entity["token"], user_id=entity["id"])
            if resp_code(check) != SUCCESS_CODE or (check.get("data") or {}).get("selectedPrize") != [POOL_CHOICE]:
                raise RuntimeError("pool_selection_unconfirmed")
            persist_write_state(poolKey, {"status": "success", "choice": POOL_CHOICE, "at": time.time()})
        if authority(entity):
            return f"【账号 {index}】今日已签（选池后确认）", True
        persist_write_state(key, {"status": "attempting", "attempts": attempts + 1, "at": time.time()})
        try:
            complete_quest(entity["token"], entity["id"], template)
        except Exception:
            pass
        try:
            signed = authority(entity)
        except Exception:
            signed = False
        persist_write_state(key, {"status": "success" if signed else "unknown", "attempts": attempts + 1, "authorityConfirmed": signed, "at": time.time()})
        return f"【账号 {index}】" + ("签到成功（服务端确认）" if signed else "签到未获权威确认，不自动重放"), signed
    finally:
        os.close(fd)


def main():
    raw = os.getenv("bjhqbwz", "")
    accounts = [x.strip() for x in raw.replace("&", "\n").splitlines() if x.strip()]

    if not accounts:
        print('[QLRUN_RESULT] FAILURE {"script":"bjhqbwz.py","reason":"no_env","retryable":0}')
        return 1
    if not WX_AUTH:
        print('[QLRUN_RESULT] FAILURE {"script":"bjhqbwz.py","reason":"no_wx_auth","retryable":0}')
        return 1

    print("=============== 北京环球 签到开始 ===============")
    summaries = []
    ok_count = 0
    for i, entry in enumerate(accounts, 1):
        parts = entry.split("#", 1)
        account = parts[0].strip()
        remark = parts[1].strip() if len(parts) > 1 else ""
        print(f"\n-------------- 账号 {i}{('/' + remark) if remark else ''} --------------")
        try:
            summary, ok = run_account(account, i)
            summaries.append(summary)
            ok_count += 1 if ok else 0
        except Exception as e:
            print(f"❌ 账号 {i} 执行异常: {e}")
            summaries.append(f"【账号 {i}】\n❌ 执行异常: {e}")
        time.sleep(1)

    print("\n=============== 北京环球 签到结束 ===============")
    title = f"北京环球签到 {ok_count}/{len(accounts)} 成功"
    try:
        send(title, "\n\n".join(summaries))
    except Exception as e:
        print(f"⚠️ 通知发送失败: {e}")

    print('[QLRUN_RESULT] ' + ('SUCCESS ' if ok_count == len(accounts) else 'FAILURE ') + json.dumps({"script": "bjhqbwz.py", "accounts": len(accounts), "failed": len(accounts) - ok_count, "retryable": 0, "mode": "read_only" if READ_ONLY else "normal"}))
    return 0 if ok_count == len(accounts) else 1

if __name__ == "__main__":
    sys.exit(main())
