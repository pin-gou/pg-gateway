import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
	AGENT_GROUPS,
	AGENT_PROVIDER_KEY,
	CODING_AGENTS,
	CodingAgentId,
	buildApplyCommand,
	envTabCode,
	generateAgentConfig,
	toAnthropicSurface,
	toOpenAISurface,
} from "@/lib/utils/agentConfigs";

const models = [
	{ id: "minimax/MiniMax-M2.1", name: "MiniMax-M2.1", contextLength: 1_000_000, maxOutputTokens: 8192 },
	{ id: "sensenova/glm-5.2", name: "glm-5.2" },
	{ id: "opencode/big-pickle", name: "big-pickle" },
];

function parseJSON(content: string): Record<string, any> {
	return JSON.parse(content);
}

/**
 * Decode the python merge program that a POSIX apply command embeds as base64
 * inside its single-line `python3 -c "… exec(base64.b64decode('…'))"` call.
 * Unescapes the outer `'…'\''…'` idiom first so the inner script is plain.
 */
function embeddedProgram(cmd: string): string {
	const unescaped = cmd.replace(/'\\''/g, "'");
	const m = unescaped.match(/exec\(base64\.b64decode\('([A-Za-z0-9+/=]+)'\)\)/);
	expect(m).not.toBeNull();
	return Buffer.from(m![1], "base64").toString("utf8");
}

describe("surface derivation", () => {
	it("appends /v1 to a bare origin", () => {
		expect(toOpenAISurface("http://localhost:8080")).toBe("http://localhost:8080/v1");
	});

	it("does not double the /v1 suffix", () => {
		expect(toOpenAISurface("http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
		expect(toOpenAISurface("http://localhost:8080/v1/")).toBe("http://localhost:8080/v1");
	});

	it("derives the anthropic surface from either form", () => {
		expect(toAnthropicSurface("http://localhost:8080")).toBe("http://localhost:8080/anthropic");
		expect(toAnthropicSurface("http://localhost:8080/v1")).toBe("http://localhost:8080/anthropic");
	});
});

describe("opencode", () => {
	it("generates a valid strict-JSON config with models + limits", () => {
		const out = generateAgentConfig({ agent: "opencode", baseUrl: "http://localhost:8080", apiKey: "sk-bf-abc", models });
		expect(out.files).toHaveLength(1);
		expect(out.files[0].path).toBe("~/.config/opencode/opencode.json");
		expect(out.defaultModelRef).toBe("celer-route/minimax/MiniMax-M2.1");

		const cfg = parseJSON(out.files[0].content);
		expect(cfg.$schema).toBe("https://opencode.ai/config.json");
		expect(cfg.model).toBe("celer-route/minimax/MiniMax-M2.1");
		expect(cfg.provider["celer-route"].npm).toBe("@ai-sdk/openai-compatible");
		expect(cfg.provider["celer-route"].options.baseURL).toBe("http://localhost:8080/v1");
		expect(cfg.provider["celer-route"].options.apiKey).toBe("sk-bf-abc");

		const m = cfg.provider["celer-route"].models;
		expect(m["minimax/MiniMax-M2.1"]).toEqual({ name: "MiniMax-M2.1", limit: { context: 1_000_000, output: 8192 } });
		expect(m["sensenova/glm-5.2"]).toEqual({ name: "glm-5.2" });
	});

	it("honors an explicit default model + responses protocol", () => {
		const out = generateAgentConfig({
			agent: "opencode",
			baseUrl: "http://localhost:8080/v1",
			apiKey: null,
			models,
			defaultModelId: "opencode/big-pickle",
			protocol: "responses",
		});
		const cfg = parseJSON(out.files[0].content);
		expect(cfg.model).toBe("celer-route/opencode/big-pickle");
		expect(cfg.provider["celer-route"].npm).toBe("@ai-sdk/openai");
		expect(cfg.provider["celer-route"].options.apiKey).toBeUndefined();
	});

	it("omits models block cleanly when no models are selected (no trailing commas)", () => {
		const out = generateAgentConfig({ agent: "opencode", baseUrl: "http://localhost:8080", apiKey: "sk-bf-abc", models: [] });
		const cfg = parseJSON(out.files[0].content);
		expect(cfg.provider["celer-route"].models).toBeUndefined();
		expect(cfg.model).toBeUndefined();
		expect(out.modelIds).toEqual([]);
	});
});

describe("claude-code", () => {
	it("writes the anthropic surface into settings.json and env recipe", () => {
		const out = generateAgentConfig({ agent: "claude-code", baseUrl: "http://localhost:8080", apiKey: "sk-bf-abc", models });
		const settings = parseJSON(out.files[0].content);
		expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://localhost:8080/anthropic");
		expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-bf-abc");
		expect(settings.env.ANTHROPIC_MODEL).toBe("minimax/MiniMax-M2.1");
		expect(out.env!.posix).toContain("export ANTHROPIC_BASE_URL=http://localhost:8080/anthropic");
	});

	it("omits auth env line when apiKey is null", () => {
		const out = generateAgentConfig({ agent: "claude-code", baseUrl: "http://localhost:8080", apiKey: null, models });
		const settings = parseJSON(out.files[0].content);
		expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
	});
});

describe("codex", () => {
	it("writes a config.toml with the celer-route provider", () => {
		const out = generateAgentConfig({ agent: "codex", baseUrl: "http://localhost:8080", apiKey: "sk-bf-abc", models });
		const toml = out.files[0].content;
		expect(out.files[0].path).toBe("~/.codex/config.toml");
		expect(toml).toContain('model = "minimax/MiniMax-M2.1"');
		expect(toml).toContain('model_provider = "celer-route"');
		expect(toml).toContain("[model_providers.celer-route]");
		expect(toml).toContain('base_url = "http://localhost:8080/v1"');
		expect(toml).toContain('env_key = "CELER_ROUTE_API_KEY"');
		expect(out.env!.posix).toEqual(["export CELER_ROUTE_API_KEY=sk-bf-abc"]);
	});
});

describe("openai-compatible", () => {
	it("emits OPENAI_* env recipe for generic agents (hermes/openclaw)", () => {
		const out = generateAgentConfig({ agent: "openai-compatible", baseUrl: "http://localhost:8080/v1", apiKey: "sk-bf-abc", models });
		const content = out.files[0].content;
		expect(content).toContain("export OPENAI_BASE_URL=http://localhost:8080/v1");
		expect(content).toContain("export OPENAI_API_KEY=sk-bf-abc");
		expect(content).toContain("export OPENAI_MODEL=minimax/MiniMax-M2.1");
		expect(out.defaultModelRef).toBe("minimax/MiniMax-M2.1");
	});
});

describe("cursor", () => {
	it("produces in-app steps, not a config file", () => {
		const out = generateAgentConfig({ agent: "cursor", baseUrl: "http://localhost:8080", apiKey: "sk-bf-abc", models });
		expect(out.steps).toBeDefined();
		expect(out.steps!.length).toBeGreaterThan(0);
		expect(out.files[0].path).toBe("Cursor 内操作步骤");
		const joined = out.files[0].content;
		expect(joined).toContain("http://localhost:8080/v1");
		expect(joined).toContain("minimax/MiniMax-M2.1");
	});
});

describe("workbuddy", () => {
	it("writes a models.json with OpenAI-compatible chat-completions URL", () => {
		const out = generateAgentConfig({ agent: "workbuddy", baseUrl: "http://localhost:8080", apiKey: "sk-bf-abc", models });
		expect(out.files[0].path).toBe("~/.workbuddy/models.json");
		expect(out.defaultModelRef).toBe("minimax/MiniMax-M2.1");
		const doc = parseJSON(out.files[0].content);
		expect(doc.availableModels).toEqual(["minimax/MiniMax-M2.1", "sensenova/glm-5.2", "opencode/big-pickle"]);
		const [first, second] = doc.models;
		expect(first).toEqual({
			id: "minimax/MiniMax-M2.1",
			name: "MiniMax-M2.1",
			vendor: "OpenAI",
			url: "http://localhost:8080/v1/chat/completions",
			apiKey: "sk-bf-abc",
			maxInputTokens: 1_000_000,
			maxOutputTokens: 8192,
		});
		expect(second).toEqual({
			id: "sensenova/glm-5.2",
			name: "glm-5.2",
			vendor: "OpenAI",
			url: "http://localhost:8080/v1/chat/completions",
			apiKey: "sk-bf-abc",
		});
	});

	it("hoists the default model to the front of availableModels", () => {
		const out = generateAgentConfig({
			agent: "workbuddy",
			baseUrl: "http://localhost:8080",
			apiKey: "sk-bf-abc",
			models,
			defaultModelId: "opencode/big-pickle",
		});
		const doc = parseJSON(out.files[0].content);
		expect(doc.availableModels).toEqual(["opencode/big-pickle", "sensenova/glm-5.2", "minimax/MiniMax-M2.1"]);
		expect(doc.models[0].id).toBe("opencode/big-pickle");
	});

	it("omits apiKey when auth is disabled", () => {
		const out = generateAgentConfig({ agent: "workbuddy", baseUrl: "http://localhost:8080", apiKey: null, models });
		const doc = parseJSON(out.files[0].content);
		expect(doc.models[0].apiKey).toBeUndefined();
	});
});

describe("codebuddy", () => {
	it("writes ~/.codebuddy/models.json with the same shape", () => {
		const out = generateAgentConfig({ agent: "codebuddy", baseUrl: "http://localhost:8080/v1", apiKey: "sk-bf-abc", models });
		expect(out.files[0].path).toBe("~/.codebuddy/models.json");
		const doc = parseJSON(out.files[0].content);
		expect(doc.models[0].url).toBe("http://localhost:8080/v1/chat/completions");
		expect(doc.availableModels).toHaveLength(models.length);
	});
});

describe("trae", () => {
	it("produces in-app steps with the full /v1 base URL", () => {
		const out = generateAgentConfig({ agent: "trae", baseUrl: "http://localhost:8080", apiKey: "sk-bf-abc", models });
		expect(out.steps!.length).toBeGreaterThan(0);
		const joined = out.files[0].content;
		expect(joined).toContain("http://localhost:8080/v1");
		expect(joined).toContain("sk-bf-abc");
		expect(joined).toContain("minimax/MiniMax-M2.1");
	});
});

describe("zcode", () => {
	it("produces in-app steps for a custom OpenAI-compatible endpoint", () => {
		const out = generateAgentConfig({ agent: "zcode", baseUrl: "http://localhost:8080", apiKey: "sk-bf-abc", models });
		expect(out.steps!.length).toBeGreaterThan(0);
		const joined = out.files[0].content;
		expect(joined).toContain("http://localhost:8080/v1");
		expect(joined).toContain("OpenAI");
	});
});

describe("marscode", () => {
	it("emits the OPENAI_* env recipe", () => {
		const out = generateAgentConfig({ agent: "marscode", baseUrl: "http://localhost:8080", apiKey: "sk-bf-abc", models });
		const content = out.files[0].content;
		expect(content).toContain("export OPENAI_BASE_URL=http://localhost:8080/v1");
		expect(content).toContain("export OPENAI_API_KEY=sk-bf-abc");
		expect(content).toContain("export OPENAI_MODEL=minimax/MiniMax-M2.1");
	});
});

describe("lingma", () => {
	it("produces Tongyi Lingma in-app steps", () => {
		const out = generateAgentConfig({ agent: "lingma", baseUrl: "http://localhost:8080", apiKey: "sk-bf-abc", models });
		expect(out.steps!.length).toBeGreaterThan(0);
		const joined = out.files[0].content;
		expect(joined).toContain("通义灵码");
		expect(joined).toContain("http://localhost:8080/v1");
		expect(joined).toContain("sk-bf-abc");
	});
});

describe("platforms", () => {
	it("renders Windows config paths with %USERPROFILE% and backslashes", () => {
		expect(
			generateAgentConfig({ agent: "opencode", baseUrl: "http://localhost:8080", apiKey: "k", models, platform: "windows" }).files[0].path,
		).toBe("%USERPROFILE%\\.config\\opencode\\opencode.json");
		expect(
			generateAgentConfig({ agent: "claude-code", baseUrl: "http://localhost:8080", apiKey: "k", models, platform: "windows" }).files[0]
				.path,
		).toBe("%USERPROFILE%\\.claude\\settings.json");
		expect(
			generateAgentConfig({ agent: "codex", baseUrl: "http://localhost:8080", apiKey: "k", models, platform: "windows" }).files[0].path,
		).toBe("%USERPROFILE%\\.codex\\config.toml");
		expect(
			generateAgentConfig({ agent: "workbuddy", baseUrl: "http://localhost:8080", apiKey: "k", models, platform: "windows" }).files[0].path,
		).toBe("%USERPROFILE%\\.workbuddy\\models.json");
		expect(
			generateAgentConfig({ agent: "codebuddy", baseUrl: "http://localhost:8080", apiKey: "k", models, platform: "windows" }).files[0].path,
		).toBe("%USERPROFILE%\\.codebuddy\\models.json");
	});

	it("keeps POSIX paths on macOS and Linux", () => {
		expect(
			generateAgentConfig({ agent: "opencode", baseUrl: "http://localhost:8080", apiKey: "k", models, platform: "macos" }).files[0].path,
		).toBe("~/.config/opencode/opencode.json");
		expect(
			generateAgentConfig({ agent: "claude-code", baseUrl: "http://localhost:8080", apiKey: "k", models, platform: "linux" }).files[0].path,
		).toBe("~/.claude/settings.json");
	});

	it("emits PowerShell and cmd env lines for Windows", () => {
		const out = generateAgentConfig({
			agent: "claude-code",
			baseUrl: "http://localhost:8080",
			apiKey: "sk-bf-abc",
			models,
			platform: "windows",
		});
		expect(out.env!.posix).toContain("export ANTHROPIC_BASE_URL=http://localhost:8080/anthropic");
		expect(out.env!.powershell).toContain('$env:ANTHROPIC_BASE_URL = "http://localhost:8080/anthropic"');
		expect(out.env!.cmd).toContain("set ANTHROPIC_BASE_URL=http://localhost:8080/anthropic");
	});

	it("renders the settings.json env identically on every platform", () => {
		const mac = generateAgentConfig({ agent: "claude-code", baseUrl: "http://localhost:8080", apiKey: "k", models, platform: "macos" });
		const win = generateAgentConfig({ agent: "claude-code", baseUrl: "http://localhost:8080", apiKey: "k", models, platform: "windows" });
		expect(mac.files[0].content).toBe(win.files[0].content);
	});

	it("adapts the Cursor settings shortcut to the platform", () => {
		expect(
			generateAgentConfig({ agent: "cursor", baseUrl: "http://localhost:8080", apiKey: "k", models, platform: "macos" }).files[0].content,
		).toContain("Settings（⌘,）");
		expect(
			generateAgentConfig({ agent: "cursor", baseUrl: "http://localhost:8080", apiKey: "k", models, platform: "windows" }).files[0].content,
		).toContain("Settings（Ctrl+,）");
	});

	it("envTabCode layers PowerShell + cmd blocks on Windows and plain exports on POSIX", () => {
		const env = generateAgentConfig({
			agent: "openai-compatible",
			baseUrl: "http://localhost:8080",
			apiKey: "k",
			models,
			platform: "windows",
		}).env!;
		const windows = envTabCode(env, "windows");
		expect(windows).toContain("# PowerShell:");
		expect(windows).toContain('$env:OPENAI_BASE_URL = "http://localhost:8080/v1"');
		expect(windows).toContain("# cmd:");
		expect(windows).toContain("set OPENAI_BASE_URL=http://localhost:8080/v1");
		expect(envTabCode(env, "linux")).toContain("export OPENAI_BASE_URL=http://localhost:8080/v1");
	});

	it("defaults to the linux (POSIX) flavor when platform is omitted", () => {
		const out = generateAgentConfig({ agent: "codex", baseUrl: "http://localhost:8080", apiKey: "sk-bf-abc", models });
		expect(out.files[0].path).toBe("~/.codex/config.toml");
		expect(out.env!.posix).toEqual(["export CELER_ROUTE_API_KEY=sk-bf-abc"]);
		expect(out.env!.powershell).toEqual(['$env:CELER_ROUTE_API_KEY = "sk-bf-abc"']);
	});
});

describe("buildApplyCommand", () => {
	it("backs up and JSON-deep-merges opencode config on POSIX (never overwrites)", () => {
		const out = generateAgentConfig({
			agent: "opencode",
			baseUrl: "http://localhost:8080",
			apiKey: "sk-bf-abc",
			models,
			platform: "linux",
		});
		const cmd = buildApplyCommand(out, "linux")!;
		expect(cmd).toContain(`mkdir -p "$HOME/.config/opencode"`);
		expect(cmd).toContain(`if [ -f "$HOME/.config/opencode/opencode.json" ]; then`);
		expect(cmd).toContain(`cp -p "$HOME/.config/opencode/opencode.json"`);
		// The merge program is a single base64-encoded python3 -c line — never a
		// heredoc, so terminal auto-indent cannot corrupt Python indentation.
		expect(cmd).toContain(`python3 -c "import base64,sys; exec(base64.b64decode('\\''`);
		expect(cmd).not.toContain("PYEOF");
		expect(cmd).not.toContain("<<");
		const prog = embeddedProgram(cmd);
		expect(prog).toContain("ours = json.loads(base64.b64decode(");
		expect(prog).toContain("json.dump(root,");
		// Precise merge, not wholesale replacement.
		expect(cmd).not.toContain("cat > ");
		expect(cmd).not.toContain("CELER_ROUTE_EOF");
	});

	it("backs up and JSON-deep-merges on Windows via ConvertFrom-Json", () => {
		const out = generateAgentConfig({
			agent: "opencode",
			baseUrl: "http://localhost:8080",
			apiKey: "sk-bf-abc",
			models,
			platform: "windows",
		});
		const cmd = buildApplyCommand(out, "windows")!;
		expect(cmd).toContain(`$__p = "$env:USERPROFILE\\.config\\opencode\\opencode.json"`);
		expect(cmd).toContain("Copy-Item -LiteralPath $__p -Destination");
		expect(cmd).toContain("ConvertFrom-Json");
		expect(cmd).toContain("ConvertTo-Json -Depth 100");
		expect(cmd).toContain("New-Object System.Text.UTF8Encoding($false)");
	});

	it("merges the codex TOML by replacing only the celer-route pieces", () => {
		const out = generateAgentConfig({ agent: "codex", baseUrl: "http://localhost:8080", apiKey: "sk-bf-abc", models, platform: "windows" });
		const cmd = buildApplyCommand(out, "windows")!;
		expect(cmd).toContain(`$__mark = '[model_providers.celer-route]'`);
		expect(cmd).toContain("$__composed.Add('model_provider = \"' + $__prov + '\"')");
		expect(cmd).toContain("Copy-Item -LiteralPath $__p -Destination");
	});

	it("backs up and merges a workbuddy models.json on both platforms", () => {
		const mac = generateAgentConfig({ agent: "workbuddy", baseUrl: "http://localhost:8080", apiKey: "k", models });
		const cmdMac = buildApplyCommand(mac, "macos")!;
		expect(cmdMac).toContain(`"$HOME/.workbuddy/models.json"`);
		const macProg = embeddedProgram(cmdMac);
		expect(macProg).toContain('root["models"] = models');
		expect(macProg).toContain("availableModels");
		const win = generateAgentConfig({ agent: "workbuddy", baseUrl: "http://localhost:8080", apiKey: "k", models, platform: "windows" });
		const cmdWin = buildApplyCommand(win, "windows")!;
		expect(cmdWin).toContain("$env:USERPROFILE\\.workbuddy\\models.json");
		expect(cmdWin).toContain("$__root.models = @($__models)");
	});

	it("set-or-appends .env on POSIX and appends a source hint", () => {
		const out = generateAgentConfig({
			agent: "openai-compatible",
			baseUrl: "http://localhost:8080",
			apiKey: "sk-bf-abc",
			models,
			platform: "linux",
		});
		const cmd = buildApplyCommand(out, "linux")!;
		const prog = embeddedProgram(cmd);
		expect(prog).toContain(`("OPENAI_BASE_URL", "http://localhost:8080/v1")`);
		expect(prog).toContain('s.startswith(k + "=")');
		// The .env write happens in an sh subprocess, so self-sourcing would not
		// persist to the user's interactive session — we guide them instead.
		expect(cmd.split("\n").some((l) => l.startsWith("source .env"))).toBe(false);
		expect(cmd).toContain("请在当前终端执行 source .env 使环境变量生效");
	});

	it("returns null for in-app-steps-only clients", () => {
		for (const agent of ["cursor", "trae", "zcode", "lingma"] as const) {
			const out = generateAgentConfig({ agent, baseUrl: "http://localhost:8080", apiKey: "k", models, platform: "linux" });
			expect(buildApplyCommand(out, "linux")).toBeNull();
		}
	});

	it("embeds a payload that equals the rendered content for a fresh install", () => {
		const out = generateAgentConfig({
			agent: "opencode",
			baseUrl: "http://localhost:8080",
			apiKey: "sk-bf-abc",
			models,
			platform: "linux",
		});
		const cmd = buildApplyCommand(out, "linux")!;
		// The config payload is double base64-encoded (content inside the python
		// program, which is itself base64 in the command) — decode both layers.
		const prog = embeddedProgram(cmd);
		const match = prog.match(/base64\.b64decode\("([^"]+)"\)/);
		expect(match).not.toBeNull();
		expect(globalThis.atob(match![1])).toBe(out.files[0].content);
	});

	it("wraps the POSIX command in a single sh -c argument with escaped inner quotes", () => {
		const out = generateAgentConfig({ agent: "codex", baseUrl: "http://localhost:8080", apiKey: "k", models, platform: "linux" });
		const cmd = buildApplyCommand(out, "linux")!;
		// Any interactive shell (bash/zsh/fish/dash) runs this one command; the
		// script body is a single single-quoted argument, so no shell-specific
		// syntax is exposed.
		expect(cmd.startsWith("sh -c '")).toBe(true);
		expect(cmd.endsWith("'")).toBe(true);
		// Unescape the '…'\''…' idiom and confirm the POSIX script round-trips
		// intact: it must deliver python via a single-line -c (base64), never a
		// multi-line heredoc that terminal auto-indent could reindent.
		const unescaped = cmd.replace(/'\\''/g, "'");
		expect(unescaped).toContain(`mkdir -p "$HOME/.codex"`);
		expect(unescaped).toContain("exec(base64.b64decode('");
		expect(unescaped).not.toContain("<<");
		const prog = embeddedProgram(cmd);
		expect(prog).toContain("re.search(r'^model");
		expect(prog).toContain("[model_providers.celer-route]");
	});

	it("leaves the Windows PowerShell command unwrapped", () => {
		const out = generateAgentConfig({ agent: "opencode", baseUrl: "http://localhost:8080", apiKey: "k", models, platform: "windows" });
		const cmd = buildApplyCommand(out, "windows")!;
		expect(cmd.startsWith("sh -c")).toBe(false);
		expect(cmd).toContain("Copy-Item -LiteralPath $__p -Destination");
	});
});

const hasShAndPython3 = (() => {
	try {
		execFileSync("sh", ["-c", "command -v python3 >/dev/null 2>&1"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

describe("buildApplyCommand runtime (real sh -c execution)", () => {
	it.skipIf(!hasShAndPython3)("writes a fresh opencode config to a temp HOME", () => {
		const home = mkdtempSync(path.join(tmpdir(), "agentcfg-opencode-"));
		const out = generateAgentConfig({
			agent: "opencode",
			baseUrl: "http://localhost:8080",
			apiKey: "sk-bf-abc",
			models,
			platform: "linux",
		});
		const cmd = buildApplyCommand(out, "linux")!;
		execFileSync("sh", ["-c", cmd], { env: { ...process.env, HOME: home } });
		const cfg = parseJSON(readFileSync(path.join(home, ".config/opencode/opencode.json"), "utf8"));
		expect(cfg.provider["celer-route"].options.baseURL).toBe("http://localhost:8080/v1");
		expect(cfg.provider["celer-route"].options.apiKey).toBe("sk-bf-abc");
	});

	it.skipIf(!hasShAndPython3)("merges into an existing config without clobbering unrelated keys", () => {
		const home = mkdtempSync(path.join(tmpdir(), "agentcfg-merge-"));
		mkdirSync(path.join(home, ".config/opencode"), { recursive: true });
		writeFileSync(
			path.join(home, ".config/opencode/opencode.json"),
			JSON.stringify({ $schema: "older", model: "some/other", keepMe: { a: 1 } }, null, 2),
		);
		const out = generateAgentConfig({
			agent: "opencode",
			baseUrl: "http://localhost:8080",
			apiKey: "sk-bf-abc",
			models,
			platform: "macos",
		});
		const cmd = buildApplyCommand(out, "macos")!;
		execFileSync("sh", ["-c", cmd], { env: { ...process.env, HOME: home } });
		const cfg = parseJSON(readFileSync(path.join(home, ".config/opencode/opencode.json"), "utf8"));
		expect(cfg.keepMe).toEqual({ a: 1 });
		expect(cfg.model).toBe("celer-route/minimax/MiniMax-M2.1");
	});

	it.skipIf(!hasShAndPython3)("merges the codex TOML (exercises regex-literal escaping)", () => {
		const home = mkdtempSync(path.join(tmpdir(), "agentcfg-toml-"));
		const out = generateAgentConfig({ agent: "codex", baseUrl: "http://localhost:8080", apiKey: "sk-bf-abc", models, platform: "macos" });
		const cmd = buildApplyCommand(out, "macos")!;
		execFileSync("sh", ["-c", cmd], { env: { ...process.env, HOME: home } });
		const toml = readFileSync(path.join(home, ".codex/config.toml"), "utf8");
		expect(toml).toContain('model = "minimax/MiniMax-M2.1"');
		expect(toml).toContain("[model_providers.celer-route]");
		expect(toml).toContain('base_url = "http://localhost:8080/v1"');
	});

	it.skipIf(!hasShAndPython3)("survives terminal auto-indent that flattens pasted continuation lines", () => {
		// Regression: iTerm/Warp-style smart paste adds uniform leading blanks
		// to every continuation line. With a multi-line python heredoc this
		// destroyed the indentation (IndentationError). The base64 python3 -c
		// design must be immune to any number of leading blanks.
		const home = mkdtempSync(path.join(tmpdir(), "agentcfg-flat-"));
		mkdirSync(path.join(home, ".config/opencode"), { recursive: true });
		writeFileSync(path.join(home, ".config/opencode/opencode.json"), '{"keepMe":{"a":1},"model":"old"}');
		const out = generateAgentConfig({
			agent: "opencode",
			baseUrl: "http://localhost:8080",
			apiKey: "sk-bf-abc",
			models,
			platform: "macos",
		});
		const cmd = buildApplyCommand(out, "macos")!;
		const indented = cmd
			.split("\n")
			.map((l, i) => (i === 0 ? l : `${" ".repeat(31)}${l}`))
			.join("\n");
		execFileSync("sh", ["-c", indented], { env: { ...process.env, HOME: home } });
		const cfg = parseJSON(readFileSync(path.join(home, ".config/opencode/opencode.json"), "utf8"));
		expect(cfg.keepMe).toEqual({ a: 1 });
		expect(cfg.model).toBe("celer-route/minimax/MiniMax-M2.1");
	});

	it.skipIf(!hasShAndPython3)("writes the env-only .env in the current directory", () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "agentcfg-env-"));
		const home = mkdtempSync(path.join(tmpdir(), "agentcfg-envhome-"));
		const out = generateAgentConfig({
			agent: "openai-compatible",
			baseUrl: "http://localhost:8080/v1",
			apiKey: "sk-bf-abc",
			models,
			platform: "linux",
		});
		const cmd = buildApplyCommand(out, "linux")!;
		execFileSync("sh", ["-c", `cd '${cwd}' && ${cmd}`], { env: { ...process.env, HOME: home } });
		const env = readFileSync(path.join(cwd, ".env"), "utf8");
		expect(env).toContain("OPENAI_BASE_URL=http://localhost:8080/v1");
		expect(env).toContain("OPENAI_API_KEY=sk-bf-abc");
		expect(existsSync(path.join(home, ".env"))).toBe(false);
	});
});

describe("agent groups", () => {
	it("covers every agent id exactly once", () => {
		const all = AGENT_GROUPS.flatMap((g) => g.agents);
		expect(new Set(all).size).toBe(all.length);
		expect(new Set(all).size).toBe(CODING_AGENTS.length);
	});
});

describe("generateAgentConfig", () => {
	it("returns modelIds mirroring the input order", () => {
		const out = generateAgentConfig({ agent: "codex", baseUrl: "http://localhost:8080", apiKey: "sk-bf-abc", models });
		expect(out.modelIds).toEqual(["minimax/MiniMax-M2.1", "sensenova/glm-5.2", "opencode/big-pickle"]);
	});

	it("falls back to the first model when defaultModelId is unknown", () => {
		const out = generateAgentConfig({
			agent: "codex",
			baseUrl: "http://localhost:8080",
			apiKey: "sk-bf-abc",
			models,
			defaultModelId: "does/not-exist",
		});
		expect(out.defaultModelRef).toBe("minimax/MiniMax-M2.1");
	});

	it("handles every agent id without throwing", () => {
		const agents: CodingAgentId[] = [
			"opencode",
			"claude-code",
			"codex",
			"openai-compatible",
			"cursor",
			"workbuddy",
			"codebuddy",
			"trae",
			"zcode",
			"marscode",
			"lingma",
		];
		for (const agent of agents) {
			expect(() => generateAgentConfig({ agent, baseUrl: "http://localhost:8080", apiKey: null, models })).not.toThrow();
		}
	});

	it("uses the shared provider key consistently", () => {
		expect(AGENT_PROVIDER_KEY).toBe("celer-route");
	});
});