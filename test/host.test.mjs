/**
 * 宿主半边的离线测试：不需要跑真正的 DSH，只要一个假 ctx。
 *
 * 覆盖三件事：
 *   1. `systemPrompt.section` 的 `text(context)` 是否**只**对该会话开着 Ultra 时返回指令；
 *   2. `/dsh-codex-effort-slider-ultra/ultra` 的 POST 是否真的改了登记表（幂等，开/关都能过）；
 *   3. 同源校验与参数校验是否挡住坏请求（CSRF / 乱写）。
 *
 * 跑法：`node test/host.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import program, { apply, Config, DEFAULT_ULTRA_PROMPT, readPrompt } from "../lib/index.js";

const ULTRA_ROUTE = "/dsh-codex-effort-slider-ultra/ultra";

/** 假 IncomingMessage：只需要 method / url / headers / 异步可迭代（body）。 */
function fakeRequest({ method = "POST", headers = {}, body = "" } = {}) {
  return {
    method,
    url: ULTRA_ROUTE,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== "") yield Buffer.from(body, "utf8");
    },
  };
}

/** 假 ServerResponse：记录 writeHead 与 end 的载荷。 */
function fakeResponse() {
  const out = { status: 0, headers: {}, body: "" };
  return {
    out,
    writeHead(status, headers = {}) {
      out.status = status;
      out.headers = headers;
      return this;
    },
    end(chunk = "") {
      out.body = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      out.json = out.body === "" ? undefined : JSON.parse(out.body);
      return this;
    },
  };
}

/** 把 apply() 接到一个记录型假 ctx 上，交出注册好的部件。`services` 模拟 `ctx.get(name)`。 */
function mount(config = {}, services = {}) {
  const sections = [];
  const routes = [];
  const effects = [];
  const ctx = {
    logger: undefined,
    get(name) {
      return Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined;
    },
    inject(deps, callback) {
      if (deps.includes("systemPrompt")) {
        callback({
          effect(factory, label) {
            effects.push(label);
            return factory();
          },
          systemPrompt: {
            section(section) {
              sections.push(section);
              return () => {};
            },
            getSectionOrder() {
              return 10200;
            },
          },
        });
      }
      if (deps.includes("webServer")) {
        callback({
          effect(factory, label) {
            effects.push(label);
            return factory();
          },
          webServer: {
            register(route) {
              routes.push(route);
              return () => {};
            },
          },
        });
      }
    },
  };
  apply(ctx, config);
  assert.equal(sections.length, 1, "应当注册且只注册一段系统提示词");
  assert.equal(routes.length, 1, "应当注册且只注册一条桥路由");
  return { section: sections[0], route: routes[0], effects };
}

async function post(route, payload, headers = { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" }) {
  const request = fakeRequest({ method: "POST", headers, body: JSON.stringify(payload) });
  const response = fakeResponse();
  await route.handler(request, response);
  return response.out;
}

test("提示词只在开着 Ultra 的会话里出现", async () => {
  const { section } = mount();

  assert.equal(section.name, "codex-effort-slider:ultra");
  assert.equal(section.order, 10200, "应当贴在 persona suffix 之后（system prompt 最末尾）");
  assert.equal(typeof section.text, "function", "text 必须是按次求值的函数，才能逐会话开关");
  assert.equal(section.text({}), "", "没有 agent 时必须是空串");
  assert.equal(section.text({ agent: { session: { id: "sess-a" } } }), "", "没登记过的会话必须是空串");

  const { route } = mount();
  const ok = await post(route, { sessionId: "sess-a", ultra: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.ultra, true);
});

test("POST 开/关是幂等的，并且只影响点名的那个会话", async () => {
  const sessions = [];
  const routes = [];
  // 用同一份 apply 的产物验证跨请求的状态
  const ctx = {
    logger: undefined,
    inject(deps, callback) {
      if (deps.includes("systemPrompt")) {
        callback({
          effect: (factory) => factory(),
          systemPrompt: {
            section(section) {
              sessions.push(section);
              return () => {};
            },
            getSectionOrder: () => 10200,
          },
        });
      }
      if (deps.includes("webServer")) {
        callback({
          effect: (factory) => factory(),
          webServer: {
            register(route) {
              routes.push(route);
              return () => {};
            },
          },
        });
      }
    },
  };
  apply(ctx, {});
  const section = sessions[0];
  const route = routes[0];

  assert.equal(section.text({ agent: { session: { id: "s1" } } }), "");

  await post(route, { sessionId: "s1", ultra: true });
  const on = section.text({ agent: { session: { id: "s1" } } });
  assert.ok(on.includes("unlimited"), "开 Ultra 后该会话应当拿到固定指令");
  assert.ok(on.includes("开启智能体团队"), "指令必须是逐字的那一句");
  assert.equal(section.text({ agent: { session: { id: "s2" } } }), "", "别的会话不受影响");

  // 重复开：状态不变，不报错
  const again = await post(route, { sessionId: "s1", ultra: true });
  assert.equal(again.status, 200);
  assert.ok(section.text({ agent: { session: { id: "s1" } } }).includes("unlimited"));

  // 关掉：立刻回到空串
  const off = await post(route, { sessionId: "s1", ultra: false });
  assert.equal(off.status, 200);
  assert.equal(section.text({ agent: { session: { id: "s1" } } }), "");
});

test("GET 能读出当前登记表", async () => {
  const routes = [];
  const ctx = {
    logger: undefined,
    inject(deps, callback) {
      if (deps.includes("webServer")) {
        callback({ effect: (factory) => factory(), webServer: { register: (r) => { routes.push(r); return () => {}; } } });
      }
    },
  };
  apply(ctx, {});
  const route = routes[0];
  await post(route, { sessionId: "sess-get", ultra: true });
  const request = fakeRequest({ method: "GET", headers: { host: "127.0.0.1:3080" } });
  const response = fakeResponse();
  await route.handler(request, response);
  assert.equal(response.out.status, 200);
  assert.deepEqual(response.out.json.sessions, ["sess-get"]);
});

test("坏请求被挡住：跨源、缺字段、非布尔、非 GET/POST", async () => {
  const routes = [];
  const ctx = {
    logger: undefined,
    inject(deps, callback) {
      if (deps.includes("webServer")) {
        callback({ effect: (factory) => factory(), webServer: { register: (r) => { routes.push(r); return () => {}; } } });
      }
    },
  };
  apply(ctx, {});
  const route = routes[0];
  const local = { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" };

  // 跨源：别的网站想偷偷打开 Ultra
  const crossOrigin = await post(route, { sessionId: "x", ultra: true }, { host: "127.0.0.1:3080", origin: "https://evil.example" });
  assert.equal(crossOrigin.status, 403);

  // 缺 sessionId
  assert.equal((await post(route, { ultra: true }, local)).status, 400);
  // ultra 不是布尔
  assert.equal((await post(route, { sessionId: "x", ultra: "yes" }, local)).status, 400);
  // 非法 JSON
  {
    const request = fakeRequest({ method: "POST", headers: local, body: "{not json" });
    const response = fakeResponse();
    await route.handler(request, response);
    assert.equal(response.out.status, 400);
  }
  // 不支持的方法
  {
    const request = fakeRequest({ method: "DELETE", headers: local });
    const response = fakeResponse();
    await route.handler(request, response);
    assert.equal(response.out.status, 405);
  }
  // Host 头不是回环（DNS rebinding）
  assert.equal((await post(route, { sessionId: "x", ultra: true }, { host: "evil.example:3080", origin: "http://evil.example:3080" })).status, 403);
});

test("apply() 在没有服务、没有 logger 的裸 ctx 上也不抛错", () => {
  assert.doesNotThrow(() => apply({}, {}));
  assert.doesNotThrow(() => apply(undefined, undefined));
  assert.doesNotThrow(() => apply({ inject() { throw new Error("nope"); } }, {}));
});

test("prompt 可通过 config 覆盖（默认文案逐字保留）", async () => {
  const sections = [];
  const ctx = {
    logger: undefined,
    inject(deps, callback) {
      if (deps.includes("systemPrompt")) {
        callback({ effect: (factory) => factory(), systemPrompt: { section: (s) => { sections.push(s); return () => {}; }, getSectionOrder: () => 10200 } });
      }
      if (deps.includes("webServer")) {
        callback({ effect: (factory) => factory(), webServer: { register: () => () => {} } });
      }
    },
  };
  apply(ctx, { prompt: "CUSTOM-ULTRA" });
  const section = sections[0];
  const routes = [];
  void routes;
  // 用另一个 apply 实例走一遍登记，再断言文案
  const sections2 = [];
  const routes2 = [];
  const ctx2 = {
    logger: undefined,
    inject(deps, callback) {
      if (deps.includes("systemPrompt")) {
        callback({ effect: (factory) => factory(), systemPrompt: { section: (s) => { sections2.push(s); return () => {}; }, getSectionOrder: () => 10200 } });
      }
      if (deps.includes("webServer")) {
        callback({ effect: (factory) => factory(), webServer: { register: (r) => { routes2.push(r); return () => {}; } } });
      }
    },
  };
  apply(ctx2, { prompt: "CUSTOM-ULTRA" });
  await post(routes2[0], { sessionId: "s-cf", ultra: true });
  assert.equal(sections2[0].text({ agent: { session: { id: "s-cf" } } }), "CUSTOM-ULTRA");
});

test("GET ?probe=<sessionId> 用真装配路径回答指令在不在提示词里", async () => {
  const sections = [];
  const routes = [];
  const assembleCalls = [];
  const ctx = {
    logger: undefined,
    get(name) {
      if (name === "sessionController") {
        return {
          async resolveAgent(sessionId) {
            return sessionId === "known" ? { agent: { session: { id: "known" } } } : { error: { code: "not-found" } };
          },
        };
      }
      return undefined;
    },
    inject(deps, callback) {
      if (deps.includes("systemPrompt")) {
        callback({
          effect: (factory) => factory(),
          systemPrompt: {
            section: (s) => { sections.push(s); return () => {}; },
            getSectionOrder: () => 10200,
            async assemble(context) {
              assembleCalls.push(context);
              // 忠实复现官方 renderPrompt 的丢弃语义：空串不会进 sections
              const text = sections[0].text(context);
              return { sections: text === "" ? [] : [{ name: "codex-effort-slider:ultra", text }] };
            },
          },
        });
      }
      if (deps.includes("webServer")) {
        callback({ effect: (factory) => factory(), webServer: { register: (r) => { routes.push(r); return () => {}; } } });
      }
    },
  };
  apply(ctx, {});

  const get = async (url) => {
    const request = { method: "GET", url, headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" } };
    const response = fakeResponse();
    await routes[0].handler(request, response);
    return response.out;
  };

  // 未开 Ultra：装配结果里没有这一段
  let out = await get(ULTRA_ROUTE + "?probe=known");
  assert.equal(out.status, 200);
  assert.equal(out.json.probe.sectionPresent, false);
  assert.equal(out.json.probe.instructionInPrompt, false);

  // 开 Ultra：同一条探针立刻变 true
  await post(routes[0], { sessionId: "known", ultra: true });
  out = await get(ULTRA_ROUTE + "?probe=known");
  assert.equal(out.json.probe.sectionPresent, true);
  assert.equal(out.json.probe.instructionInPrompt, true);
  assert.ok(out.json.probe.sectionLength > 20);

  // 未知会话：ok:false，但路由本身不炸
  out = await get(ULTRA_ROUTE + "?probe=unknown");
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, false);

  // 普通 GET 仍然返回登记表
  out = await get(ULTRA_ROUTE);
  assert.equal(out.json.ok, true);
  assert.deepEqual(out.json.sessions, ["known"]);
  assert.equal(assembleCalls.length, 2);
});

/* ══════════════════ 可在「插件」页里编辑的 Ultra 指令（Config） ══════════════════ */

/** cosmokit 的 volatile 写入口（`Symbol.for`，所以测试里不需要 import 任何包）。 */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/** 从一个真 Config 里解出一份「活配置」，顺便能模拟设置页的写回。 */
function liveConfig(initial = {}) {
  const result = Config["~standard"].validate(initial);
  assert.equal(result.issues, undefined, "默认配置必须能通过校验");
  const config = result.value;
  return {
    config,
    read: () => config.prompt.get(),
    write: (text) => config.prompt[VOLATILE_WRITE](text),
  };
}

test("Loader 只认 default 导出的 Config：prompt 是 volatile 字段，默认值是那句原文", () => {
  assert.ok(program.Config, "default 导出必须带 Config（Loader 解的是 mod.default.Config）");
  assert.equal(program.Config, Config);
  assert.equal(Config["~standard"].vendor, "schemastery", "必须让 Loader 认出这是 schemastery schema");
  const { config, read } = liveConfig();
  assert.equal(typeof config.prompt.get, "function", "volatile 字段在运行时是 { get() } 引用");
  assert.equal(read(), DEFAULT_ULTRA_PROMPT);
  // 留空字符串是合法值（= Ultra 只抬 effort、不注入指令）
  assert.equal(liveConfig({ prompt: "" }).read(), "");
  // 普通字符串也照收（patch 行里手写 prompt: "..." 的用法）
  assert.equal(liveConfig({ prompt: "X" }).read(), "X");
});

test("readPrompt 兼容三种形状，缺配置时落回默认文案", () => {
  assert.equal(readPrompt(undefined), DEFAULT_ULTRA_PROMPT);
  assert.equal(readPrompt({}), DEFAULT_ULTRA_PROMPT);
  assert.equal(readPrompt({ prompt: "字符串覆盖" }), "字符串覆盖");
  assert.equal(readPrompt({ prompt: { get: () => "引用覆盖" } }), "引用覆盖");
  assert.equal(readPrompt({ prompt: { get: () => "" } }), "", "显式空串不该被默认值顶掉");
  assert.equal(readPrompt({ prompt: { get: () => 123 } }), DEFAULT_ULTRA_PROMPT, "非字符串当没配");
  assert.equal(readPrompt({ prompt: { get: () => { throw new Error("boom"); } } }), DEFAULT_ULTRA_PROMPT, "读挂当没配");
});

test("在「插件」页改完 prompt，下一轮装配立刻生效（不重启、不重装）", async () => {
  const sections = [];
  const routes = [];
  const ctx = {
    logger: undefined,
    inject(deps, callback) {
      if (deps.includes("systemPrompt")) {
        callback({ effect: (factory) => factory(), systemPrompt: { section: (s) => { sections.push(s); return () => {}; }, getSectionOrder: () => 10200 } });
      }
      if (deps.includes("webServer")) {
        callback({ effect: (factory) => factory(), webServer: { register: (r) => { routes.push(r); return () => {}; } } });
      }
    },
  };
  const live = liveConfig();
  apply(ctx, live.config);
  await post(routes[0], { sessionId: "s-live", ultra: true });

  const text = () => sections[0].text({ agent: { session: { id: "s-live" } } });
  assert.equal(text(), DEFAULT_ULTRA_PROMPT, "默认仍是那句原文");

  live.write("只花 token，不用省。"); // 模拟官方设置页写回（volatile 原地更新）
  assert.equal(text(), "只花 token，不用省。", "改完当轮就是新文案");

  live.write(""); // 清空 = 不注入
  assert.equal(text(), "", "空文案必须返回空串（这样装配时会被整段丢弃）");

  live.write("再换一句"); // 再次改回非空
  assert.equal(text(), "再换一句");
});

/* ══════════════ 桥上的「读写指令文案」：GET ?get=prompt / POST savePrompt ══════════════ */

/** 发一个带查询串的 GET（`fakeRequest` 默认是 POST）。 */
async function get(route, query = "") {
  const request = fakeRequest({ method: "GET", headers: { host: "127.0.0.1:3080" } });
  request.url = ULTRA_ROUTE + query;
  const response = fakeResponse();
  await route.handler(request, response);
  return response.out;
}

test("GET ?get=prompt 回当前文案；没有配置服务时标记为不可编辑", async () => {
  const { route } = mount();
  const out = await get(route, "?get=prompt");
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
  assert.equal(out.json.prompt, DEFAULT_ULTRA_PROMPT);
  assert.equal(out.json.defaultPrompt, DEFAULT_ULTRA_PROMPT);
  assert.equal(out.json.editable, false, "没有 settings/configEditor 时不能编辑");
  assert.equal(out.json.namespace, "codex-effort-slider-ultra");
});

test("POST savePrompt 通过官方 settings 写回，并立刻影响下一轮装配", async () => {
  const live = liveConfig();
  const calls = [];
  const settings = {
    async mutate(ns, ops) {
      calls.push({ ns, ops });
      for (const op of ops) {
        if (op.op === "set" && op.path[0] === "prompt") live.write(op.value);
        if (op.op === "unset") live.write(DEFAULT_ULTRA_PROMPT);
      }
    },
  };
  const { route, section } = mount(live.config, { settings });
  await post(route, { sessionId: "s-cfg", ultra: true });
  const text = () => section.text({ agent: { session: { id: "s-cfg" } } });

  const saved = await post(route, { prompt: "新指令：尽量多花 token。", savePrompt: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.ok, true);
  assert.equal(saved.json.saved, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ns, "codex-effort-slider-ultra");
  assert.deepEqual(calls[0].ops, [{ op: "set", path: ["prompt"], value: "新指令：尽量多花 token。" }]);
  assert.equal(text(), "新指令：尽量多花 token。", "保存后当轮就是新文案");

  // 空串也是合法保存值（= 只抬 effort、不注入）
  await post(route, { prompt: "", savePrompt: true });
  assert.equal(text(), "");

  // 恢复默认 = unset（删掉用户层覆盖，回到 Config 的声明默认值）
  const reset = await post(route, { promptAction: "reset" });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.ok, true);
  assert.deepEqual(calls[calls.length - 1].ops, [{ op: "unset", path: ["prompt"] }]);
  assert.equal(text(), DEFAULT_ULTRA_PROMPT);
  assert.equal(reset.json.prompt, DEFAULT_ULTRA_PROMPT);
});

test("没有 settings 时退回 configEditor.edit，写回的是 patch 行的完整配置", async () => {
  const edits = [];
  const configEditor = {
    entries() {
      return [{ options: { id: "codex-effort-slider-ultra" }, config: {} }];
    },
    async edit(entry, change) {
      edits.push({ entry, next: change({ prompt: "旧文案" }, {}) });
    },
  };
  const { route } = mount({ prompt: "旧文案" }, { configEditor });
  const out = await post(route, { prompt: "只花不省", savePrompt: true });
  assert.equal(out.json.ok, true);
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].next, { prompt: "只花不省" });

  await post(route, { promptAction: "reset" });
  assert.deepEqual(edits[edits.length - 1].next, {}, "reset 是把 prompt 键整个删掉");
});

test("保存失败时回 400 且不假装成功", async () => {
  const settings = { async mutate() { throw new Error("Configuration entry changed during reload"); } };
  const { route } = mount({}, { settings });
  const out = await post(route, { prompt: "x", savePrompt: true });
  assert.equal(out.status, 400);
  assert.equal(out.json.ok, false);
  assert.match(out.json.error, /changed during reload/);
});

test("文案写回也要求同源：跨站 POST 被 403 挡掉", async () => {
  let touched = 0;
  const settings = { async mutate() { touched += 1; } };
  const { route } = mount({}, { settings });
  const out = await post(route, { prompt: "x", savePrompt: true }, { host: "127.0.0.1:3080", origin: "https://evil.example" });
  assert.equal(out.status, 403);
  assert.equal(touched, 0, "跨站请求不得写配置");
});

test("?diag=1 报告宿主真实状态：Config 在模块上、命名空间在 describe() 里", async () => {
  const settings = {
    describe() {
      return [
        { ns: "codex-effort-slider-ultra", revision: 0, applies: "live", value: { prompt: "x" } },
        { ns: "cot-translation", revision: 3, applies: "live", value: {} },
      ];
    },
    async mutate() {},
  };
  const configEditor = {
    entries() {
      return [{
        id: "include:codex-effort-slider-ultra",
        options: { id: "codex-effort-slider-ultra", name: "dsh-codex-effort-slider-ultra" },
        fiber: { state: 2, runtime: { Config: Config } },
        disabled: false,
      }];
    },
  };
  const { route } = mount({}, { settings, configEditor });
  const out = await get(route, "?diag=1");
  assert.equal(out.json.ok, true);
  assert.equal(out.json.diag.configOnModule, "present");
  assert.equal(out.json.diag.schemastery, "loaded");
  assert.equal(out.json.diag.hasNamespace, true);
  assert.ok(out.json.diag.namespaces.includes("codex-effort-slider-ultra"));
  assert.equal(out.json.diag.entry, "present");
  assert.equal(out.json.diag.runtimeConfig, "present");
  assert.equal(out.json.diag.fiberState, 2);
  assert.equal(out.json.diag.entryId, "include:codex-effort-slider-ultra");
});

test("?diag=1 在没有配置服务时照实说缺失，不抛", async () => {
  const { route } = mount({}, {});
  const out = await get(route, "?diag=1");
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
  assert.equal(out.json.diag.settingsService, "missing");
  assert.equal(out.json.diag.entry, "missing");
  assert.equal(out.json.diag.hasNamespace, false);
});
