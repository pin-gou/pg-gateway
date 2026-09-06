import { TestCommandTabs } from "@/components/testCommandPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { writeClipboard } from "@/hooks/useCopyToClipboard";
import { useGetModelsQuery, useGetProvidersQuery } from "@/lib/store/apis/providersApi";
import { useGetVirtualKeysQuery } from "@/lib/store/apis/governanceApi";
import { useGetCoreConfigQuery } from "@/lib/store";
import { RenderProviderIcon } from "@/lib/constants/icons";
import { getProviderLabel } from "@/lib/constants/logs";
import { buildExamples, resolveEndpointUrl } from "@/lib/utils/testCommandSnippets";
import { Copy, KeyRound, Sparkles, Terminal } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

interface Props {
	endpointUrl?: string;
}

export default function EndpointCard({ endpointUrl }: Props) {
	const { t } = useTranslation("common");
	const { data: providers } = useGetProvidersQuery();
	const { data: bifrostConfig } = useGetCoreConfigQuery({});
	const url = endpointUrl ?? resolveEndpointUrl();

	const enforceAuth = !!bifrostConfig?.client_config?.enforce_auth_on_inference;
	const { data: vksResponse } = useGetVirtualKeysQuery(undefined, { skip: !enforceAuth });
	const vks = useMemo(() => vksResponse?.virtual_keys ?? [], [vksResponse]);

	const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
	const [selectedModel, setSelectedModel] = useState("");
	const [selectedVkId, setSelectedVkId] = useState<string>("");

	const providerNames = useMemo(() => {
		const seen = new Set<string>();
		return (providers ?? [])
			.filter((p) => {
				if (seen.has(p.name)) return false;
				seen.add(p.name);
				return true;
			})
			.map((p) => p.name);
	}, [providers]);

	useEffect(() => {
		if (!selectedProvider && providerNames.length > 0) {
			setSelectedProvider(providerNames[0]);
		}
	}, [providerNames, selectedProvider]);

	useEffect(() => {
		if (!selectedVkId && vks.length > 0) setSelectedVkId(vks[0].id);
	}, [vks, selectedVkId]);

	const selectedVk = useMemo(() => vks.find((v) => v.id === selectedVkId), [vks, selectedVkId]);

	const { data: modelsData, isFetching: isFetchingModels } = useGetModelsQuery(
		{ provider: selectedProvider ?? "", limit: 200 },
		{ skip: !selectedProvider },
	);
	const models = useMemo(() => {
		const seen = new Set<string>();
		const list: string[] = [];
		for (const m of modelsData?.models ?? []) {
			if (!seen.has(m.name)) {
				seen.add(m.name);
				list.push(m.name);
			}
		}
		return list;
	}, [modelsData]);

	useEffect(() => {
		if (!selectedModel && models.length > 0) setSelectedModel(models[0]);
	}, [models, selectedModel]);

	const model = selectedModel || "gpt-4o-mini";
	const examples = useMemo(
		() => buildExamples(url, model, enforceAuth ? (selectedVk?.value ?? null) : null),
		[url, model, enforceAuth, selectedVk],
	);

	const tabs = useMemo(
		() =>
			[
				{ id: "curl", label: t("codeTabs.curl"), code: examples.curl },
				{ id: "python", label: t("codeTabs.python"), code: examples.python },
				{ id: "node", label: t("codeTabs.node"), code: examples.node },
				{ id: "go", label: t("codeTabs.go"), code: examples.go },
			].map((tabItem) => ({ ...tabItem, copySuccessMessage: t("home.endpointCard.copied") })),
		[examples, t],
	);

	const handleCopy = async (text: string) => {
		if (await writeClipboard(text)) {
			toast.success(t("home.endpointCard.copied"));
		} else {
			toast.error("Copy failed");
		}
	};

	return (
		<Card className="bg-card gap-0 border py-0 shadow-sm" data-testid="home-endpoint-card">
			<CardHeader className="flex flex-row items-start justify-between gap-3 border-b px-6 py-4">
				<div className="space-y-1">
					<CardTitle className="text-base font-semibold">{t("home.endpointCard.title")}</CardTitle>
					<p className="text-muted-foreground text-xs">{t("home.endpointCard.subtitle")}</p>
				</div>
				<Button asChild size="sm" className="shrink-0" data-testid="home-endpoint-connect-client-cta">
					<Link to="/workspace/agent-setup">
						<Sparkles className="mr-1 h-4 w-4" />
						{t("home.endpointCard.connectClientCta")}
					</Link>
				</Button>
			</CardHeader>
			<CardContent className="space-y-4 px-6 py-4">
				<div className="bg-muted/40 flex items-center gap-2 rounded-md border p-3 font-mono text-sm">
					<code className="flex-1 truncate" data-testid="home-endpoint-url">
						{url}
					</code>
					<Button size="sm" variant="outline" onClick={() => void handleCopy(url)}>
						<Copy className="mr-1 h-4 w-4" />
						{t("home.endpointCard.copyLabel")}
					</Button>
				</div>

				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<div className="space-y-2">
						<Label htmlFor="home-endpoint-provider">{t("home.endpointCard.providerLabel")}</Label>
						<Select value={selectedProvider ?? ""} onValueChange={(v) => setSelectedProvider(v)}>
							<SelectTrigger id="home-endpoint-provider" className="w-full">
								<SelectValue placeholder={t("home.endpointCard.providerPlaceholder")} />
							</SelectTrigger>
							<SelectContent>
								{providerNames.map((p) => (
									<SelectItem key={p} value={p} data-testid={`home-endpoint-provider-option-${p}`}>
										<span className="flex items-center gap-2">
											<RenderProviderIcon
												provider={p as Parameters<typeof RenderProviderIcon>[0]["provider"]}
												size={16}
												className="mt-0 shrink-0"
											/>
											<span className="truncate">{getProviderLabel(p)}</span>
										</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-2">
						<Label htmlFor="home-endpoint-model">{t("home.endpointCard.modelLabel")}</Label>
						<Select value={selectedModel} onValueChange={(v) => setSelectedModel(v)} disabled={isFetchingModels}>
							<SelectTrigger id="home-endpoint-model" className="w-full">
								<SelectValue
									placeholder={
										isFetchingModels
											? "…"
											: models.length === 0
												? t("home.endpointCard.modelEmpty")
												: t("home.endpointCard.modelPlaceholder")
									}
								/>
							</SelectTrigger>
							<SelectContent>
								{models.length === 0 ? (
									<SelectItem value="__none__" disabled>
										—
									</SelectItem>
								) : (
									models.map((m) => (
										<SelectItem key={m} value={m} data-testid={`home-endpoint-model-option-${m}`}>
											{m}
										</SelectItem>
									))
								)}
							</SelectContent>
						</Select>
					</div>
				</div>

				{enforceAuth && (
					<div className="space-y-2">
						<Label htmlFor="home-endpoint-vk">{t("home.endpointCard.vkLabel")}</Label>
						<Select value={selectedVkId} onValueChange={(v) => setSelectedVkId(v)} disabled={vks.length === 0}>
							<SelectTrigger id="home-endpoint-vk" className="w-full">
								<SelectValue placeholder={vks.length === 0 ? t("home.endpointCard.vkEmpty") : t("home.endpointCard.vkPlaceholder")} />
							</SelectTrigger>
							<SelectContent>
								{vks.length === 0 ? (
									<SelectItem value="__none__" disabled>
										—
									</SelectItem>
								) : (
									vks.map((vk) => (
										<SelectItem key={vk.id} value={vk.id} data-testid={`home-endpoint-vk-option-${vk.name}`}>
											<span className="flex items-center gap-2">
												<KeyRound className="text-muted-foreground h-4 w-4 shrink-0" />
												<span className="truncate">{vk.name}</span>
											</span>
										</SelectItem>
									))
								)}
							</SelectContent>
						</Select>
					</div>
				)}

				<TestCommandTabs tabs={tabs} />

				<Link
					to="/workspace/agent-setup"
					className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs underline-offset-2 hover:underline"
					data-testid="home-endpoint-agent-setup-link"
				>
					<Terminal className="h-3.5 w-3.5" />
					{t("home.endpointCard.agentSetupLink")}
				</Link>
			</CardContent>
		</Card>
	);
}