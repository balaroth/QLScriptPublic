#!/usr/bin/env node
/*
 * restore-disabled.js — 上游脚本更新后，自动恢复"本次 diff 命中且原本已禁用"的业务脚本。
 *
 * 设计口径（与 qlall.js discover() 完全一致，保证"恢复的对象"== "qlall 会执行的对象"）：
 *   - 只处理 git diff <base>..HEAD 中 新增(A)/修改(M) 的 .js/.py；删除(D)/重命名不主动恢复。
 *   - 排除目录：node_modules tools backup function assets cache .git
 *   - 排除文件：sendNotify.js wcs.js env.js notify.py
 *   - 命中条件：Crontabs.command 引用的脚本相对路径 === 某个被改业务脚本路径。
 *   - 仅当该 Crontab 当前 isDisabled=1 时才恢复：isDisabled=0, schedule=@once 1577808000000,
 *     status=1(空闲), pid=NULL；已启用(isDisabled=0)的命中项保持原样；未被本次 diff 命中的禁用项一律不动。
 *
 * 用法：
 *   node restore-disabled.js <baseCommit> [--db PATH] [--repo PATH] [--out PATH] [--dry-run]
 * 环境覆盖：QL_DATA_DIR / QL_SCRIPT_REPO（与 update-upstream.sh 一致）。
 * 退出码：0=成功(含无需恢复)；2=参数/环境错误；3=执行中部分行失败。本模块永不抛致命到 update-upstream.sh。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PAST_MANUAL_SCHEDULE = "@once 1577808000000"; // 过去时间 = 仅手动、永不自动触发（与 ensureCrontabs 纳新一致）
const IDLE_STATUS = 1;                              // 青龙约定：status=0 运行中，1 空闲

const EXCLUDE_DIR = new Set(["node_modules", "tools", "backup", "function", "assets", "cache", ".git"]);
const EXCLUDE_FILE = new Set(["sendNotify.js", "wcs.js", "env.js", "notify.py"]);

function parseArgs(argv) {
  const out = { base: null, db: null, repo: null, out: null, dryRun: false };
  const flags = new Set(["--db", "--repo", "--out"]);
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") { out.dryRun = true; continue; }
    const eq = a.indexOf("=");
    if (flags.has(a)) { out[a.slice(2)] = argv[++i]; continue; }       // --repo PATH
    if (eq > 0 && flags.has(a.slice(0, eq))) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; } // --repo=PATH
    positional.push(a);
  }
  out.base = positional[0] || process.env.QL_UPSTREAM_BASE;
  return out;
}

// 业务脚本判定：与 qlall.js discover() 对齐。返回 true 表示"值得纳入恢复候选"。
function isBusinessScript(relPath) {
  if (!/\.(js|py)$/.test(relPath)) return false;
  const segs = relPath.split("/");
  if (segs.some((s) => EXCLUDE_DIR.has(s))) return false;
  if (EXCLUDE_FILE.has(segs[segs.length - 1])) return false;
  return true;
}

// 从 Crontabs.command 中提取被引用的 smallfawn_QLScriptPublic/<rel>；无则 null。
function scriptRelFromCommand(command) {
  const m = (command || "").match(/smallfawn_QLScriptPublic\/(\S+\.(?:js|py))/);
  return m ? m[1] : null;
}

// ---- 数据库访问层：优先 require("sqlite3")（生产 @whyour/sqlite3）；缺失时退回 node:sqlite 内置 ----
function openDatabase(dbPath) {
  try {
    const Sqlite3 = require("sqlite3");
    const Ctor = Sqlite3.Database || Sqlite3.verbose().Database;
    const raw = new Ctor(dbPath);
    return adaptSqlite3(raw);
  } catch (e) {
    if (e.code !== "MODULE_NOT_FOUND") throw e;
    // 本地隔离测试环境无 npm sqlite3，用内置 node:sqlite 包一层相同的回调 API。
    const { DatabaseSync } = require("node:sqlite");
    return adaptNodeSqlite(new DatabaseSync(dbPath));
  }
}
function adaptSqlite3(raw) {
  return {
    all: (sql, p = []) => new Promise((res, rej) => raw.all(sql, p, (e, r) => (e ? rej(e) : res(r)))),
    run: (sql, p = []) => new Promise((res, rej) => raw.run(sql, p, function (e) { e ? rej(e) : res(this); })),
    close: () => new Promise((r) => raw.close(r)),
    raw,
  };
}
function adaptNodeSqlite(raw) {
  return {
    all: async (sql, p = []) => raw.prepare(sql).all(...p),
    run: async (sql, p = []) => {
      const info = raw.prepare(sql).run(...p);
      return { changes: info.changes, lastID: Number(info.lastInsertRowid) };
    },
    close: async () => raw.close(),
    raw,
  };
}

function gitDiffNameStatus(repo, base) {
  // --no-renames：重命名视为 删除旧文件 + 新增新文件；旧路径的禁用任务不被自动恢复（交由人工/纳新处理）。
  const out = execFileSync("git", ["diff", "--name-status", "--no-renames", base, "HEAD"], {
    cwd: repo, encoding: "utf8",
  });
  const changes = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(/\t/);
    const status = parts[0].trim();
    const path = parts[parts.length - 1]; // --no-renames 下每行最后一列就是新路径
    changes.push({ status, path });
  }
  return changes;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.base) {
    console.error("[restore] 缺少 <baseCommit> 参数");
    process.exit(2);
  }
  const DATA = process.env.QL_DATA_DIR || "/ql/data";
  const repo = args.repo || process.env.QL_SCRIPT_REPO || path.join(DATA, "scripts", "smallfawn_QLScriptPublic");
  const dbPath = args.db || path.join(DATA, "db", "database.sqlite");

  if (!fs.existsSync(repo)) { console.error(`[restore] 仓库不存在: ${repo}`); process.exit(2); }
  if (!fs.existsSync(dbPath)) { console.error(`[restore] 数据库不存在: ${dbPath}`); process.exit(2); }

  let changes;
  try {
    changes = gitDiffNameStatus(repo, args.base);
  } catch (e) {
    console.error(`[restore] git diff 失败（base=${args.base}）: ${e.message}`);
    process.exit(2);
  }

  // 分类本次 diff
  const hit = [];          // 命中的业务脚本(A/M)
  const skipped = { nonScript: [], deleted: [], excluded: [] };
  for (const c of changes) {
    const st = c.status[0].toUpperCase(); // A/M/D/R/C/U
    if (st === "D") { skipped.deleted.push(c.path); continue; }
    if (st !== "A" && st !== "M") { skipped.deleted.push(`${c.status} ${c.path}`); continue; }
    if (!/\.(js|py)$/.test(c.path)) { skipped.nonScript.push(c.path); continue; }
    if (!isBusinessScript(c.path)) { skipped.excluded.push(c.path); continue; }
    hit.push(c.path);
  }

  const db = openDatabase(dbPath);
  const rows = await db.all("SELECT id, name, command, schedule, status, isDisabled FROM Crontabs");
  // 脚本相对路径 -> crontab 行（一个脚本路径理论上唯一对应一条业务任务）
  const byRel = new Map();
  for (const r of rows) {
    const rel = scriptRelFromCommand(r.command);
    if (rel) byRel.set(rel, r);
  }

  // 快照阶段：找出"SELECT 时刻为禁用"的候选。注意这只是快照，真正写库时要加 isDisabled=1 守卫。
  const toRestore = [];
  const alreadyEnabled = [];
  const notFoundInCrontab = [];
  for (const rel of hit) {
    const row = byRel.get(rel);
    if (!row) { notFoundInCrontab.push(rel); continue; } // 还没纳新进 Crontabs，qlall ensureCrontabs 下次会自动建
    if (Number(row.isDisabled) === 1) {
      toRestore.push({ id: row.id, name: row.name, rel, oldSchedule: row.schedule, oldStatus: row.status });
    } else {
      alreadyEnabled.push({ id: row.id, name: row.name, rel });
    }
  }

  // 写阶段：UPDATE 带 AND isDisabled=1 守卫，并核对 changes。
  // changes=1 → 真恢复；changes=0 → SELECT 之后被别的进程/面板先启用了，不覆盖其 schedule/status，记为竞态跳过。
  // —— 测试专用缝（生产永不触发）：QL_TEST_RACE_ID=<id> 在 SELECT 分类后、写库前，用第二连接模拟另一进程已启用该行。
  if (process.env.QL_TEST_RACE_ID && !args.dryRun) {
    try {
      const raceDb = openDatabase(dbPath);
      await raceDb.run("UPDATE Crontabs SET isDisabled=0, schedule=? WHERE id=?", ["CUSTOM_RACED_SCHED", Number(process.env.QL_TEST_RACE_ID)]);
      await raceDb.close();
      console.log("[restore] (test seam) simulated concurrent enable for id=" + process.env.QL_TEST_RACE_ID);
    } catch (e) { console.error("[restore] test seam failed:", e.message); }
  }
  const restored = [];
  const raced = [];
  const failures = [];
  if (args.dryRun) {
    restored.push(...toRestore); // dry-run 不写库，报告"将会恢复"的候选
  } else {
    const iso = new Date().toISOString();
    for (const r of toRestore) {
      try {
        const info = await db.run(
          "UPDATE Crontabs SET isDisabled=0, schedule=?, status=?, pid=NULL, updatedAt=? WHERE id=? AND isDisabled=1",
          [PAST_MANUAL_SCHEDULE, IDLE_STATUS, iso, r.id]
        );
        if (Number(info.changes) === 1) restored.push(r);
        else raced.push({ id: r.id, name: r.name, rel: r.rel, reason: "SELECT 后已被其他进程/面板启用，未覆盖其 schedule/status" });
      } catch (e) { failures.push({ id: r.id, rel: r.rel, error: e.message }); }
    }
  }
  await db.close();

  const summary = {
    base: args.base,
    db: dbPath,
    dryRun: args.dryRun,
    diffTotal: changes.length,
    hitBusinessScripts: hit,
    skipped,
    notFoundInCrontab,
    alreadyEnabled,
    restored,
    raced,
    failures,
  };
  const text = JSON.stringify(summary, null, 2);
  console.log("[restore] " + (args.dryRun ? "(DRY-RUN) " : "") + text);
  if (args.out) { try { fs.mkdirSync(path.dirname(args.out), { recursive: true }); fs.writeFileSync(args.out, text); } catch (e) { console.error("[restore] 写摘要失败:", e.message); } }

  console.log(`[restore] 本次上游命中业务脚本 ${hit.length} 个；恢复已禁用 ${restored.length} 个；竞态跳过 ${raced.length} 个；` +
    `已启用保持 ${alreadyEnabled.length} 个；删除/非脚本/排除类未处理 ${skipped.deleted.length + skipped.nonScript.length + skipped.excluded.length} 个。`);
  process.exit(failures.length ? 3 : 0);
})().catch((e) => { console.error("[restore] 致命错误:", e.message); process.exit(2); });
