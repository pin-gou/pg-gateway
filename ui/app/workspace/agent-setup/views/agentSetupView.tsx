import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ProgressIndicator } from "@/components/ui/wizard/progressIndicator";
import type { TestCommandTab } from "@/components/testCommandPanel";
import type { ClientPlatform } from "@/lib/types/platform";
import { useGetCoreConfigQuery, useGetVirtualKeysQuery } from "@/lib/store";
import { useV1Models, type V1Model } from "@/lib/hooks/useV1Models";
import {
	buildApplyCommand,
	envTabCode,
	generateAgentConfig,
	toOpenAISurface,
	type AgentConfigOutput,
	type AgentModelInput,
	type CodingAgentId,
} from "@/lib/utils/agentConfigs";
import { detectPlatform } from "@/lib/utils/platform";
import { buildExamples, resolveEndpointUrl } from "@/lib/utils/testCommandSnippets";
import { parseAsStringLiteral, useQueryStates } from "nuqs";
import { ChevronLeft, ChevronRight, TerminalSquare } from "lucide-react";
import ClientStep from "./steps/clientStep";
import EndpointStep from "./steps/endpointStep";
import ModelsStep from "./steps/modelsStep";
import OutputStep from "./steps/outputStep";

const PLATFORMS = ["macos", "windows", "linux"] as const;
const STEP_IDS = ["client", "endpoint", "models", "output"] as const;
type StepId = (typeof STEP_IDS)[number];

// requiresModelSubset is the set of agents whose config embeds an explicit
// list of models. opencode writes a `models` block under `provider`;
// WorkBuddy / CodeBuddy write the `models[]` array into models.json. The
// other agents only carry a single default-model reference (ANTHROPIC_MODEL,
// codex `model`, OPENAI_MODEL, in-app step), so the picker collapses to a
// single dropdown sourced from the live /v1/models catalog.
const REQUIRES_MODEL_SUBSET: ReadonlySet<CodingAgentId> = new Set(["opencode", "workbuddy", "codebuddy"]);

function requiresModelSubset(agent: CodingAgentId): boolean {
	return REQUIRES_MODEL_SUBSET.has(agent);
}

function toAgentModel(m: V1Model): AgentModelInput {
	const ctx = m.context_length ?? m.max_input_tokens;
	return {
		id: m.id,
		name: m.name,
		contextLength: ctx,
		maxOutputTokens: m.max_output_tokens,
	};
}

export default function AgentSetupView() {
	const { t } = useTranslation("agent-setup");

	const [agent, setAgent] = useState<CodingAgentId>("opencode");
	const [baseUrl, setBaseUrl] = useState<string>(() => resolveEndpointUrl());
	const [protocol, setProtocol] = useState<"chat" | "responses">("chat");
	const [search, setSearch] = useState("");
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [defaultModelId, setDefaultModelId] = useState<string>("");
	const [selectedApiKeyId, setSelectedApiKeyId] = useState<string>("");
	const [step, setStep] = useState(0);

	const [urlPlatform, setUrlPlatform] = useQueryStates({ platform: parseAsStringLiteral(PLATFORMS) }, { history: "replace" });
	const platform: ClientPlatform = urlPlatform.platform ?? detectPlatform();
	const setPlatform = (p: ClientPlatform) => setUrlPlatform({ platform: p });

	const showModelSubset = requiresModelSubset(agent);

	const { data: bifrostConfig, isSuccess: configSettled, isError: configFailed } = useGetCoreConfigQuery({});
	const authDecided = configSettled || configFailed;
	const enforceAuth = authDecided && !!bifrostConfig?.client_config?.enforce_auth_on_inference;
	const { data: vksResponse } = useGetVirtualKeysQuery(undefined, { skip: !enforceAuth });
	const vks = useMemo(() => vksResponse?.virtual_keys ?? [], [vksResponse]);

	const selectedApiKey = useMemo(() => vks.find((v) => v.id === selectedApiKeyId) ?? vks[0] ?? null, [vks, selectedApiKeyId]);
	const apiKey = enforceAuth ? (selectedApiKey?.value ?? null) : null;

	const modelsSkip = !authDecided || (enforceAuth && !selectedApiKey);

	const { models: v1Models, isLoading: isLoadingModels, error: v1Error, refetch } = useV1Models(baseUrl, apiKey, modelsSkip);

	useEffect(() => {
		setSelectedIds((prev) => {
			const valid = new Set<string>();
			for (const id of prev) if (v1Models.some((m) => m.id === id)) valid.add(id);
			return valid;
		});
		setDefaultModelId((prev) => (v1Models.some((m) => m.id === prev) ? prev : ""));
	}, [v1Models]);

	const filteredModels = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return v1Models;
		return v1Models.filter((m) => m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q));
	}, [v1Models, search]);

	const allVisibleSelected = useMemo(
		() => filteredModels.length > 0 && filteredModels.every((m) => selectedIds.has(m.id)),
		[filteredModels, selectedIds],
	);

	const toggleModel = (id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const toggleAllVisible = () => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			for (const m of filteredModels) {
				if (allVisibleSelected) next.delete(m.id);
				else next.add(m.id);
			}
			return next;
		});
	};

	const selectedModelInputs = useMemo(() => v1Models.filter((m) => selectedIds.has(m.id)).map(toAgentModel), [v1Models, selectedIds]);

	const defaultModelPool = useMemo(
		() => (showModelSubset ? selectedModelInputs : v1Models.map(toAgentModel)),
		[showModelSubset, selectedModelInputs, v1Models],
	);

	const effectiveDefaultModelId = useMemo(() => {
		if (defaultModelId && defaultModelPool.some((m) => m.id === defaultModelId)) return defaultModelId;
		return defaultModelPool[0]?.id ?? "";
	}, [defaultModelPool, defaultModelId]);

	const output: AgentConfigOutput | null = useMemo(() => {
		if (showModelSubset && selectedModelInputs.length === 0) return null;
		if (!showModelSubset && v1Models.length === 0) return null;
		return generateAgentConfig({
			agent,
			baseUrl,
			apiKey,
			models: showModelSubset ? selectedModelInputs : v1Models.map(toAgentModel),
			defaultModelId: effectiveDefaultModelId,
			protocol: agent === "opencode" ? protocol : undefined,
			platform,
		});
	}, [agent, baseUrl, apiKey, selectedModelInputs, v1Models, showModelSubset, effectiveDefaultModelId, protocol, platform]);

	const tabs = useMemo(() => {
		if (!output) return [];
		const result: TestCommandTab[] = [];
		const apply = buildApplyCommand(output, platform);
		if (apply) {
			result.push({
				id: "apply",
				label: t("applyTab"),
				code: apply,
				description: platform === "windows" ? t("applyTabDescription") : `${t("applyTabDescription")}\n${t("applyTabShellHint")}`,
				copyLabel: t("copy"),
				copiedLabel: t("copied"),
				copyText: t("copy"),
				copySuccessMessage: t("copySuccess"),
			});
		}
		for (const [i, f] of output.files.entries()) {
			result.push({
				id: `file-${i}`,
				label: f.path,
				code: f.content,
				description: t("fileTabDescription", { path: f.path }),
				copyLabel: t("copy"),
				copiedLabel: t("copied"),
				copyText: t("copy"),
				copySuccessMessage: t("copySuccess"),
			});
		}
		const envCode = output.env ? envTabCode(output.env, platform) : "";
		if (envCode.length > 0 && !output.files.some((f) => f.content === envCode)) {
			result.push({
				id: "env",
				label: t("envTab"),
				code: envCode,
				description: t("envTabDescription"),
				copyLabel: t("copy"),
				copiedLabel: t("copied"),
				copyText: t("copy"),
				copySuccessMessage: t("copySuccess"),
			});
		}
		if (effectiveDefaultModelId) {
			const probe = buildExamples(toOpenAISurface(baseUrl), effectiveDefaultModelId, apiKey, platform);
			result.push({
				id: "test",
				label: t("testTab"),
				code: probe.curl,
				description: t("testTabDescription"),
				copyLabel: t("copy"),
				copiedLabel: t("copied"),
				copyText: t("copy"),
				copySuccessMessage: t("copySuccess"),
			});
		}
		return result;
	}, [output, t, effectiveDefaultModelId, baseUrl, apiKey, platform]);

	const noModelPickedError = showModelSubset && selectedModelInputs.length === 0;

	const stepId: StepId = STEP_IDS[step];
	const isFirst = step === 0;
	const isLast = step === STEP_IDS.length - 1;

	const canProceed = useMemo(() => {
		if (stepId === "client") return true;
		if (stepId === "endpoint") return true;
		if (stepId === "models") {
			if (showModelSubset) return selectedModelInputs.length > 0;
			return v1Models.length > 0;
		}
		return true;
	}, [stepId, showModelSubset, selectedModelInputs.length, v1Models.length]);

	const stepLabels = useMemo(() => STEP_IDS.map((id) => t(`step.${id}`)), [t]);

	const handleNext = () => {
		if (!canProceed) return;
		setStep((s) => Math.min(s + 1, STEP_IDS.length - 1));
	};

	const handleBack = () => {
		setStep((s) => Math.max(s - 1, 0));
	};

	const handleStepClick = (target: number) => {
		if (target === step) return;
		// Only allow jumping back, or jumping forward if every intermediate
		// step is satisfied. Forward jumps skip canProceed so they trust
		// prior completion; backward jumps are always free.
		if (target > step) {
			for (let i = 0; i < target; i++) {
				const sid: StepId = STEP_IDS[i];
				if (sid === "models") {
					if (showModelSubset && selectedModelInputs.length === 0) return;
					if (!showModelSubset && v1Models.length === 0) return;
				}
			}
		}
		setStep(target);
	};

	return (
		<div className="mx-auto w-full max-w-4xl space-y-6 py-6">
			<div className="space-y-1">
				<h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
					<TerminalSquare className="text-muted-foreground h-5 w-5" />
					{t("title")}
				</h2>
				<p className="text-muted-foreground text-sm">{t("subtitle")}</p>
			</div>

			<ProgressIndicator
				currentStep={step}
				totalSteps={STEP_IDS.length}
				stepIds={STEP_IDS}
				labels={stepLabels}
				testIdPrefix="agent-setup"
				onStepClick={handleStepClick}
			/>

			<Card className="bg-card gap-0 border py-0 shadow-sm">
				<CardContent className="space-y-6 px-6 py-6">
					{stepId === "client" && <ClientStep agent={agent} onAgentChange={setAgent} platform={platform} onPlatformChange={setPlatform} />}
					{stepId === "endpoint" && (
						<EndpointStep
							agent={agent}
							baseUrl={baseUrl}
							onBaseUrlChange={setBaseUrl}
							protocol={protocol}
							onProtocolChange={setProtocol}
							enforceAuth={enforceAuth}
							virtualKeys={vks}
							selectedApiKeyId={selectedApiKey?.id ?? ""}
							selectedApiKeyName={selectedApiKey?.name ?? ""}
							onSelectedApiKeyIdChange={setSelectedApiKeyId}
						/>
					)}
					{stepId === "models" && (
						<ModelsStep
							agent={agent}
							showModelSubset={showModelSubset}
							v1Models={v1Models}
							isLoadingModels={isLoadingModels}
							v1Error={v1Error}
							onRefetch={refetch}
							search={search}
							onSearchChange={setSearch}
							selectedIds={selectedIds}
							onToggleModel={toggleModel}
							onToggleAllVisible={toggleAllVisible}
							allVisibleSelected={allVisibleSelected}
							defaultModelId={effectiveDefaultModelId}
							onDefaultModelIdChange={setDefaultModelId}
							defaultModelPool={defaultModelPool}
							toAgentModel={toAgentModel}
						/>
					)}
					{stepId === "output" && <OutputStep output={output} tabs={tabs} noModelPickedError={noModelPickedError} />}
				</CardContent>
				<CardFooter className="flex items-center justify-between border-t px-6 py-4">
					<Button variant="ghost" size="sm" disabled={isFirst} onClick={handleBack} data-testid="agent-setup-back">
						<ChevronLeft className="mr-1 h-4 w-4" />
						{t("back")}
					</Button>
					<div className="flex items-center gap-2">
						{isLast ? (
							<Button size="sm" variant="outline" onClick={() => setStep(0)} data-testid="agent-setup-edit">
								{t("edit")}
							</Button>
						) : (
							<Button size="sm" disabled={!canProceed} onClick={handleNext} data-testid="agent-setup-next">
								{t("next")}
								<ChevronRight className="ml-1 h-4 w-4" />
							</Button>
						)}
					</div>
				</CardFooter>
			</Card>
		</div>
	);
}