# Eval 的 Browser prelude

Eval 的 `browser` 门面可以打开、复用、脚本化并关闭命名的 Chromium、Electron、CDP、relay 或 cmux 标签页。静态 URL 用 [`read`](./read.md)；需要认证状态、JavaScript 执行或交互时用 `browser`。

## 源码

- 宿主门面：`packages/coding-agent/src/tools/browser.ts`
- JavaScript/Python 门面：`packages/coding-agent/src/tools/browser/prelude.{js,py}`
- 面向模型的 prompt：`packages/coding-agent/src/prompts/tools/browser.md`
- 标签页生命周期：`packages/coding-agent/src/tools/browser/tab-supervisor.ts`
- Browser worker 与内部 tab API：`packages/coding-agent/src/tools/browser/tab-worker.ts`
- Browser 注册表与启动模式：`packages/coding-agent/src/tools/browser/{registry,launch,attach}.ts`
- Relay：`packages/coding-agent/src/tools/browser/relay/`
- Cmux 后端：`packages/coding-agent/src/tools/browser/cmux/`

该 prelude 仅在 Eval 与 `browser.enabled` 同时启用时存在。它不是 AgentTool。

## JavaScript API

```js
const tab = await browser.open({
  name: "main",
  url: "https://example.com",
  wait_until: "load",
});

const observation = await tab.observe();
await tab.id(observation.elements[0].id).click();
const title = await tab.title();

const length = await tab.run(
  async ({ tab }, suffix) => (await tab.title() + suffix).length,
  { args: ["!"], timeout: 30 },
);

await tab.close();
```

- `browser.open(options?) -> Promise<BrowserTab>` 打开或复用一个命名标签页并返回其句柄。
- `browser.tab(name = "main") -> BrowserTab` 返回既有句柄；不会打开标签页。
- `browser.close({ name?, all?, kill?, timeout? }) -> Promise<void>` 释放一个或全部受管标签页。
- `tab.close({ kill?, timeout? }) -> Promise<void>` 释放该句柄的标签页。

`open` 接受 `name`、`url`、`viewport`、`wait_until`、`dialogs`、`app` 与 `timeout`。`timeout` 以秒为单位，默认 30，并钳制在 1–300。

### 直接 tab 辅助函数

直接辅助函数穿过宿主桥接并返回真实的结构化值：

- 导航：`url()`、`title()`、`goto(url, { waitUntil? })`
- 检视：`observe({ includeAll?, viewportOnly? })`、`ariaSnapshot(selector?, { depth?, boxes? })`、`screenshot({ selector?, fullPage?, silent? })`、`extract("markdown" | "text")`
- 交互：`click(selector)`、`type(selector, text)`、`fill(selector, value)`、`press(key, { selector? })`、`scroll(dx, dy)`、`drag(from, to)`、`scrollIntoView(selector)`、`select(selector, ...values)`、`uploadFile(selector, ...paths)`
- 等待：`waitFor(selector, { timeout? })`、`waitForSelector(selector, { timeout?, visible?, hidden? })`、`waitForUrl(stringOrRegExp, { timeout? })`
- 页面执行：`evaluate(fnOrSource, ...args)`

直接 `waitFor` 与 `waitForSelector` 返回布尔值。`tab.id(number)` 与 `tab.ref("e5")` 则返回 `BrowserElement` 句柄。句柄支持 `click`、`type`、`fill`、`press`、`hover`、`focus`、`select`、`uploadFile`、`scrollIntoView`、`boundingBox`、`isVisible`、`isHidden` 与 `evaluate`。传给 `BrowserElement.evaluate` 的字符串是以元素为首参调用的函数表达式。

选择器接受 CSS 与 Puppeteer 的 `aria/…`、`text/…`、`xpath/…`、`pierce/…` 查询处理器。Playwright 专属的伪类（如 `:has-text()` 与 `:visible`）会被拒绝。`<select>` 元素必须用 `tab.select`；`tab.fill` 不支持它们。

`observe()` 分配由 `tab.id` 消费的数字 id。`ariaSnapshot()` 分配由 `tab.ref` 消费的 `[ref=eN]` id。导航与重渲染会使句柄失效；请在同一个 Eval cell 中重新 observe 后再操作。

### `tab.run(fnOrCode, options?)`

一次 run 接受序列化函数或 JavaScript 函数体字符串，外加 `{ args?, timeout? }`：

```js
const hrefs = await tab.run(async ({ page }) => {
  return await page.$$eval("a", links => links.map(link => link.href));
});

const title = await tab.run(
  "return await tab.title();",
  { timeout: 10 },
);
```

函数以 `{ tab, page, browser, wait, assert }` 作为首个参数。额外的 `args` 跟在后面。纯数据、函数与 `RegExp` 值会被序列化；函数无法捕获 Eval cell 的闭包。代码字符串以同样的名字作为全局变量，并允许顶层 `await`。

内部的 `tab` 是完整的 worker helper API。除直接表面外，它还包含返回句柄的 `waitFor`/`waitForSelector`，以及 run 作用域内的 `waitForNavigation`/`waitForResponse`。请在触发动作之前开始导航/响应等待。

Run 使用带普通 Eval 辅助函数与完整 Bun/Node 及工具桥接访问的共享 JavaScript 运行时。这是 API 隔离，不是安全沙箱。请求拦截会在每次 run 结束时清理。

返回值保持结构化。内部 `display(...)` 调用发出的非空文本会打印在外层 Eval cell 中，对象/图像 display 仍是 Eval 输出，而没有 display 文本的 run 不产生占位符。

## Python API

Python 暴露相同的句柄与直接方法名。`open` 与 `close` 使用关键字参数，而 `browser.tab` 与 `tab.id`/`tab.ref` 是同步句柄查找。直接辅助函数上的关键字参数会变成尾随的 JavaScript options 对象。

```python
tab = await browser.open(name="main", url="https://example.com")
observation = await tab.observe(viewportOnly=True)
await tab.id(observation["elements"][0]["id"]).click()
title = await tab.run("return await tab.title();", timeout=30)
await tab.close()
```

Python `tab.run` 只接受 JavaScript 字符串；不接受 Python 可调用对象。

## Browser 模式

`browser.open` 在显式请求时按此顺序选择浏览器：`app.cdp_url`、`app.path`，然后 `app.relay`。没有显式选择时，它依次考虑 relay 设置、已配置的 CDP、cmux，然后是项目共享的无头 Chromium。

- **无头（Headless）：** 在项目共享的 Chromium 中创建 omp 拥有的页面并应用 stealth 补丁。
- **spawn（`app.path`）：** 启动或复用一个启用了 CDP 的浏览器/Electron 可执行文件。`app.args` 只在此处生效。
- **连接（`app.cdp_url`）：** 附加到既有的 HTTP CDP discovery endpoint。
- **Relay（`app.relay: true`）：** 采用用户真实的 Chrome 标签页。`app.target` 按 URL/标题子串选择；不提供时采用可见且可用的标签页。
- **Cmux：** 驱动可用的 cmux WKWebView surface。

在不同 browser 种类间复用同一个标签页名会被拒绝，直到既有标签页关闭。关闭 omp 拥有的无头页面与自有 cmux surface 会关闭它们。连接与 relay 页面保持打开。spawn 的浏览器进程保持打开，除非 `kill: true` 释放其最后一个受管标签页并终止进程。

## 截图与输出

`tab.screenshot()` 把全分辨率图像保存到 `browser.screenshotDir` 下（未设置时保存到 OS 临时目录）并返回路径。除非 `silent: true`，它还会发出 Eval 图像。它从不接受输出路径。

宿主结果 details 把结构化的 `value` 与显示内容分开保留。显示文本受共享的内联输出策略限制；超限文本存为会话工件，并打印被截断后的文本。

## 安全与生命周期

Relay 与连接（attach）模式作用于真实的已登录会话；站点会把操作归于用户。请指定目标或创建专用标签页。未经直接授权，绝不导航用户可见的标签页或采取有后果的操作。

每个命名标签页有一个 worker，且只允许一个活动 run。超时或中止的 run 可以回收 worker 并使句柄失效。`browser.close({ all: true })` 释放全部受管标签页；`kill` 从不关闭或杀死 relay/CDP 连接的浏览器。

## 常见恢复

- 标签页缺失/已死：再次调用 `browser.open`。
- id/ref 过期：再次调用 `observe` 或 `ariaSnapshot`，然后重新获取句柄。
- 标签页忙：先 await 当前活动的辅助函数/run，再发出下一个。
- 选择器超时：重新 observe 并使用受支持的选择器。
- Relay 不可用：安装/启动 relay 并确认其 Chrome 扩展连接。
- 连接目标缺失：检视可用页面并使用精确的 `app.target`。

`tab.run` 与直接辅助函数针对实时浏览器状态执行。每次改变 UI 的操作后，请核验实际页面。
