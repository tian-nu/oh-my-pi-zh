# Collab：实时会话共享

`/collab` 将你正在运行的会话与其他 omp 实例实时共享。访客在自己的 TUI 中**原生渲染同一会话** —— 流式 assistant 文本、工具调用卡片、页脚状态（cwd、model、context %、cost）、ctrl+o 展开、`/dump` —— 而非终端镜像。访客可以向 agent 提示和中断；主机运行 agent 和所有工具。

## 快速上手

主机：

```
/collab
```

输出

```
Collab session started!
 • Join from another terminal: omp join "mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30"
 • or any web browser: my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30
```

浏览器那一行可点击加入（指向完整 `https://` deep link 的 OSC 8 超链接）：relay 在 `/` 提供 web 访客客户端，房间 id + key 放在 URL fragment 中。从另一个 omp（任意目录、任意机器），两种形式都可用：

运行 `/collab` 或 `/collab view` 会启动或显示当前活跃的托管会话，同时渲染终端/浏览器加入链接及其对应的二维码。

```
/join my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJU…
```

访客之前的会话会在 `/leave`（或主机停止时）恢复。

### 命令

| 命令              | 效果                                                                                |
| ----------------- | ----------------------------------------------------------------------------------- |
| `/collab`         | 以完全控制权限开始共享（已在托管时重新打印链接/二维码）                             |
| `/collab <relay>` | 通过指定的 relay 共享（`relay.example.com`、`ws://localhost:7475`）                  |
| `/collab view`    | 以只读权限开始共享（已在托管时重新打印链接/二维码）                                 |
| `/collab status`  | 显示链接 + 参与者                                                                   |
| `/collab stop`    | 停止共享                                                                            |
| `/join <link>`    | 以访客身份加入共享会话                                                              |
| `/leave`          | 离开（访客）或停止共享（主机）                                                      |

## 链接格式

`/join <link>` 和 `omp join "<link>"` 接受：

```
<roomId>.<key>                                                    → default relay (wss://my.omp.sh)
<roomId>#<key>                                                    → legacy bare form
host[:port]/r/<roomId>.<key>                                     → custom relay, wss:// inferred
host[:port]/r/<roomId>#<key>                                     → legacy direct relay form
https://host[:port]/r/<roomId>.<key>                             → direct relay URL, normalized to wss://
wss://host[:port]/r/<roomId>.<key>                               → direct websocket relay URL
ws://localhost:7475/r/<roomId>.<key>                             → direct plain ws, localhost only
https://host[:port]/#<link>                                      → browser deep link when web UI and relay share a host
https://web-host[:port][/<path>]/#<relay-link>                   → browser UI wrapper with relay link in the fragment
https://web.example/collab/#relay.example.com/r/<roomId>.<key>   → web UI and relay on different hosts
```

`<link>` / `<relay-link>` 会按上述任意可接受的链接递归解析。对于带可解析 fragment 的 `http(s)` 浏览器包装，fragment 优先于被当作 relay 的 HTTP host/path。这使 `https://web.example/collab/#relay.example.com/r/<roomId>.<key>` 能在 `web.example` 打开 web UI，同时加入 `wss://relay.example.com/r/<roomId>`。如果 fragment 不是完整的 collab 链接，解析会回退到旧版直连 relay 形式，因此 `https://relay.example.com/r/<roomId>#<key>` 仍表示 relay `relay.example.com`。

末尾的 `.<key>` 或 `#<key>` 部分是房间密钥，base64url 编码，分两种强度：

- **完整链接** — 48 字节：32 字节 AES-256-GCM 房间密钥后跟 16 字节写 token。授予提示、中断和 subagent 控制权。
- **只读链接** — 仅有 32 字节裸密钥，无写 token。只授予实时读取权限。无 token 的旧链接按只读解析。

新生成的链接中房间密钥用点号连接，因为 RFC 3986 禁止 URL fragment 中出现原始 `#`；解析器仍接受旧版 `#` 形式以及经 `%23` 转义的旧版 deep link。

## 端到端加密

每个会话负载（entries、events、state、prompts）在进入 socket 之前都用 AES-256-GCM 封装。relay 只能看到：

- 房间 id 和连接数，
- 不透明的密文帧及其大小，
- 4 字节路由前缀（帧的目标访客）。

持有链接即信任边界：完整链接可读取并操控会话，只读链接仅可读取。两种链接都应像机密一样保管。

## 访客权限模型

两个信任级别，由链接本身强制 —— 主机在加入时验证 16 字节写 token，并拒绝没有该 token 的对等端写入（它们在参与者列表中显示为只读，加入通知也会说明）。

持有完整链接的访客可以：

- 读取整个会话（包括加入时的历史 transcript），
- 向 agent 提示（在每个参与者的 transcript 中渲染其名字徽章；LLM 看到的是逐字的提示文本 —— 名字仅用于显示），
- 中断 agent（Esc），
- 对主机的 subagent 使用 [Agent Hub](./agent-hub.md)：实时表格和进度、chat（操控主机的 subagent）、kill、revive 以及查看 transcript（按需从主机获取）。
- 响应主机的交互式 `select` 和 `editor` 请求。主机将每个待处理请求只广播给可写的访客；第一个提交或取消的响应将其落定并撤销其他端上的展示。

持有只读链接的访客可以实时读取一切 —— 历史 transcript、流式文本、工具卡片、subagent transcript —— 但主机拒绝来自它们的提示、中断和 agent 控制。

一切会变更主机会话或主机的操作仅限主机：`/model`、`/compact`、`/resume`、`/branch`、bash（`!`）、python（`$`）、skills 等。访客保留一个小的本地允许列表（`/dump`、`/export`、`/copy`、`/open`、`/help`、`/hotkeys`、`/theme`、`/settings`、`/leave`、`/collab`、`/exit`、`/quit`）。

当访客在 assistant 回合期间加入时，该在途回合会出现在后续第一次 `message_update` 上：访客在转发 delta 之前，从 update 的完整累积消息中合成缺失的 `message_start`。如果访客加入后主机对该回合不再发出 update，就没有可供合成实时组件的 update。持久化条目仍会到达副本的消息状态，但 entry 帧被有意不渲染，因此这一边缘情况可以不在实时 TUI 中出现。

## Web 客户端

`packages/collab-web` 是同一链接的独立浏览器客户端 —— 访客端无需安装 omp。relay 在 `/` 提供它，这正是 `/collab` deep link 可点击加入的原因：`https://<relay>/#<link>` 加载客户端并从 fragment 自动连接。它渲染实时 transcript（流式文本、thinking、工具卡片）、一个带按需 transcript 的 subagent 面板，以及一个具有相同访客权限（提示、中断、hub 操作）的输入区。在包内运行 `bun run dev` 启动本地实例，`bun run mock-host` 启动一个离线脚本化主机用于开发，`bun run build` 生成可部署到任意位置的静态 `dist/`（WebCrypto 要求 HTTPS）。客户端只与 relay 通信，密钥始终留在 URL fragment 中。

当浏览器 UI 与 websocket relay 分开托管时，设置 `collab.webUrl`。为空时，`/collab` 从 `collab.relayUrl` 推导 `http(s)://host[:port]`；显式的 web UI URL 必须使用 `https://`，`http://localhost` 开发源除外。生成的浏览器 URL 仍在 fragment 中携带 relay 专属的 collab 链接。

## 设置

| 设置                  | 默认值                | 含义                                                                                                           |
| --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `collab.relayUrl`     | `wss://my.omp.sh`     | 未内联传递 relay 时 `/collab` 使用的 relay                                                                      |
| `collab.webUrl`       | 空                    | `/collab` 链接使用的浏览器 UI URL；为空时从 relay 推导；显式 `http://` 仅允许用于 localhost                     |
| `collab.displayName`  | OS 用户名             | 向其他参与者显示的名字                                                                                          |
| `share.serverUrl`     | `https://my.omp.sh/s` | `/share` 使用的分享查看/上传基础地址（链接为 `<base>/<id>#<key>`）                                              |
| `share.redactSecrets` | `true`                | 上传前对 `/share` snapshot 运行机密混淆器                                                                       |

## 自托管 relay

生产环境 relay 目前不提供自托管发行：其 Go 源码和独立二进制均未发布。下文的端点列表描述的是托管服务的网络契约，而非可安装的发行版。

对于本地协议开发，本仓库在 [`packages/collab-web/scripts/local-relay.ts`](../packages/collab-web/scripts/local-relay.ts) 提供了一个源码可见、仅支持 WebSocket 的替代实现。在 `packages/collab-web` 中运行 `bun run relay` 可监听 `ws://localhost:7466`。它实现了 `/r/<roomId>`，但不提供浏览器客户端、`/share` blob 或 `/healthz`，因此不能替代生产服务。

relay 是一个小型内容盲的 Go 服务。除活跃连接外不保留任何状态，并暴露：

- `GET /` — 静态 collab-web 访客客户端（`/collab` deep link 的目标），
- `GET /r/<roomId>?role=host|guest` — WebSocket 升级，
- `POST /s` / `GET /s/<id>` / `GET /s/<id>/raw` — `/share` 的 blob 上传、查看页面和 blob 获取，
- `GET /healthz` — 存活检查。

## 架构说明

中心（hub）拓扑 —— 主机是权威方，访客之间从不对等互联：

1. `welcome` + `snapshot-chunk` 帧 —— 初始状态和 transcript。transcript 按字节界限切块，使每次到达都重置访客的进度超时；超大的复制条目在传输前被收缩。
2. `entry` 帧 —— 持久化的会话条目，在 blob 外部化之前广播，因此图像保持内联（访客无法解析主机的 blob 引用）。访客以保留的 id 将其追加到 `~/.omp/collab/<roomId>.jsonl` 下的副本会话文件以及 agent 的消息数组中，这就是 `/dump` 和 context 估算能工作的原因。
3. `event` 帧 —— 实时 agent 事件，直接送入访客的常规事件控制器；渲染仅基于事件以防止重复渲染。
4. `state` 帧 —— 去抖的页脚快照：流式标志、主机的完整 model 对象和 thinking level（应用到访客的副本 agent 状态，因此模型显示和 context-window 计算是原生的）、主机 context 数字以及参与者。
5. `bus` 帧 —— 镜像的任务 subagent 生命周期/进度 EventBus 流量，在访客本地 bus 上重新发布，使 subagent HUD 和状态行计数原生工作。
6. `agents` 帧 —— 馈入访客本地注册表的 agent-registry 快照，使 Agent Hub 表格渲染主机的 subagent。
7. `ui-request` / `ui-request-end` 帧 —— 向完全控制访客呈现的主机 select/editor 提示，落定后在各处撤销。访客以 `ui-response` 应答。

访客→主机：`hello`、`prompt`、`abort`、`agent-cmd`（hub 的 chat/kill/revive）、`fetch-transcript`（增量读取 subagent transcript，由定向的 `transcript` 帧应答），以及 `ui-response`。副本通过常规的 `/resume` 机制加载，因此主题、ctrl+o 和 transcript 行为天然就是原生的；访客进程从不 chdir 到主机路径。
