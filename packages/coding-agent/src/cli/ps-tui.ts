/**
 * Interactive alt-screen monitor for `omp ps` (btop idiom): a live process
 * table over every selected broker scope with in-place actions.
 *
 * Keys — table: `↑/↓`/`j/k` select, `enter`/`i` info, `l` logs, `s` stop,
 * `x` kill, `r` restart, `a` toggle all scopes, `q`/`esc`/`ctrl+c` quit.
 * Sub-views (info, logs): `esc`/`q` back.
 */
import { type Component, matchesKey, ProcessTerminal, TUI, truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatDuration } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { closeDaemonClients, type DaemonBrokerClient } from "../launch/client";
import type { DaemonSnapshot, DaemonSpec } from "../launch/protocol";
import {
	collapseCommand,
	collectReports,
	daemonLabel,
	formatCommand,
	KILL_GRACE_MS,
	type PsDaemonRow,
	type PsScope,
	type PsScopeReport,
	type PsTarget,
	scopeClient,
	scopeHeader,
	TABLE_HEADER,
	TERMINAL_STATES,
	tableCells,
} from "./ps-data";

const REFRESH_MS = 2_000;
const LOGS_POLL_MS = 1_000;
const STATUS_TTL_MS = 5_000;

interface FlatRow {
	scope: PsScope;
	row: PsDaemonRow;
}

type PsTopView = "table" | "info" | "logs";

/** Options accepted by the interactive monitor: scope selection from the list flags. */
export interface PsTopOptions extends PsTarget {
	all: boolean;
}

class PsTopComponent implements Component {
	readonly #ui: TUI;
	readonly #target: PsTarget;
	readonly #done = Promise.withResolvers<void>();
	readonly #clients = new Map<string, DaemonBrokerClient>();
	#all: boolean;
	#reports: PsScopeReport[] = [];
	#flat: FlatRow[] = [];
	#selected = 0;
	/** `runtimeDir\u0000name` of the selection, kept stable across refreshes. */
	#selectedKey: string | undefined;
	#scrollTop = 0;
	#view: PsTopView = "table";
	#info: { daemon: DaemonSnapshot; spec: DaemonSpec } | undefined;
	#logsLines: string[] = [];
	#logsState = "";
	#logsTimer: NodeJS.Timeout | undefined;
	#refreshTimer: NodeJS.Timeout | undefined;
	#refreshing = false;
	#lastRefresh = 0;
	#status = "";
	#statusAt = 0;
	#disposed = false;

	constructor(ui: TUI, options: PsTopOptions) {
		this.#ui = ui;
		this.#all = options.all;
		this.#target = { dir: options.dir, global: options.global };
	}

	run(): Promise<void> {
		void this.#refresh();
		this.#refreshTimer = setInterval(() => void this.#refresh(), REFRESH_MS);
		return this.#done.promise;
	}

	dispose(): void {
		this.#disposed = true;
		clearInterval(this.#refreshTimer);
		this.#stopLogsPoll();
		for (const client of this.#clients.values()) client.close();
		this.#clients.clear();
	}

	// -- data ----------------------------------------------------------------

	async #refresh(): Promise<void> {
		if (this.#refreshing || this.#disposed) return;
		this.#refreshing = true;
		try {
			const reports = await collectReports(this.#all, this.#target);
			if (this.#disposed) return;
			this.#reports = reports;
			this.#flat = reports.flatMap(report => report.daemons.map(row => ({ scope: report.scope, row })));
			this.#lastRefresh = Date.now();
			this.#restoreSelection();
			this.#ui.requestRender();
		} catch (error) {
			this.#setStatus(chalk.red(error instanceof Error ? error.message : String(error)));
		} finally {
			this.#refreshing = false;
		}
	}

	#restoreSelection(): void {
		if (this.#selectedKey !== undefined) {
			const index = this.#flat.findIndex(entry => flatKey(entry) === this.#selectedKey);
			if (index >= 0) {
				this.#selected = index;
				return;
			}
		}
		this.#selected = Math.max(0, Math.min(this.#selected, this.#flat.length - 1));
		this.#selectedKey = this.#flat[this.#selected] ? flatKey(this.#flat[this.#selected]) : undefined;
	}

	#client(scope: PsScope): Promise<DaemonBrokerClient | undefined> {
		const cached = this.#clients.get(scope.runtimeDir);
		if (cached) return Promise.resolve(cached);
		return scopeClient(scope).then(client => {
			if (!client) return undefined;
			if (this.#disposed) {
				client.close();
				return undefined;
			}
			this.#clients.set(scope.runtimeDir, client);
			return client;
		});
	}

	#setStatus(text: string): void {
		this.#status = text;
		this.#statusAt = Date.now();
		this.#ui.requestRender();
	}

	// -- actions ---------------------------------------------------------------

	async #act(verb: "stop" | "kill" | "restart"): Promise<void> {
		const entry = this.#flat[this.#selected];
		if (!entry) return;
		const name = entry.row.snapshot.name;
		const verbLabel = verb === "restart" ? "重启" : verb === "kill" ? "强杀" : "停止";
		this.#setStatus(chalk.yellow(`${verbLabel} ${name}…`));
		try {
			const client = await this.#client(entry.scope);
			if (!client) throw new Error("该作用域无法从本机访问");
			const result = await client.request(
				verb === "restart"
					? { op: "restart", name }
					: { op: "stop", name, timeoutMs: verb === "kill" ? KILL_GRACE_MS : 5_000 },
			);
			if (result.op !== "restart" && result.op !== "stop") throw new Error(`意外的响应 ${result.op}`);
			this.#setStatus(
				chalk.green(
					`已${verb === "restart" ? "重启" : verb === "kill" ? "强杀" : "停止"} ${daemonLabel(result.daemon)}`,
				),
			);
			void this.#refresh();
		} catch (error) {
			this.#setStatus(
				chalk.red(`${verbLabel} ${name} 失败: ${error instanceof Error ? error.message : String(error)}`),
			);
		}
	}

	async #openInfo(): Promise<void> {
		const entry = this.#flat[this.#selected];
		if (!entry) return;
		try {
			const client = await this.#client(entry.scope);
			if (!client) throw new Error("该作用域无法从本机访问");
			const result = await client.request({ op: "describe", name: entry.row.snapshot.name });
			if (result.op !== "describe") throw new Error(`意外的响应 ${result.op}`);
			this.#info = { daemon: result.daemon, spec: result.spec };
			this.#view = "info";
			this.#ui.requestRender();
		} catch (error) {
			this.#setStatus(chalk.red(error instanceof Error ? error.message : String(error)));
		}
	}

	#openLogs(): void {
		const entry = this.#flat[this.#selected];
		if (!entry) return;
		this.#view = "logs";
		this.#logsLines = [];
		this.#logsState = "";
		const poll = async (): Promise<void> => {
			const current = this.#flat[this.#selected];
			if (this.#disposed || this.#view !== "logs" || !current) return;
			try {
				const client = await this.#client(current.scope);
				if (!client) throw new Error("该作用域无法从本机访问");
				const result = await client.request({
					op: "logs",
					name: current.row.snapshot.name,
					lines: Math.max(10, this.#ui.terminal.rows - 4),
					head: false,
					follow: false,
					renderTerminalRows: true,
					timeoutMs: 10_000,
				});
				if (result.op !== "logs") throw new Error(`意外的响应 ${result.op}`);
				this.#logsLines = result.terminalRows ?? result.text.replace(/\n$/, "").split("\n");
				this.#logsState = result.state;
				this.#ui.requestRender();
			} catch (error) {
				this.#logsLines = [chalk.red(error instanceof Error ? error.message : String(error))];
				this.#ui.requestRender();
			}
		};
		void poll();
		this.#logsTimer = setInterval(() => void poll(), LOGS_POLL_MS);
	}

	#stopLogsPoll(): void {
		clearInterval(this.#logsTimer);
		this.#logsTimer = undefined;
	}

	#closeView(): void {
		this.#stopLogsPoll();
		this.#view = "table";
		this.#info = undefined;
		this.#ui.requestRender();
	}

	// -- input -----------------------------------------------------------------

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.#done.resolve();
			return;
		}
		if (this.#view !== "table") {
			if (matchesKey(data, "escape") || data === "q") this.#closeView();
			return;
		}
		if (matchesKey(data, "escape") || data === "q") {
			this.#done.resolve();
			return;
		}
		if (matchesKey(data, "up") || data === "k") this.#moveSelection(-1);
		else if (matchesKey(data, "down") || data === "j") this.#moveSelection(1);
		else if (data === "a") {
			this.#all = !this.#all;
			this.#setStatus(chalk.dim(this.#all ? "正在显示所有作用域" : "正在显示当前作用域"));
			void this.#refresh();
		} else if (matchesKey(data, "enter") || data === "i") void this.#openInfo();
		else if (data === "l") this.#openLogs();
		else if (data === "s") void this.#act("stop");
		else if (data === "x") void this.#act("kill");
		else if (data === "r") void this.#act("restart");
	}

	#moveSelection(delta: number): void {
		if (this.#flat.length === 0) return;
		this.#selected = Math.max(0, Math.min(this.#flat.length - 1, this.#selected + delta));
		this.#selectedKey = flatKey(this.#flat[this.#selected]);
		this.#ui.requestRender();
	}

	// -- render ------------------------------------------------------------

	render(width: number): readonly string[] {
		const height = Math.max(6, this.#ui.terminal.rows);
		switch (this.#view) {
			case "info":
				return this.#renderInfo(width, height);
			case "logs":
				return this.#renderLogs(width, height);
			default:
				return this.#renderTable(width, height);
		}
	}

	#header(width: number, title: string): string {
		const age = this.#lastRefresh ? `${formatDuration(Date.now() - this.#lastRefresh)} 前更新` : "更新中…";
		const left = ` ${chalk.bold("omp ps")} ${chalk.dim("·")} ${title}`;
		const right = chalk.dim(age);
		const pad = Math.max(1, width - Bun.stringWidth(left) - Bun.stringWidth(right) - 1);
		return truncateToWidth(`${left}${" ".repeat(pad)}${right}`, width);
	}

	#footer(width: number, hints: string): string[] {
		const status = Date.now() - this.#statusAt < STATUS_TTL_MS ? this.#status : "";
		return [truncateToWidth(` ${status}`, width), truncateToWidth(chalk.dim(` ${hints}`), width)];
	}

	#renderTable(width: number, height: number): string[] {
		const scopesLabel = `${this.#reports.length} 个作用域内共 ${this.#flat.length} 个进程 ${chalk.dim(this.#all ? "(全部)" : "(当前)")}`;
		const header = this.#header(width, scopesLabel);
		const footer = this.#footer(
			width,
			"↑/↓ 选择 · enter 信息 · l 日志 · s 停止 · x 强杀 · r 重启 · a 全部作用域 · q 退出",
		);
		const bodyHeight = height - 1 - footer.length;

		const cells = this.#flat.map(entry => tableCells(entry.row));
		const widths = TABLE_HEADER.map((title, column) =>
			Math.max(title.length, ...cells.map(row => Bun.stringWidth(row[column]))),
		);
		const renderRow = (row: string[]): string =>
			`   ${row.map((cell, column) => cell + " ".repeat(Math.max(0, widths[column] - Bun.stringWidth(cell)))).join("  ")}`.trimEnd();

		// Body lines with the flat index carried for selection highlighting.
		const body: { text: string; flat?: number }[] = [];
		let flatIndex = 0;
		for (const report of this.#reports) {
			body.push({ text: ` ${scopeHeader(report.scope)}` });
			if (report.daemons.length === 0) {
				body.push({ text: chalk.dim("   无进程") });
			} else {
				body.push({ text: chalk.dim(renderRow([...TABLE_HEADER])) });
				for (const row of report.daemons) {
					const line = renderRow(tableCells(row));
					body.push({
						text: TERMINAL_STATES[row.snapshot.state] ? chalk.dim(line) : line,
						flat: flatIndex,
					});
					flatIndex++;
				}
			}
			body.push({ text: "" });
		}
		if (body.length === 0) body.push({ text: chalk.dim(" 未找到守护进程代理作用域。") });

		// Keep the selected line inside the viewport.
		const selectedLine = body.findIndex(line => line.flat === this.#selected);
		if (selectedLine >= 0) {
			if (selectedLine < this.#scrollTop) this.#scrollTop = selectedLine;
			if (selectedLine >= this.#scrollTop + bodyHeight) this.#scrollTop = selectedLine - bodyHeight + 1;
		}
		this.#scrollTop = Math.max(0, Math.min(this.#scrollTop, Math.max(0, body.length - bodyHeight)));

		const lines = [header];
		for (const entry of body.slice(this.#scrollTop, this.#scrollTop + bodyHeight)) {
			if (entry.flat === this.#selected) {
				const plain = ` ❯${Bun.stripANSI(entry.text).slice(2)}`;
				lines.push(truncateToWidth(chalk.inverse(plain.padEnd(width)), width));
			} else {
				lines.push(truncateToWidth(entry.text, width));
			}
		}
		while (lines.length < height - footer.length) lines.push("");
		lines.push(...footer);
		return lines;
	}

	#renderInfo(width: number, height: number): string[] {
		const info = this.#info;
		const header = this.#header(width, "进程信息");
		const footer = this.#footer(width, "esc 返回 · q 返回");
		const lines = [header, ""];
		if (info) {
			const daemon = info.daemon;
			lines.push(` ${chalk.bold(daemonLabel(daemon))}`);
			lines.push("");
			lines.push(`   命令:     ${collapseCommand(formatCommand(info.spec))}`);
			lines.push(`   工作目录: ${info.spec.cwd}`);
			if (!TERMINAL_STATES[daemon.state])
				lines.push(`   运行时长: ${formatDuration(Date.now() - daemon.startedAt)}`);
			if (daemon.exitReason) lines.push(`   退出:     ${daemon.exitReason}`);
			lines.push(`   重启次数: ${daemon.restartCount} (策略: ${info.spec.restart})`);
			lines.push(`   pty: ${info.spec.pty}  持久化: ${info.spec.persist}  分离: ${info.spec.detached}`);
			lines.push(`   所有者:   ${daemon.owner ?? "-"}`);
		} else {
			lines.push(chalk.dim(" 加载中…"));
		}
		const truncated = lines.map(line => truncateToWidth(line, width));
		while (truncated.length < height - footer.length) truncated.push("");
		truncated.push(...footer);
		return truncated;
	}

	#renderLogs(width: number, height: number): string[] {
		const entry = this.#flat[this.#selected];
		const name = entry?.row.snapshot.name ?? "?";
		const header = this.#header(
			width,
			`日志 ${chalk.bold(name)}${this.#logsState ? chalk.dim(` · ${this.#logsState}`) : ""}`,
		);
		const footer = this.#footer(width, "esc 返回 · q 返回 · 视图实时刷新");
		const bodyHeight = height - 1 - footer.length;
		const tail = this.#logsLines.slice(-bodyHeight);
		const lines = [header, ...tail.map(line => truncateToWidth(` ${line}`, width))];
		while (lines.length < height - footer.length) lines.push("");
		lines.push(...footer);
		return lines;
	}
}

function flatKey(entry: FlatRow): string {
	return `${entry.scope.runtimeDir}\u0000${entry.row.snapshot.name}`;
}

/** Run the fullscreen interactive process monitor until the user quits. */
export async function runPsTop(options: PsTopOptions): Promise<void> {
	const ui = new TUI(new ProcessTerminal());
	const component = new PsTopComponent(ui, options);
	const overlay = ui.showOverlay(component, {
		anchor: "top-left",
		width: "100%",
		maxHeight: "100%",
		margin: 0,
		fullscreen: true,
		mouseTracking: false,
	});
	ui.setFocus(component);
	ui.start();
	try {
		await component.run();
	} finally {
		component.dispose();
		overlay.hide();
		ui.stop();
		await closeDaemonClients();
	}
}
