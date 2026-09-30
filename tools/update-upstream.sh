#!/usr/bin/env bash
set -u

DATA="${QL_DATA_DIR:-/ql/data}"
REPO="${QL_SCRIPT_REPO:-$DATA/scripts/smallfawn_QLScriptPublic}"
UPSTREAM="${QL_UPSTREAM_REMOTE:-upstream}"
UPSTREAM_URL="${QL_UPSTREAM_URL:-https://github.com/smallfawn/QLScriptPublic.git}"
BRANCH="${QL_UPSTREAM_BRANCH:-main}"
GIT_KEY="${QL_GIT_SSH_KEY:-$DATA/.ssh/qlscript_deploy}"
if [ -f "$GIT_KEY" ]; then
  export GIT_SSH_COMMAND="ssh -i $GIT_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$DATA/.ssh/known_hosts"
fi
LOG_DIR="$DATA/log/update-smallfawn"
LOCK_DIR="$DATA/.qlrun/update-smallfawn.lock.d"
mkdir -p "$LOG_DIR" "$DATA/.qlrun"
LOG="$LOG_DIR/$(date '+%Y-%m-%d-%H-%M-%S').log"
RUNTIME_BACKUP="$(mktemp -d "$DATA/.qlrun/update-runtime.XXXXXX")"
exec > >(tee -a "$LOG") 2>&1

restore_runtime_files() {
  if [ -d "$RUNTIME_BACKUP" ]; then
    (cd "$RUNTIME_BACKUP" && find . -type f -print0) | while IFS= read -r -d '' rel; do
      mkdir -p "$REPO/$(dirname "$rel")"
      cp "$RUNTIME_BACKUP/$rel" "$REPO/$rel"
    done
    rm -rf "$RUNTIME_BACKUP"
  fi
}

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
  rm -rf "$RUNTIME_BACKUP"
  exit 0
fi
trap 'restore_runtime_files; rm -rf "$LOCK_DIR"' EXIT INT TERM

cd "$REPO" || { echo "[updater] repository missing: $REPO"; exit 1; }
# 运行态文件不得参与代码合并。即使上游曾误跟踪缓存，也先备份并恢复到 HEAD，
# 合并结束或失败后由 trap 原样还原，避免覆盖当前登录态。
for runtime_file in wxapp/*_token_cache.json wxapp/*_cache.json daily/*_token_cache.json jd/fruit_helpcode_new; do
  [ -f "$runtime_file" ] || continue
  mkdir -p "$RUNTIME_BACKUP/$(dirname "$runtime_file")"
  cp "$runtime_file" "$RUNTIME_BACKUP/$runtime_file"
  if git ls-files --error-unmatch "$runtime_file" >/dev/null 2>&1; then
    git checkout -- "$runtime_file"
  fi
done
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

# —— 自动恢复：本次上游 diff 命中、且原本被面板禁用的业务脚本，恢复为"手动执行"任务 ——
# 仅处理 A/M 的 .js/.py（删除/重命名/非脚本/tools/backup/库文件一律不动）；
# 恢复口径：isDisabled=0、schedule=@once 1577808000000（过去时间=仅手动）、status=空闲。
# 本步骤为非致命：失败只记日志/告警，不回滚已合并代码、不阻塞后续 hook 部署与 fork 推送。
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
RESTORE_OUT="$LOG_DIR/restore-$(date '+%Y-%m-%d-%H-%M-%S').json"
if [ -f "$SELF_DIR/restore-disabled.js" ]; then
  QL_DATA_DIR="$DATA" QL_SCRIPT_REPO="$REPO" \
    node "$SELF_DIR/restore-disabled.js" "$LOCAL_HEAD" --repo "$REPO" --db "$DATA/db/database.sqlite" --out "$RESTORE_OUT" \
    || echo "[updater] restore-disabled 非零退出码（详见 $RESTORE_OUT），继续部署"
else
  echo "[updater] 未找到 restore-disabled.js，跳过后置恢复步骤"
fi

chmod 0755 "$REPO/tools/qlrun" "$REPO/tools/qlrun-launcher" "$REPO/tools/qlall.js" "$REPO/tools/qlall-launcher"
cp "$REPO/tools/task-before.js" "$DATA/config/task_before.js"
chmod 0600 "$DATA/config/task_before.js"
if git remote get-url fork >/dev/null 2>&1; then
  if ! git push fork HEAD:main; then
    notify_failure '【青龙更新】合并成功但推送 fork 失败' "仓库：$REPO\n合并后提交：$(git rev-parse HEAD)\n本地运行代码已更新，但 GitHub fork 尚未同步。\n备份分支：$BACKUP_REF\n日志：$LOG"
    exit 4
  fi
fi
echo "[updater] merged $REMOTE_HEAD, deployed runtime hooks, and synchronized fork"
