/**
 * CLI handler for `omp ps` — inspect and control processes supervised by the
 * daemon broker from outside the harness.
 *
 * A bare `omp ps` on a TTY opens the interactive alt-screen monitor
 * (`ps-tui.ts`); `--plain`, `--json`, and non-TTY outputs use the static
 * listing. Actions (`stop`, `kill`, `restart`, `logs`, `info`) connect through
 * the regular client, which revives a dead broker so it can re-adopt detached
 * daemons before acting on them.
 */

import { truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import {
	closeDaemonClients,
	type DaemonBrokerClient,
	daemonClientForGlobal,
	daemonClientForProject,
} from "../launch/client";
import type { DaemonSnapshot } from "../launch/protocol";
import {
	collectReports,
	daemonLabel,
	formatCommand,
	KILL_GRACE_MS,
	type PsDaemonRow,
	scopeHeader,
	TABLE_HEADER,
	TERMINAL_STATES,
	tableCells,
} from "./ps-data";
import { runPsTop } from "./ps-tui";

export type PsAction = "list" | "info" | "logs" | "stop" | "kill" | "restart";

export interface PsCommandArgs {
	action: PsAction;
	/** Daemon name; required for every action except `list`. */
	name?: string;
	flags: {
		/** list: include every project and global service scope on this machine. */
		all: boolean;
		json: boolean;
		/** list: force the static listing instead of the interactive monitor. */
		plain: boolean;
		/** Target another project directory instead of the current one. */
		dir?: string;
		/** Target a machine-global service scope (e.g. browser-relay). */
		global?: string;
		/** logs: keep streaming new output. */
		follow: boolean;
		/** logs: read from the beginning instead of the tail. */
		head: boolean;
		/** logs: number of lines. */
		lines?: number;
		/** logs: regex filter. */
		grep?: string;
		/** stop: grace period in seconds before hard kill. */
		timeout?: number;
	};
}

export async function runPsCommand(cmd: PsCommandArgs): Promise<void> {
	try {
		if (cmd.action === "list") {
			const interactive =
				!cmd.flags.json && !cmd.flags.plain && process.stdout.isTTY === true && process.stdin.isTTY === true;
			if (interactive) await runPsTop(cmd.flags);
			else await runList(cmd);
			return;
		}
		if (!cmd.name) {
			console.error(chalk.red(`${cmd.action} 需要一个进程名。运行 \`omp ps\` 可列出进程。`));
			process.exitCode = 1;
			return;
		}
		await runAction(cmd, cmd.name);
	} finally {
		await closeDaemonClients();
	}
}

// ---------------------------------------------------------------------------
// Static list
// ---------------------------------------------------------------------------

async function runList(cmd: PsCommandArgs): Promise<void> {
	const reports = await collectReports(cmd.flags.all, cmd.flags);
	if (cmd.flags.json) {
		console.log(
			JSON.stringify(
				reports.map(({ scope, daemons }) => ({
					kind: scope.kind,
					projectDir: scope.projectDir,
					service: scope.service,
					runtimeDir: scope.runtimeDir,
					brokerPid: scope.brokerPid,
					daemons: daemons.map(row => ({
						...row.snapshot,
						command: row.command,
						cwd: row.cwd,
						supervised: row.supervised,
					})),
				})),
				null,
				2,
			),
		);
		return;
	}
	if (reports.length === 0) {
		console.log(chalk.dim("未找到守护进程代理作用域。"));
		return;
	}
	let first = true;
	for (const report of reports) {
		if (!first) console.log("");
		first = false;
		console.log(scopeHeader(report.scope));
		if (report.daemons.length === 0) {
			console.log(chalk.dim("  没有进程"));
			continue;
		}
		printTable(report.daemons);
	}
	if (!cmd.flags.all) {
		console.log(chalk.dim("\n使用 --all 可包含其他项目和全局服务。"));
	}
}

function printTable(rows: PsDaemonRow[]): void {
	// Truncate to the terminal on a TTY; keep full lines when piped.
	const maxWidth = process.stdout.isTTY ? (process.stdout.columns ?? 120) : Number.POSITIVE_INFINITY;
	const cells = rows.map(tableCells);
	const widths = TABLE_HEADER.map((title, column) =>
		Math.max(title.length, ...cells.map(row => Bun.stringWidth(row[column]))),
	);
	const render = (row: string[]): string => {
		const line =
			`  ${row.map((cell, column) => cell + " ".repeat(Math.max(0, widths[column] - Bun.stringWidth(cell)))).join("  ")}`.trimEnd();
		return Number.isFinite(maxWidth) ? truncateToWidth(line, maxWidth) : line;
	};
	console.log(chalk.dim(render([...TABLE_HEADER])));
	for (const [index, row] of cells.entries()) {
		const line = render(row);
		console.log(TERMINAL_STATES[rows[index].snapshot.state] ? chalk.dim(line) : line);
	}
}

// ---------------------------------------------------------------------------
// Named actions
// ---------------------------------------------------------------------------

async function actionClient(flags: PsCommandArgs["flags"]): Promise<DaemonBrokerClient> {
	if (flags.global) return daemonClientForGlobal(flags.global);
	return daemonClientForProject(flags.dir ?? getProjectDir());
}

async function runAction(cmd: PsCommandArgs, name: string): Promise<void> {
	const client = await actionClient(cmd.flags);
	try {
		switch (cmd.action) {
			case "info": {
				const result = await client.request({ op: "describe", name });
				if (result.op !== "describe") throw new Error(`代理返回了意外的响应 ${result.op}`);
				if (cmd.flags.json) {
					console.log(JSON.stringify({ ...result.daemon, spec: result.spec }, null, 2));
					return;
				}
				const daemon = result.daemon;
				console.log(daemonLabel(daemon));
				console.log(`  命令:  ${formatCommand(result.spec)}`);
				console.log(`  工作目录:      ${result.spec.cwd}`);
				if (!TERMINAL_STATES[daemon.state])
					console.log(`  运行时长:   ${formatDuration(Date.now() - daemon.startedAt)}`);
				if (daemon.exitReason) console.log(`  退出:     ${daemon.exitReason}`);
				console.log(`  重启次数: ${daemon.restartCount} (策略: ${result.spec.restart})`);
				console.log(
					`  pty: ${result.spec.pty}  持久化: ${result.spec.persist}  已分离: ${result.spec.detached}  所有者: ${daemon.owner ?? "-"}`,
				);
				return;
			}
			case "logs":
				await runLogs(cmd, client, name);
				return;
			case "stop":
			case "kill": {
				const timeoutMs = cmd.action === "kill" ? KILL_GRACE_MS : Math.round((cmd.flags.timeout ?? 5) * 1000);
				const result = await client.request({ op: "stop", name, timeoutMs });
				if (result.op !== "stop") throw new Error(`代理返回了意外的响应 ${result.op}`);
				printDaemonResult(cmd, cmd.action === "kill" ? "已终止" : "已停止", result.daemon);
				return;
			}
			case "restart": {
				const result = await client.request({ op: "restart", name });
				if (result.op !== "restart") throw new Error(`代理返回了意外的响应 ${result.op}`);
				printDaemonResult(cmd, "已重启", result.daemon);
				return;
			}
			default:
				throw new Error(`未处理的操作 ${cmd.action}`);
		}
	} catch (error) {
		console.error(chalk.red(error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}

function printDaemonResult(cmd: PsCommandArgs, verb: string, daemon: DaemonSnapshot): void {
	if (cmd.flags.json) console.log(JSON.stringify(daemon, null, 2));
	else console.log(`${verb} ${daemonLabel(daemon)}`);
}

async function runLogs(cmd: PsCommandArgs, client: DaemonBrokerClient, name: string): Promise<void> {
	const lines = Math.max(1, Math.min(1_000, Math.floor(cmd.flags.lines ?? 100)));
	// Follow mode reads the full 1000-line window on every request so overlap
	// trimming sees a stable, sliding tail; the initial print is cut to `lines`.
	const first = await client.request({
		op: "logs",
		name,
		lines: cmd.flags.follow ? 1_000 : lines,
		head: cmd.flags.head,
		grep: cmd.flags.grep,
		follow: false,
		renderTerminalRows: !cmd.flags.follow,
		timeoutMs: 30_000,
	});
	if (first.op !== "logs") throw new Error(`代理返回了意外的响应 ${first.op}`);
	if (!cmd.flags.follow) {
		const text = first.terminalRows !== undefined ? first.terminalRows.join("\n") : first.text.replace(/\n$/, "");
		if (text) console.log(text);
		console.log(chalk.dim(`[${name}: ${first.state}]`));
		return;
	}
	const initial = first.text.replace(/\n$/, "").split("\n").slice(-lines).join("\n");
	if (initial) process.stdout.write(`${initial}\n`);
	let previous = first.text;
	let cursor = first.cursor;
	let state = first.state;
	while (!TERMINAL_STATES[state]) {
		const next = await client.request({
			op: "logs",
			name,
			lines: 1_000,
			head: false,
			grep: cmd.flags.grep,
			follow: true,
			cursor,
			renderTerminalRows: false,
			timeoutMs: 30_000,
		});
		if (next.op !== "logs") throw new Error(`代理返回了意外的响应 ${next.op}`);
		// The broker always returns the tail window (cursor is only a wait
		// watermark), so trim the part we already printed.
		const fresh = next.text.slice(overlapLength(previous, next.text));
		if (fresh) process.stdout.write(fresh.endsWith("\n") ? fresh : `${fresh}\n`);
		previous = next.text;
		cursor = next.cursor;
		state = next.state;
	}
	console.log(chalk.dim(`[${name}: ${state}]`));
}

/** Longest suffix of `previous` that is a prefix of `next` — the already-printed portion of a tail window. */
function overlapLength(previous: string, next: string): number {
	for (let k = Math.min(previous.length, next.length); k > 0; k--) {
		const offset = previous.length - k;
		let match = true;
		for (let i = 0; i < k; i++) {
			if (previous.charCodeAt(offset + i) !== next.charCodeAt(i)) {
				match = false;
				break;
			}
		}
		if (match) return k;
	}
	return 0;
}
