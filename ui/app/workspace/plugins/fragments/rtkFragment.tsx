import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { MultiSelect, type MultiSelectGroup, type MultiSelectOption } from "@/components/ui/multiSelect";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useGetRtkStatsQuery, useUpdatePluginMutation } from "@/lib/store/apis/pluginsApi";
import { useGetRtkCavemanRulesQuery, useGetRtkRenderersQuery } from "@/lib/store/apis/rtkAdminApi";
import { RbacOperation, RbacResource, useRbac } from "@/lib/rbac";
import { RTK_PLUGIN, rtkConfigSchema, type Plugin, type RtkEngineStat } from "@/lib/types/plugins";
import { type CavemanRuleCatalogEntry, type RendererCatalogEntry } from "@/lib/types/rtk";
import { Link } from "@tanstack/react-router";
import { zodResolver } from "@hookform/resolvers/zod";
import { Activity, Beaker, ExternalLink, FlaskConical, HelpCircle, Image as ImageIcon, Info, RotateCcw, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RTKFormValues = z.input<typeof rtkConfigSchema>;
type Intensity = "minimal" | "standard" | "aggressive";

// ---------------------------------------------------------------------------
// effectiveMaxLines — front-end mirror of plugins/rtk/compression.go:668.
// Single source of truth: max(1, round(base * factor)) by intensity factor.
//   - minimal:   ×1.5
//   - standard:  ×1.0
//   - aggressive: ×0.5
// Showing this value helps users understand how their `max_lines_per_result`
// will actually behave under the chosen intensity.
// ---------------------------------------------------------------------------

function effectiveMaxLines(base: number, intensity: string): number {
	const v = Number(base);
	if (!Number.isFinite(v) || v <= 0) return 0;
	switch (intensity) {
		case "minimal":
			return Math.max(1, Math.round(v * 1.5));
		case "aggressive":
			return Math.max(1, Math.round(v * 0.5));
		default:
			return Math.max(1, Math.round(v));
	}
}

// ---------------------------------------------------------------------------
// toSkipRulesOption — projects one catalog row into the shape MultiSelect
// expects. The i18n key rtk.cavemanRule.<name> is consulted for the
// description so the label follows the active language; when the key is
// missing the catalog-provided label (English) is the fallback.
// ---------------------------------------------------------------------------

function toSkipRulesOption(rule: CavemanRuleCatalogEntry, description: string): MultiSelectOption {
	return {
		value: rule.name,
		label: rule.name,
		description,
	};
}

// splitCommaList is the shared parser used by the legacy comma-separated
// fields (preserve_patterns). Empty entries are dropped.
function splitCommaList(raw: string): string[] {
	if (!raw) return [];
	return raw
		.split(/\s*,\s*/)
		.map((s) => s.trim())
		.filter(Boolean);
}

// ---------------------------------------------------------------------------
// RTK_INTENSITY_PRESETS — bundled one-click presets. Values are tuned to match
// the existing tests' expectations and the documented defaults in config.go.
// Clicking a preset writes the relevant fields; the user can still tweak any
// field afterwards (the buttons are "jump-start", not "lock-in").
// ---------------------------------------------------------------------------

interface IntensityPreset {
	id: Intensity;
	intensity: Intensity;
	max_lines_per_result: number;
	max_chars_per_result: number;
	dedup_threshold: number;
	enable_grouping: boolean;
	grouping_threshold: number;
	min_tokens_to_compress: number;
}

const RTK_INTENSITY_PRESETS: Record<Intensity, IntensityPreset> = {
	minimal: {
		id: "minimal",
		intensity: "minimal",
		max_lines_per_result: 240,
		max_chars_per_result: 24000,
		dedup_threshold: 5,
		enable_grouping: false,
		grouping_threshold: 5,
		min_tokens_to_compress: 4000,
	},
	standard: {
		id: "standard",
		intensity: "standard",
		max_lines_per_result: 120,
		max_chars_per_result: 12000,
		dedup_threshold: 3,
		enable_grouping: false,
		grouping_threshold: 3,
		min_tokens_to_compress: 2000,
	},
	aggressive: {
		id: "aggressive",
		intensity: "aggressive",
		max_lines_per_result: 60,
		max_chars_per_result: 6000,
		dedup_threshold: 3,
		enable_grouping: true,
		grouping_threshold: 3,
		min_tokens_to_compress: 1000,
	},
};

// PRESET_FIELDS — the 7 fields that quick presets touch. Used by revertPreset
// to reset only these fields to their last-saved values without disturbing
// independent settings (scope, snapshot, renderers, etc.).
const PRESET_FIELDS: (keyof IntensityPreset & keyof RTKFormValues)[] = [
	"intensity",
	"max_lines_per_result",
	"max_chars_per_result",
	"dedup_threshold",
	"enable_grouping",
	"grouping_threshold",
	"min_tokens_to_compress",
];

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatCompactNumber(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
	}
	return String(value);
}

function formatBytes(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	const units = ["B", "kB", "MB", "GB"];
	let v = value;
	let i = 0;
	while (v >= 1000 && i < units.length - 1) {
		v /= 1000;
		i++;
	}
	return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function formatRatio(ratio: number): string {
	if (!Number.isFinite(ratio) || ratio <= 0) return "0%";
	const pct = Math.min(100, Math.max(0, ratio * 100));
	return `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
}

// ---------------------------------------------------------------------------
// EngineStatsRow — one row of the per-engine monitoring table. Surfaces
// invocations, input/output bytes and lifetime compressed_by ratio for a
// single registered engine. The id comes straight from the server's
// MetricsSnapshot.EngineBreakdown and is rendered verbatim so the UI
// stays accurate when a future engine is registered server-side.
// ---------------------------------------------------------------------------

function EngineStatsRow({ stat }: { stat: RtkEngineStat }) {
	const { t } = useTranslation("plugins");
	return (
		<div className="rounded-md border bg-zinc-50/30 px-3 py-2 dark:bg-zinc-800/20" data-testid={`rtk-engine-stats-${stat.id}`}>
			<div className="flex flex-wrap items-center justify-between gap-2 text-sm">
				<div className="flex items-center gap-2">
					<Badge variant="outline" className="font-mono text-[10px] uppercase">
						{stat.id}
					</Badge>
					<span className="text-muted-foreground text-xs">{t("rtk.engineRoleScope", { role: engineRoleScope(stat.id) })}</span>
				</div>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
					<span>
						<span className="text-muted-foreground">{t("rtk.engineInvocations")}: </span>
						<span className="font-medium">{formatCompactNumber(stat.invocations)}</span>
					</span>
					<span>
						<span className="text-muted-foreground">{t("rtk.engineInputBytes")}: </span>
						<span className="font-medium">{formatBytes(stat.inputBytes)}</span>
					</span>
					<span>
						<span className="text-muted-foreground">{t("rtk.engineOutputBytes")}: </span>
						<span className="font-medium">{formatBytes(stat.outputBytes)}</span>
					</span>
					<span>
						<span className="text-muted-foreground">{t("rtk.engineCompressedBy")}: </span>
						<span className="font-medium">{formatRatio(stat.compressedBy)}</span>
					</span>
				</div>
			</div>
		</div>
	);
}

// engineRoleScope returns a short human description of which message roles
// the given engine id targets, mirroring enginesForRole in
// plugins/rtk/compression.go. Unknown engine ids are labelled as "all roles"
// so future engines don't render as empty badges.
function engineRoleScope(id: string): string {
	switch (id) {
		case "rtk":
			return "tool / assistant";
		case "caveman":
			return "user";
		default:
			return "all roles";
	}
}

// ---------------------------------------------------------------------------
// MonitoringPanel — process-lifetime compression counters + per-engine
// breakdown. Polls /api/context/rtk/stats every 5s. The aggregate four
// cards retain their original data-testids (rtk-stats-*) so the existing
// rtkMonitoringPanel.test.tsx suite stays green; the per-engine rows
// sit below under a new rtk-engine-stats-* testid namespace and are
// hidden when the server reports no engine activity yet.
// ---------------------------------------------------------------------------

export function MonitoringPanel() {
	const { t } = useTranslation("plugins");
	const { data, isLoading } = useGetRtkStatsQuery(undefined, {
		pollingInterval: 5000,
	});

	const stats = data?.stats;
	const noActivity = !stats || (stats.invocations === 0 && stats.compressedCount === 0);
	const engineStats = stats?.engineBreakdown ?? [];

	if (isLoading && !stats) {
		return <div className="text-muted-foreground py-4 text-sm">{t("rtk.monitoringLoading")}</div>;
	}

	return (
		<div className="space-y-4" data-testid="rtk-monitoring-panel">
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
				<div data-testid="rtk-stats-invocations" className="rounded-lg border p-4 text-center">
					<div className="text-2xl font-bold">{formatCompactNumber(stats?.invocations ?? 0)}</div>
					<div className="text-muted-foreground text-xs">{t("rtk.totalInvocations")}</div>
				</div>
				<div data-testid="rtk-stats-compressed" className="rounded-lg border p-4 text-center">
					<div className="text-2xl font-bold">{formatCompactNumber(stats?.compressedCount ?? 0)}</div>
					<div className="text-muted-foreground text-xs">{t("rtk.compressedRequests")}</div>
				</div>
				<div data-testid="rtk-stats-tokens-saved" className="rounded-lg border p-4 text-center">
					<div className="text-2xl font-bold">{formatCompactNumber(stats?.tokensSaved ?? 0)}</div>
					<div className="text-muted-foreground text-xs">{t("rtk.tokensSaved")}</div>
				</div>
				<div data-testid="rtk-stats-compression-ratio" className="rounded-lg border p-4 text-center">
					<div className="text-2xl font-bold">{formatRatio(stats?.compressionRatio ?? 0)}</div>
					<div className="text-muted-foreground text-xs">{t("rtk.compressionRatio")}</div>
				</div>
			</div>

			{engineStats.length > 0 && (
				<div className="space-y-2" data-testid="rtk-engine-stats-group">
					<div className="text-muted-foreground text-xs font-medium uppercase">{t("rtk.engineStatsTitle")}</div>
					<div className="space-y-2">
						{engineStats.map((stat) => (
							<EngineStatsRow key={stat.id} stat={stat} />
						))}
					</div>
				</div>
			)}

			{noActivity && (
				<p className="text-muted-foreground text-center text-xs" data-testid="rtk-stats-empty">
					{t("rtk.noDataYet")}
				</p>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// HelpHint — small (?) icon with a tooltip; uses the shared Tooltip primitive.
// Used inline next to field labels to surface "when to change this" hints
// without bloating the FormDescription text.
// ---------------------------------------------------------------------------

function HelpHint({ children }: { children: React.ReactNode }) {
	return (
		<TooltipProvider delayDuration={150}>
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="text-muted-foreground inline-flex cursor-help items-center" tabIndex={0}>
						<HelpCircle className="h-3.5 w-3.5" />
					</span>
				</TooltipTrigger>
				<TooltipContent side="top" className="max-w-xs text-xs">
					{children}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

// ---------------------------------------------------------------------------
// IntensityPresetButtons — 3-button preset picker. Clicking writes the preset
// values into the form via setValue. The currently-selected preset is
// highlighted; if the user customizes any of the affected fields, the highlight
// disappears (computed from live form values).
// ---------------------------------------------------------------------------

function IntensityPresetButtons({
	intensity,
	onPick,
	disabled,
}: {
	intensity: string;
	onPick: (preset: IntensityPreset) => void;
	disabled?: boolean;
}) {
	const { t } = useTranslation("plugins");
	const order: Intensity[] = ["minimal", "standard", "aggressive"];
	return (
		<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
			{order.map((id) => {
				const active = intensity === id;
				return (
					<Button
						key={id}
						type="button"
						variant={active ? "default" : "outline"}
						className="h-auto justify-start px-4 py-3 text-left"
						onClick={() => onPick(RTK_INTENSITY_PRESETS[id])}
						disabled={disabled}
						data-testid={`rtk-preset-${id}`}
					>
						<div className="flex w-full flex-col items-start gap-1">
							<div className="flex items-center gap-2">
								<span className="text-sm font-semibold">{t(`rtk.intensity${id.charAt(0).toUpperCase()}${id.slice(1)}`)}</span>
								{active && (
									<Badge variant="secondary" className="text-[10px]">
										{t("rtk.presetActive")}
									</Badge>
								)}
							</div>
							<span className={`text-xs font-normal ${active ? "text-primary-foreground/80" : "text-muted-foreground"}`}>
								{t(`rtk.preset${id.charAt(0).toUpperCase()}${id.slice(1)}Hint`)}
							</span>
						</div>
					</Button>
				);
			})}
		</div>
	);
}

// ---------------------------------------------------------------------------
// EnabledSwitchPanel — top-level on/off toggle plus the pipeline checkboxes
// in one card. The on/off toggle mirrors ProvidercooldownFragment.EnabledSwitch
// UX: clicking flips plugin.enabled immediately and toasts success without a
// separate Save step. The pipeline checkboxes (RTK always-on, Caveman opt-in)
// live beneath the toggle because they describe *which* engines run when the
// plugin is on — collapsing them into the enablement zone keeps the "what gets
// executed" decision in one place.
//
// The Caveman checkbox is bound to form.caveman.enabled via the shared
// ConfigForm form instance; flipping it dirties the form but does not persist
// until the operator clicks Save (consistent with every other ConfigForm
// field). When the plugin is disabled, both checkboxes are visually disabled
// so the operator doesn't tune engines that won't run.
//
// We deliberately do NOT round-trip the existing config payload in the toggle
// handler — doing so would force the operator's untuned knobs (intensity,
// thresholds, renderers whitelist, etc.) to be persisted as part of a pure
// enable/disable action, which is surprising.
// ---------------------------------------------------------------------------

export function EnabledSwitchPanel({ plugin, form }: { plugin: Plugin; form: ReturnType<typeof useForm<RTKFormValues>> }) {
	const { t } = useTranslation("plugins");
	const hasUpdateAccess = useRbac(RbacResource.Plugins, RbacOperation.Update);
	const [updatePlugin, { isLoading }] = useUpdatePluginMutation();

	const handleToggle = async (checked: boolean) => {
		if (!hasUpdateAccess) return;
		try {
			// Mirror the switch into the inner config.enabled so the stored
			// row stays in sync with the plugin-level Enabled. The plugin-level
			// flag is the master switch (the framework removes disabled
			// plugins from the pipeline), but plugins/rtk/hooks.go also reads
			// config.Enabled at runtime — a stored enabled:false alongside an
			// enabled plugin-level flag silently disables compression even
			// though the UI switch reads "on". Round-tripping the existing
			// config preserves every other knob the operator has tuned; the
			// only field we overwrite here is enabled.
			const existingConfig = (plugin.config || {}) as Record<string, unknown>;
			await updatePlugin({
				name: RTK_PLUGIN,
				data: {
					enabled: checked,
					config: { ...existingConfig, enabled: checked },
				},
			}).unwrap();
			toast.success(checked ? t("rtk.enabledToast") : t("rtk.disabledToast"));
		} catch {
			toast.error(t("rtk.updateFailedToast"));
		}
	};

	const cavemanChecked = !!form.watch("caveman.enabled");
	const setCavemanEnabled = (v: boolean) => form.setValue("caveman.enabled", v, { shouldDirty: true });
	const checkboxesDisabled = !hasUpdateAccess || !plugin.enabled;

	return (
		<div className="rounded-lg border p-4" data-testid="rtk-enabled-section">
			<div className="flex flex-row items-center justify-between">
				<div className="space-y-0.5">
					<label className="text-sm font-medium">{t("rtk.enableTitle")}</label>
					<p className="text-muted-foreground text-sm">{t("rtk.enableDescription")}</p>
				</div>
				<Switch
					data-testid="rtk-enabled-switch"
					checked={plugin.enabled}
					onCheckedChange={handleToggle}
					disabled={isLoading || !hasUpdateAccess}
				/>
			</div>

			<div className="mt-4 space-y-1 border-t pt-4">
				<div className="flex items-center gap-1.5">
					<span className="text-sm font-semibold">{t("rtk.pipelineSectionTitle")}</span>
					<HelpHint>{t("rtk.pipelineSectionIntro")}</HelpHint>
				</div>
				<div className="space-y-3" data-testid="pipeline-engines">
					<FormItem className="flex flex-row items-start space-y-0 space-x-3">
						<FormControl>
							<Checkbox data-testid="pipeline-rtk-checkbox" checked disabled className="mt-1" />
						</FormControl>
						<div className="space-y-1 leading-none">
							<div className="flex items-center gap-1.5">
								<FormLabel>{t("rtk.pipelineRtkLabel")}</FormLabel>
								<HelpHint>{t("rtk.pipelineRtkHint")}</HelpHint>
							</div>
							<FormDescription>{t("rtk.pipelineRtkDescription")}</FormDescription>
						</div>
					</FormItem>
					<FormItem className="flex flex-row items-start space-y-0 space-x-3">
						<FormControl>
							<Checkbox
								data-testid="pipeline-caveman-checkbox"
								checked={cavemanChecked}
								onCheckedChange={(v) => setCavemanEnabled(v === true)}
								disabled={checkboxesDisabled}
								className="mt-1"
							/>
						</FormControl>
						<div className="space-y-1 leading-none">
							<div className="flex items-center gap-1.5">
								<FormLabel>{t("rtk.pipelineCavemanLabel")}</FormLabel>
								<HelpHint>{t("rtk.pipelineCavemanHint")}</HelpHint>
							</div>
							<FormDescription>{t("rtk.pipelineCavemanDescription")}</FormDescription>
						</div>
					</FormItem>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// RtkEnginePanel — per-engine configuration card for the RTK compression
// engine (the default engine, targeting tool/assistant content). All
// fields and their data-testids match the legacy "preset-managed"
// sections so existing rtkFragment.test.tsx assertions (raw_output_dir /
// raw_output_ttl_hours, intensity, max_lines) keep working without
// changes.
// ---------------------------------------------------------------------------

function RtkEnginePanel({
	form,
	intensity,
	maxLines,
	effectiveLines,
	hasUpdateAccess,
	onPickPreset,
	onRevertPreset,
}: {
	form: ReturnType<typeof useForm<RTKFormValues>>;
	intensity: string;
	maxLines: number;
	effectiveLines: number;
	hasUpdateAccess: boolean;
	onPickPreset: (preset: IntensityPreset) => void;
	onRevertPreset: () => void;
}) {
	const { t } = useTranslation("plugins");
	return (
		<fieldset className="rounded-lg border p-4" data-testid="engine-panel-rtk">
			<legend className="bg-background px-2 text-sm font-semibold">
				<Badge variant="outline" className="mr-1 font-mono text-[10px] uppercase">
					rtk
				</Badge>
				{t("rtk.rtkEngineTitle")}
			</legend>
			<div className="mt-2 space-y-4">
				<p className="text-muted-foreground text-xs">{t("rtk.rtkEngineIntro")}</p>

				{/* ── Intro card + presets ─────────────────────────────────────── */}
				<Card data-testid="rtk-intro-card">
					<CardHeader className="pb-3">
						<div className="flex items-center gap-2">
							<Info className="text-muted-foreground h-4 w-4" />
							<CardTitle className="text-base">{t("rtk.introTitle")}</CardTitle>
						</div>
						<CardDescription>{t("rtk.introDescription")}</CardDescription>
					</CardHeader>
					<CardContent className="space-y-3">
						<ul className="text-muted-foreground list-disc space-y-1 pl-5 text-sm">
							<li>{t("rtk.introBullet1")}</li>
							<li>{t("rtk.introBullet2")}</li>
							<li>{t("rtk.introBullet3")}</li>
						</ul>
						<Separator />
						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<span className="text-sm font-medium">{t("rtk.presetSectionLabel")}</span>
									<HelpHint>{t("rtk.presetHelp")}</HelpHint>
								</div>
							</div>
							<div className="flex items-end gap-2">
								<div className="min-w-0 flex-1">
									<IntensityPresetButtons intensity={intensity} onPick={onPickPreset} disabled={!hasUpdateAccess} />
								</div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={onRevertPreset}
									disabled={!hasUpdateAccess}
									data-testid="rtk-revert-preset-btn"
									className="shrink-0"
								>
									<Undo2 className="h-4 w-4" />
									{t("rtk.revertPreset")}
								</Button>
							</div>
						</div>
					</CardContent>
				</Card>

				{/* ── ① Managed by Quick Presets (7 fields) ──────────────────────── */}
				<fieldset className="rounded-lg border p-4" data-testid="rtk-preset-managed-section">
					<legend className="bg-background px-2 text-sm font-semibold">{t("rtk.presetManagedSection")}</legend>
					<div className="mt-2 space-y-4">
						<FormField
							control={form.control}
							name="intensity"
							render={({ field }) => (
								<FormItem>
									<div className="flex items-center gap-1.5">
										<FormLabel>{t("rtk.intensityLabel")}</FormLabel>
										<HelpHint>{t("rtk.intensityWhen")}</HelpHint>
									</div>
									<Select value={field.value} onValueChange={field.onChange}>
										<FormControl>
											<SelectTrigger data-testid="rtk-field-intensity">
												<SelectValue placeholder={t("rtk.intensityPlaceholder")} />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectItem value="minimal">{t("rtk.intensityMinimal")}</SelectItem>
											<SelectItem value="standard">{t("rtk.intensityStandard")}</SelectItem>
											<SelectItem value="aggressive">{t("rtk.intensityAggressive")}</SelectItem>
										</SelectContent>
									</Select>
									<FormDescription>{t("rtk.intensityDescription")}</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
							<FormField
								control={form.control}
								name="max_lines_per_result"
								render={({ field }) => (
									<FormItem>
										<div className="flex items-center gap-1.5">
											<FormLabel>{t("rtk.maxLinesLabel")}</FormLabel>
											<HelpHint>{t("rtk.maxLinesWhen")}</HelpHint>
										</div>
										<FormControl>
											<Input
												data-testid="rtk-field-max-lines"
												type="number"
												min={0}
												{...field}
												onChange={(e) => field.onChange(e.target.valueAsNumber || e.target.value)}
											/>
										</FormControl>
										<FormDescription>
											{t("rtk.maxLinesDescription")}
											{Number(maxLines) > 0 && (
												<>
													{" · "}
													<span className="font-medium">{t("rtk.effectiveValue", { value: effectiveLines })}</span>
												</>
											)}
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="max_chars_per_result"
								render={({ field }) => (
									<FormItem>
										<div className="flex items-center gap-1.5">
											<FormLabel>{t("rtk.maxCharsLabel")}</FormLabel>
											<HelpHint>{t("rtk.maxCharsWhen")}</HelpHint>
										</div>
										<FormControl>
											<Input
												data-testid="rtk-field-max-chars"
												type="number"
												min={0}
												{...field}
												onChange={(e) => field.onChange(e.target.valueAsNumber || e.target.value)}
											/>
										</FormControl>
										<FormDescription>{t("rtk.maxCharsDescription")}</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="dedup_threshold"
								render={({ field }) => (
									<FormItem>
										<div className="flex items-center gap-1.5">
											<FormLabel>{t("rtk.dedupThresholdLabel")}</FormLabel>
											<HelpHint>{t("rtk.dedupThresholdWhen")}</HelpHint>
										</div>
										<FormControl>
											<Input
												data-testid="rtk-field-dedup-threshold"
												type="number"
												min={0}
												{...field}
												onChange={(e) => field.onChange(e.target.valueAsNumber || e.target.value)}
											/>
										</FormControl>
										<FormDescription>{t("rtk.dedupThresholdDescription")}</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						</div>
						<FormField
							control={form.control}
							name="enable_grouping"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
									<div className="space-y-0.5">
										<div className="flex items-center gap-1.5">
											<FormLabel>{t("rtk.enableGroupingLabel")}</FormLabel>
											<HelpHint>{t("rtk.enableGroupingWhen")}</HelpHint>
										</div>
										<FormDescription>{t("rtk.enableGroupingDescription")}</FormDescription>
									</div>
									<FormControl>
										<Switch data-testid="rtk-field-enable-grouping" checked={field.value} onCheckedChange={field.onChange} />
									</FormControl>
								</FormItem>
							)}
						/>
						{form.watch("enable_grouping") && (
							<FormField
								control={form.control}
								name="grouping_threshold"
								render={({ field }) => (
									<FormItem>
										<div className="flex items-center gap-1.5">
											<FormLabel>{t("rtk.groupingThresholdLabel")}</FormLabel>
											<HelpHint>{t("rtk.groupingThresholdWhen")}</HelpHint>
										</div>
										<FormControl>
											<Input
												data-testid="rtk-field-grouping-threshold"
												type="number"
												min={0}
												{...field}
												onChange={(e) => field.onChange(e.target.valueAsNumber || e.target.value)}
											/>
										</FormControl>
										<FormDescription>{t("rtk.groupingThresholdDescription")}</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}
						<FormField
							control={form.control}
							name="min_tokens_to_compress"
							render={({ field }) => (
								<FormItem>
									<div className="flex items-center gap-1.5">
										<FormLabel>{t("rtk.minTokensToCompressLabel")}</FormLabel>
										<HelpHint>{t("rtk.minTokensToCompressWhen")}</HelpHint>
									</div>
									<FormControl>
										<Input
											data-testid="rtk-field-min-tokens"
											type="number"
											min={0}
											{...field}
											onChange={(e) => field.onChange(e.target.valueAsNumber || e.target.value)}
										/>
									</FormControl>
									<FormDescription>{t("rtk.minTokensToCompressDescription")}</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
					</div>
				</fieldset>

				{/* ── Semantic compression ──
					RTK-engine-only (Caveman is pure rules and never runs the
					renderer pipeline), so this lives under the RTK tab rather
					than the cross-engine shared settings. */}
				<fieldset className="rounded-lg border p-4">
					<legend className="bg-background px-2 text-sm font-semibold">{t("rtk.renderersSection")}</legend>
					<div className="mt-2 space-y-3">
						<FormField
							control={form.control}
							name="enable_renderers"
							render={({ field }) => (
								<FormItem className="flex flex-row items-start space-y-0 space-x-3">
									<FormControl>
										<Switch checked={Boolean(field.value)} onCheckedChange={field.onChange} data-testid="rtk-field-enable-renderers" />
									</FormControl>
									<div className="space-y-1 leading-none">
										<div className="flex items-center gap-1.5">
											<FormLabel>{t("rtk.enableRenderersLabel")}</FormLabel>
											<HelpHint>{t("rtk.enableRenderersWhen")}</HelpHint>
										</div>
										<FormDescription>{t("rtk.enableRenderersDescription")}</FormDescription>
									</div>
								</FormItem>
							)}
						/>
						{form.watch("enable_renderers") && <DisabledRenderersField form={form} hasUpdateAccess={hasUpdateAccess} />}
					</div>
				</fieldset>
			</div>
		</fieldset>
	);
}

// ---------------------------------------------------------------------------
// DisabledRenderersField — multi-select dropdown for disabled_renderers.
// Mirrors the caveman skip_rules UX: group options by category so the
// dropdown reads naturally; unknown names (hand-typed in older configs)
// flow through as a warning row rather than being silently dropped.
// ---------------------------------------------------------------------------

function DisabledRenderersField({ form, hasUpdateAccess }: { form: ReturnType<typeof useForm<RTKFormValues>>; hasUpdateAccess: boolean }) {
	const { t } = useTranslation("plugins");
	const renderersQuery = useGetRtkRenderersQuery();
	const renderers = renderersQuery.data?.renderers ?? [];

	const groups = useMemo<MultiSelectGroup[]>(() => {
		if (renderers.length === 0) return [];
		const byCategory = new Map<string, RendererCatalogEntry[]>();
		for (const r of renderers) {
			const cat = r.category || "other";
			if (!byCategory.has(cat)) byCategory.set(cat, []);
			byCategory.get(cat)!.push(r);
		}
		const groupOrder = ["git", "test", "terraform", "structured"];
		const out: MultiSelectGroup[] = [];
		for (const cat of groupOrder) {
			const items = byCategory.get(cat);
			if (!items || items.length === 0) continue;
			out.push({
				heading: t(`rtk.disabledRenderersGroup${cat.charAt(0).toUpperCase()}${cat.slice(1)}`),
				options: items.map((r) => ({
					value: r.name,
					label: r.name,
				})),
			});
		}
		return out;
		// eslint-disable-next-line react-hooks/exhaustive-deps -- groups close over t
	}, [renderers, t]);

	return (
		<FormField
			control={form.control}
			name="disabled_renderers"
			render={({ field }) => {
				const knownNames = new Set(renderers.map((r) => r.name));
				const fieldValue = Array.isArray(field.value) ? field.value : [];
				const unknownNames = fieldValue.filter((n) => n && !knownNames.has(n));
				return (
					<FormItem>
						<div className="flex items-center gap-1.5">
							<FormLabel>{t("rtk.disabledRenderersLabel")}</FormLabel>
							<HelpHint>{t("rtk.disabledRenderersWhen")}</HelpHint>
						</div>
						<FormControl>
							<MultiSelect
								options={groups}
								value={fieldValue}
								resetOnDefaultValueChange={false}
								onValueChange={(vals) => field.onChange(vals)}
								placeholder={renderersQuery.isError ? t("rtk.disabledRenderersLoadError") : t("rtk.disabledRenderersPlaceholder")}
								emptyIndicator={t("rtk.disabledRenderersEmpty")}
								hideSelectAll
								maxCount={3}
								className="border-input text-foreground bg-background hover:bg-accent hover:text-accent-foreground rounded-sm font-normal"
								data-testid="rtk-field-disabled-renderers"
								disabled={!hasUpdateAccess}
							/>
						</FormControl>
						<FormDescription>{t("rtk.disabledRenderersDescription")}</FormDescription>
						{unknownNames.length > 0 && (
							<p className="text-muted-foreground mt-1 text-xs">
								{t("rtk.disabledRenderersUnknownWarning", { names: unknownNames.join(", ") })}
							</p>
						)}
						<FormMessage />
					</FormItem>
				);
			}}
		/>
	);
}

// ---------------------------------------------------------------------------
// CavemanEnginePanel — per-engine configuration card for the Caveman prose
// compression engine (opt-in, targeting user-role messages). All existing
// caveman-field-* testids are preserved so legacy tests keep passing.
// ---------------------------------------------------------------------------

function CavemanEnginePanel({ form, hasUpdateAccess }: { form: ReturnType<typeof useForm<RTKFormValues>>; hasUpdateAccess: boolean }) {
	const { t } = useTranslation("plugins");
	const cavemanRulesQuery = useGetRtkCavemanRulesQuery();
	const cavemanRules = cavemanRulesQuery.data?.rules ?? [];
	const builtInPreservePatterns = cavemanRulesQuery.data?.builtInPreservePatterns ?? [];

	// skip_rules → group rules by category so the dropdown reads naturally.
	// Each option's secondary text shows the canonical description; unknown
	// names (from older hand-typed configs) flow through as a warning row
	// rather than being silently dropped.
	const skipRulesGroups = useMemo<MultiSelectGroup[]>(() => {
		if (cavemanRules.length === 0) return [];
		const byCategory = new Map<string, CavemanRuleCatalogEntry[]>();
		for (const r of cavemanRules) {
			const cat = r.category || "other";
			if (!byCategory.has(cat)) byCategory.set(cat, []);
			byCategory.get(cat)!.push(r);
		}
		const groupOrder = ["filler", "terse", "context", "structural", "dedup", "ultra"];
		const groups: MultiSelectGroup[] = [];
		for (const cat of groupOrder) {
			const rules = byCategory.get(cat);
			if (!rules || rules.length === 0) continue;
			groups.push({
				heading: t(`rtk.cavemanSkipRulesGroup${cat.charAt(0).toUpperCase()}${cat.slice(1)}`),
				options: rules.map((r) => toSkipRulesOption(r, t(`rtk.cavemanRule.${r.name}`, { defaultValue: r.label }))),
			});
		}
		return groups;
		// eslint-disable-next-line react-hooks/exhaustive-deps -- toSkipRulesOption closes over t
	}, [cavemanRules, t]);

	// The Caveman tab is only rendered while caveman.enabled is true (the
	// pipeline checkbox in EnabledSwitchPanel is the single source of truth for
	// toggling the engine), so the sub-fields below render unconditionally here
	// — there is no "enable Caveman" switch to duplicate.
	return (
		<fieldset className="rounded-lg border p-4" data-testid="engine-panel-caveman">
			<legend className="bg-background px-2 text-sm font-semibold">
				<Badge variant="outline" className="mr-1 font-mono text-[10px] uppercase">
					caveman
				</Badge>
				{t("rtk.cavemanEngineTitle")}
			</legend>
			<div className="mt-2 space-y-4">
				<p className="text-muted-foreground text-xs">{t("rtk.cavemanIntro")}</p>
				<FormField
					control={form.control}
					name="caveman.intensity"
					render={({ field }) => (
						<FormItem>
							<div className="flex items-center gap-1.5">
								<FormLabel>{t("rtk.cavemanIntensityLabel")}</FormLabel>
								<HelpHint>{t("rtk.cavemanIntensityWhen")}</HelpHint>
							</div>
							<Select value={field.value} onValueChange={field.onChange} disabled={!hasUpdateAccess}>
								<FormControl>
									<SelectTrigger data-testid="caveman-field-intensity">
										<SelectValue placeholder={t("rtk.cavemanIntensityPlaceholder")} />
									</SelectTrigger>
								</FormControl>
								<SelectContent>
									{(["lite", "full", "ultra"] as const).map((v) => (
										<SelectItem key={v} value={v}>
											{t(`rtk.cavemanIntensity${v.charAt(0).toUpperCase()}${v.slice(1)}`)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<FormDescription>{t("rtk.cavemanIntensityDescription")}</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>
				<FormField
					control={form.control}
					name="caveman.min_message_length"
					render={({ field }) => (
						<FormItem>
							<div className="flex items-center gap-1.5">
								<FormLabel>{t("rtk.cavemanMinLengthLabel")}</FormLabel>
								<HelpHint>{t("rtk.cavemanMinLengthWhen")}</HelpHint>
							</div>
							<FormControl>
								<Input
									data-testid="caveman-field-min-length"
									type="number"
									min={0}
									{...field}
									onChange={(e) => field.onChange(Number(e.target.value))}
								/>
							</FormControl>
							<FormDescription>{t("rtk.cavemanMinLengthDescription")}</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>
				<FormField
					control={form.control}
					name="caveman.skip_rules"
					render={({ field }) => {
						const knownNames = new Set(cavemanRules.map((r) => r.name));
						const fieldValue = Array.isArray(field.value) ? field.value : [];
						const unknownNames = fieldValue.filter((n) => n && !knownNames.has(n));
						return (
							<FormItem>
								<div className="flex items-center gap-1.5">
									<FormLabel>{t("rtk.cavemanSkipRulesLabel")}</FormLabel>
									<HelpHint>{t("rtk.cavemanSkipRulesWhen")}</HelpHint>
								</div>
								<FormControl>
									<MultiSelect
										options={skipRulesGroups}
										value={fieldValue}
										resetOnDefaultValueChange={false}
										onValueChange={(vals) => field.onChange(vals)}
										placeholder={cavemanRulesQuery.isError ? t("rtk.cavemanSkipRulesLoadError") : t("rtk.cavemanSkipRulesPlaceholder")}
										emptyIndicator={t("rtk.cavemanSkipRulesEmpty")}
										hideSelectAll
										maxCount={3}
										className="border-input text-foreground bg-background hover:bg-accent hover:text-accent-foreground rounded-sm font-normal"
										data-testid="caveman-field-skip-rules"
										disabled={!hasUpdateAccess}
									/>
								</FormControl>
								<FormDescription>{t("rtk.cavemanSkipRulesDescription")}</FormDescription>
								{unknownNames.length > 0 && (
									<p className="text-muted-foreground mt-1 text-xs">
										{t("rtk.cavemanSkipRulesUnknownWarning", { names: unknownNames.join(", ") })}
									</p>
								)}
								<FormMessage />
							</FormItem>
						);
					}}
				/>
				<FormField
					control={form.control}
					name="caveman.preserve_patterns"
					render={({ field }) => {
						const fieldValue = Array.isArray(field.value) ? field.value : [];
						const invalid = fieldValue.filter((p) => {
							if (!p) return false;
							try {
								// eslint-disable-next-line no-new -- RegExp constructor throws on bad patterns
								new RegExp(p);
								return false;
							} catch {
								return true;
							}
						});
						return (
							<FormItem>
								<div className="flex items-center gap-1.5">
									<FormLabel>{t("rtk.cavemanPreserveLabel")}</FormLabel>
									<HelpHint>{t("rtk.cavemanPreserveWhen")}</HelpHint>
								</div>
								<FormControl>
									<Textarea
										data-testid="caveman-field-preserve-patterns"
										placeholder={t("rtk.cavemanPreservePlaceholder")}
										rows={3}
										value={fieldValue.join(", ")}
										onChange={(e) => field.onChange(splitCommaList(e.target.value))}
										onBlur={(e) => field.onChange(splitCommaList(e.target.value))}
									/>
								</FormControl>
								<FormDescription>{t("rtk.cavemanPreserveDescription")}</FormDescription>
								{invalid.length > 0 && (
									<p className="text-muted-foreground mt-1 text-xs">{t("rtk.cavemanPreserveUnknownWarning", { count: invalid.length })}</p>
								)}
								{builtInPreservePatterns.length > 0 && (
									<details className="text-muted-foreground mt-2 text-xs">
										<summary className="cursor-pointer select-none">{t("rtk.cavemanPreserveBuiltInTitle")}</summary>
										<p className="mt-1">{t("rtk.cavemanPreserveBuiltInHint")}</p>
										<ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 pl-4 sm:grid-cols-3">
											{builtInPreservePatterns.map((name) => (
												<li key={name} className="font-mono">
													{name}
												</li>
											))}
										</ul>
									</details>
								)}
								<FormMessage />
							</FormItem>
						);
					}}
				/>
			</div>
		</fieldset>
	);
}

// ---------------------------------------------------------------------------
// SharedSettingsSection — cross-engine settings that apply to BOTH engines:
// raw-output persistence (also feeds the log detail diff view). RTK-only
// steps (renderers, filters, grouping, presets) live under the RTK tab.
// ---------------------------------------------------------------------------

function SharedSettingsSection({ form }: { form: ReturnType<typeof useForm<RTKFormValues>> }) {
	const { t } = useTranslation("plugins");
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<span className="text-sm font-semibold">{t("rtk.sharedSettingsTitle")}</span>
				<HelpHint>{t("rtk.sharedSettingsHelp")}</HelpHint>
			</div>

			{/* Debug / raw output — cross-engine persistence (rtk embeds a recovery
				hint, caveman only persists for the log audit trail). The persisted
				raw output also feeds the log detail diff view, so this section is
				the single source of truth for "view the pre-compression text".
				Plain card, no collapse, since both engines share it. */}
			<fieldset className="rounded-lg border p-4">
				<legend className="bg-background px-2 text-xs font-semibold">{t("rtk.rawOutputSection")}</legend>
				<div className="mt-2 space-y-4">
					<FormField
						control={form.control}
						name="raw_output_retention"
						render={({ field }) => (
							<FormItem>
								<div className="flex items-center gap-1.5">
									<FormLabel>{t("rtk.rawOutputRetentionLabel")}</FormLabel>
									<HelpHint>{t("rtk.rawOutputRetentionWhen")}</HelpHint>
								</div>
								<Select value={field.value} onValueChange={field.onChange}>
									<FormControl>
										<SelectTrigger data-testid="rtk-field-raw-output-retention">
											<SelectValue placeholder={t("rtk.rawOutputRetentionPlaceholder")} />
										</SelectTrigger>
									</FormControl>
									<SelectContent>
										<SelectItem value="never">{t("rtk.rawOutputRetentionNever")}</SelectItem>
										<SelectItem value="failures">{t("rtk.rawOutputRetentionFailures")}</SelectItem>
										<SelectItem value="always">{t("rtk.rawOutputRetentionAlways")}</SelectItem>
									</SelectContent>
								</Select>
								<FormDescription>{t("rtk.rawOutputRetentionDescription")}</FormDescription>
								<FormMessage />
							</FormItem>
						)}
					/>
					<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
						<FormField
							control={form.control}
							name="raw_output_max_bytes"
							render={({ field }) => (
								<FormItem>
									<div className="flex items-center gap-1.5">
										<FormLabel>{t("rtk.rawOutputMaxBytesLabel")}</FormLabel>
										<HelpHint>{t("rtk.rawOutputMaxBytesWhen")}</HelpHint>
									</div>
									<FormControl>
										<Input
											data-testid="rtk-field-raw-output-max-bytes"
											type="number"
											min={0}
											{...field}
											onChange={(e) => field.onChange(e.target.valueAsNumber || e.target.value)}
										/>
									</FormControl>
									<FormDescription>{t("rtk.rawOutputMaxBytesDescription")}</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="raw_output_ttl_hours"
							render={({ field }) => (
								<FormItem>
									<div className="flex items-center gap-1.5">
										<FormLabel>{t("rtk.rawOutputTTLLabel")}</FormLabel>
										<HelpHint>{t("rtk.rawOutputTTLWhen")}</HelpHint>
									</div>
									<FormControl>
										<Input
											data-testid="rtk-field-raw-output-ttl-hours"
											type="number"
											min={0}
											max={168}
											{...field}
											onChange={(e) => field.onChange(e.target.valueAsNumber || e.target.value)}
										/>
									</FormControl>
									<FormDescription>{t("rtk.rawOutputTTLDescription")}</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
					</div>
					<FormField
						control={form.control}
						name="raw_output_dir"
						render={({ field }) => (
							<FormItem>
								<div className="flex items-center gap-1.5">
									<FormLabel>{t("rtk.rawOutputDirLabel")}</FormLabel>
									<HelpHint>{t("rtk.rawOutputDirWhen")}</HelpHint>
								</div>
								<FormControl>
									<Input data-testid="rtk-field-raw-output-dir" type="text" placeholder={t("rtk.rawOutputDirPlaceholder")} {...field} />
								</FormControl>
								<FormDescription>{t("rtk.rawOutputDirDescription")}</FormDescription>
								<FormMessage />
							</FormItem>
						)}
					/>
				</div>
			</fieldset>
		</div>
	);
}

// ---------------------------------------------------------------------------
// ConfigForm — react-hook-form + zod wrapper that renders the cross-engine
// settings (SharedSettingsSection) and per-engine configuration panels
// (RtkEnginePanel / CavemanEnginePanel). The form instance is owned by
// RtkFragment and shared with EnabledSwitchPanel so the pipeline / caveman
// checkboxes and the per-engine card below stay in sync. The form schema
// and submit payload are unchanged so the persisted config.json shape stays
// wire-compatible.
// ---------------------------------------------------------------------------

function ConfigForm({
	plugin,
	form,
	isSaving,
	lastSavedRef,
}: {
	plugin: Plugin;
	form: ReturnType<typeof useForm<RTKFormValues>>;
	isSaving: boolean;
	lastSavedRef: React.MutableRefObject<Partial<RTKFormValues>>;
}) {
	const { t } = useTranslation("plugins");
	const hasUpdateAccess = useRbac(RbacResource.Plugins, RbacOperation.Update);

	const pluginConfig = (plugin.config || {}) as Record<string, any>;

	// Keep the form in sync if the underlying plugin/config changes (e.g. after
	// an admin edit or reload from server). Without this, switching between
	// plugins in the sidebar leaves stale defaults visible.
	//
	// Dependency is a JSON fingerprint, not the plugin.config object
	// reference — the parent re-renders frequently with a fresh object
	// identity even when the underlying fields are unchanged, which used
	// to call form.reset() and clobber unsaved edits (including the new
	// enabled toggle). Stringifying gives a stable signal that only fires
	// when the operator-visible config actually moves.
	useEffect(() => {
		form.reset({
			intensity: pluginConfig.intensity || "standard",
			max_lines_per_result: pluginConfig.max_lines_per_result || 120,
			max_chars_per_result: pluginConfig.max_chars_per_result || 12000,
			dedup_threshold: pluginConfig.dedup_threshold || 3,
			enable_grouping: pluginConfig.enable_grouping ?? false,
			grouping_threshold: pluginConfig.grouping_threshold || 3,
			enabled_filters: pluginConfig.enabled_filters ?? [],
			disabled_filters: pluginConfig.disabled_filters ?? [],
			// `||` (not `??`): the persisted config may carry an explicit empty
			// string rather than a null field, and `??` would let "" through.
			raw_output_retention: pluginConfig.raw_output_retention || "always",
			raw_output_max_bytes: pluginConfig.raw_output_max_bytes || 1048576,
			raw_output_dir: pluginConfig.raw_output_dir ?? "",
			raw_output_ttl_hours: pluginConfig.raw_output_ttl_hours ?? 24,
			pipeline: pluginConfig.pipeline ?? [{ id: "rtk" }],
			min_tokens_to_compress: pluginConfig.min_tokens_to_compress ?? 0,
			enable_renderers: pluginConfig.enable_renderers ?? true,
			disabled_renderers: pluginConfig.disabled_renderers ?? [],
			caveman: {
				enabled: pluginConfig.caveman?.enabled ?? false,
				intensity: pluginConfig.caveman?.intensity || "lite",
				min_message_length: pluginConfig.caveman?.min_message_length ?? 50,
				skip_rules: pluginConfig.caveman?.skip_rules ?? [],
				preserve_patterns: pluginConfig.caveman?.preserve_patterns ?? [],
			},
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [JSON.stringify(pluginConfig)]);

	// lastSavedRef tracks the most recently saved values so revertPreset can
	// reset only the 7 preset-managed fields without touching independent ones.
	// The ref itself is owned by RtkFragment (so the save success path there
	// can refresh it), but the initial-sync fingerprint effect lives here so
	// it stays close to the form values it observes.
	useEffect(() => {
		lastSavedRef.current = form.formState.defaultValues as Partial<RTKFormValues>;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [JSON.stringify(pluginConfig)]);

	// Watch intensity + max_lines to display the live "effective value" hint.
	const intensity = form.watch("intensity") ?? "standard";
	const maxLines = form.watch("max_lines_per_result") ?? 0;
	const effectiveLines = useMemo(() => effectiveMaxLines(Number(maxLines) || 0, String(intensity)), [maxLines, intensity]);

	const applyPreset = (preset: IntensityPreset) => {
		form.setValue("intensity", preset.intensity, { shouldDirty: true });
		form.setValue("max_lines_per_result", preset.max_lines_per_result, { shouldDirty: true });
		form.setValue("max_chars_per_result", preset.max_chars_per_result, { shouldDirty: true });
		form.setValue("dedup_threshold", preset.dedup_threshold, { shouldDirty: true });
		form.setValue("enable_grouping", preset.enable_grouping, { shouldDirty: true });
		form.setValue("grouping_threshold", preset.grouping_threshold, { shouldDirty: true });
		form.setValue("min_tokens_to_compress", preset.min_tokens_to_compress, { shouldDirty: true });
		toast.info(t("rtk.presetAppliedToast", { name: t(`rtk.intensity${preset.id.charAt(0).toUpperCase()}${preset.id.slice(1)}`) }));
	};

	const revertPreset = () => {
		const saved = lastSavedRef.current;
		if (!saved) return;
		PRESET_FIELDS.forEach((field) => {
			form.setValue(field, saved[field] as any, { shouldDirty: true });
		});
		toast.info(t("rtk.revertPresetToast"));
	};

	// Caveman is opt-in via the pipeline checkbox in EnabledSwitchPanel. When it
	// is disabled, the whole "Caveman config" tab (and its only toggle, which
	// duplicates the pipeline checkbox) is hidden. Enabling Caveman auto-jumps
	// to its tab (so the operator lands straight on the freshly-relevant fields);
	// disabling it while on its tab bounces back to the shared tab so the active
	// tab never points at a hidden panel. The previous-value ref keeps a freshly
	// loaded config that already has Caveman enabled from auto-jumping on mount.
	const cavemanEnabled = !!form.watch("caveman.enabled");
	const [activeTab, setActiveTab] = useState<string>("shared");
	const prevCavemanEnabled = useRef(cavemanEnabled);
	useEffect(() => {
		if (cavemanEnabled && !prevCavemanEnabled.current) {
			setActiveTab("caveman");
		} else if (!cavemanEnabled && activeTab === "caveman") {
			setActiveTab("shared");
		}
		prevCavemanEnabled.current = cavemanEnabled;
	}, [cavemanEnabled, activeTab]);

	return (
		<div className="space-y-6">
			{/* ── Three configuration tabs: shared / RTK / Caveman ─────────────── */}
			<Tabs value={activeTab} onValueChange={setActiveTab} data-testid="rtk-config-tabs">
				<TabsList className="gap-2">
					<TabsTrigger value="shared" data-testid="rtk-tab-shared">
						{t("rtk.tabShared")}
					</TabsTrigger>
					<TabsTrigger value="rtk" data-testid="rtk-tab-rtk">
						{t("rtk.tabRtk")}
					</TabsTrigger>
					{cavemanEnabled && (
						<TabsTrigger value="caveman" data-testid="rtk-tab-caveman">
							{t("rtk.tabCaveman")}
						</TabsTrigger>
					)}
				</TabsList>

				<TabsContent value="shared" className="mt-4">
					<SharedSettingsSection form={form} />
				</TabsContent>

				<TabsContent value="rtk" className="mt-4">
					<div className="space-y-4">
						<RtkEnginePanel
							form={form}
							intensity={intensity}
							maxLines={maxLines}
							effectiveLines={effectiveLines}
							hasUpdateAccess={hasUpdateAccess}
							onPickPreset={applyPreset}
							onRevertPreset={revertPreset}
						/>

						{/* ── Effect-verification nudge ─────────────────────────────── */}
						<div className="bg-muted/30 text-muted-foreground rounded-lg border border-dashed p-3 text-xs">
							<div className="flex items-start gap-2">
								<Beaker className="mt-0.5 h-4 w-4 shrink-0" />
								<div className="space-y-1.5">
									<div className="text-foreground text-sm font-medium">{t("rtk.afterSaveTitle")}</div>
									<div>{t("rtk.afterSaveBody")}</div>
									<div className="flex flex-wrap gap-2 pt-1">
										<Button variant="outline" size="sm" asChild>
											<Link to="/workspace/plugins/rtk/preview" data-testid="rtk-after-save-preview">
												<ImageIcon className="h-3.5 w-3.5" />
												{t("rtk.admin.tabs.preview")}
											</Link>
										</Button>
										<Button variant="outline" size="sm" asChild>
											<Link to="/workspace/plugins/rtk/test" data-testid="rtk-after-save-test">
												<Beaker className="h-3.5 w-3.5" />
												{t("rtk.admin.tabs.test")}
											</Link>
										</Button>
										<Button variant="outline" size="sm" asChild>
											<Link to="/workspace/plugins/rtk/raw-output" data-testid="rtk-after-save-raw">
												<FileSearchIcon />
												{t("rtk.admin.tabs.rawOutput")}
											</Link>
										</Button>
									</div>
								</div>
							</div>
						</div>
					</div>
				</TabsContent>

				{cavemanEnabled && (
					<TabsContent value="caveman" className="mt-4">
						<CavemanEnginePanel form={form} hasUpdateAccess={hasUpdateAccess} />
					</TabsContent>
				)}
			</Tabs>

			{/* Save bar */}
			<div className="bg-background sticky bottom-0 z-10 -mx-4 mt-6 flex flex-wrap items-center justify-between gap-2 border-t px-4 pt-4 pb-2">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => form.reset()}
					disabled={!form.formState.isDirty || !hasUpdateAccess}
					data-testid="rtk-reset-btn"
				>
					<RotateCcw className="h-4 w-4" />
					{t("rtk.reset")}
				</Button>
				<div className="flex flex-wrap items-center gap-2">
					<Button variant="outline" size="sm" asChild data-testid="rtk-admin-link-filters">
						<Link to="/workspace/plugins/rtk/filters">
							<FlaskConical className="h-4 w-4" />
							{t("rtk.admin.tabs.filters")}
						</Link>
					</Button>
					<Button variant="outline" size="sm" asChild data-testid="rtk-admin-link-test">
						<Link to="/workspace/plugins/rtk/test">
							<Beaker className="h-4 w-4" />
							{t("rtk.admin.tabs.test")}
						</Link>
					</Button>
					<Button type="submit" disabled={isSaving || !form.formState.isDirty || !hasUpdateAccess} data-testid="rtk-save-btn">
						{isSaving ? t("rtk.saving") : t("rtk.saveConfiguration")}
					</Button>
				</div>
			</div>
		</div>
	);
}

// Tiny inline icon component for the "Raw Output" link in the after-save card.
// Kept local to avoid adding another lucide import beyond what's already used.
function FileSearchIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className="h-3.5 w-3.5"
		>
			<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
			<path d="M14 2v6h6" />
			<circle cx="11.5" cy="14.5" r="2.5" />
			<path d="M13.5 16.5 15 18" />
		</svg>
	);
}

// ---------------------------------------------------------------------------
// RtkFragment — MonitoringPanel + Settings card. The Settings card hosts
// EnabledSwitchPanel (top-level on/off toggle + the two pipeline checkboxes)
// and ConfigForm (shared settings + per-engine configuration panels). The
// react-hook-form instance lives here so both children stay in sync — flipping
// the Caveman checkbox in EnabledSwitchPanel is visible to CavemanEnginePanel
// immediately. Flipping plugin.enabled is still an immediate mutation
// (mirrors ProvidercooldownFragment) without touching the inner config
// payload.
//
// Server-side, plugins/rtk/config.go's applyConfigDefaults zero-detect
// safeguard keeps RTK enabled even when the persisted config_json is null
// or all-zero — the inner Config.Enabled flag never gets a chance to silently
// turn the plugin into a no-op.
// ---------------------------------------------------------------------------

export function RtkFragment({ plugin }: { plugin: Plugin }) {
	const { t } = useTranslation("plugins");
	const hasUpdateAccess = useRbac(RbacResource.Plugins, RbacOperation.Update);
	const [updatePlugin, { isLoading: isSaving }] = useUpdatePluginMutation();
	const lastSavedRef = useRef<Partial<RTKFormValues>>({});

	const onSubmit = async (values: RTKFormValues) => {
		if (!hasUpdateAccess) return;
		// Pipeline is derived from the per-engine toggles in the EnabledSwitchPanel
		// — RTK is always-on and listed first, Caveman trails when enabled.
		// This keeps the wire format stable (pluginConfig.pipeline) while the
		// UI no longer exposes the raw JSON array.
		const pipeline = values.caveman?.enabled ? [{ id: "rtk" }, { id: "caveman" }] : [{ id: "rtk" }];
		values.pipeline = pipeline;
		// Mirror the plugin-level Enabled into the inner config.enabled so
		// the saved row's engine-level flag never drifts from the master
		// switch. Without this the stored row omits the field and reads as
		// false on next load, silently disabling compression even when the
		// top-level switch is on. See plugins/rtk/hooks.go PreLLMHook.
		values.enabled = !!plugin.enabled;
		try {
			await updatePlugin({
				name: RTK_PLUGIN,
				data: {
					enabled: plugin.enabled,
					config: values,
				},
			}).unwrap();
			lastSavedRef.current = values;
			toast.success(t("rtk.savedToast"));
		} catch {
			toast.error(t("rtk.saveFailedToast"));
		}
	};

	const onError = () => {
		toast.error(t("rtk.formErrorToast"));
	};

	return (
		<div data-testid="rtk-fragment" className="space-y-6">
			<div className="space-y-1">
				<h3 className="text-lg font-semibold">{t("rtk.title")}</h3>
				<p className="text-muted-foreground text-sm">{t("rtk.subtitle")}</p>
			</div>

			<div className="rounded-lg border p-4">
				<div className="mb-4 flex items-center gap-2">
					<Activity className="text-muted-foreground h-4 w-4" />
					<h4 className="text-sm font-medium">{t("rtk.monitoringTitle")}</h4>
				</div>
				<MonitoringPanel />
			</div>

			<div className="rounded-lg border p-4">
				<h4 className="mb-4 text-sm font-medium">{t("rtk.settingsTitle")}</h4>
				<FormFieldsHost plugin={plugin} isSaving={isSaving} lastSavedRef={lastSavedRef} onSubmit={onSubmit} onError={onError} />
			</div>
		</div>
	);
}

// FormFieldsHost — wraps the Settings card's two halves in a single
// react-hook-form context so the Caveman checkbox in EnabledSwitchPanel and
// the Caveman configuration panel below share one form instance. Saves are
// triggered by ConfigForm's submit button; the onSubmit callback derives the
// pipeline array from form.caveman.enabled and persists.
function FormFieldsHost({
	plugin,
	isSaving,
	lastSavedRef,
	onSubmit,
	onError,
}: {
	plugin: Plugin;
	isSaving: boolean;
	lastSavedRef: React.MutableRefObject<Partial<RTKFormValues>>;
	onSubmit: (values: RTKFormValues) => Promise<void>;
	onError: () => void;
}) {
	const pluginConfig = (plugin.config || {}) as Record<string, any>;
	const form = useForm<RTKFormValues>({
		resolver: zodResolver(rtkConfigSchema),
		defaultValues: {
			// Engine-level enabled mirrors the plugin-level master switch
			// (single source of truth: plugin.enabled). Reading the stored
			// config first keeps the form in sync with whatever the API
			// returned; if absent, we fall back to the master switch so
			// legacy rows never show as "off" when the operator has RTK on.
			enabled: pluginConfig.enabled ?? !!plugin.enabled,
			intensity: pluginConfig.intensity || "standard",
			max_lines_per_result: pluginConfig.max_lines_per_result || 120,
			max_chars_per_result: pluginConfig.max_chars_per_result || 12000,
			dedup_threshold: pluginConfig.dedup_threshold || 3,
			enable_grouping: pluginConfig.enable_grouping ?? false,
			grouping_threshold: pluginConfig.grouping_threshold || 3,
			enabled_filters: pluginConfig.enabled_filters ?? [],
			disabled_filters: pluginConfig.disabled_filters ?? [],
			// `||` (not `??`): the persisted config may carry an explicit empty
			// string rather than a null field, and `??` would let "" through.
			raw_output_retention: pluginConfig.raw_output_retention || "always",
			raw_output_max_bytes: pluginConfig.raw_output_max_bytes || 1048576,
			raw_output_dir: pluginConfig.raw_output_dir ?? "",
			raw_output_ttl_hours: pluginConfig.raw_output_ttl_hours ?? 24,
			pipeline: pluginConfig.pipeline ?? [{ id: "rtk" }],
			min_tokens_to_compress: pluginConfig.min_tokens_to_compress ?? 0,
			enable_renderers: pluginConfig.enable_renderers ?? true,
			disabled_renderers: pluginConfig.disabled_renderers ?? [],
			caveman: {
				enabled: pluginConfig.caveman?.enabled ?? false,
				intensity: pluginConfig.caveman?.intensity || "lite",
				min_message_length: pluginConfig.caveman?.min_message_length ?? 50,
				skip_rules: pluginConfig.caveman?.skip_rules ?? [],
				preserve_patterns: pluginConfig.caveman?.preserve_patterns ?? [],
			},
		},
	});
	return (
		<Form {...form}>
			<form onSubmit={form.handleSubmit(onSubmit, onError)} className="space-y-6">
				<EnabledSwitchPanel plugin={plugin} form={form} />
				<ConfigForm plugin={plugin} form={form} isSaving={isSaving} lastSavedRef={lastSavedRef} />
			</form>
		</Form>
	);
}

// Default export for convenience (also used by pluginsView.tsx)
export default RtkFragment;