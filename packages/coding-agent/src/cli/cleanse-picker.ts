/**
 * Standalone TUI pickers for `omp cleanse`.
 *
 * Mirrors {@link ./setup-model-picker.ts}: one-shot {@link TUI} instances over a
 * {@link SelectList} or {@link Input}, resolved on select/submit/cancel and torn
 * down immediately so the command can keep writing plain stdout afterwards.
 */
import { Input, ProcessTerminal, type SelectItem, SelectList, TUI } from "@oh-my-pi/pi-tui";
import type { CleanseCheckerDescriptor } from "../cleanse/checkers";
import type { CleanseTargetChoice } from "../cleanse/types";
import { getSelectListTheme } from "../modes/theme/theme";

/** Pick between running every discovered checker, one specific checker, or a free-form request. */
export async function pickCleanseTarget(checkers: readonly CleanseCheckerDescriptor[]): Promise<CleanseTargetChoice> {
	const items: SelectItem[] = [
		{
			value: "all",
			label: `运行全部 ${checkers.length} 个已发现的检测器`,
		},
		...checkers.map(checker => ({
			value: `checker:${checker.id}`,
			label: checker.label,
			description: `${checker.language} — ${checker.command}`,
		})),
		{
			value: "request",
			label: "描述要修复的问题…",
			description: "由探测代理推断要运行的命令",
		},
	];
	const selection = await selectOne("选择要清理的内容：", items);
	if (selection === null) return { kind: "cancel" };
	if (selection === "all") return { kind: "all" };
	if (selection === "request") {
		const request = await promptCleanseRequest();
		return request === null ? { kind: "cancel" } : { kind: "request", request };
	}
	return { kind: "checker", id: selection.slice("checker:".length) };
}

/** One-shot text prompt for a free-form cleanse request; `null` when cancelled or left empty. */
export async function promptCleanseRequest(): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	const ui = new TUI(new ProcessTerminal());
	let resolved = false;
	const finish = (value: string | null): void => {
		if (resolved) return;
		resolved = true;
		ui.stop();
		resolve(value);
	};
	const input = new Input();
	input.onSubmit = value => finish(value.trim() || null);
	input.onEscape = () => finish(null);
	process.stdout.write('描述要检测并修复的内容（例如 "ts errors"）：\n');
	ui.addChild(input);
	ui.setFocus(input);
	ui.start();
	return promise;
}

async function selectOne(title: string, items: SelectItem[]): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	const ui = new TUI(new ProcessTerminal());
	let resolved = false;
	const finish = (value: string | null): void => {
		if (resolved) return;
		resolved = true;
		ui.stop();
		resolve(value);
	};
	const list = new SelectList(items, Math.min(items.length, 12), getSelectListTheme());
	list.onSelect = item => finish(item.value);
	list.onCancel = () => finish(null);
	process.stdout.write(`${title}\n`);
	ui.addChild(list);
	ui.setFocus(list);
	ui.start();
	return promise;
}
