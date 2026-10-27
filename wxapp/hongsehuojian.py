#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 红色火箭(华夏基金) - 每日签到得积分
# 入口: 微信小程序「红色火箭」-> 积分中心 -> 签到
# 说明: 通过 wx_server(smallcat) 用 openid 自动登录, 完成每日签到
# 账号变量名:hshj   (填写 wx_server 中的 openid, 多账号用换行或 & 分割, 可选 #备注)
# 需要配置 wx_server_url、wx_auth
# 可选变量:
#   hshj_ticket       手动 ticket, 格式 token 或 token#userId, 多账号用换行/& 分割(按账号顺序)
#   hshj_phone_login  是否允许用 /wx/getphonenumber 自动登录, 默认 1(开启), 置 0 关闭
#   hshj_ver          miniProgram.version, 默认 1.46.0
#new Env("红色火箭签到")
#cron 25 8 * * *
#
# ---------------------------------------------------------------------------
# 接口契约(全部逆自反编译包 wx1b44c3ad181bde16 主包, 已逐行核对)
#   base: https://index.amcfortune.com                     common/vendor.js:6290 (模块 6c8e)
#   固定请求头: ticket / Bank-Type:main / pro / ver / pla / register_channel /
#              click_id / user_id / mini_program:wechat     vendor.js:6292-6301
#     pro    = "RedRocket"(本 appid) 或 "RedRocket-Pro"     vendor.js:12074 setupPlatform
#     pla    = rr_iphone / rr_Android / rr_<osName>         vendor.js:12070
#     ver    = getAccountInfoSync().miniProgram.version, 空则 "1.46.0"
#     user_id= 有 ticket 时才带                             vendor.js:6300
#   GET : 自动追加 query key=Date.now()                     vendor.js:6289
#   POST: 追加请求头 nonce / timestamp / signature /
#         key_version / openid                              vendor.js:6302-6308
#   签名(模块 b633, vendor.js:9643-9666 + 9760 c()):
#     t = {...body}; t.nonce ?= nonce; t.timestamp ?= timestamp;
#     t.appSecret = state.encryptKey; if (ticket!=null) t.ticket = ticket
#     raw = 键名升序 "k=v&" 拼接后去掉末尾 "&" (值为对象时 JSON.stringify)
#     signature = Base64(md5_hex_lowercase(utf8(raw)))
#       md5  : 模块 80d8 blueimp, h() 用 "0123456789abcdef" 小写十六进制,
#              g()=unescape(encodeURIComponent()) 即 UTF-8      vendor.js:6960-7000
#       Base64: 模块 b633 u.encode, 标准字母表 + "=" 补位         vendor.js:9720-9737
#     appSecret = wx.getUserCryptoManager().getLatestUserKey().encryptKey
#              -> smallcat POST /wx/encryptkey 的 data.encrypt_key
#     key_version = 同一响应的 data.version
#   响应码(vendor.js:6341-6371): 0/200 成功; 7006 -> 重取 secure_path 加密列表;
#     7005 -> 刷新用户 key 后重试一次; 407 -> ticket 失效, 清空 ticket/userId
#   端点(模块 86ff):
#     POST /fundex-uc/uc/v1/getWxOpenIdAndUnionId {code}  -> data.openId/unionId
#                                                           vendor.js:10228
#     POST /fundex-uc/uc/v1/login {...}                   -> data.token(=ticket)
#                                                           components/loginBtns/loginBtns.js:176
#     POST /fundex-uc/uc/v1/getTokenStatus {token,source}  data.status=="0" 有效,
#                                                           data.newToken 轮换
#                                                           vendor.js:11959
#     GET  /fundex-activity/point/sign/getSignDays        vendor.js:7470
#     POST /fundex-activity/point/sign/userSignIn         vendor.js:7544
#     GET  /fundex-activity/point/account/getTotalPoint   vendor.js:7494 (silent)
#   userSignIn 不在加密列表内(secure_path 实测只含 redPacket/exchangeRedPacket、
#   watchWordCustom/doExchange、point/task/completeTaskV3), 故明文 body。
#
# 已知限制(如实说明, 不猜接口):
#   1. 签到页 pages_detail/ 在分包内, smallcat /wx/downloadurl 按文档只返回主包,
#      分包 js 解包为空壳, 因此 getSignDays / userSignIn 的**业务入参无法从源码还原**。
#      本脚本按「无额外入参」发送(GET 只带 key, POST 送 {}), 并在拿到 getSignDays
#      响应后把其中的 activityNo/activityId 等活动标识透传给 userSignIn(存在才带),
#      不构造任何源码里没有的字段。
#   2. 全包唯一发 ticket 的入口是 /fundex-uc/uc/v1/login, 且只接受
#      wx.getPhoneNumber 的 code。实测服务端对本账号返回
#      loginStatus=fail / loginDesc=用户登录失败(已试过 isAuthorized、去
#      registerChannel、先建运行时会话、appSecret 冷启动态等多种忠实复刻),
#      属服务端注册/风控策略, 不做绕过。若遇此情况请先在小程序内手动登录一次,
#      或把 App 内已登录的 token 填到 hshj_ticket 变量。
# ---------------------------------------------------------------------------

import base64
import hashlib
import json
import os
import random
import sys
import time
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
# 常量 (均来自反编译源码, 非机密)
# ---------------------------------------------------------------------------
MINI_APP_ID = "wx1b44c3ad181bde16"
BASE_URL = "https://index.amcfortune.com"
PRO = "RedRocket"
PLA = "rr_Android"
AGREEMENT = "阅读并同意用户协议、隐私政策，未注册的手机号认证后自动创建新账户"

EP_OPENID = "/fundex-uc/uc/v1/getWxOpenIdAndUnionId"
EP_LOGIN = "/fundex-uc/uc/v1/login"
EP_TOKEN_STATUS = "/fundex-uc/uc/v1/getTokenStatus"
EP_SIGN_DAYS = "/fundex-activity/point/sign/getSignDays"
EP_SIGN_RECORD = "/fundex-activity/point/sign/getRecordList"
EP_SIGN_IN = "/fundex-activity/point/sign/userSignIn"
EP_TOTAL_POINT = "/fundex-activity/point/account/getTotalPoint"
EP_SECURE_LIST = "/fundex-material/knowledgeBase/findKnowledgeInfoListByKeyList"

# smallcat / wx_server 配置 (机密, 只从环境变量读取)
WX_SERVER_URL = os.getenv("wx_server_url", "http://192.168.31.196:8787").rstrip("/")
WX_AUTH = os.getenv("wx_auth", "")
VERSION = os.getenv("hshj_ver", "1.46.0")
ALLOW_PHONE_LOGIN = os.getenv("hshj_phone_login", "1").strip().lower() not in ("0", "false", "no")

TOKEN_CACHE_PATH = Path(__file__).with_name("hongsehuojian_token_cache.json")

# --- 防重放/结果契约 (与 JS 脚本同一语义, 不把失败伪装成成功) -----------------
# HSHJ_READ_ONLY=1: 只登录+只读权威状态(getRecordList/getTotalPoint),
#   绝不调用写接口 userSignIn, 也不写状态文件; 用于上线后只读/权威验证。
# 状态文件 hongsehuojian_sign_state.json: 按 日期 -> account 记录
#   success / failed / attempting / unknown + attempts(当日写次数) +
#   not_signed_confirms(写后未知后连续权威确认未签的次数)。
# 写前必须原子落盘 attempting 并回读校验成功才允许出网;
# 写后结果未知(网络/超时/5xx)只做只读权威收敛, 本进程不重发;
# 冷却期 + 连续两次权威确认未签后, 当日最多再恢复写一次(硬上限)。
READ_ONLY = os.getenv("HSHJ_READ_ONLY", "0").strip().lower() in ("1", "true", "yes")
STATE_PATH = Path(__file__).with_name("hongsehuojian_sign_state.json")
COOLDOWN_SEC = 1800        # 写后未知后的冷却期(秒), 期间不恢复写
MAX_WRITE_ATTEMPTS = 2      # 当日写次数硬上限: 首次 + 最多一次恢复写
RESULT_LINE_TAG = "[QLRUN_RESULT]"


def _today():
    return time.strftime("%Y-%m-%d", time.localtime())


def load_state():
    try:
        if STATE_PATH.exists():
            return json.loads(STATE_PATH.read_text(encoding="utf-8")) or {}
    except Exception:
        pass
    return {}


def save_state_atomic(state):
    """临时文件 + os.replace 原子落盘, 并回读校验; 失败抛错(写前必须阻断)。"""
    tmp = STATE_PATH.with_name(STATE_PATH.name + ".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, STATE_PATH)
    back = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    if back != state:
        raise RuntimeError("状态文件回读校验不一致")


def _rec(state, account_id):
    return (state.setdefault(_today(), {}).get(account_id)) or {}


def _set_rec(state, account_id, rec):
    state.setdefault(_today(), {})[account_id] = rec
    save_state_atomic(state)


def _is_transient(exc):
    """只读 GET 的瞬态故障(连接/超时/408/425/429/5xx); 写 POST 不在此重试。"""
    if isinstance(exc, (requests.exceptions.ConnectionError,
                       requests.exceptions.Timeout,
                       requests.exceptions.ChunkedEncodingError)):
        return True
    resp = getattr(exc, "response", None)
    if resp is not None and getattr(resp, "status_code", 0) in (408, 425, 429, 500, 502, 503, 504):
        return True
    return False


session = requests.Session()


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
def mask(value):
    if not value:
        return ""
    value = str(value)
    if len(value) <= 10:
        return value[:2] + "***"
    return f"{value[:4]}***{value[-4:]}"


def js_str(value):
    """复刻 JS 的字符串拼接语义, 保证签名串与小程序完全一致。"""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    if isinstance(value, dict):
        # 源码: Object.prototype.toString.call(v) === "[object Object]" 时用 JSON.stringify
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        # JS 里数组走 "" + arr, 等价于 join(",")
        return ",".join(js_str(x) for x in value)
    return str(value)


def make_signature(body, nonce, timestamp, app_secret, ticket=None):
    """signature = Base64(md5_hex_lowercase(sorted "k=v&" join))  (vendor.js 模块 b633)"""
    fields = dict(body or {})
    fields.setdefault("nonce", nonce)
    fields.setdefault("timestamp", timestamp)
    fields["appSecret"] = app_secret
    if ticket is not None:
        fields["ticket"] = ticket
    raw = "".join(f"{k}={js_str(fields[k])}&" for k in sorted(fields.keys()))[:-1]
    digest = hashlib.md5(raw.encode("utf-8")).hexdigest()
    return base64.b64encode(digest.encode("utf-8")).decode("utf-8")


def make_nonce():
    # 源码: "" + (1e6*Math.random()).toFixed(0) + (1e6*Math.random()).toFixed(0)
    return f"{random.randint(0, 1000000)}{random.randint(0, 1000000)}"


# ---------------------------------------------------------------------------
# 国密 SM4-128-ECB 加密 (vendor.js 模块 5c57, secure path 请求体加密)
# 实测(2026-10-27 设备 wxapkg 还原):
#   - key = base64decode(encrypt_key)(16 字节); PKCS#7 填充; ECB(无 iv)
#   - 明文 = JSON.stringify(原始 body); 输出 = 小写 hex
#   - 信封 = {"msg": hex密文}; signature 覆盖该加密后信封
# ---------------------------------------------------------------------------
_SM4_SBOX = [
    0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7, 0x16, 0xb6, 0x14, 0xc2, 0x28, 0xfb, 0x2c, 0x05,
    0x2b, 0x67, 0x9a, 0x76, 0x2a, 0xbe, 0x04, 0xc3, 0xaa, 0x44, 0x13, 0x26, 0x49, 0x86, 0x06, 0x99,
    0x9c, 0x42, 0x50, 0xf4, 0x91, 0xef, 0x98, 0x7a, 0x33, 0x54, 0x0b, 0x43, 0xed, 0xcf, 0xac, 0x62,
    0xe4, 0xb3, 0x1c, 0xa9, 0xc9, 0x08, 0xe8, 0x95, 0x80, 0xdf, 0x94, 0xfa, 0x75, 0x8f, 0x3f, 0xa6,
    0x47, 0x07, 0xa7, 0xfc, 0xf3, 0x73, 0x17, 0xba, 0x83, 0x59, 0x3c, 0x19, 0xe6, 0x85, 0x4f, 0xa8,
    0x68, 0x6b, 0x81, 0xb2, 0x71, 0x64, 0xda, 0x8b, 0xf8, 0xeb, 0x0f, 0x4b, 0x70, 0x56, 0x9d, 0x35,
    0x1e, 0x24, 0x0e, 0x5e, 0x63, 0x58, 0xd1, 0xa2, 0x25, 0x22, 0x7c, 0x3b, 0x01, 0x21, 0x78, 0x87,
    0xd4, 0x00, 0x46, 0x57, 0x9f, 0xd3, 0x27, 0x52, 0x4c, 0x36, 0x02, 0xe7, 0xa0, 0xc4, 0xc8, 0x9e,
    0xea, 0xbf, 0x8a, 0xd2, 0x40, 0xc7, 0x38, 0xb5, 0xa3, 0xf7, 0xf2, 0xce, 0xf9, 0x61, 0x15, 0xa1,
    0xe0, 0xae, 0x5d, 0xa4, 0x9b, 0x34, 0x1a, 0x55, 0xad, 0x93, 0x32, 0x30, 0xf5, 0x8c, 0xb1, 0xe3,
    0x1d, 0xf6, 0xe2, 0x2e, 0x82, 0x66, 0xca, 0x60, 0xc0, 0x29, 0x23, 0xab, 0x0d, 0x53, 0x4e, 0x6f,
    0xd5, 0xdb, 0x37, 0x45, 0xde, 0xfd, 0x8e, 0x2f, 0x03, 0xff, 0x6a, 0x72, 0x6d, 0x6c, 0x5b, 0x51,
    0x8d, 0x1b, 0xaf, 0x92, 0xbb, 0xdd, 0xbc, 0x7f, 0x11, 0xd9, 0x5c, 0x41, 0x1f, 0x10, 0x5a, 0xd8,
    0x0a, 0xc1, 0x31, 0x88, 0xa5, 0xcd, 0x7b, 0xbd, 0x2d, 0x74, 0xd0, 0x12, 0xb8, 0xe5, 0xb4, 0xb0,
    0x89, 0x69, 0x97, 0x4a, 0x0c, 0x96, 0x77, 0x7e, 0x65, 0xb9, 0xf1, 0x09, 0xc5, 0x6e, 0xc6, 0x84,
    0x18, 0xf0, 0x7d, 0xec, 0x3a, 0xdc, 0x4d, 0x20, 0x79, 0xee, 0x5f, 0x3e, 0xd7, 0xcb, 0x39, 0x48,
]
_SM4_CK = [
    0x00070e15, 0x1c232a31, 0x383f464d, 0x545b6269, 0x70777e85, 0x8c939aa1, 0xa8afb6bd, 0xc4cbd2d9,
    0xe0e7eef5, 0xfc030a11, 0x181f262d, 0x343b4249, 0x50575e65, 0x6c737a81, 0x888f969d, 0xa4abb2b9,
    0xc0c7ced5, 0xdce3eaf1, 0xf8ff060d, 0x141b2229, 0x30373e45, 0x4c535a61, 0x686f767d, 0x848b9299,
    0xa0a7aeb5, 0xbcc3cad1, 0xd8dfe6ed, 0xf4fb0209, 0x10171e25, 0x2c333a41, 0x484f565d, 0x646b7279,
]
_SM4_FK = (0xa3b1bac6, 0x56aa3350, 0x677d9197, 0xb27022dc)
_SM4_M = 0xFFFFFFFF


def _rol32(x, n):
    return ((x << n) | (x >> (32 - n))) & _SM4_M


def _sm4_tau(a):
    b = [_SM4_SBOX[(a >> 24) & 255], _SM4_SBOX[(a >> 16) & 255],
         _SM4_SBOX[(a >> 8) & 255], _SM4_SBOX[a & 255]]
    return (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]


def _sm4_round_keys(key16):
    k = [(key16[0] << 24) | (key16[1] << 16) | (key16[2] << 8) | key16[3],
         (key16[4] << 24) | (key16[5] << 16) | (key16[6] << 8) | key16[7],
         (key16[8] << 24) | (key16[9] << 16) | (key16[10] << 8) | key16[11],
         (key16[12] << 24) | (key16[13] << 16) | (key16[14] << 8) | key16[15]]
    k = [k[0] ^ _SM4_FK[0], k[1] ^ _SM4_FK[1], k[2] ^ _SM4_FK[2], k[3] ^ _SM4_FK[3]]
    rk = []
    for i in range(32):
        out = _sm4_tau(k[1] ^ k[2] ^ k[3] ^ _SM4_CK[i])
        x = k[0] ^ out ^ _rol32(out, 13) ^ _rol32(out, 23)
        rk.append(x)
        k = [k[1], k[2], k[3], x]
    return rk


def _sm4_block(block, rk):
    x = [(block[0] << 24) | (block[1] << 16) | (block[2] << 8) | block[3],
         (block[4] << 24) | (block[5] << 16) | (block[6] << 8) | block[7],
         (block[8] << 24) | (block[9] << 16) | (block[10] << 8) | block[11],
         (block[12] << 24) | (block[13] << 16) | (block[14] << 8) | block[15]]
    for i in range(32):
        out = _sm4_tau(x[1] ^ x[2] ^ x[3] ^ rk[i])
        xn = x[0] ^ out ^ _rol32(out, 2) ^ _rol32(out, 10) ^ _rol32(out, 18) ^ _rol32(out, 24)
        x = [x[1], x[2], x[3], xn]
    y = [x[3], x[2], x[1], x[0]]
    res = []
    for w in y:
        res += [(w >> 24) & 255, (w >> 16) & 255, (w >> 8) & 255, w & 255]
    return res


def sm4_ecb_hex(plaintext: bytes, key_b64: str) -> str:
    """SM4-128-ECB + PKCS#7, 返回小写 hex。key_b64 = encrypt_key(base64 串)。"""
    key16 = base64.b64decode(key_b64)
    rk = _sm4_round_keys(key16)
    pad = 16 - (len(plaintext) % 16)
    data = plaintext + bytes([pad]) * pad
    out = bytearray()
    for off in range(0, len(data), 16):
        out += bytes(_sm4_block(data[off:off + 16], rk))
    return out.hex()


def read_token_cache():
    try:
        if not TOKEN_CACHE_PATH.exists():
            return {}
        return json.loads(TOKEN_CACHE_PATH.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def write_token_cache(cache):
    try:
        TOKEN_CACHE_PATH.write_text(
            json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception as e:
        print(f"⚠️ 写入token缓存失败: {e}")


# ---------------------------------------------------------------------------
# smallcat
# ---------------------------------------------------------------------------
def smallcat(endpoint, account_id):
    if not WX_AUTH:
        raise RuntimeError("缺少 wx_auth, 无法调用 wx_server")
    headers = {"Accept": "application/json", "Content-Type": "application/json", "auth": WX_AUTH}
    body = json.dumps({"appid": MINI_APP_ID, "openid": account_id})
    resp = session.post(f"{WX_SERVER_URL}{endpoint}", data=body, headers=headers, timeout=60)
    resp.raise_for_status()
    return resp.json()


def get_code(account_id, endpoint="/wx/code"):
    """smallcat 偶发 "获取失败"(运行时会话抖动), 刷新会话后间隔重试。"""
    last_msg = ""
    for attempt in range(4):
        if attempt:
            try:
                smallcat("/wx/refresh", account_id)
            except Exception:
                pass
            time.sleep(3)
        data = smallcat(endpoint, account_id)
        if isinstance(data, dict) and data.get("status") is False:
            last_msg = data.get("message") or "获取失败"
            continue
        code = data.get("code") or (data.get("data") or {}).get("code")
        if code:
            return code
        last_msg = "wx_server 未返回 code"
    raise RuntimeError(f"wx_server {endpoint} 失败(已重试): {last_msg}")


def get_encrypt_key(account_id):
    data = (smallcat("/wx/encryptkey", account_id).get("data") or {})
    return data.get("encrypt_key"), data.get("version")


# ---------------------------------------------------------------------------
# 红色火箭 客户端
# ---------------------------------------------------------------------------
class RedRocket:
    def __init__(self, account_id, index):
        self.account_id = account_id
        self.index = index
        self.ticket = ""
        self.user_id = ""
        self.openid = ""
        self.unionid = ""
        self.encrypt_key = None
        self.encrypt_ver = None
        self.secure_paths = set()

    def fetch_secure_paths(self):
        """拉取需加密体的 API 路径清单 (secure_path)。失败不致命, 7006 时会再补拉。"""
        try:
            r = self.request(EP_SECURE_LIST, {"knowledgeKeyList": "secure_path"}, "GET")
            data = r.get("data") or []
            content = ""
            if isinstance(data, list) and data:
                content = data[0].get("knowledgeContent") or ""
            self.secure_paths = {x.strip() for x in content.split(",") if x.strip()}
        except Exception as e:
            print(f"  拉取加密清单失败(忽略): {e}")

    def _is_secure(self, path):
        return path in self.secure_paths

    # -- 传输层 ----------------------------------------------------------
    def request(self, path, data=None, method="POST", _retried=False):
        data = dict(data or {})
        headers = {
            "ticket": self.ticket or "",
            "Bank-Type": "main",
            "pro": PRO,
            "ver": VERSION,
            "pla": PLA,
            "register_channel": "",
            "click_id": "",
            "user_id": self.user_id if self.ticket else "",
            "mini_program": "wechat",
            "content-type": "application/json",
        }
        url = f"{BASE_URL}{path}"
        if method.upper() == "GET":
            data["key"] = int(time.time() * 1000)
            # 只读 GET: 瞬态故障有界重试一次; 写 POST 绝不重试
            resp = None
            for _get_attempt in range(2):
                try:
                    resp = session.get(url, params=data, headers=headers, timeout=60)
                    break
                except Exception as _e:
                    if _get_attempt == 0 and _is_transient(_e):
                        time.sleep(2)
                        continue
                    raise
        else:
            # secure path: 把原始 body 用 SM4-ECB 加密成 {"msg":hex}; 签名覆盖加密后信封
            if self._is_secure(path) and self.encrypt_key:
                plaintext = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
                data = {"msg": sm4_ecb_hex(plaintext.encode("utf-8"), self.encrypt_key)}
            nonce = make_nonce()
            timestamp = str(int(time.time() * 1000))
            headers.update({
                "nonce": nonce,
                "timestamp": timestamp,
                "signature": make_signature(data, nonce, timestamp, self.encrypt_key,
                                            self.ticket if self.ticket else None),
                "key_version": js_str(self.encrypt_ver),
                "openid": self.openid or "",
            })
            resp = session.post(
                url,
                data=json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8"),
                headers=headers,
                timeout=60,
            )
        resp.raise_for_status()
        resp.encoding = "utf-8"
        result = resp.json()

        code = str(result.get("code", ""))
        if code == "7005" and not _retried:
            # 用户加密 key 过期 -> 刷新后重试一次 (vendor.js:6358)
            self.encrypt_key, self.encrypt_ver = get_encrypt_key(self.account_id)
            return self.request(path, data, method, _retried=True)
        if code == "7006" and not getattr(self, "_retried_secure", False):
            # 服务端把该路径加入加密清单: 重取清单, 把路径标记为 secure 后重试一次
            print(f"  ⚠️ 7006(加密清单变更): 重取清单并加密重试")
            self._retried_secure = True
            self.fetch_secure_paths()
            self.secure_paths.add(path)
            return self.request(path, data, method, _retried=True)
        if code == "7006":
            print(f"  ⚠️ 服务端返回 7006(加密仍不被接受): {result.get('msg') or result.get('message')}")
        if code == "407":
            self.ticket = ""
            self.user_id = ""
            self.forget_ticket()
            raise RuntimeError("ticket 已失效(407), 需重新登录")
        return result

    @staticmethod
    def ok(result):
        return str(result.get("code", "")) in ("0", "200")

    @staticmethod
    def err(result):
        return result.get("msg") or result.get("message") or json.dumps(result, ensure_ascii=False)[:200]

    # -- 缓存 ------------------------------------------------------------
    def load_cache(self):
        entry = read_token_cache().get(self.account_id) or {}
        self.ticket = entry.get("ticket") or ""
        self.user_id = str(entry.get("userId") or "")
        return bool(self.ticket)

    def save_cache(self):
        cache = read_token_cache()
        cache[self.account_id] = {
            "ticket": self.ticket,
            "userId": self.user_id,
            "openId": self.openid,
            "updatedAt": int(time.time()),
        }
        write_token_cache(cache)

    def forget_ticket(self):
        cache = read_token_cache()
        if self.account_id in cache:
            del cache[self.account_id]
            write_token_cache(cache)

    # -- 登录 ------------------------------------------------------------
    def resolve_openid(self):
        """wx.login code -> openId / unionId (小程序 store 的 openid, 非 wx_server 的 openid)。"""
        code = get_code(self.account_id)
        result = self.request(EP_OPENID, {"code": code})
        if not self.ok(result):
            raise RuntimeError(f"获取 openId 失败: {self.err(result)}")
        data = result.get("data") or {}
        self.openid = data.get("openId") or ""
        self.unionid = data.get("unionId") or ""
        if not self.openid:
            raise RuntimeError(f"响应未包含 openId: {self.err(result)}")

    def check_ticket(self):
        """POST getTokenStatus: data.status=="0" 有效; newToken 需轮换。"""
        try:
            result = self.request(EP_TOKEN_STATUS,
                                  {"token": self.ticket, "source": "miniProgram"})
        except Exception as e:
            print(f"  校验 ticket 异常: {e}")
            return False
        if not self.ok(result):
            return False
        data = result.get("data") or {}
        if str(data.get("status", "")) != "0":
            return False
        if data.get("newToken"):
            self.ticket = data["newToken"]
            print("  ticket 已轮换")
        if data.get("userId"):
            self.user_id = str(data["userId"])
        self.save_cache()
        return True

    def login_by_phone(self):
        """唯一发 ticket 的入口, 需 wx.getPhoneNumber 的 code (用户已明确授权)。"""
        phone_code = get_code(self.account_id, "/wx/getphonenumber")
        body = {
            "loginWay": "miniprogram",
            "platform": "mini_fundex",
            "code": phone_code,
            "openId": self.openid,
            "unionId": self.unionid,
            "signAgreement": AGREEMENT,
            "registerChannel": "",
        }
        result = self.request(EP_LOGIN, body)
        data = result.get("data") or {}
        if str(data.get("loginStatus", "")).lower() != "success":
            raise RuntimeError(data.get("loginDesc") or self.err(result))
        self.ticket = data.get("token") or ""
        self.user_id = str(data.get("userId") or "")
        if not self.ticket:
            raise RuntimeError("登录成功但未返回 token")
        self.save_cache()
        return data.get("isRegister")

    # -- 签到 ------------------------------------------------------------
    def get_sign_days(self):
        """查询签到日历。

        实测 `point/sign/getSignDays` 需要一个只存在于分包里的业务入参, 不带参
        时服务端直接 500(`{"msg":"系统异常","data":{"cause":"cause null"}}`);
        而 `point/sign/getRecordList`(源码里的 homeQuery) 无参即可返回完整日历,
        且带服务端当天日期, 因此改用后者判定「今日是否已签」。
        """
        result = self.request(EP_SIGN_RECORD, {}, "GET")
        if not self.ok(result):
            raise RuntimeError(f"查询签到状态失败: {self.err(result)}")
        return result.get("data")

    @staticmethod
    def parse_sign_state(data):
        """从 getRecordList 响应里提取「今日是否已签」、连续天数与今日积分。

        实测响应形状:
            {"continuousDays": 0, "today": "2026-08-16",
             "signRecordList": [{"signDate": "2026-08-16", "point": 2,
                                 "signIn": false, "iconType": "5",
                                 "inflateDay": false}, ...]}
        以服务端 `today` 为准(不用本机时区)在 signRecordList 里找当天那条;
        读不到时返回 signed=None, 交由上层直接提交签到。
        """
        signed, days, today_point = None, None, None
        if isinstance(data, dict):
            days = data.get("continuousDays")
            today = data.get("today")
            records = data.get("signRecordList")
            if isinstance(records, list):
                for item in records:
                    if not isinstance(item, dict):
                        continue
                    if today and item.get("signDate") != today:
                        continue
                    value = item.get("signIn")
                    if isinstance(value, bool):
                        signed = value
                    elif isinstance(value, (int, str)) and str(value) in ("0", "1"):
                        signed = str(value) == "1"
                    today_point = item.get("point")
                    break
        return signed, days, today_point

    def sign_in(self):
        """POST point/sign/userSignIn。空 body: 全包无任何 activityNo/activityId,
        用户身份完全由 ticket 头承载。"""
        result = self.request(EP_SIGN_IN, {})
        return self.ok(result), result

    def total_point(self):
        try:
            result = self.request(EP_TOTAL_POINT, {}, "GET")
            if self.ok(result):
                data = result.get("data")
                if isinstance(data, dict):
                    for key in ("totalPoint", "total", "point", "points", "balance"):
                        if data.get(key) is not None:
                            return data[key]
                    return json.dumps(data, ensure_ascii=False)[:120]
                return data
        except Exception as e:
            print(f"  查询积分异常: {e}")
        return None


# ---------------------------------------------------------------------------
# 主流程 (每账号一次幂等签到)
# ---------------------------------------------------------------------------
def ensure_ticket(client, manual_ticket):
    if manual_ticket:
        token, _, uid = manual_ticket.partition("#")
        client.ticket = token.strip()
        client.user_id = uid.strip()
        print(f"账号 {client.index} 使用手动 ticket: {mask(client.ticket)}")
        if client.check_ticket():
            return True
        print(f"账号 {client.index} 手动 ticket 校验未通过, 继续尝试其他方式")
        client.ticket, client.user_id = "", ""

    if client.load_cache():
        print(f"账号 {client.index} 使用缓存 ticket: {mask(client.ticket)}")
        if client.check_ticket():
            return True
        print(f"账号 {client.index} 缓存 ticket 失效")
        client.ticket, client.user_id = "", ""
        client.forget_ticket()

    if not ALLOW_PHONE_LOGIN:
        raise RuntimeError("无可用 ticket, 且 hshj_phone_login=0 已关闭手机号登录")

    is_register = client.login_by_phone()
    print(f"账号 {client.index} 登录成功: userId={client.user_id} "
          f"{'(首次注册)' if str(is_register) == '1' else ''}")
    return True


def run_account(account_id, index, state):
    """返回 (汇总文本, outcome)。outcome =
    {"status": "SUCCESS"|"FAILURE", "retryable": bool,
     "write_attempted": bool, "reason": str}
    登录/写前读取的瞬态失败可 retryable=True(外层安全重跑);
    写已尝试(成功/拒绝/未知)一律 write_attempted=True, FAILURE 时 retryable=False。
    """
    lines = [f"【账号 {index}】"]
    outcome = {"status": "SUCCESS", "retryable": True,
               "write_attempted": False, "reason": ""}
    client = RedRocket(account_id, index)

    client.encrypt_key, client.encrypt_ver = get_encrypt_key(account_id)
    if not client.encrypt_key:
        raise RuntimeError("wx_server 未返回 encrypt_key, 无法签名")
    client.resolve_openid()
    client.fetch_secure_paths()

    manual = MANUAL_TICKETS[index - 1] if index - 1 < len(MANUAL_TICKETS) else ""
    ensure_ticket(client, manual)

    # 权威只读: 今日是否已签 (以服务端 today 为准)
    data = client.get_sign_days()
    signed, days, today_point = RedRocket.parse_sign_state(data)
    print(f"账号 {index} 签到状态: 今日已签={signed} 连续天数={days} 今日可得={today_point}")

    if signed is True:
        # 幂等收敛: 权威已签 -> 落 success, 绝不写
        try:
            _set_rec(state, account_id, {"status": "success",
                                         "reason": "authoritative_signed"})
        except Exception as e:
            print(f"  ⚠️ 状态落盘失败(已签幂等, 不影响结果): {e}")
        msg = f"今日已签到{f', 连续 {days} 天' if days is not None else ''}"
        print(f"✅ 账号 {index} {msg}")
        lines.append(f"✅ {msg}")
    elif READ_ONLY:
        # 只读模式: 不写状态文件, 不发写请求
        outcome["reason"] = "read_only_mode"
        print(f"🔍 账号 {index} 只读模式: 今日未签, 不发起签到写")
        lines.append("🔍 只读模式: 未发起签到写")
    else:
        rec = _rec(state, account_id)
        st = rec.get("status")

        if st == "success":
            lines.append("✅ 今日已签到(状态文件确认)")
        elif st == "failed":
            # 当日已被服务端确定性拒绝: 不再重发, 如实报失败且不允许外层重放
            outcome["status"] = "FAILURE"
            outcome["retryable"] = False
            outcome["reason"] = "write_rejected_today"
            print(f"❌ 账号 {index} 今日签到写已被服务端拒绝, 不再重发")
            lines.append(f"❌ 今日签到写已被服务端拒绝({rec.get('reason', '')}), 不再重发")
        do_write = False
        if st == "success":
            lines.append("✅ 今日已签到(状态文件确认)")
        elif st == "failed":
            # 当日已被服务端确定性拒绝: 不再重发, 如实报失败且不允许外层重放
            outcome["status"] = "FAILURE"
            outcome["retryable"] = False
            outcome["reason"] = "write_rejected_today"
            print(f"❌ 账号 {index} 今日签到写已被服务端拒绝, 不再重发")
            lines.append(f"❌ 今日签到写已被服务端拒绝({rec.get('reason', '')}), 不再重发")
        elif st in ("attempting", "unknown"):
            # 上次写出网后结果未知(或进程崩溃残留): 本进程不重发, 只做权威收敛
            attempts = rec.get("attempts", 1)
            last_ts = rec.get("last_attempt_ts", 0)
            confirms = rec.get("not_signed_confirms", 0) + 1
            if attempts >= MAX_WRITE_ATTEMPTS:
                outcome["status"] = "FAILURE"
                outcome["retryable"] = False
                outcome["reason"] = "recovery_attempts_exhausted"
                lines.append("⚠️ 写后结果未知: 当日恢复写次数已用尽, 不再自动写")
            elif time.time() - last_ts < COOLDOWN_SEC:
                _set_rec(state, account_id,
                         {**rec, "status": "unknown", "not_signed_confirms": confirms})
                outcome["status"] = "FAILURE"
                outcome["reason"] = "unknown_cooldown"
                lines.append(f"⚠️ 写后结果未知: 权威确认未签(第{confirms}次), 冷却期内不重发")
            elif confirms < 2:
                _set_rec(state, account_id,
                         {**rec, "status": "unknown", "not_signed_confirms": confirms})
                outcome["status"] = "FAILURE"
                outcome["reason"] = "unknown_confirming"
                lines.append(f"⚠️ 写后结果未知: 权威确认未签(第{confirms}/2次), 暂不恢复写")
            else:
                # 冷却期已过 + 连续两次权威确认未签: 放行唯一一次恢复写
                do_write = True
        else:
            do_write = True  # 当日首次写

        if do_write:
            # --- 真正发写: 首次 或 唯一一次恢复写 ---
            rec = _rec(state, account_id)
            attempts = rec.get("attempts", 0) + 1
            # 写前原子落盘 attempting 并回读校验, 失败则阻断写(绝不先出网)
            try:
                _set_rec(state, account_id,
                         {"status": "attempting", "attempts": attempts,
                          "last_attempt_ts": int(time.time()),
                          "not_signed_confirms": rec.get("not_signed_confirms", 0)})
            except Exception as e:
                outcome["status"] = "FAILURE"
                outcome["retryable"] = True  # 写未出网, 外层可安全重跑
                outcome["reason"] = "state_persist_failed"
                print(f"❌ 账号 {index} 写前状态落盘失败, 阻断写: {e}")
                lines.append(f"❌ 写前状态落盘失败, 阻断写: {e}")
                point = client.total_point()
                if point is not None:
                    lines.append(f"当前积分: {point}")
                return "\n".join(lines), outcome

            outcome["write_attempted"] = True
            try:
                ok, result = client.sign_in()
            except Exception as e:
                # 写后结果未知: 落 unknown, 本进程不重发, 交权威收敛
                _set_rec(state, account_id,
                         {**_rec(state, account_id), "status": "unknown"})
                outcome["status"] = "FAILURE"
                outcome["retryable"] = False
                outcome["reason"] = "write_unknown"
                print(f"❌ 账号 {index} 写后结果未知({e}), 不重发, 等待权威收敛")
                lines.append(f"❌ 签到写结果未知({e}), 不重发, 等待权威收敛")
            else:
                if ok:
                    data_ = result.get("data")
                    gained = None
                    if isinstance(data_, dict):
                        gained = data_.get("point") or data_.get("points") or data_.get("addPoint")
                    gained = gained or today_point
                    msg = "签到成功" + (f", +{gained} 积分" if gained else "")
                    _set_rec(state, account_id, {"status": "success", "attempts": attempts})
                    print(f"🎉 账号 {index} {msg}")
                    lines.append(f"🎉 {msg}")
                else:
                    detail = RedRocket.err(result)
                    if any(k in detail for k in ("已签", "重复", "已参与", "已领取")):
                        _set_rec(state, account_id,
                                 {"status": "success", "attempts": attempts,
                                  "reason": "server_idempotent"})
                        print(f"✅ 账号 {index} 今日已签到 ({detail})")
                        lines.append("✅ 今日已签到(服务端幂等)")
                    else:
                        _set_rec(state, account_id,
                                 {"status": "failed", "attempts": attempts,
                                  "reason": detail[:120]})
                        outcome["status"] = "FAILURE"
                        outcome["retryable"] = False
                        outcome["reason"] = "write_rejected"
                        print(f"❌ 账号 {index} 签到被服务端拒绝: {detail}")
                        lines.append(f"❌ 签到被服务端拒绝: {detail}")

    point = client.total_point()
    if point is not None:
        print(f"账号 {index} 当前积分: {point}")
        lines.append(f"当前积分: {point}")
    return "\n".join(lines), outcome


def _emit_result(status, payload):
    """整脚本只输出一条结构化结果行; 末尾追加扁平 retryable=0/1 以兼容 qlall
    NO_RETRY_FAILURE 正则(要求行内字面 retryable=0)。不打印 token/code/手机号。"""
    retry = payload.pop("retryable", 0)
    print(f"{RESULT_LINE_TAG} {status} {json.dumps(payload, ensure_ascii=False)} retryable={retry}")


def main():
    raw = os.getenv("hshj", "")
    accounts = [x.strip() for x in raw.replace("&", "\n").splitlines() if x.strip()]

    print("=============== 红色火箭 签到开始 ===============")
    if READ_ONLY:
        print("🔍 HSHJ_READ_ONLY=1 只读模式: 不发起任何签到写")

    if not accounts:
        print("❌ 未检测到账号信息(环境变量 hshj), 退出。")
        _emit_result("FAILURE", {"script": "hongsehuojian.py",
                                 "reason": "no_accounts", "retryable": 0})
        sys.exit(1)
    if not WX_AUTH:
        print("❌ 未配置 wx_auth, 无法获取 code, 退出。")
        _emit_result("FAILURE", {"script": "hongsehuojian.py",
                                 "reason": "no_wx_auth", "retryable": 0})
        sys.exit(1)

    state = load_state()
    summaries = []
    ok_n, fail_n = 0, 0
    write_attempted = False
    reasons = []
    for i, entry in enumerate(accounts, 1):
        parts = entry.split("#", 1)
        account = parts[0].strip()
        remark = parts[1].strip() if len(parts) > 1 else ""
        print(f"\n-------------- 账号 {i}{('/' + remark) if remark else ''} --------------")
        try:
            summary, oc = run_account(account, i, state)
        except Exception as e:
            # 异常发生在写之前: 未出网, 外层可安全重跑
            print(f"❌ 账号 {i} 执行异常: {e}")
            summary = f"【账号 {i}】\n❌ 执行异常: {e}"
            oc = {"status": "FAILURE", "retryable": True,
                  "write_attempted": False, "reason": "prewrite_exception"}
        summaries.append(summary)
        write_attempted = write_attempted or oc["write_attempted"]
        if oc["status"] == "SUCCESS":
            ok_n += 1
        else:
            fail_n += 1
            reasons.append(oc.get("reason") or "failure")
        time.sleep(1)

    status = "SUCCESS" if fail_n == 0 else "FAILURE"
    # 写已尝试过(无论成败/拒绝/未知) -> 失败不可由外层整段重放;
    # 纯写前登录/读取瞬态失败才可 retryable=1。
    retryable = 0 if (status == "FAILURE" and write_attempted) else (1 if status == "FAILURE" else 0)

    print("\n=============== 红色火箭 签到结束 ===============")
    try:
        send(f"红色火箭签到 {ok_n}/{len(accounts)} 成功", "\n\n".join(summaries))
    except Exception as e:
        print(f"⚠️ 通知发送失败: {e}")

    _emit_result(status, {
        "script": "hongsehuojian.py",
        "accounts": f"{ok_n}/{len(accounts)}",
        "mode": "read_only" if READ_ONLY else "normal",
        "writeAttempted": 1 if write_attempted else 0,
        "reason": ";".join(reasons) if reasons else "ok",
        "retryable": retryable,
    })
    sys.exit(0 if status == "SUCCESS" else 1)


MANUAL_TICKETS = [
    x.strip() for x in os.getenv("hshj_ticket", "").replace("&", "\n").splitlines() if x.strip()
]

if __name__ == "__main__":
    main()
