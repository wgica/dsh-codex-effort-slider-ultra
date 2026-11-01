# 变更日志

本仓库是上游 [dsh-codex-effort-slider](https://github.com/Microqian2th/dsh-codex-effort-slider) 的 Ultra 分支。
下面只记录**能对应到本仓库代码与测试**的内容，不补写没有发生过的历史。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [1.5.6] - 2026-11-01

本仓库当前版本（`v1.5.6`）的能力清单。

### 新增

- **Ultra 虚拟档**：滑条最右端多一个停靠点（虚拟第 N+1 档）。它仍然写回该模型**真实的最高档**
  `reasoning_effort`，不伪造宿主不认识的等级 —— 官方一整套校验、状态回报、回滚逻辑照旧生效。
- **Ultra 指令注入（逐会话、按 System Prompt section）**：滑条停在 Ultra 时，客户端
  `POST /dsh-codex-effort-slider-ultra/ultra`（只接受 loopback 同源请求）告知宿主；宿主用
  `systemPrompt.section({ name: "codex-effort-slider:ultra" })` 把 `ULTRA_PROMPT` 那句默认指令折进该会话的
  系统提示词（大意：不要吝惜 Token、把预算用满、必要时开启智能体团队；**逐字原文**见 `lib/index.js`，
  加载时可用 `config.prompt` 覆盖）。
- **指令文案热改**：设置 → 插件 → 本插件那一行（官方 `plugins.row.config` 插槽），
  或右键滑条 → 设置面板里的「Ultra 指令」；两处读写**同一份**插件配置，保存后**下一轮对话就生效**，
  不重装、不重启。留空 = Ultra 只抬 effort、不注入任何指令。
- **兜底配置编辑器**：官方 `form` 没下发时，同一位置换成插件自带的编辑器，走同一条同源桥、同一份配置，
  不会出现「没有配置表单」的死路。
- **Ultra 过渡动画**：从更低档滑进 Ultra 的瞬间，官方那一行「推理等级」被临时顶掉，换成居中的过渡文字
  （Ultra 紫渐变 + 偏紫白扫光，从右往左**只扫一遍**），停留 1400ms 后 300ms 淡出并还原原文字；
  播放中若又滑离 Ultra 会立刻收掉。开关与文案在滑条设置面板与官方插件页都能改（文案上限 40 字）。
- **自检 / 诊断接口**：`GET /dsh-codex-effort-slider-ultra/ultra` 返回处于 Ultra 的会话 id 列表；
  `?probe=<sessionId>` 返回该会话系统提示词里 Ultra 段的真实状态；`?get=prompt` 返回当前文案与是否可写；
  `?diag=1` 返回宿主诊断（schemastery 是否加载、`Config` 是否在模块上、Loader 是否认到、失败原因原文）。
- **安装 / 卸载脚本**：`install.cmd` → `install-profile.ps1`：备份 profile 的 `package.json`（带时间戳）→
  加一条 `link:` 依赖 → 把包名追加进 `dsh.profile.bundles` → 建 junction / 符号链接 → 校验写回结果；
  `-Uninstall` 卸载还原，`-WhatIf` 只打印不落盘。
- **一键上传 GitHub**：`publish.cmd` / `publish.ps1`：检查环境与 git 身份 → `git init -b main` → 校正 origin →
  有变更才提交 → 推送到 `main`；带 `-Owner` / `-Repo` / `-Token` / `-Message` / `-NoPush` / `-Help`。
- **打包脚本**：`npm run pack` → `scripts/pack.mjs`（纯 Node、零依赖），产出
  `dist/dsh-codex-effort-slider-ultra-<version>.zip`，zip 内 `package.json` 在根。
- **离线测试套件**：宿主半边 `test/host.test.mjs`、客户端 `test/client.test.mjs`；
  `test/harness.mjs` 提供保状态的 React 桩、够用的假 DOM（portal / MutationObserver / 多属性选择器）与
  逐字对齐官方产物的假官方菜单。首次跑宿主测试前用 `node test/prepare-deps.mjs` 准备依赖。
- **在线试玩**：`node preview/make-preview.mjs` 生成 `preview/panel.html`，不装插件也能拖。

### 变更

- 滑条颜色与能量由**位置连续驱动**：左端恒为蓝 `#4d93f8`，越往右越紫（最高档终点 `#4c1d95`）；
  官方那一行的数值文字也随档位变色（`Off` 保持官方灰）。
- 星空粒子放在独立的 `.ces-stars` 层、用确定性伪随机（`starHash01`，不用 `Math.random`）；
  高度与相位解耦（实测相关系数 −0.110，断言守着 `|r| < 0.35`）。
- `prefers-reduced-motion` 下**放缓**而不是冻住（收起扫光、粒子周期 ×2.6）。
- 拖动写入：同档位去重 + 在途合并 + 120ms 降频。
- 官方那一行只写 4 个内联样式并 append 一个容器，不碰官方 class、不改官方文字与 chevron；
  认不出锚点时一律 fail-open（官方菜单保持原样）。

### 修复（含 v1.4.x–v1.5.5 在本分支上的调校）

- 过渡动画：v1.4.1 修正扫光方向（之前反了）与垂直位置（之前偏下）；
  v1.4.2–v1.4.4 调整渐变配色、移除会带坏裁剪的 `filter`、收窄偏白段；
  v1.5.0 偏白段收到约 1.6%、发光改用 `text-shadow` 加回；
  v1.5.1 扫光改成**只跑一遍**（原先 `infinite` 会在结束后从右侧重新冲进来）；
  v1.5.2 把发光挪到独立的 `.ces-flash__glow` 层 —— Chromium 在带 `text-shadow` 的元素上会放弃
  `background-clip:text` 裁剪，把渐变画成一块矩形底色；
  v1.5.3 把入场位移挪到 `.ces-flash__stack`，让发光层与正文严格一起动；
  v1.5.4 定下 14px / 400 + `letter-spacing:normal` + `font-synthesis:none`（不让浏览器给中文合成假粗体）；
  v1.5.5 过渡文字整体上抬 `FLASH_LIFT_PX`（当前 2px；3px 时观感太靠上）。
- 写入失败 / 超时（10s）→ 回滚到真实档位并显示原因，**不谎报成功**。
- `directoryFor()` 在会话作用域就绪前抛错 → 退避重试（60ms 起，约 9 秒）+ 自愈；档位数是后到的，
  桥会在档位数变化时主动重扫。

### 已知限制

- 首次安装 / 升级到新版本仍需重启一次 DSH（宿主半边模块在启动时加载；之后的**文案改动**不需要）。
- 控制项活在官方模型菜单里，所以必须先点开菜单才能改档位；输入框工具行上没有常驻读数。
- 依赖官方菜单的 DOM 语义属性；官方改成非 `menuitem` 结构、去掉 `aria-controls`、
  或不再用 `data-composer-card` 时，插件会**静默退回「什么都不做」**，官方菜单照常可用。
- 那一行加高约 20px + 滑条 28px，菜单总高会变大；官方会自己重测位置，但极小屏幕上可能贴边。
- 主题令牌缺失时回退到中性灰 + `#4d93f8` 蓝，观感可用但不如在 DSH 内贴合。

### 测试

- `node test/host.test.mjs`：**17 / 17 通过**。
- `node test/client.test.mjs`：**595 / 595 通过**。

## [更早的版本]

v1.5.6 之前的版本沿上游 [dsh-codex-effort-slider](https://github.com/Microqian2th/dsh-codex-effort-slider) 演进，
未逐版记录。

## [未发布]

<!-- 下一个版本的变更写在这里：### 新增 / ### 变更 / ### 修复 -->
