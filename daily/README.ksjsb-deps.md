# ksjsb 依赖可复现声明（禁止仅靠手工 npm -g）

## 根因
`daily/ksjsb.core.cjs` 在加载期 `require("socks-proxy-agent")`，原生产报
`Error: Cannot find module 'socks-proxy-agent'`（MODULE_NOT_FOUND）。
脚本头已声明所需依赖：`axios socks-proxy-agent@8 smallfawn@latest`；
其中 axios / smallfawn 早已在青龙全局依赖中，独缺 socks-proxy-agent。

## 现有机制（已核查）
青龙全局 Node 依赖由容器内这份清单 + pnpm 统一安装（非仓库根 package.json，仓库根本无 package.json）：
- 清单文件：`/ql/data/dep_cache/node/global/5/package.json`
- 实际安装目录：`/ql/data/dep_cache/node/global/5/node_modules`（pnpm 虚拟仓 `.pnpm/`）
- 该清单即青龙面板「依赖管理」保存的内容；增删依赖应由面板写入并触发 pnpm 安装。

## 最小正确改动（对全局依赖清单，一行）
在 `dependencies` 中追加（按字母序置于 smallfawn 附近）：

```json
"socks-proxy-agent": "^8.0.5",
```

等价 manifest 补丁（对 `/ql/data/dep_cache/node/global/5/package.json`）：
```diff
 	"smallfawn": "^1.2.3",
+	"socks-proxy-agent": "^8.0.5",
 	"tough-cookie": "^6.0.2",
```

应用后由青龙面板重新安装全局依赖（等价 `pnpm install` 于该 prefix），
使其进入 pnpm 仓与 NODE_PATH 指向的 node_modules，而非散落在 `/usr/local/lib/node_modules`。

## 当前生产临时态（报备，待收口）
本次诊断中为让 ksjsb 越过 MODULE_NOT_FOUND 做了一次性 `npm install -g socks-proxy-agent@8`，
落地 `/usr/local/lib/node_modules/socks-proxy-agent@8.0.5`（也在 NODE_PATH 上，故当前可解析）。
这是**临时兜底**，不进入版本化清单。收口方式：
1. 按上面把 `socks-proxy-agent@^8.0.5` 加进青龙全局依赖清单并 pnpm 安装；
2. 确认 `/ql/data/dep_cache/node/global/5/node_modules/socks-proxy-agent` 可用后，
   `npm uninstall -g socks-proxy-agent` 移除手工兜底。

## ksck 未配置（CONFIG_FAIL，非成功）
ksck 环境变量当前未配置（`printenv | grep -c ^ksck = 0`）。依赖修好后脚本会进入
"无账号/未配置"分支，qlall 按 CONFIG_FAIL 判 fail 且首轮停重试。
**剩余用户动作**：在青龙为 ksjsb 配置 `ksck`（开宝箱 ck#salt#代理）。不得判成功。
