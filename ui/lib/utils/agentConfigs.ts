// Agent config generation engine.
//
// celer-route exposes OpenAI-compatible (/v1), Anthropic-compatible
// (/anthropic/v1/messages) and GenAI surfaces. AI clients rarely discover
// models themselves — most require the model list to be written explicitly
// into their own config file (or hand-entered in an in-app form). This module
// turns the live model catalog (as returned by the celer-route API) + an
// endpoint + a virtual key into ready-to-paste config for the supported AI
// clients: coding agents (opencode, Claude Code, Codex), domestic desktop
// agents & IDEs (WorkBuddy, CodeBuddy, Trae, ZCode, MarsCode, 通义灵码), IDE
// extensions (Cursor) and generic OpenAI-compatible clients.
//
// The functions here are pure: they take plain data and return plain strings.
// The Web UI (workspace/agent-setup) is the single consumer. Besides the
// ready-to-paste files/env/steps it also exposes buildApplyCommand, which
// turns the rendered output into a self-contained `sh -c '…'` (macOS/Linux)
// or PowerShell (Windows) command that writes the config directly to disk on
// the target OS. The POSIX form is wrapped so it runs from any interactive
// shell (bash/zsh/fish) without depending on the user's terminal syntax.

import type { ClientPlatform } from "@/lib/types/platform";
import { displayPath } from "@/lib/utils/platform";

export type CodingAgentId =
	| "opencode"
	| "claude-code"
	| "codex"
	| "openai-compatible"
	| "cursor"
	| "workbuddy"
	| "codebuddy"
	| "trae"
	| "zcode"
	| "marscode"
	| "lingma";

export interface AgentModelInput {
	/** Full model id as used in requests, e.g. "minimax/MiniMax-M2.1". */
	id: string;
	/** Display name, defaults to `id`. */
	name?: string;
	/** context window in tokens, from the model catalog. */
	contextLength?: number;
	/** max output tokens, from the model catalog. */
	maxOutputTokens?: number;
}

export interface AgentConfigInput {
	agent: CodingAgentId;
	/** Endpoint origin, e.g. "http://localhost:8080" or ".../v1". Normalized internally. */
	baseUrl: string;
	/** Virtual key value (sk-bf-...). May be null when auth is disabled. */
	apiKey: string | null;
	models: AgentModelInput[];
	/** Default model id to select; falls back to the first model. */
	defaultModelId?: string;
	/** opencode only: chat (@ai-sdk/openai-compatible) or responses (@ai-sdk/openai). */
	protocol?: "chat" | "responses";
	/** Target OS; drives config paths, env-var syntax and in-app shortcuts. Defaults to linux. */
	platform?: ClientPlatform;
}

/**
 * How a one-command apply merges into an existing file (after backing it up):
 *
 * - "json-deep": deep-merge this JSON object over the existing one (ours wins
 *   per key; everything else is preserved). opencode / Claude Code settings.
 * - "json-models": merge the `models[]` array (dedup by id) and union
 *   `availableModels`. WorkBuddy / CodeBuddy models.json.
 * - "toml": replace the top-level `model`/`model_provider` and the
 *   `[model_providers.celer-route]` section, keeping everything else. Codex.
 * - "env": set-or-append KEY=VALUE lines. `.env` recipes.
 */
export type AgentFileMerge = "json-deep" | "json-models" | "toml" | "env";

export interface AgentConfigFile {
	/** Human-friendly path shown to the user, e.g. "~/.config/opencode/opencode.json". */
	path: string;
	content: string;
	language: "json" | "toml" | "shell" | "markdown";
	/**
	 * Real filesystem path a one-command apply should write to. Omitted for
	 * display-only pseudo files (in-app step lists for Cursor/Trae/…), which
	 * means the client has no file to write and no apply tab is offered.
	 * Env-recipe clients carry `.env` here while keeping the display label.
	 */
	applyPath?: string;
	/** How an existing file is merged (backup-first). Required on every applyPath. */
	merge?: AgentFileMerge;
}

/**
 * One env recipe expressed in the three shell dialects. The arrays carry no
 * comment headers; display code (envTabCode) layers those on top.
 */
export interface AgentConfigEnv {
	/** POSIX shells: export KEY=value */
	posix: string[];
	/** Windows PowerShell: $env:KEY = "value" */
	powershell: string[];
	/** Windows cmd: set KEY=value */
	cmd: string[];
}

export interface AgentConfigOutput {
	files: AgentConfigFile[];
	/** Optional env-var recipe for tools that read the key from the environment. */
	env?: AgentConfigEnv;
	/** In-app steps for tools that do not take a config file (Cursor/Windsurf). */
	steps?: string[];
	/** Full model reference for the default model, e.g. "celer-route/minimax/MiniMax-M2.1". */
	defaultModelRef?: string;
	modelIds: string[];
}

/** Provider key used inside the generated agent configs (opencode/codex). */
export const AGENT_PROVIDER_KEY = "celer-route";

/** Strip a trailing "/v1" from a base URL so we can derive sibling surfaces. */
export function stripV1Suffix(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** OpenAI-compatible surface — append "/v1" unless already present. */
export function toOpenAISurface(baseUrl: string): string {
	const url = stripV1Suffix(baseUrl);
	return `${url}/v1`;
}

/** Anthropic-compatible surface — the gateway serves /anthropic/v1/messages. */
export function toAnthropicSurface(baseUrl: string): string {
	const url = stripV1Suffix(baseUrl);
	return `${url}/anthropic`;
}

function pickDefaultModelId(models: AgentModelInput[], requested?: string): string | undefined {
	if (requested && models.some((m) => m.id === requested)) return requested;
	return models[0]?.id;
}

function toLimit(contextLength?: number, maxOutputTokens?: number): Record<string, number> | undefined {
	const limit: Record<string, number> = {};
	if (contextLength && contextLength > 0) limit.context = contextLength;
	if (maxOutputTokens && maxOutputTokens > 0) limit.output = maxOutputTokens;
	return Object.keys(limit).length > 0 ? limit : undefined;
}

function effectivePlatform(input: AgentConfigInput): ClientPlatform {
	return input.platform ?? "linux";
}

/** Build the three shell dialects of an env recipe from (key, value) pairs. */
function buildEnv(entries: Array<[string, string]>): AgentConfigEnv {
	const env: AgentConfigEnv = { posix: [], powershell: [], cmd: [] };
	for (const [key, value] of entries) {
		env.posix.push(`export ${key}=${value}`);
		env.powershell.push(`$env:${key} = "${value}"`);
		env.cmd.push(`set ${key}=${value}`);
	}
	return env;
}

/**
 * Human-facing env recipe for the selected platform. Windows shows both the
 * PowerShell and the cmd block (with comment headers) so users on either
 * shell get a runnable snippet; macOS/Linux show the POSIX export lines.
 */
export function envTabCode(env: AgentConfigEnv, platform: ClientPlatform): string {
	if (platform === "windows") {
		const blocks: string[] = [];
		if (env.powershell.length > 0) blocks.push("# PowerShell:\n" + env.powershell.join("\n"));
		if (env.cmd.length > 0) blocks.push("# cmd:\n" + env.cmd.join("\n"));
		return blocks.join("\n\n");
	}
	return env.posix.join("\n");
}

function generateOpenCode(input: AgentConfigInput): AgentConfigOutput {
	const baseURL = toOpenAISurface(input.baseUrl);
	const models = input.models;
	const defaultModelId = pickDefaultModelId(models, input.defaultModelId) ?? "";
	const defaultModelRef = `${AGENT_PROVIDER_KEY}/${defaultModelId}`;
	const npm = input.protocol === "responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible";
	const platform = effectivePlatform(input);

	// Build the object so key order is stable and the output is always valid
	// strict JSON (no trailing commas even when apiKey/models are empty).
	const config: Record<string, unknown> = {
		$schema: "https://opencode.ai/config.json",
	};
	if (defaultModelId) config.model = defaultModelRef;
	config.provider = {
		[AGENT_PROVIDER_KEY]: {
			npm,
			name: AGENT_PROVIDER_KEY,
			options: {
				baseURL,
				...(input.apiKey ? { apiKey: input.apiKey } : {}),
			},
			...(models.length > 0 ? { models: opencodeModelsObject(models) } : {}),
		},
	};
	const content = JSON.stringify(config, null, 2);
	const path = displayPath(platform, ".config", "opencode", "opencode.json");

	return {
		files: [{ path, content, language: "json", applyPath: path, merge: "json-deep" }],
		defaultModelRef: defaultModelId ? defaultModelRef : undefined,
		modelIds: models.map((m) => m.id),
	};
}

function opencodeModelsObject(models: AgentModelInput[]): Record<string, Record<string, unknown>> {
	const out: Record<string, Record<string, unknown>> = {};
	for (const m of models) {
		const entry: Record<string, unknown> = {};
		if (m.name && m.name !== m.id) entry.name = m.name;
		const limit = toLimit(m.contextLength, m.maxOutputTokens);
		if (limit) entry.limit = limit;
		out[m.id] = entry;
	}
	return out;
}

function generateClaudeCode(input: AgentConfigInput): AgentConfigOutput {
	const baseURL = toAnthropicSurface(input.baseUrl);
	const defaultModelId = pickDefaultModelId(input.models, input.defaultModelId);
	const platform = effectivePlatform(input);

	const entries: Array<[string, string]> = [
		["ANTHROPIC_BASE_URL", baseURL],
		...(input.apiKey ? ([["ANTHROPIC_AUTH_TOKEN", input.apiKey]] as Array<[string, string]>) : []),
		...(defaultModelId ? ([["ANTHROPIC_MODEL", defaultModelId]] as Array<[string, string]>) : []),
	];
	const env = buildEnv(entries);

	const settings: Record<string, Record<string, string>> = { env: {} };
	for (const [key, value] of entries) {
		settings.env[key] = value;
	}

	const content = JSON.stringify(settings, null, 2);
	const path = displayPath(platform, ".claude", "settings.json");

	return {
		files: [{ path, content, language: "json", applyPath: path, merge: "json-deep" }],
		env,
		defaultModelRef: defaultModelId,
		modelIds: input.models.map((m) => m.id),
	};
}

function generateCodex(input: AgentConfigInput): AgentConfigOutput {
	const baseURL = toOpenAISurface(input.baseUrl);
	const defaultModelId = pickDefaultModelId(input.models, input.defaultModelId) ?? "";
	const envKey = "CELER_ROUTE_API_KEY";
	const platform = effectivePlatform(input);

	const content = [
		`model = ${JSON.stringify(defaultModelId)}`,
		`model_provider = ${JSON.stringify(AGENT_PROVIDER_KEY)}`,
		"",
		`[model_providers.${AGENT_PROVIDER_KEY}]`,
		`name = ${JSON.stringify(AGENT_PROVIDER_KEY)}`,
		`base_url = ${JSON.stringify(baseURL)}`,
		'wire_api = "chat"',
		`env_key = ${JSON.stringify(envKey)}`,
		"",
	].join("\n");

	const path = displayPath(platform, ".codex", "config.toml");

	return {
		files: [{ path, content, language: "toml", applyPath: path, merge: "toml" }],
		env: input.apiKey ? buildEnv([[envKey, input.apiKey]]) : undefined,
		defaultModelRef: defaultModelId,
		modelIds: input.models.map((m) => m.id),
	};
}

/** Shared renderer for env-recipe-only clients (openai-compatible, MarsCode). */
function generateEnvRecipe(input: AgentConfigInput, entries: Array<[string, string]>): AgentConfigOutput {
	const platform = effectivePlatform(input);
	const env = buildEnv(entries);
	const defaultModelId = pickDefaultModelId(input.models, input.defaultModelId) ?? "";

	return {
		files: [
			{
				path: ".env (环境变量接入)",
				content: envTabCode(env, platform),
				language: "shell",
				applyPath: ".env",
				merge: "env",
			},
		],
		env,
		defaultModelRef: defaultModelId,
		modelIds: input.models.map((m) => m.id),
	};
}

function generateOpenAICompatible(input: AgentConfigInput): AgentConfigOutput {
	const baseURL = toOpenAISurface(input.baseUrl);
	const defaultModelId = pickDefaultModelId(input.models, input.defaultModelId) ?? "";

	const entries: Array<[string, string]> = [
		["OPENAI_BASE_URL", baseURL],
		...(input.apiKey ? ([["OPENAI_API_KEY", input.apiKey]] as Array<[string, string]>) : []),
		["OPENAI_MODEL", defaultModelId],
	];

	return generateEnvRecipe(input, entries);
}

function generateCursor(input: AgentConfigInput): AgentConfigOutput {
	const baseURL = toOpenAISurface(input.baseUrl);
	const defaultModelId = pickDefaultModelId(input.models, input.defaultModelId) ?? "";
	const providerName = AGENT_PROVIDER_KEY;
	const platform = effectivePlatform(input);
	const settingsShortcut = platform === "macos" ? "⌘," : "Ctrl+,";

	const steps = [
		`打开 Cursor → Settings（${settingsShortcut}）→ Models`,
		`在 "Model Provider" 下点击 "+ Add" → 选择 "OpenAI"`,
		`Name 填 ${providerName}`,
		`Base URL 填 ${baseURL}`,
		input.apiKey ? `API Key 填 ${input.apiKey}` : `API Key 留空（celer-route 未开启强制鉴权）`,
		`点击 "Verify"，选择默认模型：${defaultModelId}`,
		`确认后可在模型下拉中切换到任意已配置模型`,
	];

	const content = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");

	return {
		files: [{ path: "Cursor 内操作步骤", content, language: "markdown" }],
		steps,
		defaultModelRef: defaultModelId,
		modelIds: input.models.map((m) => m.id),
	};
}

/**
 * Tencent WorkBuddy / CodeBuddy share the same local model registry: a
 * `~/.{workbuddy,codebuddy}/models.json` containing an OpenAI-compatible
 * `models[]` list plus an `availableModels[]` allow-list. Each model entry
 * points at a full chat-completions URL, so celer-route's `/v1` surface maps
 * to `{origin}/v1/chat/completions`. The first `availableModels` entry is the
 * client's default model, so the picker's default is hoisted to the front.
 */
function generateTencentModelsJson(input: AgentConfigInput, path: string): AgentConfigOutput {
	const baseURL = `${toOpenAISurface(input.baseUrl)}/chat/completions`;
	const models = input.models;
	const defaultModelId = pickDefaultModelId(models, input.defaultModelId) ?? "";

	const ordered = [...models];
	if (defaultModelId) {
		const i = ordered.findIndex((m) => m.id === defaultModelId);
		if (i > 0) [ordered[0], ordered[i]] = [ordered[i], ordered[0]];
	}

	const entries = ordered.map((m) => {
		const entry: Record<string, string | number> = {
			id: m.id,
			name: m.name && m.name !== m.id ? m.name : m.id,
			vendor: "OpenAI",
			url: baseURL,
		};
		if (input.apiKey) entry.apiKey = input.apiKey;
		if (m.contextLength && m.contextLength > 0) entry.maxInputTokens = m.contextLength;
		if (m.maxOutputTokens && m.maxOutputTokens > 0) entry.maxOutputTokens = m.maxOutputTokens;
		return entry;
	});

	const doc: Record<string, unknown> = { models: entries };
	if (ordered.length > 0) doc.availableModels = ordered.map((m) => m.id);

	return {
		files: [{ path, content: `${JSON.stringify(doc, null, 2)}\n`, language: "json", applyPath: path, merge: "json-models" }],
		defaultModelRef: defaultModelId || undefined,
		modelIds: models.map((m) => m.id),
	};
}

function generateWorkBuddy(input: AgentConfigInput): AgentConfigOutput {
	return generateTencentModelsJson(input, displayPath(effectivePlatform(input), ".workbuddy", "models.json"));
}

function generateCodeBuddy(input: AgentConfigInput): AgentConfigOutput {
	return generateTencentModelsJson(input, displayPath(effectivePlatform(input), ".codebuddy", "models.json"));
}

function generateTrae(input: AgentConfigInput): AgentConfigOutput {
	const baseURL = toOpenAISurface(input.baseUrl);
	const defaultModelId = pickDefaultModelId(input.models, input.defaultModelId) ?? "";
	const providerName = AGENT_PROVIDER_KEY;

	const steps = [
		`打开 Trae → 设置 → 模型 → 自定义模型`,
		`添加模型，API 格式选择「OpenAI」（若你的服务只提供 Anthropic 协议再换）`,
		`Name 填 ${providerName}`,
		`Base URL 填 ${baseURL}（务必填完整路径，含 /v1）`,
		input.apiKey ? `API Key 填 ${input.apiKey}` : `API Key 留空（celer-route 未开启强制鉴权）`,
		`Model ID 填 ${defaultModelId}（模型目录里的完整 ID）`,
		`点击连接/校验后，即可在模型下拉中切换到该模型`,
	];

	const content = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");

	return {
		files: [{ path: "Trae 内操作步骤", content, language: "markdown" }],
		steps,
		defaultModelRef: defaultModelId,
		modelIds: input.models.map((m) => m.id),
	};
}

function generateZCode(input: AgentConfigInput): AgentConfigOutput {
	const baseURL = toOpenAISurface(input.baseUrl);
	const defaultModelId = pickDefaultModelId(input.models, input.defaultModelId) ?? "";

	const steps = [
		`打开 ZCode → 设置 → 模型接入`,
		`选择「自定义 OpenAI 兼容接口」`,
		`Base URL 填 ${baseURL}（含 /v1）`,
		input.apiKey ? `API Key 填 ${input.apiKey}` : `API Key 留空（celer-route 未开启强制鉴权）`,
		`Model ID 填 ${defaultModelId}（模型目录里的完整 ID）`,
		`保存后即可在模型列表中切换到该模型`,
	];

	const content = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");

	return {
		files: [{ path: "ZCode 内操作步骤", content, language: "markdown" }],
		steps,
		defaultModelRef: defaultModelId,
		modelIds: input.models.map((m) => m.id),
	};
}

function generateMarsCode(input: AgentConfigInput): AgentConfigOutput {
	const baseURL = toOpenAISurface(input.baseUrl);
	const defaultModelId = pickDefaultModelId(input.models, input.defaultModelId) ?? "";

	const entries: Array<[string, string]> = [
		["OPENAI_BASE_URL", baseURL],
		...(input.apiKey ? ([["OPENAI_API_KEY", input.apiKey]] as Array<[string, string]>) : []),
		["OPENAI_MODEL", defaultModelId],
	];

	return generateEnvRecipe(input, entries);
}

function generateLingma(input: AgentConfigInput): AgentConfigOutput {
	const baseURL = toOpenAISurface(input.baseUrl);
	const defaultModelId = pickDefaultModelId(input.models, input.defaultModelId) ?? "";

	const steps = [
		`安装通义灵码插件（VS Code / JetBrains 扩展市场搜索「通义灵码」）`,
		`打开设置 → 模型服务 → 自定义端点`,
		`协议选择「OpenAI 兼容（Chat Completions）」`,
		`Base URL 填 ${baseURL}（含 /v1）`,
		input.apiKey ? `API Key 填 ${input.apiKey}` : `API Key 留空（celer-route 未开启强制鉴权）`,
		`模型（Model）填 ${defaultModelId}（模型目录里的完整 ID）`,
		`保存并重载窗口后生效`,
	];

	const content = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");

	return {
		files: [{ path: "通义灵码 内操作步骤", content, language: "markdown" }],
		steps,
		defaultModelRef: defaultModelId,
		modelIds: input.models.map((m) => m.id),
	};
}

/**
 * Category groups for the agent dropdown. Order is display order; the group
 * labels live in the i18n `agent.group.*` keys.
 */
export type AgentGroupId = "coding" | "domestic" | "ide" | "generic";

export interface AgentGroup {
	id: AgentGroupId;
	agents: CodingAgentId[];
}

export const AGENT_GROUPS: AgentGroup[] = [
	{ id: "coding", agents: ["opencode", "claude-code", "codex", "marscode"] },
	{ id: "domestic", agents: ["workbuddy", "zcode"] },
	{ id: "ide", agents: ["codebuddy", "cursor", "trae", "lingma"] },
	{ id: "generic", agents: ["openai-compatible"] },
];

export const CODING_AGENTS: CodingAgentId[] = AGENT_GROUPS.flatMap((g) => g.agents);

/**
 * Generate the ready-to-paste config for an AI client.
 * Pure — no I/O, no side effects.
 */
export function generateAgentConfig(input: AgentConfigInput): AgentConfigOutput {
	switch (input.agent) {
		case "opencode":
			return generateOpenCode(input);
		case "claude-code":
			return generateClaudeCode(input);
		case "codex":
			return generateCodex(input);
		case "openai-compatible":
			return generateOpenAICompatible(input);
		case "cursor":
			return generateCursor(input);
		case "workbuddy":
			return generateWorkBuddy(input);
		case "codebuddy":
			return generateCodeBuddy(input);
		case "trae":
			return generateTrae(input);
		case "zcode":
			return generateZCode(input);
		case "marscode":
			return generateMarsCode(input);
		case "lingma":
			return generateLingma(input);
	}
}

/**
 * Turn a rendered AgentConfigOutput into a self-contained, copy-pasteable
 * shell command that applies the config on the target OS.
 *
 * The command NEVER wholesale-replaces an existing config:
 *
 *   1. It backs up the existing file (`cp -p … .bak-<ts>` / `Copy-Item …`) .
 *   2. It merges precisely, per AgentFileMerge strategy — JSON deep-merge
 *      (opencode/Claude Code), models[]-dedup + availableModels union
 *      (WorkBuddy/CodeBuddy), TOML section replace (Codex), KEY=VALUE
 *      set-or-append (.env) — preserving every unrelated key/section/providers
 *      the user already has.
 *   3. If an existing config fails to parse, it aborts and leaves the file
 *      untouched (the backup remains).
 *
 * POSIX merges run under `python3` (near-universal on dev machines); if it is
 * missing the command fails loudly instead of clobbering. The POSIX script is
 * wrapped as a single `sh -c '…'` argument so it runs unmodified from bash,
 * zsh, fish or dash — the user never has to switch shells. The merge program
 * is delivered to python3 on a single base64-encoded line (never a heredoc),
 * so terminal smart-paste/auto-indent features cannot corrupt Python's
 * indentation. Windows merges use built-in PowerShell JSON cmdlets and text
 * handling, writing BOM-less UTF-8 so JSON/TOML parse cleanly on PowerShell
 * 5.1.
 *
 * Returns null when there is nothing to write (in-app-steps-only clients like
 * Cursor/Trae/ZCode/通义灵码) — the page then hides the apply tab.
 */
export function buildApplyCommand(output: AgentConfigOutput, platform: ClientPlatform): string | null {
	const writable = output.files.filter((f) => f.applyPath);
	if (writable.length === 0) return null;

	// Env-recipe clients (openai-compatible / MarsCode) end with a hint on how
	// to load the merged `.env`.
	const envOnly = writable.every((f) => f.applyPath === ".env") && !!output.env;

	const blocks: string[] = [];
	for (const file of writable) {
		blocks.push(...(platform === "windows" ? windowsFileBlock(file, output.env) : posixFileBlock(file, output.env)));
	}
	if (envOnly) {
		blocks.push("");
		blocks.push(
			...(platform === "windows"
				? ["# 已将环境变量写入当前目录 .env（KEY=VALUE）。", "# 在 PowerShell 中请使用「环境变量」标签页的 PowerShell/cmd 写法导出后使用。"]
				: ["# 已将环境变量写入当前目录 .env", 'echo "请在当前终端执行 source .env 使环境变量生效（本命令在 sh 子进程中运行）"']),
		);
	}

	const script = blocks.join("\n");
	if (platform === "windows") return script;
	return `sh -c ${shSingleQuote(script)}`;
}

/**
 * Quote a POSIX script as a single `sh -c` argument. Any interactive shell —
 * bash, zsh, fish, dash (the macOS/Linux default /bin/sh) — can then run
 * `sh -c '…'` verbatim regardless of its own syntax, so macOS/Linux apply
 * commands no longer depend on the user's terminal. Inner single quotes are
 * escaped with the POSIX `'…'\''…'` concatenation idiom.
 */
function shSingleQuote(script: string): string {
	return `'${script.replace(/'/g, "'\\''")}'`;
}

/**
 * Run a python program from a single, indentation-immune line. The program is
 * base64-encoded and exec'd, so no multi-line heredoc body ever reaches the
 * terminal — tools that auto-indent pasted continuation lines (iTerm, Warp,
 * etc.) cannot flatten the Python indentation. The `-c` argument is
 * double-quoted for the shell; the program's single quote around the payload
 * is handled by the outer `sh -c` quoting.
 */
function pyInvocation(program: string): string {
	return `python3 -c "import base64,sys; exec(base64.b64decode('${b64(program)}'))"`;
}

/** Browser-safe base64 of a UTF-8 string (used to embed payloads without delimiter risk). */
function b64(utf8: string): string {
	const bytes = new TextEncoder().encode(utf8);
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}

/** Extract KEY/VALUE pairs from the posix env lines (strip "export "). */
function envEntries(env: AgentConfigEnv | undefined): Array<[string, string]> {
	if (!env) return [];
	const out: Array<[string, string]> = [];
	for (const line of env.posix) {
		const body = line.startsWith("export ") ? line.slice("export ".length) : line;
		const eq = body.indexOf("=");
		if (eq < 0) continue;
		out.push([body.slice(0, eq), body.slice(eq + 1)]);
	}
	return out;
}

function pyEsc(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

// ---------------------------------------------------------------------------
// POSIX (bash + python3) merge snippets
// ---------------------------------------------------------------------------

function pyJsonDeepSource(applyPath: string, content: string): string {
	return `import os, sys, json, base64

p = os.path.expanduser("${applyPath}")
ours = json.loads(base64.b64decode("${b64(content)}").decode("utf-8"))
root = {}
if os.path.exists(p):
    try:
        root = json.load(open(p, encoding="utf-8"))
    except Exception:
        sys.stderr.write("error: %s is not valid JSON; left untouched (a backup was made)\\n" % p)
        sys.exit(1)

def deep(base, over):
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            deep(base[k], v)
        else:
            base[k] = v

deep(root, ours)
tmp = p + ".tmp"
json.dump(root, open(tmp, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
os.replace(tmp, p)
print("merged celer-route config into", p)`;
}

function pyJsonModelsSource(applyPath: string, content: string): string {
	return `import os, sys, json, base64

p = os.path.expanduser("${applyPath}")
ours = json.loads(base64.b64decode("${b64(content)}").decode("utf-8"))
root = {}
if os.path.exists(p):
    try:
        root = json.load(open(p, encoding="utf-8"))
    except Exception:
        sys.stderr.write("error: %s is not valid JSON; left untouched (a backup was made)\\n" % p)
        sys.exit(1)

models = []
seen = set()
for m in (ours.get("models") or []) + (root.get("models") or []):
    mid = m.get("id") or ""
    if mid and mid not in seen:
        seen.add(mid)
        models.append(m)
root["models"] = models

avail = []
for ident in (ours.get("availableModels") or []) + (root.get("availableModels") or []):
    if ident not in avail:
        avail.append(ident)
root["availableModels"] = avail

tmp = p + ".tmp"
json.dump(root, open(tmp, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
os.replace(tmp, p)
print("merged celer-route models into", p)`;
}

function pyTomlSource(applyPath: string, content: string): string {
	return `import os, sys, re, base64

p = os.path.expanduser("${applyPath}")
ours = base64.b64decode("${b64(content)}").decode("utf-8")
model_val = re.search(r'^model\\s*=\\s*"([^"]*)"', ours, re.M).group(1)
prov_val = re.search(r'^model_provider\\s*=\\s*"([^"]*)"', ours, re.M).group(1)
mark = "[model_providers.celer-route]"
sec_lines = ours[ours.index(mark):].splitlines()

keep = []
in_celer = False
saw_section = False
if os.path.exists(p):
    for line in open(p, encoding="utf-8"):
        s = line.strip()
        if s == mark:
            in_celer = True
            continue
        if in_celer:
            if s.startswith("["):
                in_celer = False
            else:
                continue
        if not saw_section:
            if re.match(r'^model\\s*=', s) or re.match(r'^model_provider\\s*=', s):
                continue
        if s.startswith("["):
            saw_section = True
        keep.append(line.rstrip("\\n"))

top = ['model = "%s"' % model_val, 'model_provider = "%s"' % prov_val, ""]
composed = top + keep + [""] + sec_lines
open(p, "w", encoding="utf-8").write("\\n".join(composed) + "\\n")
print("merged celer-route provider into", p)`;
}

function pyEnvSource(applyPath: string, env: AgentConfigEnv | undefined): string {
	const pairs = envEntries(env);
	const pairsLit = pairs.map(([k, v]) => `    ("${pyEsc(k)}", "${pyEsc(v)}"),`).join("\n");
	return `import os

p = os.path.expanduser("${applyPath}")
pairs = [
${pairsLit}
]
lines = []
if os.path.exists(p):
    lines = open(p, encoding="utf-8").read().splitlines()
keys = {k: False for k, _ in pairs}
keep = []
for line in lines:
    s = line.strip()
    hit = False
    for k, _ in pairs:
        if s.startswith(k + "="):
            keys[k] = True
            hit = True
            break
    if not hit:
        keep.append(line)
for k, v in pairs:
    if not keys[k]:
        keep.append(k + "=" + v)
text = "\\n".join(keep)
if text and not text.endswith("\\n"):
    text += "\\n"
open(p, "w", encoding="utf-8").write(text)
print("updated", p)`;
}

function posixFileBlock(file: AgentConfigFile, env: AgentConfigEnv | undefined): string[] {
	const applyPath = file.applyPath!;
	const parent = posixParent(applyPath);
	const target = bashPath(applyPath);
	const lines: string[] = [];
	if (parent) lines.push(`mkdir -p "${parent}"`);
	lines.push(`if [ -f "${target}" ]; then`);
	lines.push(`  cp -p "${target}" "${target}.bak-$(date +%Y%m%d-%H%M%S)" || { echo "backup failed: ${target}" >&2; exit 1; }`);
	lines.push(`fi`);
	lines.push(`command -v python3 >/dev/null 2>&1 || { echo "python3 is required to merge into ${target}" >&2; exit 1; }`);
	let program: string;
	switch (file.merge) {
		case "json-deep":
			program = pyJsonDeepSource(applyPath, file.content);
			break;
		case "json-models":
			program = pyJsonModelsSource(applyPath, file.content);
			break;
		case "toml":
			program = pyTomlSource(applyPath, file.content);
			break;
		case "env":
			program = pyEnvSource(applyPath, env);
			break;
		default:
			// applyPath'd files always carry a merge strategy; keep TS happy.
			program = pyJsonDeepSource(applyPath, file.content);
			break;
	}
	lines.push(pyInvocation(program));
	return lines;
}

/** Bash-resolvable path: `~/` becomes `$HOME/` (bash does not expand `~` inside quotes). */
function bashPath(applyPath: string): string {
	if (applyPath.startsWith("~/")) return `$HOME/${applyPath.slice(2)}`;
	return applyPath;
}

// ---------------------------------------------------------------------------
// Windows (PowerShell) merge snippets — built-in JSON cmdlets + text handling
// ---------------------------------------------------------------------------

/** Quoted PowerShell expression for the target path (e.g. "$env:USERPROFILE\…"). */
function psTargetValue(applyPath: string): string {
	if (applyPath.startsWith("%USERPROFILE%\\")) {
		return `"$env:USERPROFILE${applyPath.slice("%USERPROFILE%".length)}"`;
	}
	return `"${applyPath}"`;
}

/** Quoted PowerShell parent dir, or "" for a bare filename (e.g. .env). */
function psParentValue(applyPath: string): string {
	const idx = applyPath.lastIndexOf("\\");
	if (idx <= 0) return "";
	const dir = applyPath.slice(0, idx);
	if (dir.startsWith("%USERPROFILE%")) {
		return `"$env:USERPROFILE${dir.slice("%USERPROFILE%".length)}"`;
	}
	return `"${dir}"`;
}

/** Emits `$__p = …`, parent dir creation, and the backup-if-exists header. */
function psBackupHeader(targetValue: string, parentValue: string): string[] {
	const lines: string[] = [`$__p = ${targetValue}`];
	if (parentValue) {
		lines.push(`New-Item -ItemType Directory -Force -Path ${parentValue} | Out-Null`);
	}
	lines.push(`if (Test-Path -LiteralPath $__p) {`);
	lines.push(`  Copy-Item -LiteralPath $__p -Destination "$__p.bak-$((Get-Date).ToString('yyyyMMdd-HHmmss'))" -Force`);
	lines.push(`}`);
	return lines;
}

function psJsonDeepBlock(applyPath: string, content: string): string[] {
	const targetValue = psTargetValue(applyPath);
	const parentValue = psParentValue(applyPath);
	const b64s = b64(content);
	return [
		...psBackupHeader(targetValue, parentValue),
		`$__ours = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64s}')) | ConvertFrom-Json`,
		`if (Test-Path -LiteralPath $__p) { $__root = Get-Content -Raw -LiteralPath $__p | ConvertFrom-Json } else { $__root = [pscustomobject]@{} }`,
		`function __Merge($__base, $__over) {`,
		`  foreach ($__prop in $__over.PSObject.Properties) {`,
		`    $__n = $__prop.Name; $__v = $__prop.Value`,
		`    $__cur = $__base.$__n`,
		`    if ($__v -is [System.Management.Automation.PSCustomObject]) {`,
		`      if ($null -eq $__cur -or $__cur -isnot [System.Management.Automation.PSCustomObject]) {`,
		`        $__cur = [pscustomobject]@{}`,
		`        Add-Member -InputObject $__base -NotePropertyName $__n -NotePropertyValue $__cur -Force`,
		`      }`,
		`      __Merge $__cur $__v`,
		`    } else {`,
		`      Add-Member -InputObject $__base -NotePropertyName $__n -NotePropertyValue $__v -Force`,
		`    }`,
		`  }`,
		`}`,
		`__Merge $__root $__ours`,
		`[IO.File]::WriteAllText($__p, ($__root | ConvertTo-Json -Depth 100), (New-Object System.Text.UTF8Encoding($false)))`,
		`Write-Host "merged celer-route config into $__p"`,
	];
}

function psJsonModelsBlock(applyPath: string, content: string): string[] {
	const targetValue = psTargetValue(applyPath);
	const parentValue = psParentValue(applyPath);
	const b64s = b64(content);
	return [
		...psBackupHeader(targetValue, parentValue),
		`$__ours = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64s}')) | ConvertFrom-Json`,
		`if (Test-Path -LiteralPath $__p) { $__root = Get-Content -Raw -LiteralPath $__p | ConvertFrom-Json } else { $__root = [pscustomobject]@{ models = @(); availableModels = @() } }`,
		`$__models = New-Object System.Collections.Generic.List[object]`,
		`$__seen = @{}`,
		`foreach ($__m in @($__ours.models)) { if (-not $__seen.ContainsKey($__m.id)) { $__seen[$__m.id] = $true; $__models.Add($__m) } }`,
		`foreach ($__m in @($__root.models)) { if (-not $__seen.ContainsKey($__m.id)) { $__seen[$__m.id] = $true; $__models.Add($__m) } }`,
		`$__root.models = @($__models)`,
		`$__avail = New-Object System.Collections.Generic.List[string]`,
		`foreach ($__id in @($__ours.availableModels) + @($__root.availableModels)) { if (-not $__avail.Contains($__id)) { $__avail.Add($__id) } }`,
		`$__root.availableModels = @($__avail)`,
		`[IO.File]::WriteAllText($__p, ($__root | ConvertTo-Json -Depth 100), (New-Object System.Text.UTF8Encoding($false)))`,
		`Write-Host "merged celer-route models into $__p"`,
	];
}

function psTomlBlock(applyPath: string, content: string): string[] {
	const targetValue = psTargetValue(applyPath);
	const parentValue = psParentValue(applyPath);
	const b64s = b64(content);
	return [
		...psBackupHeader(targetValue, parentValue),
		`$__oursText = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64s}'))`,
		`$__model = [regex]::Match($__oursText, '(?m)^model\\s*=\\s*"([^"]*)"').Groups[1].Value`,
		`$__prov = [regex]::Match($__oursText, '(?m)^model_provider\\s*=\\s*"([^"]*)"').Groups[1].Value`,
		`$__mark = '[model_providers.celer-route]'`,
		`$__secLines = $__oursText.Substring($__oursText.IndexOf($__mark)) -split "\`r?\`n"`,
		`if (Test-Path -LiteralPath $__p) { $__lines = @(Get-Content -LiteralPath $__p) } else { $__lines = @() }`,
		`$__keep = New-Object System.Collections.Generic.List[string]`,
		`$__inCeler = $false`,
		`$__sawSec = $false`,
		`foreach ($__line in $__lines) {`,
		`  $__s = $__line.Trim()`,
		`  if ($__s -eq $__mark) { $__inCeler = $true; continue }`,
		`  if ($__inCeler) { if ($__s.StartsWith('[')) { $__inCeler = $false } else { continue } }`,
		`  if (-not $__sawSec) { if ($__s -match '^model\\s*=' -or $__s -match '^model_provider\\s*=') { continue } }`,
		`  if ($__s.StartsWith('[')) { $__sawSec = $true }`,
		`  $__keep.Add($__line)`,
		`}`,
		`$__composed = New-Object System.Collections.Generic.List[string]`,
		`$__composed.Add('model = "' + $__model + '"')`,
		`$__composed.Add('model_provider = "' + $__prov + '"')`,
		`$__composed.Add('')`,
		`foreach ($__l in $__keep) { $__composed.Add($__l) }`,
		`$__composed.Add('')`,
		`foreach ($__l in $__secLines) { $__composed.Add($__l) }`,
		`[IO.File]::WriteAllText($__p, ([string]::Join("\`n", $__composed) + "\`n"), (New-Object System.Text.UTF8Encoding($false)))`,
		`Write-Host "merged celer-route provider into $__p"`,
	];
}

function psEnvBlock(applyPath: string, env: AgentConfigEnv | undefined): string[] {
	const targetValue = psTargetValue(applyPath);
	const parentValue = psParentValue(applyPath);
	const pairs = envEntries(env);
	const pairsLit = pairs.map(([k, v]) => `  @("${psEsc(k)}", "${psEsc(v)}"),`).join("\n");
	return [
		...psBackupHeader(targetValue, parentValue),
		`$__pairs = @(`,
		pairsLit,
		`)`,
		`if (Test-Path -LiteralPath $__p) { $__lines = @(Get-Content -LiteralPath $__p) } else { $__lines = @() }`,
		`$__keys = @{}`,
		`foreach ($__kv in $__pairs) { $__keys[$__kv[0]] = $false }`,
		`$__keep = New-Object System.Collections.Generic.List[string]`,
		`foreach ($__line in $__lines) {`,
		`  $__s = $__line.Trim()`,
		`  $__hit = $false`,
		`  foreach ($__kv in $__pairs) { if ($__s.StartsWith($__kv[0] + "=")) { $__keys[$__kv[0]] = $true; $__hit = $true; break } }`,
		`  if (-not $__hit) { $__keep.Add($__line) }`,
		`}`,
		`foreach ($__kv in $__pairs) { if (-not $__keys[$__kv[0]]) { $__keep.Add($__kv[0] + "=" + $__kv[1]) } }`,
		`[IO.File]::WriteAllText($__p, ([string]::Join("\`n", $__keep) + "\`n"), (New-Object System.Text.UTF8Encoding($false)))`,
		`Write-Host "updated $__p"`,
	];
}

function psEsc(s: string): string {
	return s.replace(/`/g, "``").replace(/"/g, '""').replace(/\n/g, "`n");
}

function windowsFileBlock(file: AgentConfigFile, env: AgentConfigEnv | undefined): string[] {
	switch (file.merge) {
		case "json-deep":
			return psJsonDeepBlock(file.applyPath!, file.content);
		case "json-models":
			return psJsonModelsBlock(file.applyPath!, file.content);
		case "toml":
			return psTomlBlock(file.applyPath!, file.content);
		case "env":
			return psEnvBlock(file.applyPath!, env);
	}
	return [];
}

/** Parent dir for a POSIX path (with ~ resolved to $HOME), or "" for a bare filename (e.g. .env). */
function posixParent(applyPath: string): string {
	const idx = applyPath.lastIndexOf("/");
	if (idx <= 0) return "";
	const dir = applyPath.slice(0, idx);
	if (dir.startsWith("~/")) return `$HOME${dir.slice(1)}`;
	return dir;
}