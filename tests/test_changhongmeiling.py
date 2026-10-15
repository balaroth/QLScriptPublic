import importlib.util
import re
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name("changhongmeiling.py")
if not SCRIPT.exists():
    SCRIPT = Path(__file__).resolve().parents[1] / "daily" / "changhongmeiling.py"
spec = importlib.util.spec_from_file_location("changhongmeiling", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class Response:
    def __init__(self, status=200, body=None, text=""):
        self.status_code = status
        self._body = body
        self.text = text or ("" if body is None else str(body))

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class CollectorHttp:
    def __init__(self, body):
        self.body = body
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return Response(200, self.body)


class BusinessHttp:
    def __init__(self, bodies):
        self.bodies = list(bodies)
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return Response(200, self.bodies.pop(0))


def menu(aggr="8PDA0H"):
    return {"code": "200", "data": [{"name": "签到打卡", "webUrl": f"/pages/arger/arger?activityData={aggr},0,10"}]}


def check(enabled=True):
    return {"code": "200", "data": {"aggrId": "8PDA0H", "isCan": 1 if enabled else 0, "prompt": "活动已结束" if not enabled else ""}}


def activity(signed=False):
    return {"code": "200", "data": {"aggrAssemblyList": [{"aggrAssemblySignin": {"isSignin": 1 if signed else 0}}]}}


def test_parse_legacy_accounts():
    accounts = mod.parse_accounts("token1#主账号\ntoken2")
    assert [(x.token, x.note) for x in accounts] == [("token1", "主账号"), ("token2", "旧变量账号2")]


def test_collector_session_contract_and_mask():
    http = CollectorHttp({"status": True, "via": "runtime-code-getTokenByJsCode", "data": {"token": "fresh", "phone": "18812341257"}})
    account = mod.fetch_collector_session(http=http, auth="secret", url="http://collector")
    assert account.token == "fresh"
    assert account.note == "collector:188****1257"
    url, kwargs = http.calls[0]
    assert url == "http://collector/wx/changhong-session"
    assert kwargs["json"] == {"appid": "wx36c3413e8fe39263"}
    assert kwargs["headers"]["auth"] == "secret"


def test_collector_failure_is_explicit():
    http = CollectorHttp({"status": False, "message": "not bound"})
    try:
        mod.fetch_collector_session(http=http, auth="secret")
        raise AssertionError("expected ChanghongError")
    except mod.ChanghongError as exc:
        assert re.search("not bound", str(exc))


def test_already_signed_only_discovers_and_reads():
    logs = []
    http = BusinessHttp([menu(), check(), activity(True)])
    result = mod.Task(mod.Account("token", "测试"), http=http, logger=logs.append).run()
    assert result == {"ok": True, "already": True, "aggrId": "8PDA0H"}
    assert len(http.calls) == 3
    assert "服务端活动状态确认" in logs[0]


def test_unsigned_signs_and_must_pass_activity_readback():
    logs = []
    http = BusinessHttp([menu(), check(), activity(False), {"code": "200", "data": {}}, check(), activity(True)])
    result = mod.Task(mod.Account("token", "测试"), http=http, logger=logs.append).run()
    assert result == {"ok": True, "already": False, "aggrId": "8PDA0H"}
    paths = [call[1].split("/gw/applet")[-1].split("?")[0] for call in http.calls]
    assert paths == ["/homePage/getShortcutMenuList", "/aggr/aggregationCheck", "/aggr/aggregationInfo", "/aggr/signin", "/aggr/aggregationCheck", "/aggr/aggregationInfo"]
    assert http.calls[3][2]["params"] == {"aggrId": "8PDA0H"}
    assert "已回查确认" in logs[0]


def test_http_200_without_business_success_fails():
    http = BusinessHttp([menu(), {"code": "500", "message": "token失效"}])
    result = mod.Task(mod.Account("bad", "测试"), http=http, logger=lambda _: None).run()
    assert result["ok"] is False
    assert "token失效" in result["error"]


def test_disabled_activity_fails_without_write():
    http = BusinessHttp([menu(), check(False)])
    result = mod.Task(mod.Account("token", "测试"), http=http, logger=lambda _: None).run()
    assert result["ok"] is False
    assert "活动已结束" in result["error"]
    assert len(http.calls) == 2


def test_readback_false_is_failure():
    http = BusinessHttp([menu(), check(), activity(False), {"code": "200", "data": {}}, check(), activity(False)])
    result = mod.Task(mod.Account("token", "测试"), http=http, logger=lambda _: None).run()
    assert result["ok"] is False
    assert "回查仍为未签到" in result["error"]


def test_main_prefers_collector_and_emits_success():
    logs = []
    collector = CollectorHttp({"status": True, "via": "runtime-code-getTokenByJsCode", "data": {"token": "fresh", "phone": "18812341257"}})
    business = BusinessHttp([menu(), check(), activity(True)])
    results = mod.main(raw="old#旧账号", auto_login=True, collector_http=collector, collector_auth="secret", http=business, logger=logs.append)
    assert results[0]["ok"] is True
    assert business.calls[0][2]["headers"]["Token"] == "fresh"
    assert "[QLRUN_RESULT] SUCCESS" in logs


def test_main_falls_back_to_legacy_and_still_emits_success():
    logs = []
    collector = CollectorHttp({"status": False, "message": "temporary"})
    business = BusinessHttp([menu(), check(), activity(True)])
    results = mod.main(raw="old#旧账号", auto_login=True, collector_http=collector, collector_auth="secret", http=business, logger=logs.append)
    assert results[0]["ok"] is True
    assert business.calls[0][2]["headers"]["Token"] == "old"
    assert any("回退旧 chmlck" in x for x in logs)
    assert "[QLRUN_RESULT] SUCCESS" in logs


def test_no_account_emits_failure():
    logs = []
    assert mod.main(raw="", auto_login=False, logger=logs.append) == []
    assert any(x.startswith("[QLRUN_RESULT] FAILURE reason=changhong_no_account") for x in logs)


if __name__ == "__main__":
    tests = [(name, value) for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    failures = 0
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except Exception as exc:
            failures += 1
            print(f"FAIL {name}: {type(exc).__name__}: {exc}")
    print(f"RESULT PASS={len(tests)-failures} FAIL={failures}")
    raise SystemExit(1 if failures else 0)
