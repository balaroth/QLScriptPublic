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
  local restore_failed=0 rel src dst
  if [ -d "$RUNTIME_BACKUP" ]; then
    # 使用 process substitution 而不是管道，确保 restore_failed 在当前 shell 生效。
    while IFS= read -r -d '' rel; do
      src="$RUNTIME_BACKUP/$rel"
      dst="$REPO/$rel"
      mkdir -p "$(dirname "$dst")" || restore_failed=1
      if ! cp -f -- "$src" "$dst" || ! cmp -s -- "$src" "$dst"; then
        echo "[updater] failed to restore runtime file: $rel"
        restore_failed=1
      fi
    done < <(cd "$RUNTIME_BACKUP" && find . -type f ! -name '.tracked-files' -print0)
    if [ -f "$RUNTIME_BACKUP/.tracked-files" ]; then
      while IFS= read -r rel; do
        [ -n "$rel" ] || continue
        git update-index --skip-worktree -- "$rel" > /dev/null 2>&1 || restore_failed=1
      done < "$RUNTIME_BACKUP/.tracked-files"
    fi
    if [ "$restore_failed" -eq 0 ]; then
      rm -rf "$RUNTIME_BACKUP"
    else
      echo "[updater] runtime restore failed; backup retained: $RUNTIME_BACKUP"
    fi
  fi
  return "$restore_failed"
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
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if ! restore_runtime_files; then rc=90; fi
  rm -rf "$LOCK_DIR"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cd "$REPO" || { echo "[updater] repository missing: $REPO"; exit 1; }
# 运行态文件不得参与代码合并。只做去重备份并保持 tracked cache 为 skip-worktree；
# 不再在更新前 restore/checkout 缓存，避免任一异常退出先破坏登录态。
declare -A RUNTIME_SEEN=()
for runtime_file in wxapp/*_token_cache.json wxapp/*_cache.json daily/*_token_cache.json jd/fruit_helpcode_new; do
  [ -f "$runtime_file" ] || continue
  [ -z "${RUNTIME_SEEN[$runtime_file]+x}" ] || continue
  RUNTIME_SEEN[$runtime_file]=1
  mkdir -p "$RUNTIME_BACKUP/$(dirname "$runtime_file")"
  cp -p -- "$runtime_file" "$RUNTIME_BACKUP/$runtime_file"
  if git ls-files --error-unmatch -- "$runtime_file" > /dev/null 2>&1; then
    printf '%s\n' "$runtime_file" >> "$RUNTIME_BACKUP/.tracked-files"
    git update-index --skip-worktree -- "$runtime_file"
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
MERGE_CONFLICTS=''
if ! git merge --no-edit "$UPSTREAM/$BRANCH"; then
  MERGE_CONFLICTS=$(git diff --name-only --diff-filter=U | sed -n '1,80p')
  if [ -z "$MERGE_CONFLICTS" ]; then
    git merge --abort || true
    notify_failure '【青龙更新】上游合并异常' "仓库：$REPO\n本地提交：$LOCAL_HEAD\n上游提交：$REMOTE_HEAD\n合并失败但未识别冲突文件，已中止并保留当前可运行版本。\n备份分支：$BACKUP_REF\n日志：$LOG"
    exit 2
  fi

  # 生产仓库包含已经真实验收的定制增强。发生同文件冲突时整文件保留本地版本，
  # 非冲突文件仍正常接收上游；禁止使用 -X ours 将两套逻辑半拼接到同一文件。
  RESOLVE_FAILED=0
  while IFS= read -r conflict_file; do
    [ -n "$conflict_file" ] || continue
    echo "[updater] conflict keeps verified local file: $conflict_file"
    git checkout --ours -- "$conflict_file" || RESOLVE_FAILED=1
    git add -- "$conflict_file" || RESOLVE_FAILED=1
  done <<< "$MERGE_CONFLICTS"

  REMAINING_CONFLICTS=$(git diff --name-only --diff-filter=U | sed -n '1,80p')
  if [ "$RESOLVE_FAILED" -ne 0 ] || [ -n "$REMAINING_CONFLICTS" ]; then
    git merge --abort || true
    notify_failure '【青龙更新】冲突自动解析失败' "仓库：$REPO\n本地提交：$LOCAL_HEAD\n上游提交：$REMOTE_HEAD\n原始冲突：\n$MERGE_CONFLICTS\n剩余冲突：\n${REMAINING_CONFLICTS:-无}\n已中止并保留当前可运行版本。\n备份分支：$BACKUP_REF\n日志：$LOG"
    exit 2
  fi
  if ! git commit --no-edit; then
    git merge --abort || git reset --hard "$LOCAL_HEAD"
    notify_failure '【青龙更新】冲突解析后提交失败' "仓库：$REPO\n本地提交：$LOCAL_HEAD\n上游提交：$REMOTE_HEAD\n已回滚到同步前版本。\n备份分支：$BACKUP_REF\n日志：$LOG"
    exit 2
  fi
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

# 对仓库内已有的重点回归测试做更新门禁；失败必须回滚，不能把半可用代码发布到生产。
TEST_FAIL=''
for test_file in \
  tests/test_qyqd.js \
  tests/test_tjg.js \
  tests/test_changhongmeiling.py \
  tests/hdl.test.js; do
  [ -f "$test_file" ] || continue
  case "$test_file" in
    *.js)
      node "$test_file" >/dev/null 2>&1 || TEST_FAIL="$TEST_FAIL\n$test_file"
      ;;
    *.py)
      python3 "$test_file" >/dev/null 2>&1 || TEST_FAIL="$TEST_FAIL\n$test_file"
      ;;
  esac
done

if [ -n "$TEST_FAIL" ]; then
  FAILED_HEAD=$(git rev-parse HEAD)
  git reset --hard "$LOCAL_HEAD"
  notify_failure '【青龙更新】合并后回归测试失败' "仓库：$REPO\n失败合并：$FAILED_HEAD\n已回滚到：$LOCAL_HEAD\n失败测试：$TEST_FAIL\n备份分支：$BACKUP_REF\n日志：$LOG"
  exit 5
fi

if [ -n "$MERGE_CONFLICTS" ]; then
  echo "[updater] upstream merged; verified local versions kept for conflicts:"
  printf '%s\n' "$MERGE_CONFLICTS"
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
