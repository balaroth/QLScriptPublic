#!/usr/bin/env bash
set -u

DATA="${QL_DATA_DIR:-/ql/data}"
REPO="${QL_SCRIPT_REPO:-$DATA/scripts/smallfawn_QLScriptPublic}"
UPSTREAM="${QL_UPSTREAM_REMOTE:-upstream}"
UPSTREAM_URL="${QL_UPSTREAM_URL:-https://github.com/smallfawn/QLScriptPublic.git}"
BRANCH="${QL_UPSTREAM_BRANCH:-main}"
LOG_DIR="$DATA/log/update-smallfawn"
LOCK_DIR="$DATA/.qlrun/update-smallfawn.lock.d"
mkdir -p "$LOG_DIR" "$DATA/.qlrun"
LOG="$LOG_DIR/$(date '+%Y-%m-%d-%H-%M-%S').log"
exec > >(tee -a "$LOG") 2>&1

notify_failure() {
  local subject="$1" body="$2"
  QL_SUPPRESS_NOTIFY= UPDATE_NOTICE_TITLE="$subject" UPDATE_NOTICE_BODY="$body" \
    node - <<'NODE'
const path = require('path');
const data = process.env.QL_DATA_DIR || '/ql/data';
const repo = process.env.QL_SCRIPT_REPO || path.join(data, 'scripts', 'smallfawn_QLScriptPublic');
const { sendNotify } = require(path.join(repo, 'tools', 'sendNotify.js'));
Promise.resolve(sendNotify(process.env.UPDATE_NOTICE_TITLE, process.env.UPDATE_NOTICE_BODY, {}))
  .catch((e) => { console.error('[updater] notify failed:', e && e.message ? e.message : e); process.exitCode = 1; });
NODE
}

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo '[updater] another update is running; skip'
  exit 0
fi
trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM

cd "$REPO" || { echo "[updater] repository missing: $REPO"; exit 1; }
if ! git diff --quiet || ! git diff --cached --quiet; then
  notify_failure '【青龙更新】工作树存在未提交改动' "仓库：$REPO\n自动更新已停止，避免覆盖未提交修改。\n日志：$LOG"
  exit 1
fi

if git remote get-url "$UPSTREAM" >/dev/null 2>&1; then
  git remote set-url "$UPSTREAM" "$UPSTREAM_URL"
else
  git remote add "$UPSTREAM" "$UPSTREAM_URL"
fi

if ! git fetch --prune "$UPSTREAM" "$BRANCH"; then
  notify_failure '【青龙更新】拉取上游失败' "上游：$UPSTREAM_URL\n分支：$BRANCH\n现有代码保持不变。\n日志：$LOG"
  exit 1
fi

LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse "$UPSTREAM/$BRANCH")
if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ] || git merge-base --is-ancestor "$REMOTE_HEAD" "$LOCAL_HEAD"; then
  echo "[updater] already up to date or local contains upstream: $LOCAL_HEAD"
  exit 0
fi

BACKUP_REF="backup/pre-upstream-$(date '+%Y%m%d-%H%M%S')"
git branch "$BACKUP_REF" "$LOCAL_HEAD"
if ! git merge --no-edit "$UPSTREAM/$BRANCH"; then
  CONFLICTS=$(git diff --name-only --diff-filter=U | sed -n '1,40p')
  git merge --abort || true
  notify_failure '【青龙更新】上游代码冲突' "仓库：$REPO\n本地提交：$LOCAL_HEAD\n上游提交：$REMOTE_HEAD\n冲突文件：\n${CONFLICTS:-未识别}\n已中止合并并保留当前可运行版本。\n备份分支：$BACKUP_REF\n日志：$LOG"
  exit 2
fi

CHECK_FAIL=''
while IFS= read -r file; do
  case "$file" in
    *.js|*.cjs)
      node --check "$file" >/dev/null 2>&1 || CHECK_FAIL="$CHECK_FAIL\n$file"
      ;;
    *.py)
      python3 -m py_compile "$file" >/dev/null 2>&1 || CHECK_FAIL="$CHECK_FAIL\n$file"
      ;;
  esac
done < <(git diff --name-only "$LOCAL_HEAD..HEAD")

if [ -n "$CHECK_FAIL" ]; then
  FAILED_HEAD=$(git rev-parse HEAD)
  git reset --hard "$LOCAL_HEAD"
  notify_failure '【青龙更新】合并后语法检查失败' "仓库：$REPO\n失败合并：$FAILED_HEAD\n已回滚到：$LOCAL_HEAD\n失败文件：$CHECK_FAIL\n备份分支：$BACKUP_REF\n日志：$LOG"
  exit 3
fi

cp "$REPO/tools/qlrun-launcher" /usr/local/bin/qlrun
cp "$REPO/tools/qlall-launcher" /usr/local/bin/qlall
chmod 0755 /usr/local/bin/qlrun /usr/local/bin/qlall
cp "$REPO/tools/task-before.js" "$DATA/config/task_before.js"
chmod 0600 "$DATA/config/task_before.js"
echo "[updater] merged $REMOTE_HEAD and deployed runtime hooks"
