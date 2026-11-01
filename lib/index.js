/**
 * dsh-codex-effort-slider-ultra — 宿主半边
 *
 * 客户端半边（`lib/client.js`）负责滑条本身；宿主半边只做两件事：
 *
 *   1. **让这个包成为 cordis 树上的一行**：`dsh.client` 的客户端 bundle 是靠
 *      「宿主 Loader 的条目里有这个包」被 `dsh-client-modules` 扫出来、编进
 *      `window.__DSH_BOOT__` 的。没有宿主条目，客户端产物永远不会被加载。
 *   2. **Ultra 档的提示词注入**：滑条最右端的 Ultra = 模型真实最高 effort + 一句固定
 *      指令。真实 effort 由客户端直接写进模型目录（它本来就能选 Max），宿主这里只负责
 *      把「这句指令」按会话折进系统提示词。
 *
 * Ultra 提示词为什么要绕一圈到宿主：客户端 bundle 只能改 DOM 与模型目录，没有任何
 * 「往消息/系统提示词里塞字」的能力；而 `systemPrompt.section({ text })` 是宿主侧唯一
 * 官方、缓存友好的逐会话条件注入点（`text` 每轮按 `context.agent.session` 求值，
 * 关掉时返回空串，等于没注册过）。两者之间用同源 HTTP 路由搭桥 —— 和 `dsh-plugin`
 * 的 `/dsh-plugin-hub/*` 完全一致的形状，不引入任何新依赖。
 *
 * 三条纪律（沿用 DSH 生态里已被事故验证过的形状）：
 *   1. **apply() 绝不抛错**：同步抛错会让该条目的 fiber 失败，启动审计会把它报成
 *      「Failed to load plugins」。
 *   2. **inject 只声明确定存在的服务**：`systemPrompt` 与 `webServer` 都是 dsh-base /
 *      dsh-web-app 必然 provide 的第一方服务；声明它们的回调若永不满足，也只是本条目
 *      的这一个回调不挂载，不影响滑条本身（滑条在客户端，不依赖宿主这一行）。
 *   3. **不打日志噪音**：加载成功不值得写一行日志；只在 bundle 缺失时告警一次。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * schemastery 是 DSH 插件配置的 schema 协议（`~standard`.vendor === "schemastery"）。
 * 它在 profile 里本来就是共享库（dsh-context 等第一方插件都依赖它），我们只是用同一个
 * 版本来声明 `Config`。
 *
 * 三选一，最后选了**顶层 await 的动态 import**：
 *
 *   · 静态 `import z from "@deepseek-ai/schemastery"` —— 解析失败会让**整个模块**加载失败
 *     （插件在 Loader 里变成 "Failed to load plugins"），而 schemastery 只服务于
 *     「在官方插件页里编辑文案」这一件事；拿不到它时滑条与注入必须照常工作。
 *   · `createRequire(...)("@deepseek-ai/schemastery")` —— 实测在 DSH 宿主里必挂：官方 Loader
 *     用 Node 的**内部 ESM loader** 装载插件，此时 require 它的 CJS 构建会连带 require
 *     依赖的 cosmokit，而 cosmokit 只有 ESM → `Unexpected module status 0. Cannot require()
 *     ES Module ... because it is not yet fully loaded`（原文见 `?diag=1` 的
 *     `schemasteryError`）。这条路线彻底放弃。
 *   · **顶层 await 的 `import()`** —— 走纯 ESM 通道，没有上面那个竞态；还能 try/catch，
 *     所以是唯一同时满足「能拿到」与「拿不到也活着」的形状。
 *
 * fail-open 的落点：拿不到时 `z === null` ⇒ `Config === undefined` ⇒ 官方 Loader 不校验配置、
 * 官方「插件」页不出现输入框；文案退回 `apply(ctx, { prompt })` 或默认值（`readPrompt` 三种形状都认）。
 */
let z = null;

/** 最近一次加载 schemastery 的失败原因（只给 `?diag=1` 排障用，不参与运行逻辑）。 */
let schemasteryError = "";

try {
  const loaded = await import("@deepseek-ai/schemastery");
  const schema = loaded && typeof loaded === "object" && "default" in loaded ? loaded.default : loaded;
  if (typeof schema === "function") z = schema;
  else schemasteryError = "不是函数：" + Object.prototype.toString.call(schema);
} catch (error) {
  schemasteryError = error instanceof Error ? error.message : String(error);
}


const PACKAGE_ID = "dsh-codex-effort-slider-ultra";

/** 客户端 ↔ 宿主 的桥：POST 同步某会话的 Ultra 开关，GET 读当前登记表（排障用）。 */
const ULTRA_ROUTE = "/dsh-codex-effort-slider-ultra/ultra";

/**
 * 本包在 profile patch 里的行 id。
 *
 * 三个身份在官方 Loader 里是同一个字符串：
 *   · patch 行 id（`codex-effort-slider-ultra`）
 *   · Loader 条目 id = `entry.options.id`（= settings 命名空间 `ns`）
 *   · 官方「插件」页里那个 row 的 `rowId`
 * 所以「插件」页用 `formFor(openRow.rowId)` 找 form 时，正好命中我们声明的 volatile 配置。
 * 改这个名字要同时改 cordis.patch.yml 的 `id:` 与客户端 `ENTRY_ID`。
 */
const ROW_ID = "codex-effort-slider-ultra";

/** 系统提示词里这一段的名字（全局注册，按会话求值，关掉时为空串）。 */
const ULTRA_SECTION = "codex-effort-slider:ultra";

/**
 * Ultra 档注入的固定指令，**逐字**来自用户给的「无限 token」提示词。
 * 这是**默认值**：文案可以在官方「插件」页的条目里直接改（见下方 `Config`），
 * 改完即时生效，不需要重装插件。
 */
const ULTRA_PROMPT =
  "切记的是：我们是deepseek公司，你的用量是unlimited的，我正在对你极限测试，开启智能体团队，不要吝惜Token。一定要切记，随意花费，你非常的富有";

/** 默认文案的别名（给 Config 的 `.default()` 用，同时也导出给客户端做「恢复默认」的提示）。 */
const DEFAULT_ULTRA_PROMPT = ULTRA_PROMPT;

/**
 * 插件配置（官方 Loader 的 `Config`）。
 *
 * 只有 `prompt` 一个字段，且它是 **volatile** 的 —— 这正是「在官方插件列表里出现一个可编辑
 * 输入框」的开关：
 *
 *   1. `dsh-settings` 的 `describe()` 只把「有 Config 且至少一个 volatile 字段且 fiber 活着」
 *      的 Loader 条目收进 `namespaces`（ns = 条目 id，也就是本包的 patch 行 id
 *      `codex-effort-slider-ultra`）。
 *   2. `@deepseek-ai/dsh-client-ui-plugin-manager`（官方「插件」页）在渲染某一行时，
 *      只有当 `configForms.describe()` 里存在同名 ns 才会把 `form` 传给
 *      `plugins.row.config` 插槽 —— 也就是输入框真正绑得上的数据源。
 *   3. volatile 字段在运行时被解析成一个 `{ get() }` 引用；官方设置页写回时走
 *      `configEditor.edit()` + Loader 的 `_commitVolatile()`，**原地更新这个引用**，
 *      不 dispose / 不重跑 apply。所以 `text()` 里每轮现读 `config.prompt.get()`
 *      就能做到「改完下一轮就生效」。
 *
 * 留空字符串 = Ultra 档只抬 effort、不注入任何指令（一种显式的「关掉注入」用法）。
 *
 * schemastery 拿不到时 `Config` 退化为 `undefined`：Loader 不校验配置、官方页面没有输入框，
 * 文案仍可由 `apply(ctx, { prompt })` 提供（见 `readPrompt` 的形状兼容）—— 滑条与注入照常工作。
 */
const Config =
  z === null
    ? undefined
    : z.object({
        prompt: z
          .string()
          .default(DEFAULT_ULTRA_PROMPT)
          .description("Ultra 档注入的系统提示词指令（留空 = 只抬 effort、不注入）")
          .volatile(),
      });

/**
 * 读一个 volatile 字段的当前值：兼容三种形状 ——
 *   · `{ get() }` 引用（正式运行时，settings 写回后原地变化）
 *   · 字符串（patch 行上直接写 `prompt: "..."`，或旧版本行为）
 *   · undefined（字段缺失 / 配置被清空到没有值）
 * 任何异常都返回 undefined，由调用方兜底到默认文案。
 */
function readVolatileText(value) {
  try {
    if (value === undefined || value === null) return undefined;
    if (typeof value === "string") return value;
    if (typeof value.get === "function") {
      const next = value.get();
      return typeof next === "string" ? next : undefined;
    }
  } catch {
    /* 读取本身失败 = 当它没配过 */
  }
  return undefined;
}

/**
 * 当前该注入的指令文案：没配过就用默认值；配了空串就是空串（= 不注入）。
 * @param config - 宿主解出来的插件配置
 */
function readPrompt(config) {
  const text = readVolatileText(config?.prompt);
  return text === undefined ? DEFAULT_ULTRA_PROMPT : text;
}

/** 桥的请求体上限：只接受一个小对象，超出直接拒绝。 */
const BODY_LIMIT_BYTES = 4096;

/** 本机回环主机名：`localhost` / `127.0.0.1` / `[::1]` 指向同一台机器的同一个端口。 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 静态核对客户端产物：只读文件、查关键标志，**不执行**产物。
 * 任何问题只告警，绝不阻断启动（这份产物坏了，坏的也只是那一块控件）。
 */
function auditClientBundle(log) {
  try {
    const bundle = readFileSync(fileURLToPath(new URL("./client.js", import.meta.url)), "utf8");
    const problems = [];
    if (!bundle.includes(`id: "${PACKAGE_ID}"`) && !bundle.includes(`id:"${PACKAGE_ID}"`)) problems.push("bundle id 不匹配");
    if (!bundle.includes("__ModuleLoader__.load")) problems.push("不是模块加载器 bundle");
    if (!bundle.includes("return module.exports")) problems.push("工厂没有交出 exports");
    if (!bundle.includes("conversation.input.right")) problems.push("没有声明目标插槽");
    if (!/exports\.apply\s*=/.test(bundle)) problems.push("没有导出 apply");
    if (problems.length > 0) {
      log(`客户端产物 lib/client.js 检查未通过（界面可能不会出现滑条）：${problems.join("；")}`);
      return;
    }
    log(`客户端产物 lib/client.js 就绪（${Buffer.byteLength(bundle, "utf8")} 字节，静态检查通过）`);
  } catch (error) {
    log(`客户端产物 lib/client.js 不可读（界面不会出现滑条）：${String(error)}`);
  }
}

/** 最小的 JSON 响应：本地桥不需要协商缓存，也绝不缓存。 */
function sendJson(response, status, value) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

/** 把 `host[:port]` 形式的 authority 归一化成 `loopback:端口`；非回环或解析失败返回 null。 */
function loopbackAuthority(authority) {
  try {
    const parsed = new URL(`http://${authority}`);
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) return null;
    return `loopback:${parsed.port === "" ? "80" : parsed.port}`;
  } catch {
    return null;
  }
}

/**
 * 只接受来自本机回环 web server 同源的写请求。
 * 这是我们全部的 CSRF 防线：Ultra 会改写模型看到的内容，绝不能让任意网页触发。
 */
function isSameOrigin(request) {
  const host = request.headers.host;
  const hostKey = host === undefined ? null : loopbackAuthority(host);
  if (hostKey === null) return false;
  const origin = request.headers.origin;
  // 浏览器对 POST 必定带 Origin；能省略它的只有本机原生客户端，而它们本来就能伪造任意头。
  if (origin === undefined || origin === "") return true;
  try {
    const url = new URL(origin);
    // 桌面端（Electron 宿主）页面跑在宿主自定义协议下，与 Host 必然不等。
    if (url.protocol === "dsh-app:") return true;
    return loopbackAuthority(url.host) === hostKey;
  } catch {
    return false;
  }
}

/** 读一个 JSON 请求体（带上限）；不是合法 JSON 就抛错，由调用方转成 400。 */
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  return JSON.parse(text);
}

/**
 * 从请求 URL 里取一个查询参数（未解析的 `request.url` 直接用）。
 * 拿不到 / 空串 -> null，由调用方决定兜底。
 * @param url - 原始 request.url
 * @param name - 参数名
 * @returns 去空白后的值或 null
 */
function queryParam(url, name) {
  try {
    const text = typeof url === "string" ? url : "";
    const mark = text.indexOf("?");
    if (mark < 0) return null;
    const value = new URLSearchParams(text.slice(mark + 1)).get(name);
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * 从请求 URL 里取 `?probe=<sessionId>`。拿不到 / 空串 -> null（走普通 GET）。
 * @param url - 原始 request.url（未解析）
 * @returns 会话 id 或 null
 */
function probeSessionId(url) {
  return queryParam(url, "probe");
}

/**
 * 把「当前生效的文案」和「能不能在界面上改」告诉客户端。
 * 只回文案本身，不回显任何会话内容；`editable` 取决于宿主有没有配置写入服务。
 * @param response - node 响应对象
 * @param deps - `{ readPrompt(), settings(), configEditor() }` 惰性依赖
 */
function answerPromptRead(response, deps) {
  try {
    const readPromptFn = typeof deps?.readPrompt === "function" ? deps.readPrompt : null;
    const current = readPromptFn === null ? undefined : readPromptFn();
    const service = (name) => {
      try {
        return typeof deps?.[name] === "function" ? deps[name]() : null;
      } catch {
        return null;
      }
    };
    const settings = service("settings");
    const configEditor = service("configEditor");
    const editable = (settings !== null && typeof settings.mutate === "function")
      || (configEditor !== null && typeof configEditor.edit === "function");
    sendJson(response, 200, {
      ok: true,
      prompt: typeof current === "string" ? current : DEFAULT_ULTRA_PROMPT,
      defaultPrompt: DEFAULT_ULTRA_PROMPT,
      editable,
      namespace: ROW_ID,
    });
  } catch (error) {
    sendJson(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * 诊断：官方配置表单为什么没有出现。
 *
 * 契约（`dsh-tool-cordis` 的 Config 投影）是：`entry.fiber.runtime.Config` 决定这一行有没有 schema。
 * 这个接口只回答"运行中的状态长什么样"，不写任何东西，便于在不重启的前提下定位问题。
 * @param response - node 响应对象
 * @param deps - `{ settings(), configEditor() }` 惰性依赖
 */
function answerDiagnostics(response, deps) {
  const report = {};
  const service = (name) => {
    try {
      return typeof deps?.[name] === "function" ? deps[name]() : null;
    } catch (error) {
      return { __throw: error instanceof Error ? error.message : String(error) };
    }
  };
  try {
    report.schemastery = z === null ? "missing" : "loaded";
    report.schemasteryError = schemasteryError;
    report.configOnModule = Config === undefined ? "undefined" : "present";
    const settings = service("settings");
    report.settingsService = settings === null ? "missing" : typeof settings;
    report.namespaces = [];
    report.hasNamespace = false;
    if (settings !== null && typeof settings === "object" && typeof settings.describe === "function") {
      try {
        const described = settings.describe();
        // `describe()` 返回的是**数组**（`[{ns, schema, revision, value, ...}]`）；老版本/远程
        // 投影里也见过 `{namespaces}` 的形状，两种都认。
        const list = Array.isArray(described)
          ? described
          : (Array.isArray(described?.namespaces) ? described.namespaces : []);
        const namespaces = list
          .map((item) => (item !== null && typeof item === "object" ? item.ns : null))
          .filter((ns) => typeof ns === "string");
        report.namespaces = namespaces.slice(0, 200);
        report.hasNamespace = namespaces.indexOf(ROW_ID) >= 0;
      } catch (error) {
        report.describeError = error instanceof Error ? error.message : String(error);
      }
    }
    const configEditor = service("configEditor");
    report.configEditorService = configEditor === null ? "missing" : typeof configEditor;
    report.entry = "missing";
    if (configEditor !== null && typeof configEditor === "object" && typeof configEditor.entries === "function") {
      const entry = configEditor.entries().find((row) => row?.options?.id === ROW_ID);
      report.entry = entry === undefined ? "missing" : "present";
      if (entry !== undefined) {
        report.fiberState = entry.fiber?.state ?? null;
        report.runtimeConfig = entry.fiber?.runtime?.Config === undefined ? "undefined" : "present";
        report.disable = entry.disabled === true;
        report.entryId = entry.id;
        report.entryModuleName = entry.options?.name;
      }
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  sendJson(response, 200, { ok: true, module: import.meta.url, diag: report });
}

/**
 * 把文案写回 profile 的插件配置（**不重装、不重启**）。
 *
 * 写路径与官方「插件」页的输入框完全相同：
 *   `settings.mutate(ns, ops)`（首选，处理分层/版本/volatile 校验）
 *   否则退回 `configEditor.edit(entry, ...)`（直接写 patch 行）
 * 两条路都会让 Loader 走 `_commitVolatile()`：运行中那个 `{ get() }` 引用被原地更新，
 * 于是下一轮 `systemPrompt.assemble` 立刻读到新文案。
 * @param deps - `{ settings(), configEditor() }` 惰性依赖
 * @param action - `{ kind: "set", prompt: string }` 或 `{ kind: "reset" }`
 */
async function writePromptConfig(deps, action) {
  const service = (name) => {
    try {
      return typeof deps?.[name] === "function" ? deps[name]() : null;
    } catch {
      return null;
    }
  };
  const ops = action.kind === "reset"
    ? [{ op: "unset", path: ["prompt"] }]
    : [{ op: "set", path: ["prompt"], value: action.prompt }];
  const settings = service("settings");
  if (settings !== null && typeof settings.mutate === "function") {
    await settings.mutate(ROW_ID, ops);
    return;
  }
  const configEditor = service("configEditor");
  if (configEditor !== null && typeof configEditor.edit === "function") {
    const rows = typeof configEditor.entries === "function" ? configEditor.entries() : [];
    const entry = Array.isArray(rows) ? rows.find((row) => row?.options?.id === ROW_ID) : undefined;
    if (entry === undefined) throw new Error(`没有找到 ${ROW_ID} 的配置条目`);
    await configEditor.edit(entry, (current) => {
      const next = { ...(current ?? {}) };
      if (action.kind === "reset") delete next.prompt;
      else next.prompt = action.prompt;
      return next;
    });
    return;
  }
  throw new Error("宿主没有 settings / configEditor 服务，无法保存文案");
}

/**
 * 排障探针：用**真正的装配路径**跑一遍，回答"这段指令此刻在不在系统提示词里"。
 * 只回布尔与长度，不回显提示词原文，也不回显会话内容。
 * 供安装后自检：`curl -H 'Origin: <origin>' 'http://127.0.0.1:3080/dsh-codex-effort-slider-ultra/ultra?probe=<sessionId>'`
 * @param sessionId - 要探的会话
 * @param response - node 响应对象
 * @param deps - `{ systemPrompt(), resolveAgent(sessionId) }` 惰性依赖
 */
async function answerProbe(sessionId, response, deps) {
  try {
    const systemPrompt = typeof deps?.systemPrompt === "function" ? deps.systemPrompt() : null;
    if (systemPrompt === null || typeof systemPrompt.assemble !== "function") {
      sendJson(response, 200, { ok: false, error: "systemPrompt service unavailable" });
      return;
    }
    const resolveAgent = typeof deps?.resolveAgent === "function" ? deps.resolveAgent : null;
    const resolved = resolveAgent === null ? null : await resolveAgent(sessionId);
    const agent = resolved !== null && typeof resolved === "object" && resolved.agent ? resolved.agent : null;
    if (agent === null) {
      sendJson(response, 200, { ok: false, error: "session agent not found", sessionId });
      return;
    }
    const assembly = await systemPrompt.assemble({ agent, scope: agent });
    const sections = Array.isArray(assembly?.sections) ? assembly.sections : [];
    let own = null;
    for (const section of sections) {
      if (section !== null && typeof section === "object" && section.name === ULTRA_SECTION) own = section;
    }
    const text = own !== null && typeof own.text === "string" ? own.text : "";
    sendJson(response, 200, {
      ok: true,
      sessionId,
      probe: {
        sectionPresent: own !== null,
        sectionLength: text.length,
        instructionInPrompt: text.trim() !== "",
        sectionCount: sections.length,
      },
    });
  } catch (error) {
    sendJson(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * 造一个客户端 ↔ 宿主桥的处理器，闭包持有本插件实例的登记表。
 *   POST { sessionId, ultra }        -> 设置该会话的 Ultra 开关（幂等；客户端是权威方）
 *   POST { prompt, savePrompt:true } -> 保存 Ultra 指令文案（写 profile，即时生效）
 *   POST { promptAction:"reset" }    -> 文案恢复默认（删掉用户层覆盖）
 *   GET                              -> 当前登记表（排障用）
 *   GET  ?probe=<sessionId>          -> 用真装配路径回答"指令在不在提示词里"
 *   GET  ?get=prompt                 -> 当前生效文案 + 能否编辑
 * @param ultraSessions - 开着 Ultra 的 sessionId 集合
 * @returns 直接丢给 webServer.register 的 handler
 */
function createUltraHandler(ultraSessions, deps = {}) {
  return async function handleUltraRequest(request, response) {
    if (request.method === "GET") {
      // `GET ?probe=<sessionId>`：真的跑一遍提示词装配，回答"这句指令到底进没进 prompt"。
      // 只读、同源（浏览器地址栏里贴不出来跨站）、不携带任何会话内容回显。
      const probeId = probeSessionId(request.url);
      if (probeId !== null) {
        await answerProbe(probeId, response, deps);
        return;
      }
      // `GET ?diag=1`：只读诊断——官方配置表单为什么没出现（runtime.Config 有没有被 Loader 认到）。
      if (queryParam(request.url, "diag") === "1") {
        answerDiagnostics(response, deps);
        return;
      }
      // `GET ?get=prompt`：给设置面板回填用。跨站读不到响应（没有 CORS 头），无需额外校验。
      if (queryParam(request.url, "get") === "prompt") {
        answerPromptRead(response, deps);
        return;
      }
      sendJson(response, 200, { ok: true, sessions: Array.from(ultraSessions) });
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "GET, POST" });
      response.end();
      return;
    }
    if (!isSameOrigin(request)) {
      sendJson(response, 403, { ok: false, error: "untrusted origin" });
      return;
    }
    try {
      const body = await readJsonBody(request);
      // 文案写回：与 Ultra 开关共用同一个桥，但两类请求体互斥（会话开关 / 配置写入）。
      if (body?.promptAction === "reset") {
        await writePromptConfig(deps, { kind: "reset" });
        const rest = typeof deps.readPrompt === "function" ? deps.readPrompt() : DEFAULT_ULTRA_PROMPT;
        if (typeof deps.log === "function") deps.log("Ultra 指令已恢复默认（用户层覆盖已删除）");
        sendJson(response, 200, { ok: true, prompt: typeof rest === "string" ? rest : DEFAULT_ULTRA_PROMPT, saved: false });
        return;
      }
      if (body?.savePrompt === true) {
        const prompt = typeof body?.prompt === "string" ? body.prompt : "";
        await writePromptConfig(deps, { kind: "set", prompt });
        if (typeof deps.log === "function") deps.log(`Ultra 指令已更新（${prompt.length} 字），下一轮装配生效`);
        sendJson(response, 200, { ok: true, prompt, saved: true, length: prompt.length });
        return;
      }
      const sessionId = body?.sessionId;
      const ultra = body?.ultra;
      if (typeof sessionId !== "string" || sessionId === "") {
        sendJson(response, 400, { ok: false, error: "sessionId is required" });
        return;
      }
      if (typeof ultra !== "boolean") {
        sendJson(response, 400, { ok: false, error: "ultra must be a boolean" });
        return;
      }
      if (ultra) ultraSessions.add(sessionId);
      else ultraSessions.delete(sessionId);
      sendJson(response, 200, { ok: true, sessionId, ultra, sessions: ultraSessions.size });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/**
 * 注册系统提示词里那一段。`text` 每轮按会话求值：
 *   - 会话开着 Ultra  -> 返回**当前配置的**指令（每轮现读，改文案下一轮生效）；
 *   - 关掉 / 文案为空   -> 返回空串，组装时被丢弃，等于这段从没存在过。
 * @param systemPrompt - 宿主 systemPrompt 服务
 * @param ultraSessions - 开着 Ultra 的 sessionId 集合
 * @param promptOf - 取当前文案的函数（`() => string`）或字符串
 * @returns 反注册函数
 */
function mountUltraSection(systemPrompt, ultraSessions, promptOf, notify) {
  return systemPrompt.section({
    name: ULTRA_SECTION,
    // 贴在 persona suffix 之后，也就是系统提示词的最后一个位置：说完所有工具说明再交代这件事。
    order: systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX"),
    text: (context) => {
      try {
        const session = context?.agent?.session;
        if (session === undefined || session === null) return "";
        if (!ultraSessions.has(session.id)) return "";
        const prompt = typeof promptOf === "function" ? promptOf() : promptOf;
        const text = typeof prompt === "string" ? prompt : "";
        if (text.trim() === "") return "";
        if (typeof notify === "function") notify(session.id);
        return text;
      } catch {
        // 装配是"要么全成、要么整轮发不出去"的路径：这里无论如何都返回空串，
        // 宁可这一轮缺一条指令，也不能让会话发不出消息。
        return "";
      }
    },
    interpolate: false,
  });
}

/**
 * @param ctx 宿主 cordis 上下文
 * @param config 由官方 Loader 解出来的插件配置（`{ prompt: volatileRef }`）；
 *   也兼容直接传字符串的老形状（`{ prompt: "..." }`）。
 */
export function apply(ctx, config = {}) {
  /**
   * 文案的**唯一**读取点：每次装配现读，所以官方设置页改完下一轮就生效。
   * 配置不可读时回落到默认值 —— 注入能力本身不依赖配置系统。
   */
  const readLivePrompt = () => readPrompt(config);
  /** 本实例的登记表：只放开通 Ultra 的会话。客户端是权威方，关掉即删除。 */
  const ultraSessions = new Set();

  let log = (message) => {
    try {
      console.info(`[${PACKAGE_ID}] ${message}`);
    } catch {
      /* 连日志都不能抛 */
    }
  };
  try {
    const candidate = ctx?.logger;
    const sink = typeof candidate === "function" ? candidate(PACKAGE_ID) : candidate;
    log = (message) => {
      try {
        if (sink && typeof sink.info === "function") sink.info(`[${PACKAGE_ID}] ${message}`);
        else console.info(`[${PACKAGE_ID}] ${message}`);
      } catch {
        /* 连日志都不能抛 */
      }
    };
    auditClientBundle(log);
  } catch {
    /* 审计本身失败也必须让 apply 静默成功 */
  }

  /** 惰性取可选宿主服务（拿不到就是 null，绝不抛）。 */
  const serviceOf = (name) => {
    try {
      return typeof ctx?.get === "function" ? ctx.get(name) ?? null : null;
    } catch {
      return null;
    }
  };
  /** 探针用：会话 id -> 活着的 Agent（优先官方 sessionController，其次 agents 注册表）。 */
  const resolveAgent = async (sessionId) => {
    try {
      const controller = serviceOf("sessionController");
      if (controller !== null && typeof controller.resolveAgent === "function") {
        return await controller.resolveAgent(sessionId);
      }
      const agents = serviceOf("agents");
      if (agents !== null && typeof agents.get === "function") {
        const agent = agents.get(sessionId);
        return agent ? { agent } : { error: { code: "not-found" } };
      }
    } catch {
      /* 探针失败只是探针失败 */
    }
    return null;
  };

  // 提示词注入：最末尾的一段（persona suffix 之后）。关掉时是空串，不污染缓存前缀。
  let injectedSystemPrompt = null;
  try {
    ctx.inject?.(["systemPrompt"], (scoped) => {
      try {
        injectedSystemPrompt = scoped.systemPrompt;
        const logged = new Set();
        scoped.effect(
          () =>
            mountUltraSection(scoped.systemPrompt, ultraSessions, readLivePrompt, (sessionId) => {
              if (logged.has(sessionId)) return;
              logged.add(sessionId);
              log(`Ultra 指令已进入会话 ${sessionId} 的系统提示词`);
            }),
          `${PACKAGE_ID}: ultra prompt section`,
        );
      } catch {
        /* 注册失败 = 没有 Ultra 提示词，滑条本身照样能用 */
      }
    });
  } catch {
    /* 服务声明失败不影响客户端那半边 */
  }

  // 客户端 ↔ 宿主桥：同源、只在本机回环 web server 上。
  try {
    ctx.inject?.(["webServer"], (host) => {
      try {
        const handler = createUltraHandler(ultraSessions, {
          systemPrompt: () => injectedSystemPrompt ?? serviceOf("systemPrompt"),
          resolveAgent,
          // 文案的读/写：读走运行中的 volatile 引用，写走官方 settings（退回 configEditor）。
          readPrompt: readLivePrompt,
          settings: () => serviceOf("settings"),
          configEditor: () => serviceOf("configEditor"),
          log,
        });
        host.effect(
          () => host.webServer.register({ kind: "exact", path: ULTRA_ROUTE, handler }),
          `${PACKAGE_ID}: ultra bridge route`,
        );
      } catch {
        /* 注册失败 = 客户端同步不通，Ultra 退化成「最高 effort + 无额外指令」 */
      }
    });
  } catch {
    /* 同上 */
  }
}

export default { apply, Config };

/**
 * 给离线测试 / 客户端提示用的导出（运行时无副作用）。
 * `DEFAULT_ULTRA_PROMPT` 就是「恢复默认」按钮该写回的值。
 */
export { Config, DEFAULT_ULTRA_PROMPT, ULTRA_PROMPT, ULTRA_SECTION, ULTRA_ROUTE, readPrompt };
