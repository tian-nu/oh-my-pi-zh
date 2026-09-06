import type { CommandMetadata } from "@oh-my-pi/pi-utils/cli";

export const acpHelp = {
	description: "以 ACP（Agent Client Protocol）服务器模式通过 stdio 运行 Oh My Pi",
} satisfies CommandMetadata;

export const agentsHelp = { description: "管理内置任务 agent" } satisfies CommandMetadata;

export const authBrokerHelp = {
	description: "管理 omp auth-broker（凭据保险库）",
} satisfies CommandMetadata;

export const authGatewayHelp = {
	description: "基于已配置的 broker 运行 auth-gateway 转发代理",
} satisfies CommandMetadata;

export const benchHelp = {
	description:
		"模型基准测试：测量聊天、prefill、生成与 prompt-cache 负载下的 TTFT/prefill 与解码吞吐（p50/p95）",
} satisfies CommandMetadata;

export const browserRelayHelp = {
	description: "运行本地 CDP 中继，让浏览器前置流程能够驱动你自己的 Chrome 标签页",
} satisfies CommandMetadata;

export const cleanseHelp = {
	description: "使用带权重的并行子 agent 检测并修复项目诊断问题",
} satisfies CommandMetadata;

export const commitHelp = { description: "生成提交信息并更新 changelog" } satisfies CommandMetadata;

export const completionsHelp = {
	description: "输出 shell 补全脚本（bash、zsh 或 fish）",
} satisfies CommandMetadata;

export const completeHelp = { hidden: true } satisfies CommandMetadata;

export const compressHelp = {
	description: "将文本文件改写为高密度的 prompt 寄存格式，并报告丢弃了哪些内容",
} satisfies CommandMetadata;

export const configHelp = { description: "管理配置项" } satisfies CommandMetadata;

export const dryBalanceHelp = {
	description: "以随机会话 id 演练（dry-run）OAuth 账号额度均衡",
} satisfies CommandMetadata;

export const galleryHelp = {
	description: "在确定性可视化画廊中预览工具、composer 和状态栏渲染效果",
} satisfies CommandMetadata;

export const gcHelp = { description: "运行存储垃圾回收" } satisfies CommandMetadata;
export const ifBenchHelp = {
	description:
		"指令遵循与工作记忆基准测试：用一条会移动的猫叫声指令驱动单条缓存线程执行字形数组操作",
} satisfies CommandMetadata;
export const gitHelp = {
	description: "交互式全屏 git 界面：分屏 diff 查看器、暂存侧边栏和提交编辑器",
} satisfies CommandMetadata;

export const grepHelp = { description: "测试 grep 工具" } satisfies CommandMetadata;

export const grievancesHelp = {
	description: "查看、清理或推送已上报的工具问题（自动 QA grievances）",
} satisfies CommandMetadata;

export const imagesHelp = {
	description: "检查、诊断、探测并清理图片发布后端",
} satisfies CommandMetadata;

export const installHelp = {
	description: "安装或链接扩展包（`plugin install`/`plugin link` 的别名）",
} satisfies CommandMetadata;

export const joinHelp = { description: "加入共享协作会话（等同于 /join）" } satisfies CommandMetadata;

export const modelsHelp = { description: "列出、搜索并刷新可用模型" } satisfies CommandMetadata;

export const pluginHelp = { description: "管理插件（安装、卸载、列出等）" } satisfies CommandMetadata;

export const psHelp = {
	description: "列出并控制由 daemon 监管的后台进程（日志、停止、杀掉、重启）",
} satisfies CommandMetadata;

export const readHelp = {
	description: "查看 read 工具对某个路径、URL 或内部 URI 会返回的内容",
} satisfies CommandMetadata;
export const renderHelp = {
	description: "通过正式 transcript 渲染管线绘制整个会话线程（含重绘计时）",
} satisfies CommandMetadata;

export const sayHelp = {
	description: "使用本地 TTS 引擎合成文本并通过扬声器播放",
} satisfies CommandMetadata;

export const searchHelp = { description: "测试 web search provider" } satisfies CommandMetadata;

export const shareHelp = {
	description: "通过加密链接分享已保存的会话（等同于 /share）",
} satisfies CommandMetadata;

export const setupHelp = {
	description: "运行引导设置，或为可选功能安装依赖",
} satisfies CommandMetadata;

export const shellHelp = { description: "交互式 shell 控制台" } satisfies CommandMetadata;

export const sshHelp = { description: "管理 SSH 主机配置" } satisfies CommandMetadata;

export const statsHelp = { description: "查看使用统计" } satisfies CommandMetadata;

export const tinyModelsHelp = {
	description: "下载 tiny 本地模型（会话标题 + 记忆）",
} satisfies CommandMetadata;

export const tokenHelp = { description: "获取某个 provider 的 API key 或 OAuth token" } satisfies CommandMetadata;

export const ttsrHelp = {
	description: "检查并测试 Time-Traveling Stream Rules（TTSR）",
} satisfies CommandMetadata;

export const updateHelp = { description: "检查并安装更新" } satisfies CommandMetadata;

export const usageHelp = {
	description: "显示每个已认证账号的 provider 用量限额",
} satisfies CommandMetadata;

export const worktreeHelp = {
	description: "添加、列出或清理 git worktree（启用时先执行 clone）",
} satisfies CommandMetadata;
