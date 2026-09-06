import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog";
import { $which, type FetchImpl, getAgentDbPath, isEnoent } from "@oh-my-pi/pi-utils";
import {
	queryBlobBrokerDoctor,
	queryBlobBrokerProbe,
	queryBlobBrokerPurge,
	queryBlobBrokerStatus,
} from "../blob-broker/daemon";
import {
	type BlobDestinationId,
	type BlobDestinationMetadata,
	BUILTIN_BLOB_DESTINATIONS,
} from "../blob-broker/destinations";
import type {
	BlobBrokerDoctorRequest,
	BlobBrokerDoctorResponse,
	BlobBrokerProbeRequest,
	BlobBrokerProbeResponse,
	BlobBrokerPurgeRequest,
	BlobBrokerPurgeResponse,
	BlobBrokerStatus,
	BlobBrokerWorkerConfig,
} from "../blob-broker/protocol";
import {
	hashProviderFileCredential,
	ProviderFileCache,
	type ProviderFileCacheEntry,
	type ProviderFileCacheStatus,
	type ProviderFileClient,
	type ProviderFileProvider,
} from "../blob-broker/provider-file-types";
import { createAnthropicFileClient } from "../blob-broker/provider-files-anthropic";
import { createGeminiProviderFileClient } from "../blob-broker/provider-files-gemini";
import { createOpenAIFileClient } from "../blob-broker/provider-files-openai";
import {
	type BlobBrokerSavingsStatus,
	blobBrokerSavingsJournalPath,
	readBlobBrokerSavingsStatus,
} from "../blob-broker/savings";
import { providerFileCachePath, resolveBlobBrokerConfigs } from "../blob-broker/service";
import { createConfiguredUploader } from "../blob-broker/uploaders";
import { Settings } from "../config/settings";

export const IMAGES_ACTIONS = ["status", "doctor", "probe", "purge"] as const;
export type ImagesAction = (typeof IMAGES_ACTIONS)[number];

export interface ImagesCommandArgs {
	readonly action: ImagesAction;
	readonly flags: {
		readonly json?: boolean;
		readonly apply?: boolean;
		readonly all?: boolean;
		readonly dir?: string;
		/** Positive request timeout in seconds. */
		readonly timeout?: number;
	};
}

export interface ImagesResolvedConfig {
	readonly enabled: boolean;
	readonly orderedBackends: readonly BlobDestinationId[];
	readonly configs: readonly BlobBrokerWorkerConfig[];
	readonly providerFileCachePath: string;
	readonly savingsJournalPath: string;
}

export interface ImagesProviderFileSnapshot {
	readonly entries: readonly ProviderFileCacheEntry[];
	readonly lastError?: string;
}

export type ImagesDoctorSeverity = "ok" | "warn" | "error";

export interface ImagesDoctorCheck {
	readonly name: string;
	readonly severity: ImagesDoctorSeverity;
	readonly detail: string;
}

export interface ImagesCliDependencies {
	readonly loadSettings: (projectDir: string) => Promise<Settings>;
	readonly resolveConfig: (settings: Settings, projectDir: string) => ImagesResolvedConfig;
	readonly readSavings: (journalPath: string) => Promise<BlobBrokerSavingsStatus>;
	readonly readProviderFileSnapshot: (indexPath: string) => Promise<ImagesProviderFileSnapshot>;
	readonly loadProviderFileCache: (indexPath: string) => ProviderFileCache;
	readonly openAuthStorage: () => Promise<AuthStorage>;
	readonly createProviderFileClient: (
		provider: ProviderFileProvider,
		credential: string,
		fetchImpl: FetchImpl,
	) => ProviderFileClient | null;
	readonly queryStatus: (projectDir: string) => Promise<BlobBrokerStatus | null>;
	readonly queryDoctor: (
		projectDir: string,
		request?: BlobBrokerDoctorRequest,
	) => Promise<BlobBrokerDoctorResponse | null>;
	readonly queryProbe: (
		projectDir: string,
		config: BlobBrokerWorkerConfig,
		request?: BlobBrokerProbeRequest,
	) => Promise<BlobBrokerProbeResponse | null>;
	readonly queryPurge: (
		projectDir: string,
		request: BlobBrokerPurgeRequest,
	) => Promise<BlobBrokerPurgeResponse | null>;
	readonly which: (binary: string) => string | null;
	readonly fetch: FetchImpl;
	readonly writeStdout: (text: string) => void;
	readonly writeStderr: (text: string) => void;
}

export interface SafeDaemonStatus {
	readonly state: "running" | "stopped";
	readonly baseUrl?: string;
	readonly lazy?: boolean;
	readonly metrics?: BlobBrokerStatus["metrics"];
	readonly recentFetches?: BlobBrokerStatus["recentFetches"];
}

export interface ImagesStatusResult {
	readonly action: "status";
	readonly exitCode: 0;
	readonly projectDir: string;
	readonly enabled: boolean;
	readonly backends: readonly BlobDestinationId[];
	readonly daemon: SafeDaemonStatus;
	readonly providerFiles: ProviderFileCacheStatus;
	readonly savings: BlobBrokerSavingsStatus;
}

export interface ImagesDoctorResult {
	readonly action: "doctor";
	readonly exitCode: 0 | 1;
	readonly projectDir: string;
	readonly healthy: boolean;
	readonly checks: readonly ImagesDoctorCheck[];
}

export interface ImagesProbeResult {
	readonly action: "probe";
	readonly exitCode: 0 | 1;
	readonly projectDir: string;
	readonly backend?: BlobDestinationId;
	readonly daemonState: "running" | "stopped";
	readonly ok: boolean;
	readonly durationMs?: number;
	readonly detail: string;
}

export interface ImagesDaemonPurgeResult {
	readonly applied: boolean;
	readonly purgedBlobs: number;
	readonly reclaimedBytes: number;
	readonly attempted: number;
	readonly deleted: number;
	readonly errors: readonly string[];
}

export interface ImagesProviderPurgeResult {
	readonly selected: number;
	readonly bytes: number;
	readonly deleted: number;
	readonly skippedAuth: number;
	readonly errors: readonly string[];
}

export interface ImagesPurgeResult {
	readonly action: "purge";
	readonly exitCode: 0 | 1;
	readonly projectDir: string;
	readonly applied: boolean;
	readonly all: boolean;
	readonly daemon: ImagesDaemonPurgeResult | null;
	readonly providerFiles: ImagesProviderPurgeResult;
}

export interface ImagesErrorResult {
	readonly action: ImagesAction;
	readonly exitCode: 1 | 2;
	readonly error: string;
}

export type ImagesCommandResult =
	| ImagesStatusResult
	| ImagesDoctorResult
	| ImagesProbeResult
	| ImagesPurgeResult
	| ImagesErrorResult;

const BINARY_BY_DESTINATION: Readonly<Partial<Record<BlobDestinationId, string>>> = {
	cloudflared: "cloudflared",
	"named-cloudflared": "cloudflared",
	ngrok: "ngrok",
	tailscale: "tailscale",
	"localhost-run": "ssh",
	pinggy: "ssh",
	ssh: "ssh",
	devtunnel: "devtunnel",
	zrok: "zrok",
	bore: "bore",
};

function defaultResolveConfig(settings: Settings, projectDir: string): ImagesResolvedConfig {
	return {
		enabled: settings.get("images.urls.enabled"),
		orderedBackends: settings.get("images.urls.backends"),
		configs: resolveBlobBrokerConfigs(settings, projectDir),
		providerFileCachePath: providerFileCachePath(settings, projectDir),
		savingsJournalPath: blobBrokerSavingsJournalPath(settings, projectDir),
	};
}

function defaultCreateProviderFileClient(
	provider: ProviderFileProvider,
	credential: string,
	fetchImpl: FetchImpl,
): ProviderFileClient | null {
	for (const model of getBundledModels(provider)) {
		const client =
			provider === "openai"
				? createOpenAIFileClient(model, credential, fetchImpl)
				: provider === "anthropic"
					? createAnthropicFileClient(model, credential, fetchImpl)
					: createGeminiProviderFileClient(model, credential, fetchImpl);
		if (client) return client;
	}
	return null;
}

async function defaultOpenAuthStorage(): Promise<AuthStorage> {
	const store = await SqliteAuthCredentialStore.open(getAgentDbPath());
	const storage = new AuthStorage(store);
	await storage.reload();
	return storage;
}

function persistedProviderFileEntry(value: unknown): ProviderFileCacheEntry | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entry = value as Partial<ProviderFileCacheEntry>;
	const handle = entry.handle;
	if (
		(entry.provider !== "openai" && entry.provider !== "anthropic" && entry.provider !== "google") ||
		typeof entry.credentialHash !== "string" ||
		!/^[0-9a-f]{64}$/.test(entry.credentialHash) ||
		typeof entry.contentHash !== "string" ||
		!/^[0-9a-f]{64}$/.test(entry.contentHash) ||
		!handle ||
		handle.provider !== entry.provider ||
		typeof handle.mimeType !== "string" ||
		typeof handle.bytes !== "number" ||
		!Number.isSafeInteger(handle.bytes) ||
		handle.bytes < 0 ||
		(handle.expiresAt !== undefined && typeof handle.expiresAt !== "number")
	) {
		return undefined;
	}
	return entry as ProviderFileCacheEntry;
}

async function defaultReadProviderFileSnapshot(indexPath: string): Promise<ImagesProviderFileSnapshot> {
	let source: string;
	try {
		source = await fs.readFile(indexPath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return { entries: [] };
		return { entries: [], lastError: safeDetail(error) };
	}
	try {
		const parsed = JSON.parse(source) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { entries: [], lastError: "Malformed provider file cache index" };
		}
		const candidate = parsed as { version?: unknown; entries?: unknown };
		if (candidate.version !== 1 || !Array.isArray(candidate.entries)) {
			return { entries: [], lastError: "Unsupported provider file cache index" };
		}
		return { entries: candidate.entries.flatMap(value => persistedProviderFileEntry(value) ?? []) };
	} catch {
		return { entries: [], lastError: "Malformed provider file cache index" };
	}
}

const DEFAULT_DEPENDENCIES: ImagesCliDependencies = {
	loadSettings: projectDir => Settings.loadReadOnly({ cwd: projectDir }),
	resolveConfig: defaultResolveConfig,
	readSavings: readBlobBrokerSavingsStatus,
	readProviderFileSnapshot: defaultReadProviderFileSnapshot,
	loadProviderFileCache: indexPath => new ProviderFileCache(indexPath),
	openAuthStorage: defaultOpenAuthStorage,
	createProviderFileClient: defaultCreateProviderFileClient,
	queryStatus: queryBlobBrokerStatus,
	queryDoctor: queryBlobBrokerDoctor,
	queryProbe: queryBlobBrokerProbe,
	queryPurge: queryBlobBrokerPurge,
	which: binary => $which(binary) ?? null,
	fetch: globalThis.fetch,
	writeStdout: text => {
		process.stdout.write(text);
	},
	writeStderr: text => {
		process.stderr.write(text);
	},
};

function dependencies(overrides: Partial<ImagesCliDependencies> | undefined): ImagesCliDependencies {
	return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

function safeDetail(value: unknown): string {
	const message = value instanceof Error ? value.message : String(value);
	return message
		.replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
		.replace(/([?&](?:access_token|api[_-]?key|key|token)=)[^&#\s]+/gi, "$1[redacted]")
		.replace(/https?:\/\/[^\s)]+/gi, raw => {
			try {
				return new URL(raw).origin;
			} catch {
				return "[redacted URL]";
			}
		})
		.slice(0, 500);
}

function safeBaseUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		return url.origin;
	} catch {
		return undefined;
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function publicStatus(status: BlobBrokerStatus | null): SafeDaemonStatus {
	if (!status) return { state: "stopped" };
	return {
		state: "running",
		...(safeBaseUrl(status.baseUrl) ? { baseUrl: safeBaseUrl(status.baseUrl) } : {}),
		lazy: status.lazy,
		metrics: status.metrics,
		recentFetches: status.recentFetches.map(event => ({
			fetcherId: event.fetcherId,
			corroborated: event.corroborated,
			timestamp: event.timestamp,
			method: event.method,
			found: event.found,
			tokenSuffix: event.tokenSuffix,
		})),
	};
}

function providerFileStatus(indexPath: string, snapshot: ImagesProviderFileSnapshot): ProviderFileCacheStatus {
	const providers: Record<ProviderFileProvider, number> = { openai: 0, anthropic: 0, google: 0 };
	let bytes = 0;
	let entries = 0;
	const now = Date.now();
	for (const entry of snapshot.entries) {
		if (entry.handle.expiresAt !== undefined && entry.handle.expiresAt <= now) continue;
		entries++;
		bytes += entry.handle.bytes;
		providers[entry.provider]++;
	}
	return {
		indexPath,
		entries,
		bytes,
		providers,
		dirty: false,
		...(snapshot.lastError === undefined ? {} : { lastError: snapshot.lastError }),
	};
}

async function collectStatus(
	projectDir: string,
	config: ImagesResolvedConfig,
	deps: ImagesCliDependencies,
): Promise<ImagesStatusResult> {
	const [daemon, journalSavings, providerFileSnapshot] = await Promise.all([
		deps.queryStatus(projectDir),
		deps.readSavings(config.savingsJournalPath),
		deps.readProviderFileSnapshot(config.providerFileCachePath),
	]);
	const providerFiles = providerFileStatus(config.providerFileCachePath, providerFileSnapshot);
	const savings = daemon?.savings ?? journalSavings;
	return {
		action: "status",
		exitCode: 0,
		projectDir,
		enabled: config.enabled,
		backends: config.orderedBackends,
		daemon: publicStatus(daemon),
		providerFiles,
		savings,
	};
}

function configuredValue(value: unknown): boolean {
	return typeof value === "string" ? value.trim().length > 0 : value !== undefined;
}

function configChecks(config: ImagesResolvedConfig, deps: ImagesCliDependencies): ImagesDoctorCheck[] {
	const checks: ImagesDoctorCheck[] = [];
	checks.push({
		name: "enabled",
		severity: config.enabled ? "ok" : "error",
		detail: config.enabled ? "图片发布已启用" : "images.urls.enabled 为 false",
	});
	if (config.orderedBackends.length === 0) {
		checks.push({ name: "backends", severity: "error", detail: "未配置任何图片发布后端" });
	}
	const configByKind = new Map(config.configs.map(item => [item.kind, item]));
	for (const backend of config.orderedBackends) {
		const metadata: BlobDestinationMetadata = BUILTIN_BLOB_DESTINATIONS[backend];
		const unavailable = metadata.status === "defunct" || metadata.status === "incompatible";
		checks.push({
			name: `registry:${backend}`,
			severity: unavailable ? "error" : metadata.status === "requires-account" ? "warn" : "ok",
			detail: unavailable
				? `${metadata.label}: ${metadata.reason ?? metadata.status}`
				: `${metadata.label}: ${metadata.status}`,
		});
		const runtime = configByKind.get(backend);
		if (backend !== "provider-files" && runtime) {
			// Serving kinds carry their exposure settings as top-level worker-config fields, while
			// the registry describes them as option keys; a value in either place is configured.
			const serveFields: Record<string, string | number | undefined> = {
				publicBaseUrl: runtime.publicBaseUrl,
				bindHost: runtime.bindHost,
				sshTarget: runtime.sshTarget,
				sshRemotePort: runtime.sshRemotePort,
			};
			const missingOptions = metadata.options
				.filter(field => field.required && !configuredValue(runtime.options[field.key] ?? serveFields[field.key]))
				.map(field => field.key);
			const missingCredentials = metadata.credentials
				.filter(field => field.required && !configuredValue(runtime.credentials[field.key]))
				.map(field => field.key);
			const missing = [...missingOptions, ...missingCredentials];
			let runtimeError: string | undefined;
			if (missing.length === 0) {
				try {
					createConfiguredUploader(backend, runtime);
				} catch (error) {
					runtimeError = safeDetail(error);
				}
			}
			checks.push({
				name: `config:${backend}`,
				severity: missing.length === 0 && runtimeError === undefined ? "ok" : "error",
				detail:
					missing.length > 0
						? `缺少必需字段: ${missing.join(", ")}`
						: (runtimeError ?? "必需配置已就绪"),
			});
		}
		const binary = BINARY_BY_DESTINATION[backend];
		if (binary) {
			const found = deps.which(binary);
			checks.push({
				name: `binary:${backend}`,
				severity: found ? "ok" : "error",
				detail: found ? `${binary} 可用` : `${binary} 不在 PATH 中`,
			});
		}
	}
	return checks;
}

async function diskChecks(config: ImagesResolvedConfig): Promise<ImagesDoctorCheck[]> {
	const directories = new Set<string>([
		path.dirname(config.providerFileCachePath),
		path.dirname(config.savingsJournalPath),
		...config.configs.flatMap(item =>
			item.persist ? [item.persist.blobsDir, path.dirname(item.persist.indexPath)] : [],
		),
	]);
	const checks: ImagesDoctorCheck[] = [];
	for (const directory of directories) {
		try {
			await fs.access(directory, fsConstants.R_OK | fsConstants.W_OK);
			checks.push({
				name: "disk",
				severity: "ok",
				detail: `缓存目录可读可写: ${directory}`,
			});
		} catch {
			checks.push({
				name: "disk",
				severity: "warn",
				detail: `缓存目录不存在或不可写: ${directory}`,
			});
		}
	}
	return checks;
}

async function collectDoctor(
	projectDir: string,
	config: ImagesResolvedConfig,
	deps: ImagesCliDependencies,
): Promise<ImagesDoctorResult> {
	const checks = [...configChecks(config, deps), ...(await diskChecks(config))];
	if (config.orderedBackends.includes("provider-files")) {
		let storage: AuthStorage | undefined;
		try {
			storage = await deps.openAuthStorage();
			const authenticated = (["openai", "anthropic", "google"] as const).filter(provider =>
				storage?.hasAuth(provider),
			);
			checks.push({
				name: "config:provider-files",
				severity: authenticated.length > 0 ? "ok" : "error",
				detail:
					authenticated.length > 0
						? `以下提供商认证可用: ${authenticated.join(", ")}`
						: "没有可用的 OpenAI、Anthropic 或 Google 认证",
			});
		} catch {
			checks.push({
				name: "config:provider-files",
				severity: "warn",
				detail: "无法检查提供商认证存储",
			});
		} finally {
			storage?.close();
		}
	}
	const daemon = await deps.queryDoctor(projectDir, { probe: true });
	if (!daemon) {
		checks.push({ name: "daemon", severity: "warn", detail: "图片守护进程已停止或无法访问" });
	} else {
		for (const check of daemon.checks) {
			checks.push({
				name: `daemon:${check.name}`,
				severity: check.status === "pass" ? "ok" : check.status === "warn" ? "warn" : "error",
				detail: safeDetail(check.detail),
			});
		}
	}
	const healthy = !checks.some(check => check.severity === "error");
	return { action: "doctor", exitCode: healthy ? 0 : 1, projectDir, healthy, checks };
}

async function collectProbe(
	projectDir: string,
	config: ImagesResolvedConfig,
	timeoutMs: number | undefined,
	deps: ImagesCliDependencies,
): Promise<ImagesProbeResult> {
	const first = config.configs[0];
	if (!config.enabled || !first) {
		return {
			action: "probe",
			exitCode: 1,
			projectDir,
			daemonState: "stopped",
			ok: false,
			detail: config.enabled ? "未配置任何 URL 后端" : "图片发布已禁用",
		};
	}
	const response = await deps.queryProbe(projectDir, first, { timeoutMs });
	if (!response) {
		return {
			action: "probe",
			exitCode: 1,
			projectDir,
			backend: first.kind,
			daemonState: "stopped",
			ok: false,
			detail: "图片守护进程无法启动或无法访问",
		};
	}
	return {
		action: "probe",
		exitCode: response.ok ? 0 : 1,
		projectDir,
		backend: first.kind,
		daemonState: "running",
		ok: response.ok,
		durationMs: response.durationMs,
		detail: safeDetail(response.detail),
	};
}

function credentialValues(storage: AuthStorage, provider: ProviderFileProvider): string[] {
	const values: string[] = [];
	for (const row of storage.listStoredCredentials(provider)) {
		const credential = row.credential;
		if (credential.type === "api_key") values.push(credential.key);
		else if (credential.access) values.push(credential.access);
	}
	return values;
}

async function credentialForEntry(storage: AuthStorage, entry: ProviderFileCacheEntry): Promise<string | undefined> {
	const values = credentialValues(storage, entry.provider);
	try {
		const resolved = await storage.getApiKey(entry.provider);
		if (resolved) values.push(resolved);
	} catch {
		// A failed refresh is reported as skipped authentication, never with credential detail.
	}
	return values.find(value => hashProviderFileCredential(value) === entry.credentialHash);
}

async function purgeProviderFiles(
	entries: readonly ProviderFileCacheEntry[],
	cache: ProviderFileCache | undefined,
	apply: boolean,
	deps: ImagesCliDependencies,
): Promise<ImagesProviderPurgeResult> {
	const bytes = entries.reduce((total, entry) => total + entry.handle.bytes, 0);
	if (!apply || entries.length === 0 || !cache) {
		return { selected: entries.length, bytes, deleted: 0, skippedAuth: 0, errors: [] };
	}
	let storage: AuthStorage;
	try {
		storage = await deps.openAuthStorage();
	} catch {
		return { selected: entries.length, bytes, deleted: 0, skippedAuth: entries.length, errors: [] };
	}
	let deleted = 0;
	let skippedAuth = 0;
	const errors: string[] = [];
	try {
		for (const entry of entries) {
			const credential = await credentialForEntry(storage, entry);
			if (!credential) {
				skippedAuth++;
				continue;
			}
			const client = deps.createProviderFileClient(entry.provider, credential, deps.fetch);
			if (!client) {
				skippedAuth++;
				continue;
			}
			try {
				await client.delete(entry.handle);
				cache.delete(entry.provider, credential, entry.contentHash);
				deleted++;
			} catch (error) {
				errors.push(`${entry.provider}: ${safeDetail(error)}`);
			}
		}
		if (deleted > 0) cache.save();
	} finally {
		storage.close();
	}
	return { selected: entries.length, bytes, deleted, skippedAuth, errors };
}

function publicPurgeResponse(response: BlobBrokerPurgeResponse | null): ImagesDaemonPurgeResult | null {
	if (!response) return null;
	return {
		applied: response.applied,
		purgedBlobs: response.purgedBlobs,
		reclaimedBytes: response.reclaimedBytes,
		attempted: response.attempted,
		deleted: response.deleted,
		errors: response.errors.map(safeDetail),
	};
}

async function collectPurge(
	projectDir: string,
	config: ImagesResolvedConfig,
	apply: boolean,
	all: boolean,
	deps: ImagesCliDependencies,
): Promise<ImagesPurgeResult> {
	const snapshot = await deps.readProviderFileSnapshot(config.providerFileCachePath);
	const now = Date.now();
	const selectedEntries = snapshot.entries.filter(
		entry => all || (entry.handle.expiresAt !== undefined && entry.handle.expiresAt <= now),
	);
	const cache =
		apply && selectedEntries.length > 0 ? deps.loadProviderFileCache(config.providerFileCachePath) : undefined;
	const [daemonRaw, providerFilesRaw] = await Promise.all([
		deps.queryPurge(projectDir, { apply, all, expiredOnly: !all }),
		purgeProviderFiles(selectedEntries, cache, apply, deps),
	]);
	const daemon = publicPurgeResponse(daemonRaw);
	const providerFiles: ImagesProviderPurgeResult =
		snapshot.lastError === undefined
			? providerFilesRaw
			: { ...providerFilesRaw, errors: [...providerFilesRaw.errors, snapshot.lastError] };
	const failed =
		(daemon?.errors.length ?? 0) > 0 || providerFiles.errors.length > 0 || (apply && providerFiles.skippedAuth > 0);
	return {
		action: "purge",
		exitCode: failed ? 1 : 0,
		projectDir,
		applied: apply,
		all,
		daemon,
		providerFiles,
	};
}

function renderStatus(result: ImagesStatusResult): string {
	const lines = [
		`图片后端: ${result.backends.length > 0 ? result.backends.join(" → ") : "无"}`,
		`已启用: ${result.enabled ? "是" : "否"}`,
		`守护进程: ${result.daemon.state}${result.daemon.baseUrl ? ` (${result.daemon.baseUrl})` : ""}`,
	];
	const metrics = result.daemon.metrics;
	if (metrics) {
		lines.push(
			`Blob: ${metrics.activeBlobs} 个活跃 (${metrics.eagerBlobs} 个 eager, ${metrics.lazyBlobs} 个 lazy)`,
			`存储: 常驻 ${formatBytes(metrics.residentBytes)}, 磁盘 ${formatBytes(metrics.diskBytes)}`,
			`获取: ${metrics.hits} 次命中, ${metrics.misses} 次未命中, ${metrics.duplicateTokenGets} 次重复 GET`,
			`已发送字节: ${formatBytes(metrics.bytesServed)}`,
		);
	}
	lines.push(
		`节省字节: ${formatBytes(result.savings.savedBytes)} (${formatBytes(result.savings.inlineBytes)} 内联 → ${formatBytes(result.savings.referenceBytes)} 引用)`,
		`提供商文件: ${result.providerFiles.entries} 个活跃, ${formatBytes(result.providerFiles.bytes)}`,
	);
	for (const event of result.daemon.recentFetches ?? []) {
		lines.push(
			`最近获取: ${event.fetcherId ?? "未知"}; corroborated=${event.corroborated ? "是" : "否"}; ${event.method} ${event.found ? "命中" : "未命中"}`,
		);
	}
	return `${lines.join("\n")}\n`;
}

function renderDoctor(result: ImagesDoctorResult): string {
	const lines = result.checks.map(check => `[${check.severity.toUpperCase()}] ${check.name}: ${check.detail}`);
	lines.push(result.healthy ? "图片诊断通过。" : "图片诊断发现错误。");
	return `${lines.join("\n")}\n`;
}

function renderProbe(result: ImagesProbeResult): string {
	const duration = result.durationMs === undefined ? "" : ` in ${result.durationMs} ms`;
	return `图片探测${result.ok ? "通过" : "失败"}${duration}: ${result.detail}\n`;
}

function renderPurge(result: ImagesPurgeResult): string {
	const daemonSelected = result.daemon?.purgedBlobs ?? 0;
	const daemonBytes = result.daemon?.reclaimedBytes ?? 0;
	const lines = [
		result.applied ? "图片清理已执行。" : "图片清理为试运行；传入 --apply 以执行删除。",
		`守护进程 blob: ${daemonSelected}, ${formatBytes(daemonBytes)}`,
		`提供商文件: 选中 ${result.providerFiles.selected}, 已删除 ${result.providerFiles.deleted}, ${formatBytes(result.providerFiles.bytes)}`,
	];
	if (result.providerFiles.skippedAuth > 0) {
		lines.push(
			`已跳过 ${result.providerFiles.skippedAuth} 个提供商文件: 无法找到匹配的认证。`,
		);
	}
	for (const error of result.daemon?.errors ?? []) lines.push(`守护进程错误: ${error}`);
	for (const error of result.providerFiles.errors) lines.push(`提供商错误: ${error}`);
	return `${lines.join("\n")}\n`;
}

function renderHuman(result: ImagesCommandResult): string {
	if ("error" in result) return `images ${result.action}: ${result.error}\n`;
	switch (result.action) {
		case "status":
			return renderStatus(result);
		case "doctor":
			return renderDoctor(result);
		case "probe":
			return renderProbe(result);
		case "purge":
			return renderPurge(result);
	}
}

/** Execute one standalone images command with injectable, leak-free runtime seams. */
export async function runImagesCommand(
	args: ImagesCommandArgs,
	overrides?: Partial<ImagesCliDependencies>,
): Promise<ImagesCommandResult> {
	const deps = dependencies(overrides);
	let result: ImagesCommandResult;
	const projectDir = path.resolve(args.flags.dir ?? process.cwd());
	const timeout = args.flags.timeout;
	if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0)) {
		result = { action: args.action, exitCode: 2, error: "--timeout 必须是正整数" };
	} else {
		try {
			const settings = await deps.loadSettings(projectDir);
			const config = deps.resolveConfig(settings, projectDir);
			switch (args.action) {
				case "status":
					result = await collectStatus(projectDir, config, deps);
					break;
				case "doctor":
					result = await collectDoctor(projectDir, config, deps);
					break;
				case "probe":
					result = await collectProbe(
						projectDir,
						config,
						timeout === undefined ? undefined : timeout * 1000,
						deps,
					);
					break;
				case "purge":
					result = await collectPurge(
						projectDir,
						config,
						args.flags.apply === true,
						args.flags.all === true,
						deps,
					);
					break;
			}
		} catch (error) {
			result = { action: args.action, exitCode: 1, error: safeDetail(error) };
		}
	}
	if (args.flags.json) deps.writeStdout(`${JSON.stringify(result)}\n`);
	else if ("error" in result) deps.writeStderr(renderHuman(result));
	else deps.writeStdout(renderHuman(result));
	return result;
}
