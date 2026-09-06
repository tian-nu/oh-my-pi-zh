/**
 * Stats CLI command handlers.
 *
 * Handles `omp stats` subcommand for viewing AI usage statistics.
 */

import { truncateToWidth } from "@oh-my-pi/pi-tui/utils";
import { formatDuration, formatNumber, formatPercent } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { openPath } from "../utils/open";

/**
 * Single-line TTY progress bar. On a non-TTY stream we just stay quiet -
 * the final "Synced ..." summary still prints either way.
 */
function createSyncProgressReporter(): {
	onProgress: (event: { current: number; total: number; sessionFile: string }) => void;
	finish: () => void;
} {
	const stream = process.stderr;
	const isTty = stream.isTTY === true;
	let lastWidth = 0;
	let lastRender = 0;
	return {
		onProgress(event) {
			if (!isTty) return;
			const now = Date.now();
			// Throttle to ~30 fps and always force a render for the last file.
			if (event.current < event.total && now - lastRender < 33) return;
			lastRender = now;
			const label = chalk.dim(shortenSessionFile(event.sessionFile));
			const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
			const counter = chalk.cyan(`[${event.current}/${event.total}]`);
			const line = `${counter} ${pct}%  ${label}`;
			const columns = stream.columns ?? 120;
			const trimmed = truncateToWidth(line, columns - 1);
			stream.write(`\r${trimmed.padEnd(lastWidth)}`);
			lastWidth = trimmed.length;
		},
		finish() {
			if (!isTty || lastWidth === 0) return;
			stream.write(`\r${" ".repeat(lastWidth)}\r`);
			lastWidth = 0;
		},
	};
}

function shortenSessionFile(p: string): string {
	const marker = "/sessions/";
	const idx = p.indexOf(marker);
	return idx >= 0 ? p.slice(idx + marker.length) : p;
}

// =============================================================================
// Types
// =============================================================================

export interface StatsCommandArgs {
	port: number;
	host: string;
	json: boolean;
	summary: boolean;
}

function formatCost(n: number): string {
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

function normalizePremiumRequests(n: number): number {
	return Math.round((n + Number.EPSILON) * 100) / 100;
}

// =============================================================================
// Command Handler
// =============================================================================

export async function runStatsCommand(cmd: StatsCommandArgs): Promise<void> {
	// Lazy import to avoid loading stats module when not needed
	const { closeDb, formatStatsDashboardUrl, getDashboardStats, getTotalMessageCount, startServer, syncAllSessions } =
		await import("@oh-my-pi/omp-stats");

	// Sync session files first
	const progress = createSyncProgressReporter();
	process.stderr.write("正在同步会话文件...\n");
	const { processed, files } = await syncAllSessions({ onProgress: progress.onProgress });
	progress.finish();
	const total = await getTotalMessageCount();
	console.log(`已同步 ${processed} 条新记录（来自 ${files} 个文件，共 ${total} 条）\n`);

	if (cmd.json) {
		const stats = await getDashboardStats();
		console.log(JSON.stringify(stats, null, 2));
		return;
	}

	if (cmd.summary) {
		await printStatsSummary();
		return;
	}

	// Start the dashboard server
	const { hostname, port } = await startServer(cmd.port, cmd.host);
	const url = formatStatsDashboardUrl(hostname, port);
	console.log(chalk.green(`仪表盘地址：${url}`));

	// Open browser
	openPath(url);

	console.log("按 Ctrl+C 停止\n");

	// Keep process running
	process.on("SIGINT", () => {
		console.log("\n正在关闭...");
		closeDb();
		process.exit(0);
	});

	// Keep the process alive
	await new Promise(() => {});
}

async function printStatsSummary(): Promise<void> {
	const { getDashboardStats } = await import("@oh-my-pi/omp-stats");
	const stats = await getDashboardStats();
	const { overall, byModel, byFolder } = stats;

	console.log(chalk.bold("\n=== AI 使用统计 ===\n"));

	console.log(chalk.bold("总体："));
	console.log(`  请求数：${formatNumber(overall.totalRequests)}（${formatNumber(overall.failedRequests)} 个错误）`);
	console.log(`  错误率：${formatPercent(overall.errorRate)}`);
	console.log(`  总 Token：${formatNumber(overall.totalInputTokens + overall.totalOutputTokens)}`);
	console.log(`  输入 Token：${formatNumber(overall.totalInputTokens)}`);
	console.log(`  输出 Token：${formatNumber(overall.totalOutputTokens)}`);
	console.log(`  缓存命中率：${formatPercent(overall.cacheRate)}`);
	console.log(`  缓存节省：${formatPercent(overall.cacheSavings)}`);
	console.log(`  总成本：${formatCost(overall.totalCost)}`);
	console.log(`  高级请求数：${formatNumber(normalizePremiumRequests(overall.totalPremiumRequests ?? 0))}`);
	console.log(`  平均耗时：${overall.avgDuration !== null ? formatDuration(overall.avgDuration) : "-"}`);
	console.log(`  平均 TTFT：${overall.avgTtft !== null ? formatDuration(overall.avgTtft) : "-"}`);
	if (overall.avgTokensPerSecond !== null) {
		console.log(`  平均 Token/秒：${overall.avgTokensPerSecond.toFixed(1)}`);
	}

	if (byModel.length > 0) {
		console.log(chalk.bold("\n按模型："));
		for (const m of byModel.slice(0, 10)) {
			console.log(
				`  ${m.model}: ${formatNumber(m.totalRequests)} 次请求, ${formatCost(m.totalCost)}, 缓存命中率 ${formatPercent(m.cacheRate)}, 缓存节省 ${formatPercent(m.cacheSavings)}`,
			);
		}
	}

	if (byFolder.length > 0) {
		console.log(chalk.bold("\n按目录："));
		for (const f of byFolder.slice(0, 10)) {
			console.log(`  ${f.folder}: ${formatNumber(f.totalRequests)} 次请求, ${formatCost(f.totalCost)}`);
		}
	}

	console.log("");
}
