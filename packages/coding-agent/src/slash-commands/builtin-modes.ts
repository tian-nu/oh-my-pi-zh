import * as path from "node:path";
import {
	expandRoleAlias,
	formatModelString,
	getModelMatchPreferences,
	resolveCliModel,
	type ResolveCliModelResult,
} from "../config/model-resolver";
import type { SettingPath, Settings } from "../config/settings";
import { describeLoopLimitRuntime } from "../modes/loop-limit";
import type { InteractiveModeContext } from "../modes/types";
import type { AgentSession } from "../session/agent-session";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import { handleSecurityCommand } from "./helpers/security";
import type { ParsedSlashCommand, SlashCommandSpec, TuiSlashCommandRuntime } from "./types";

export function refreshStatusLine(ctx: InteractiveModeContext): void {
	ctx.statusLine.invalidate();
	ctx.ui.requestRender();
}

/**
 * Resolve a `/model` / `/switch` selector the way `omp bench` and `--model`
 * do: exact `provider/id`, fuzzy ids (`opus`), role aliases (`@smol`, `smol`),
 * and `:level` thinking suffixes. Unqualified selectors prefer the session's
 * `--models` scope, else the authenticated set, before the full catalog.
 */
function resolveSessionModelSelector(
	selector: string,
	session: AgentSession,
	settings: Settings,
): ResolveCliModelResult {
	const scoped = session.scopedModels.map(entry => entry.model);
	return resolveCliModel({
		cliModel: selector,
		modelRegistry: session.modelRegistry,
		availableModels: scoped.length > 0 ? scoped : undefined,
		settings,
		preferences: getModelMatchPreferences(settings),
	});
}

async function runWithDetachedModeDraft(
	command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
	run: () => Promise<boolean>,
): Promise<void> {
	const { editor } = runtime.ctx;
	if (!runtime.draftDetached) editor.clearDraft();
	try {
		const submitted = await run();
		if (!submitted && ((runtime.input?.images?.length ?? 0) > 0 || (runtime.input?.imageLinks?.length ?? 0) > 0)) {
			editor.pendingImages = [...(runtime.input?.images ?? []), ...editor.pendingImages];
			editor.pendingImageLinks = [
				...(runtime.input?.imageLinks ?? runtime.input?.images?.map(() => undefined) ?? []),
				...editor.pendingImageLinks,
			];
			editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		}
	} catch (error) {
		if (!editor.getText() && editor.pendingImages.length === 0) {
			editor.setText(command.text);
			editor.pendingImages = runtime.input?.images ? [...runtime.input.images] : [];
			editor.pendingImageLinks = runtime.input?.imageLinks ? [...runtime.input.imageLinks] : [];
			editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		}
		runtime.ctx.showError(error instanceof Error ? error.message : String(error));
	}
}

/** `/fast status` label for the active model: "on" when its family is priority, else "off". */
function formatFastModeStatus(session: AgentSession): string {
	return session.isFastModeEnabled() ? "on" : "off";
}

/** `/extended-context status` label for the premium long-context window setting. */
function formatExtendedContextStatus(settings: Settings): string {
	return settings.get("extendedContext") ? "on" : "off";
}

/** Applies an `/extended-context` argument and returns its operator feedback. */
function applyExtendedContextCommand(settings: Settings, args: string): string | undefined {
	const arg = args.trim().toLowerCase();
	const current = settings.get("extendedContext");
	if (!arg || arg === "toggle") {
		const enabled = !current;
		settings.set("extendedContext", enabled);
		return `扩展上下文已${enabled ? "启用" : "禁用"}。`;
	}
	if (arg === "on") {
		settings.set("extendedContext", true);
		return "扩展上下文已启用。";
	}
	if (arg === "off") {
		settings.set("extendedContext", false);
		return "扩展上下文已禁用。";
	}
	if (arg === "status") return `扩展上下文当前为 ${formatExtendedContextStatus(settings)}。`;
	return undefined;
}

/** Detailed, session-effective `/computer status` diagnostics. */
function formatComputerUseStatus(session: AgentSession): string {
	const enabled = session.settings.get("computer.enabled");
	const active = session.getEvalPreludes().some(definition => definition.name === "computer");
	const configured = {
		display: session.settings.get("computer.display"),
		maxWidth: session.settings.get("computer.maxWidth"),
		maxHeight: session.settings.get("computer.maxHeight"),
	};
	return [
		`计算机操作：${enabled ? "已启用" : "已禁用"}`,
		`预加载：${active ? "活跃" : "未激活"}`,
		`配置：display=${configured.display}, maxWidth=${configured.maxWidth}, maxHeight=${configured.maxHeight}`,
	].join(" · ");
}

/**
 * Apply a session-scoped computer-use toggle and rebuild the current prompt.
 * The override is never persisted to settings.json.
 */
async function applyComputerUseToggle(session: AgentSession, enable: boolean): Promise<string> {
	const previous = session.settings.get("computer.enabled");
	session.settings.override("computer.enabled", enable);
	if (enable && !session.getEvalPreludes().some(definition => definition.name === "computer")) {
		session.settings.override("computer.enabled", previous);
		return "计算机操作在当前会话不可用。";
	}
	try {
		await session.refreshBaseSystemPrompt();
	} catch (error) {
		session.settings.override("computer.enabled", previous);
		throw error;
	}
	return enable
		? `本会话已启用计算机操作。${formatComputerUseStatus(session)}`
		: "本会话已禁用计算机操作。";
}

const AUTOCOMPLETE_DETAIL_LIMIT = 48;

function shortDetail(value: string, limit = AUTOCOMPLETE_DETAIL_LIMIT): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit - 1)}…`;
}

export function formatTokenCount(value: number): string {
	return value.toLocaleString();
}

export const BUILTIN_MODE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "security",
		icon: "shield",
		description: "计划、运行、检查、导入和对比 OMP 原生安全扫描",
		allowArgs: true,
		acpInputHint: "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>",
		subcommands: [
			{ name: "plan", description: "创建不可变的安全扫描计划" },
			{ name: "scan", description: "启动已计划或新建计划的原生扫描" },
			{ name: "status", description: "显示原生扫描操作状态" },
			{ name: "cancel", description: "取消正在运行的原生扫描" },
			{ name: "scans", description: "列出已保存的项目安全扫描" },
			{ name: "show", description: "渲染扫描或 security:// 资源" },
			{ name: "import", description: "导入 SARIF 或 Codex Security 包" },
			{ name: "export", description: "导出规范包、SARIF 或报告" },
			{ name: "validate", description: "用 OMP 原生工具验证单个发现" },
			{ name: "compare", description: "对比两次扫描间的发现脉络" },
			{ name: "disposition", description: "为发现设置处置结论及理由" },
		],
		handle: handleSecurityCommand,
	},
	{
		name: "settings",
		icon: "settings",
		description: "打开设置菜单",
		handleTui: (_command, runtime) => {
			runtime.ctx.showSettingsSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "setup",
		aliases: ["providers"],
		icon: "gear",
		description: "打开提供商设置",
		allowArgs: true,
		subcommands: [{ name: "providers", description: "配置登录与网页搜索提供商" }],
		handleTui: async (command, runtime) => {
			const args = command.args.trim().toLowerCase();
			const opensProviders = args === "" || args === "providers";
			if (opensProviders) {
				await runtime.ctx.showProviderSetup();
			} else {
				runtime.ctx.showWarning(`用法：/${command.name} [providers]`);
			}
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "plan",
		icon: "plan",
		description: "切换计划模式（执行前先由 agent 规划）",
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("plan.enabled" as SettingPath)) return "计划模式：已在设置中禁用";
			if (runtime.ctx.planModeEnabled) {
				const planFile = runtime.ctx.planModePlanFilePath;
				return `计划模式：开${planFile ? ` (${path.basename(planFile)})` : ""}`;
			}
			if (runtime.ctx.goalModeEnabled) return "计划模式：被目标模式阻止";
			return "计划模式：关";
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handlePlanModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "plan-review",
		icon: "plan",
		description: "重新打开最近一次计划的评审（仅计划模式）",
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.planModeEnabled ? "计划评审：可用" : "计划评审：计划模式未开启",
		handleTui: async (_command, runtime) => {
			await runtime.ctx.openPlanReview();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "vibe",
		icon: "wave",
		description: "切换 Vibe 模式（直接的持久 fast/good worker 会话；只读工具集）",
		inlineHint: "[prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (runtime.ctx.vibeModeEnabled) return "Vibe：开";
			if (runtime.ctx.planModeEnabled) return "Vibe：被计划模式阻止";
			if (runtime.ctx.goalModeEnabled) return "Vibe：被目标模式阻止";
			return "Vibe：关";
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleVibeModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "goal",
		icon: "goal",
		description: "切换目标模式（本会话的持久自主目标）",
		subcommands: [
			{ name: "set", description: "设置或替换当前目标", usage: "<objective>" },
			{ name: "show", description: "查看当前目标详情" },
			{ name: "pause", description: "暂停当前目标" },
			{ name: "resume", description: "恢复已暂停的目标" },
			{ name: "drop", description: "放弃当前目标" },
			{ name: "budget", description: "调整 token 预算", usage: "<N|off>" },
		],
		inlineHint: "[objective]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.settings.get("goal.enabled" as SettingPath)) return "目标模式：已在设置中禁用";
			if (runtime.ctx.planModeEnabled) return "目标模式：被计划模式阻止";
			const state = runtime.ctx.session.getGoalModeState();
			return state ? `目标模式：${state.goal.status}（${shortDetail(state.goal.objective)}）` : "目标模式：关";
		},
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleGoalModeCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "guided-goal",
		icon: "compass",
		description: "让 agent 在对话中采访你，然后配置目标模式",
		inlineHint: "[rough objective]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runWithDetachedModeDraft(command, runtime, () =>
				runtime.ctx.handleGuidedGoalCommand(command.args || undefined, runtime.input),
			);
		},
	},
	{
		name: "loop",
		icon: "loop",
		description:
			"切换循环模式。启用后，你发送的下一条提示会在每次让出（yield）后自动重新提交。Esc 取消当前迭代；再次输入 /loop 关闭。",
		inlineHint: "[count|duration] [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			if (!runtime.ctx.loopModeEnabled) return "循环：关";
			if (runtime.ctx.loopModePaused) return "循环：已暂停";
			if (runtime.ctx.loopLimit) return `循环：开（${describeLoopLimitRuntime(runtime.ctx.loopLimit)}）`;
			if (runtime.ctx.loopPrompt) return "循环：开（重复提示）";
			return "循环：开（等待下一条提示）";
		},
		handleTui: async (command, runtime) => {
			const prompt = await runtime.ctx.handleLoopCommand(command.args);
			runtime.ctx.editor.setText("");
			// Surface any inline prompt so the dispatcher returns it and the normal
			// submit flow runs the first loop iteration (recording it as the loop prompt).
			if (prompt) return { prompt };
		},
	},
	{
		name: "queue",
		icon: "inbox",
		description: "将消息排入队列，待 agent 让出后发送",
		inlineHint: "<message>",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleQueueCommand(command.args);
		},
	},
	{
		name: "model",
		aliases: ["models"],
		icon: "model",
		description: "切换本会话的模型",
		acpDescription: "显示当前模型选择",
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? `Model: ${model.provider}/${model.id}` : "模型：未选择";
		},
		handle: async (command, runtime) => {
			if (command.args) {
				const selector = command.args.trim();
				const resolved = resolveSessionModelSelector(selector, runtime.session, runtime.settings);
				const match = resolved.model;
				if (!match) {
					return usage(
						`未知模型：${selector}。请使用 ACP \`session/setModel\` 通过选择器选择，或用 /model 列出可用模型。`,
						runtime,
					);
				}
				try {
					await runtime.session.setModel(match);
					if (resolved.thinkingLevel !== undefined) runtime.session.setThinkingLevel(resolved.thinkingLevel);
					await runtime.output(`模型已设置为 ${match.provider}/${match.id}。`);
					await runtime.notifyTitleChanged?.();
					await runtime.notifyConfigChanged?.();
					return commandConsumed();
				} catch (err) {
					return usage(`设置模型失败：${errorMessage(err)}`, runtime);
				}
			}

			const model = runtime.session.model;
			await runtime.output(
				model ? `当前模型：${model.provider}/${model.id}` : "当前未选择模型。",
			);
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector();
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "switch",
		icon: "swap",
		description: "切换本会话的模型（同 alt+p）；支持模糊 id、provider/id、@role、:level",
		acpDescription: "仅为当前会话切换模型",
		acpInputHint: "[model]",
		inlineHint: "[model]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? `Model: ${model.provider}/${model.id}` : "模型：未选择";
		},
		handle: async (command, runtime) => {
			const selector = command.args.trim();
			if (!selector) {
				const model = runtime.session.model;
				await runtime.output(
					model ? `当前模型：${model.provider}/${model.id}` : "当前未选择模型。",
				);
				return commandConsumed();
			}
			const resolved = resolveSessionModelSelector(selector, runtime.session, runtime.settings);
			if (!resolved.model) return usage(`未知模型：${selector}`, runtime);
			try {
				await runtime.session.setModelTemporary(resolved.model, resolved.thinkingLevel);
				await runtime.output(`仅本会话生效的模型：${formatModelString(resolved.model)}。`);
				await runtime.notifyTitleChanged?.();
				await runtime.notifyConfigChanged?.();
				return commandConsumed();
			} catch (err) {
				return usage(`切换模型失败：${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			runtime.ctx.editor.setText("");
			const selector = command.args.trim();
			if (!selector) {
				runtime.ctx.showModelSelector({ temporaryOnly: true });
				return;
			}
			const resolved = resolveSessionModelSelector(selector, runtime.ctx.session, runtime.ctx.settings);
			if (!resolved.model) {
				runtime.ctx.showError(`未知模型：${selector}`);
				return;
			}
			if (resolved.warning) runtime.ctx.showStatus(resolved.warning);
			await runtime.ctx.switchSessionModel(resolved.model, resolved.thinkingLevel);
		},
	},
	{
		name: "fast",
		icon: "fast",
		description: "切换优先服务层级（OpenAI service_tier=priority，Anthropic speed=fast）",
		acpDescription: "切换快速模式",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "启用快速模式" },
			{ name: "off", description: "禁用快速模式" },
			{ name: "status", description: "显示快速模式状态" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => `快速模式：${formatFastModeStatus(runtime.ctx.session)}`,
		handle: async (command, runtime) => {
			const arg = command.args.toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.session.toggleFastMode();
				await runtime.output(`快速模式已${enabled ? "启用" : "禁用"}。`);
				return commandConsumed();
			}
			if (arg === "on") {
				const supported = runtime.session.setFastMode(true);
				await runtime.output(supported ? "快速模式已启用。" : "当前模型不支持快速模式。");
				return commandConsumed();
			}
			if (arg === "off") {
				runtime.session.setFastMode(false);
				await runtime.output("快速模式已禁用。");
				return commandConsumed();
			}
			if (arg === "status") {
				await runtime.output(`快速模式当前为 ${formatFastModeStatus(runtime.session)}。`);
				return commandConsumed();
			}
			return usage("用法：/fast [on|off|status]", runtime);
		},
		handleTui: (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (!arg || arg === "toggle") {
				const enabled = runtime.ctx.session.toggleFastMode();
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(`快速模式已${enabled ? "启用" : "禁用"}。`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "on") {
				const supported = runtime.ctx.session.setFastMode(true);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus(supported ? "快速模式已启用。" : "当前模型不支持快速模式。");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "off") {
				runtime.ctx.session.setFastMode(false);
				refreshStatusLine(runtime.ctx);
				runtime.ctx.showStatus("快速模式已禁用。");
				runtime.ctx.editor.setText("");
				return;
			}
			if (arg === "status") {
				runtime.ctx.showStatus(`快速模式当前为 ${formatFastModeStatus(runtime.ctx.session)}。`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("用法：/fast [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "skillful",
		icon: "compass",
		description: "切换是否在系统提示中列出可用技能（仅本会话）",
		acpDescription: "切换技能列表",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "在本会话提示中列出技能" },
			{ name: "off", description: "在本会话中省略技能列表" },
			{ name: "status", description: "显示技能列表状态" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`技能列表：${runtime.ctx.session.settings.get("skillful") ? "开" : "关"}`,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(
					`技能列表：${runtime.session.settings.get("skillful") ? "开" : "关"}（会话级覆盖；默认取 skillful 设置）。`,
				);
				return commandConsumed();
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enabled =
					arg === "on"
						? await runtime.session.setSkillful(true)
						: arg === "off"
							? await runtime.session.setSkillful(false)
							: await runtime.session.toggleSkillful();
				await runtime.output(`本会话技能列表已${enabled ? "启用" : "禁用"}。`);
				return commandConsumed();
			}
			return usage("用法：/skillful [on|off|status]", runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(`技能列表：${runtime.ctx.session.settings.get("skillful") ? "开" : "关"}`);
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enabled =
					arg === "on"
						? await runtime.ctx.session.setSkillful(true)
						: arg === "off"
							? await runtime.ctx.session.setSkillful(false)
							: await runtime.ctx.session.toggleSkillful();
				runtime.ctx.showStatus(`本会话技能列表已${enabled ? "启用" : "禁用"}。`);
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("用法：/skillful [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "extended-context",
		icon: "expand",
		description: "切换加购的长上下文窗口",
		acpDescription: "切换扩展上下文",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "启用加购长上下文窗口" },
			{ name: "off", description: "使用标准定价的上下文窗口" },
			{ name: "status", description: "显示扩展上下文状态" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`扩展上下文：${formatExtendedContextStatus(runtime.ctx.settings)}`,
		handle: async (command, runtime) => {
			const output = applyExtendedContextCommand(runtime.settings, command.args);
			if (!output) return usage("用法：/extended-context [on|off|status]", runtime);
			await runtime.output(output);
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			const output = applyExtendedContextCommand(runtime.ctx.settings, command.args);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.showStatus(output ?? "用法：/extended-context [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "computer",
		icon: "computer",
		description: "切换本会话的原生计算机操作 eval 预加载",
		acpDescription: "切换计算机操作",
		acpInputHint: "[on|off|status]",
		subcommands: [
			{ name: "on", description: "本会话启用计算机操作" },
			{ name: "off", description: "本会话禁用计算机操作" },
			{ name: "status", description: "显示计算机操作状态" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			`计算机操作：${runtime.ctx.session.settings.get("computer.enabled") ? "开" : "关"}`,
		handle: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				await runtime.output(formatComputerUseStatus(runtime.session));
				return commandConsumed();
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable = arg === "off" ? false : arg === "on" || !runtime.session.settings.get("computer.enabled");
				await runtime.output(await applyComputerUseToggle(runtime.session, enable));
				return commandConsumed();
			}
			return usage("用法：/computer [on|off|status]", runtime);
		},
		handleTui: async (command, runtime) => {
			const arg = command.args.trim().toLowerCase();
			if (arg === "status") {
				runtime.ctx.showStatus(formatComputerUseStatus(runtime.ctx.session));
				runtime.ctx.editor.setText("");
				return;
			}
			if (!arg || arg === "toggle" || arg === "on" || arg === "off") {
				const enable =
					arg === "off" ? false : arg === "on" || !runtime.ctx.session.settings.get("computer.enabled");
				runtime.ctx.showStatus(await applyComputerUseToggle(runtime.ctx.session, enable));
				runtime.ctx.editor.setText("");
				return;
			}
			runtime.ctx.showStatus("用法：/computer [on|off|status]");
			runtime.ctx.editor.setText("");
		},
	},
	{
		name: "prewalk",
		icon: "prewalk",
		description: "在下一个操作切换到快速/廉价模型（无需 --prewalk 也可使用）",
		acpDescription: "在下一个操作执行 Prewalk",
		handle: async (_command, runtime) => {
			const rolePattern = expandRoleAlias("@smol", runtime.settings);
			const resolved = resolveCliModel({
				cliModel: rolePattern,
				modelRegistry: runtime.session.modelRegistry,
				preferences: getModelMatchPreferences(runtime.settings),
			});
			if (resolved.error || !resolved.model) {
				return usage(resolved.error ?? `未找到模型 "${rolePattern}"`, runtime);
			}
			if (!runtime.session.modelRegistry.hasConfiguredAuth(resolved.model)) {
				return usage(`${resolved.model.provider}/${resolved.model.id} 缺少 API 密钥`, runtime);
			}
			const armed = runtime.session.armPrewalk(resolved.model, resolved.thinkingLevel);
			if (armed) {
				await runtime.output(
					`Prewalk 已开启：将在下一次编辑/写入时切换到 ${resolved.model.provider}/${resolved.model.id}（受 todo 门控）。`,
				);
			}
			return commandConsumed();
		},
	},
];
