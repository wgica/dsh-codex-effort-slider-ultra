# 参与贡献

感谢你愿意改进这个插件。它是上游 [dsh-codex-effort-slider](https://github.com/Microqian2th/dsh-codex-effort-slider)
的 Ultra 分支，改动请尽量小而具体，一次 PR 只做一件事。

## 先看这几条约定

- **无构建步骤**：`lib/client.js`（客户端）与 `lib/index.js`（宿主）就是发布产物 —— 手写、可读，
  改完直接跑，没有 `pnpm build` 之类的步骤。
- **零运行时依赖**：除了 `optionalDependencies` 里的 `@deepseek-ai/schemastery`（官方配置 schema），不要再加依赖。
- **必须 fail-open**：认不出官方 DOM 锚点、宿主服务缺失、会话不存在时，一律「什么都不做」——
  官方菜单必须保持原样，绝不能因为本插件而点不开。
- **别碰官方 class 与文字**：只写内联样式 + 追加自己的容器；官方 class、`role`、文案、chevron 都不动。
- 文档、注释用中文；提交信息带 `feat:` / `fix:` / `docs:` / `chore:` 这类前缀。

## 准备环境

需要 **Node.js ≥ 22**（见 `package.json` 的 `engines`）。

```bash
node test/prepare-deps.mjs    # 首次必跑（幂等）
```

它把 `@deepseek-ai/schemastery`（及 `cosmokit`）从本机已装的 DSH profile / 全局安装里复制到本包的
`node_modules/`，**只给离线测试用**；正式安装时由 profile 解析依赖，不读这里。
客户端测试不需要任何依赖。清掉它：`node test/prepare-deps.mjs --clean`。

## 跑测试

```bash
npm test           # 客户端：node test/client.test.mjs —— 595 项
npm run test:host  # 宿主：  node test/host.test.mjs —— 17 项
npm run test:all   # 两个套件依次跑
```

两套都是**离线**的：`test/harness.mjs` 提供保状态的 React 桩、够用的假 DOM 与逐字对齐官方产物的假官方菜单，
不启动真 DSH。函数行为改动请**顺带加断言** —— 现有测试里有大量「旧实现会失败」的守卫（例如粒子高度的
相关系数、`background-clip` 的坑、同档位去重），删断言前先想清楚。

## 开发循环

1. 改 `lib/client.js` 或 `lib/index.js`。
2. `npm run test:all` 全绿。
3. **完全退出并重开 DSH**，再看真实效果 —— 宿主在启动时把插件读进内存，只关窗口不够。
   唯一的例外是 Ultra **指令文案**：改完下一轮对话就生效，不用重启。
4. 不想装也能看观感：`node preview/make-preview.mjs` 重新生成 `preview/panel.html`（CSS 与拖动数学
   直接从 `lib/client.js` 抽取，所以它不会和产物漂移），浏览器打开即可拖；这个页面不接宿主、不做档位写回。

装进自己的 profile 试：仓库根的 `install.cmd`（`-Uninstall` 卸载、`-WhatIf` 只打印不落盘），
或 `dsh plugin --profile <profile> add "file:<本目录绝对路径>"`。

## CI

每个 PR 会在 GitHub Actions 上跑同一套测试：`.github/workflows/ci.yml` 里 Node 22 / 24 的 Linux 与
Node 24 的 Windows 各跑一遍 —— 客户端测试零依赖直跑，宿主测试前先用 `npm install --no-save --no-package-lock`
装一份 `@deepseek-ai/schemastery`。本地全绿再提，能省一轮往返。

## 提交前检查清单

- [ ] `npm run test:all` 全绿（宿主 **17** + 客户端 **595**）。
- [ ] 没有新增运行时依赖；`node_modules/`、`dist/`、`*.zip` 等产物没有入库（`.gitignore` 已经挡住，别用 `git add -f` 手滑带进去）。
- [ ] 动过 DOM 桥的地方仍然 fail-open：认不出锚点时官方菜单不受影响。
- [ ] 新行为配了断言；改了观感就重跑 `node preview/make-preview.mjs`，真机截图（`preview/screenshots/`）若更新一并提交。
- [ ] README / CHANGELOG 里写的东西确实成立：不写没验证过的接口、参数和文件。
- [ ] 没有把个人绝对路径（`E:\...`、`C:\Users\...`）写进代码、脚本或文档。
- [ ] 提交信息带前缀，一个提交只做一件事。

## 反馈问题

- **Bug / 功能请求**：走 [GitHub Issues](https://github.com/wgica/dsh-codex-effort-slider-ultra/issues)。
- 报 bug 请附：DSH 版本、本插件版本（`package.json` 的 `version`）、以及**右键滑条 →「复制诊断」**导出的内容。
  「插件页看不到配置表单」这类问题，再补一条 `GET /dsh-codex-effort-slider-ultra/ultra?diag=1` 的输出。
- 上游的问题（滑条本体、配色、动画）请提到[上游仓库](https://github.com/Microqian2th/dsh-codex-effort-slider)，
  别提到这里 —— 本分支只多了一个 Ultra 档。

## 许可

本仓库是 MIT（见 `LICENSE`）。提交 PR 即表示你同意自己的贡献以 MIT 许可发布，并保留上游的版权与署名。
