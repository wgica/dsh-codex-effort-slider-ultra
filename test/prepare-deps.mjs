/**
 * 只为**离线测试**准备运行时依赖：把 `@deepseek-ai/schemastery`（及其运行时依赖
 * `@deepseek-ai/cosmokit`）从本机已安装的 DSH 里复制到本包的 `node_modules/`。
 *
 * 为什么需要它：
 *   · 宿主半边 `lib/index.js` 要 `import z from "@deepseek-ai/schemastery"` 来声明
 *     `Config`（官方 Loader 的配置 schema，`.volatile()` 字段 = 可在「插件」页里实时编辑）。
 *   · 正式安装到 profile 之后，这个 import 由 profile 的 node_modules 解析 —— 不需要本脚本。
 *   · 但本仓是开发副本、又在 profile 之外，直接跑 `node test/host.test.mjs` 会
 *     `ERR_MODULE_NOT_FOUND`；这里复制一份出来给测试用（约 260 KB）。
 *
 * 这个目录是**开发脚手架**，不会被安装：`plugin_manager` / `pnpm` 安装 file: 依赖时
 * 依据 package.json 的 `files` 白名单打包，`node_modules/` 不在白名单里。
 * 想清掉它：`node test/prepare-deps.mjs --clean`。
 *
 * 跑法：`node test/prepare-deps.mjs`（幂等）
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)); // <pkg>/test
const PKG = dirname(ROOT); // <pkg>
const TARGET = join(PKG, "node_modules", "@deepseek-ai");

/** 需要复制进来的包。 */
const NEEDED = ["schemastery", "cosmokit"];

/** 候选来源：环境变量 > DSH profile > 全局 dsh 安装 > 兄弟 profile。 */
function candidateRoots() {
  const roots = [];
  const push = (value) => {
    if (typeof value === "string" && value !== "") roots.push(value);
  };
  push(process.env.DSH_PROFILE_DIR);
  push(process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, "profiles", "web"));
  push(process.env.USERPROFILE === undefined ? undefined : join(process.env.USERPROFILE, ".dsh", "profiles", "web"));
  push(process.env.HOME === undefined ? undefined : join(process.env.HOME, ".dsh", "profiles", "web"));
  push(process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh"));
  return roots;
}

/** 在候选根里找到包含全部 NEEDED 的 `node_modules/@deepseek-ai` 目录。 */
function findSource() {
  for (const root of candidateRoots()) {
    for (const nodeModules of [join(root, "node_modules"), root]) {
      const base = join(nodeModules, "@deepseek-ai");
      if (!existsSync(base)) continue;
      const ok = NEEDED.every((name) => existsSync(join(base, name, "package.json")));
      if (ok) return base;
    }
  }
  return null;
}

function clean() {
  rmSync(join(PKG, "node_modules"), { recursive: true, force: true });
  console.log("已清掉 test 用的 node_modules（正式安装不依赖它）");
}

function main() {
  if (process.argv.includes("--clean")) {
    clean();
    return;
  }
  const source = findSource();
  if (source === null) {
    console.error("找不到 @deepseek-ai/schemastery：先装好 DSH（profile 里自带），或设置 DSH_PROFILE_DIR。");
    process.exitCode = 1;
    return;
  }
  mkdirSync(TARGET, { recursive: true });
  for (const name of NEEDED) {
    const from = join(source, name);
    const to = join(TARGET, name);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true, dereference: true });
    const size = dirSize(to);
    console.log(`✓ ${name} <- ${from}（${Math.round(size / 1024)} KB）`);
  }
  console.log(`测试用依赖就绪：${TARGET}`);
}

function dirSize(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += dirSize(child);
    else if (entry.isFile()) total += statSync(child).size;
  }
  return total;
}

main();
