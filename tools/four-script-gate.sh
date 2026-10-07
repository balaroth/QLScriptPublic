#!/usr/bin/env bash
# four-script-gate.sh — d3 青龙四脚本生产链路门禁
# 只能由 d4 的受限 SSH key 或管理员本地执行。
set -u

CNAME=$(sudo docker ps --filter name=qinglong --format '{{.Names}}' | python3 -c 'import sys; print(next((x.strip() for x in sys.stdin if x.strip()), ""))')
REPO=/ql/data/scripts/smallfawn_QLScriptPublic
TASK=/ql/shell/task.sh
RUN_ID="${FOUR_SCRIPT_GATE_NONCE:-$(date +%s%N)}"
PASS=0
FAIL=0

ok(){ printf 'PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad(){ printf 'FAIL  %s :: %s\n' "$1" "${2:-unknown}"; FAIL=$((FAIL+1)); }

if [ -z "$CNAME" ]; then
  echo 'FAIL  runner :: qinglong container not found'
  echo '==== FOUR-SCRIPT RESULT: PASS=0 FAIL=4 ===='
  exit 1
fi

run_case() {
  name="$1"
  required="$2"
  command="$3"
  log=$(mktemp "/tmp/four-script-gate-${name}.XXXXXX.log")
  sudo docker exec "$CNAME" bash -lc "$command" >"$log" 2>&1 || true
  if grep -q '\[QLRUN_RESULT\] SUCCESS' "$log" && ! grep -q '\[QLRUN_RESULT\] FAILURE' "$log" && grep -q "$required" "$log"; then
    ok "$name"
  else
    summary=$(python3 - "$log" <<'PY'
import pathlib, re, sys
s=pathlib.Path(sys.argv[1]).read_text(errors='replace')
lines=[x.strip() for x in s.splitlines() if x.strip()]
focus=[x for x in lines if 'QLRUN_RESULT' in x or '执行失败' in x or '登录失败' in x or '初始化失败' in x]
print(' | '.join((focus or lines[-4:]))[:500])
PY
)
    bad "$name" "$summary"
  fi
  rm -f "$log"
}

MIDEA_CACHE="/tmp/four-script-gate-midea-${RUN_ID}.json"
AIMA_CACHE="/tmp/four-script-gate-aima-${RUN_ID}.json"

run_case 'mdhy.js' '美的主端手机号授权登录成功，会员接口验真通过' \
  "rm -f '$MIDEA_CACHE'; QL_SUPPRESS_NOTIFY=1 MIDEA_SESSION_CACHE_FILE='$MIDEA_CACHE' MDHY_TEST_NONCE='gate-mdhy-$RUN_ID' real_time=true '$TASK' '$REPO/wxapp/mdhy.js'"
run_case 'wx_midea.js' '缓存session经会员接口验真通过' \
  "QL_SUPPRESS_NOTIFY=1 MIDEA_SESSION_CACHE_FILE='$MIDEA_CACHE' MDHY_TEST_NONCE='gate-wx-midea-$RUN_ID' real_time=true '$TASK' '$REPO/wxapp/wx_midea.js'"
run_case 'tjg.js' '门禁模式：官方安全网络初始化验证通过' \
  "QL_SUPPRESS_NOTIFY=1 TJG_GATE_FORCE_SECURE_INIT=1 TJG_TEST_NONCE='gate-tjg-$RUN_ID' real_time=true '$TASK' '$REPO/wxapp/tjg.js'"
run_case 'aima.js' '登录成功且会员接口验真通过' \
  "rm -f '$AIMA_CACHE'; QL_SUPPRESS_NOTIFY=1 AIMA_TOKEN_CACHE_FILE='$AIMA_CACHE' AIMA_TEST_NONCE='gate-aima-$RUN_ID' real_time=true '$TASK' '$REPO/wxapp/aima.js'"

sudo docker exec "$CNAME" rm -f "$MIDEA_CACHE" "$AIMA_CACHE" >/dev/null 2>&1 || true
printf '==== FOUR-SCRIPT RESULT: PASS=%s FAIL=%s ====\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
