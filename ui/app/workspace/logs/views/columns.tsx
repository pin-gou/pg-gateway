import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { ProviderIconType, RenderProviderIcon } from "@/lib/constants/icons";
import {
	getProviderLabel,
	logAppDisplayName,
	mapAppToClientApp,
	mapUserAgentToApp,
	ProviderName,
	RequestTypeColors,
	RequestTypeLabels,
	Status,
	StatusBarColors,
} from "@/lib/constants/logs";
import { ChatMessageContent, DisplayLogEntry, LogEntry, ResponsesMessage, ResponsesMessageContentBlock } from "@/lib/types/logs";
import { cn } from "@/lib/utils";
import { formatCompactNumber, formatTokensAdaptive } from "@/lib/utils/numbers";
import { ColumnDef } from "@tanstack/react-table";
import { format, formatDistanceToNow } from "date-fns";
import { enUS, zhCN, type Locale } from "date-fns/locale";
import { ArrowUpDown, ChevronRight, CornerDownRight, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

// Passed to useReactTable({ meta }) by the logs page so the expander column can
// read/toggle chain expansion without threading props through column factories.
export interface LogsTableMeta {
	expandedChainIds: Set<string>;
	loadingChainIds: Set<string>;
	onToggleChain: (log: LogEntry) => void;
}

function getAssistantToolCallSummary(log?: LogEntry): string {
	const toolCalls = log?.output_message?.tool_calls || [];
	return toolCalls
		.map((toolCall) => {
			const name = toolCall?.function?.name;
			if (!name) {
				return "";
			}
			const argumentsText = toolCall?.function?.arguments?.trim();
			return argumentsText ? `${name}(${argumentsText})` : name;
		})
		.filter(Boolean)
		.join("\n");
}

function getMessageFromContent(content?: ChatMessageContent): string {
	if (content == undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	for (const block of content) {
		if ((block.type === "text" || block.type === "input_text" || block.type === "output_text") && block.text) {
			return block.text;
		}
	}
	return "";
}

export function getRealtimeTurnMessages(log?: LogEntry): {
	tool?: string;
	user?: string;
	assistant?: string;
	assistantToolCall?: string;
} {
	const toolMessages = log?.input_history?.filter((message) => message.role === "tool") || [];
	const userMessages = log?.input_history?.filter((message) => message.role === "user") || [];
	return {
		tool:
			toolMessages
				.map((m) => getMessageFromContent(m.content))
				.filter(Boolean)
				.join("\n") || "",
		user:
			userMessages
				.map((m) => getMessageFromContent(m.content))
				.filter(Boolean)
				.join("\n") || "",
		assistant: log?.output_message ? getMessageFromContent(log.output_message.content) : "",
		assistantToolCall: getAssistantToolCallSummary(log),
	};
}

export function getMessage(log?: LogEntry) {
	if (log?.object === "list_models") {
		return "N/A";
	}
	if (log?.object === "realtime.turn") {
		const messages = getRealtimeTurnMessages(log);
		const parts = [
			messages.tool ? `Tool Result: ${messages.tool}` : "",
			messages.user ? `User: ${messages.user}` : "",
			messages.assistantToolCall ? `Assistant Tool Call: ${messages.assistantToolCall}` : "",
			messages.assistant ? `Assistant: ${messages.assistant}` : "",
		].filter(Boolean);
		if (parts.length > 0) {
			return parts.join("\n");
		}
		return "";
	}
	if (log?.input_history && log.input_history.length > 0) {
		for (let i = log.input_history.length - 1; i >= 0; i--) {
			if (log.input_history[i]?.role === "user") {
				return getMessageFromContent(log.input_history[i].content);
			}
		}
		const lastInput = log.input_history[log.input_history.length - 1];
		return getMessageFromContent(lastInput?.content);
	} else if (log?.responses_input_history && log.responses_input_history.length > 0) {
		let lastMessage: ResponsesMessage | undefined;
		for (let i = log.responses_input_history.length - 1; i >= 0; i--) {
			if (log.responses_input_history[i]?.role === "user") {
				lastMessage = log.responses_input_history[i];
				break;
			}
		}
		if (!lastMessage) {
			lastMessage = log.responses_input_history[log.responses_input_history.length - 1];
		}
		if (!lastMessage) {
			return "";
		}
		let lastMessageContent = lastMessage.content;
		if (typeof lastMessageContent === "string") {
			return lastMessageContent;
		}
		let firstTextContentBlock = "";
		for (const block of (lastMessageContent ?? []) as ResponsesMessageContentBlock[]) {
			if (block.text && block.text !== "") {
				firstTextContentBlock = block.text;
				break;
			}
		}
		// If no content found in content field, check output field for Responses API
		if (!firstTextContentBlock && lastMessage.output) {
			// Handle output field - it could be a string, an array of content blocks, or a computer tool call output data
			if (typeof lastMessage.output === "string") {
				return lastMessage.output;
			} else if (Array.isArray(lastMessage.output)) {
				return lastMessage.output.map((block) => block.text).join("\n");
			} else if (lastMessage.output.type && lastMessage.output.type === "computer_screenshot") {
				return lastMessage.output.image_url;
			}
		}
		return firstTextContentBlock ?? "";
	} else if (log?.output_message) {
		return getMessageFromContent(log.output_message.content);
	} else if (log?.speech_input) {
		return log.speech_input.input;
	} else if (log?.transcription_input) {
		return "Audio file";
	} else if (log?.image_generation_input?.prompt) {
		return log.image_generation_input.prompt;
	}
	const obj = log?.object as string | undefined;
	if (obj === "image_edit" || obj === "image_edit_stream" || obj === "image_variation") {
		return "Image file";
	}
	if (log?.content_summary) {
		return log.content_summary;
	}
	return "";
}

export function truncateByWidth(text: string | undefined, maxChineseChars: number): string {
	if (!text) return "";
	const maxThirds = maxChineseChars * 3;
	let width = 0;
	for (let i = 0; i < text.length; i++) {
		const charWidth = text.charCodeAt(i) < 128 ? 2 : 3;
		if (width + charWidth > maxThirds) {
			return text.slice(0, i) + "...";
		}
		width += charWidth;
	}
	return text;
}

export function LogMessageCell({ log, contentClassName = "max-w-full" }: { log: LogEntry; contentClassName?: string }) {
	const { t } = useTranslation("logs");
	const input = getMessage(log);
	const isLargePayload = log.is_large_payload_request || log.is_large_payload_response;
	const realtimeMessages = log.object === "realtime.turn" ? getRealtimeTurnMessages(log) : null;

	const truncatedInput = truncateByWidth(input, 25);
	const truncatedTool = truncateByWidth(realtimeMessages?.tool, 25);
	const truncatedUser = truncateByWidth(realtimeMessages?.user, 25);
	const truncatedAssistantToolCall = truncateByWidth(realtimeMessages?.assistantToolCall, 25);
	const truncatedAssistant = truncateByWidth(realtimeMessages?.assistant, 25);

	return (
		<div className="flex items-center gap-1.5">
			{isLargePayload && (
				<span
					className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/50 dark:text-amber-400"
					title={t("columns.largePayloadTitle")}
				>
					LP
				</span>
			)}
			{realtimeMessages &&
			(realtimeMessages.tool || realtimeMessages.user || realtimeMessages.assistantToolCall || realtimeMessages.assistant) ? (
				<div className={cn(contentClassName, "font-mono text-sm font-normal leading-5")}>
					{realtimeMessages.tool ? <div className="truncate">{t("columns.toolResult", { text: truncatedTool })}</div> : null}
					{realtimeMessages.user ? <div className="truncate">{t("columns.user", { text: truncatedUser })}</div> : null}
					{realtimeMessages.assistantToolCall ? (
						<div className="truncate">{t("columns.assistantToolCall", { text: truncatedAssistantToolCall })}</div>
					) : null}
					{realtimeMessages.assistant ? <div className="truncate">{t("columns.assistant", { text: truncatedAssistant })}</div> : null}
				</div>
			) : (
				<div className={cn(contentClassName, "truncate font-mono text-[12px] font-normal")}>
					{truncatedInput || (isLargePayload ? t("columns.largePayloadBoth") : "-")}
				</div>
			)}
		</div>
	);
}

const MAX_ATTRIBUTION_LINES = 1;

// AttributionCell resolves an attribution value using a plural-first fallback:
// plural names -> singular name -> plural ids -> singular id. When a plural
// (array) source is used, values render one per line, capped at
// MAX_ATTRIBUTION_LINES with a "+N more" indicator for the remainder.
function AttributionCell({ names, name, ids, id }: { names?: string[]; name?: string | null; ids?: string[]; id?: string | null }) {
	const { t } = useTranslation("logs");
	let values: string[] = [];
	if (Array.isArray(names) && names.filter(Boolean).length > 0) {
		values = names.filter(Boolean);
	} else if (name) {
		values = [name];
	} else if (Array.isArray(ids) && ids.filter(Boolean).length > 0) {
		values = ids.filter(Boolean);
	} else if (id) {
		values = [id];
	}

	if (values.length === 0) {
		return <div className="max-w-[180px] truncate font-mono text-xs">-</div>;
	}

	const visible = values.slice(0, MAX_ATTRIBUTION_LINES);
	const remaining = values.length - visible.length;

	return (
		<div className="flex max-w-[180px] flex-col gap-0.5 font-mono text-xs leading-tight" title={values.join("\n")}>
			{visible.map((value, index) => (
				<span key={index} className="truncate">
					{value}
				</span>
			))}
			{remaining > 0 && <span className="text-muted-foreground">{t("columns.more", { count: remaining })}</span>}
		</div>
	);
}

export const createColumns = (customAppIcons: Record<string, string> = {}, groupedView = false): ColumnDef<LogEntry>[] => {
	// Chevron that expands a fallback chain in the grouped view. Child rows get a
	// corner connector instead so the hierarchy stays readable in any column order.
	const expandColumn: ColumnDef<LogEntry>[] = groupedView
		? [
				{
					id: "expand",
					header: "",
					size: 52,
					cell: ({ row, table }) => {
						const meta = table.options.meta as LogsTableMeta | undefined;
						const log = row.original as DisplayLogEntry;
						if (log.__chainChild) {
							return <CornerDownRight className="text-muted-foreground/70 mx-auto size-3.5" />;
						}
						const childCount = log.child_count ?? 0;
						if (!childCount || !meta) return null;
						const isExpanded = meta.expandedChainIds.has(log.id);
						const isLoading = meta.loadingChainIds.has(log.id);
						return (
							<button
								type="button"
								data-testid="log-chain-expand-btn"
								aria-label={isExpanded ? "Collapse fallback chain" : `Expand fallback chain (${childCount} attempts)`}
								aria-expanded={isExpanded}
								className="text-muted-foreground hover:text-foreground absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center gap-1 rounded-sm transition-colors"
								onClick={(event) => {
									event.stopPropagation();
									meta.onToggleChain(log);
								}}
							>
								{isLoading ? (
									<Loader2 className="size-3.5 animate-spin" />
								) : (
									<ChevronRight className={cn("size-3.5 transition-transform", isExpanded && "rotate-90")} />
								)}
								<span className="font-mono text-[10.5px] tabular-nums">{childCount}</span>
							</button>
						);
					},
				},
			]
		: [];

	const baseColumns: ColumnDef<LogEntry>[] = [
		{
			accessorKey: "status",
			header: "",
			size: 8,
			maxSize: 8,
			cell: ({ row }) => {
				const status = row.original.status as Status;
				return <div className={`h-full min-h-[24px] w-1 rounded-sm ${StatusBarColors[status]}`} />;
			},
		},
		{
			accessorKey: "timestamp",
			header: ({ column }) => {
				const { t } = useTranslation("logs");
				return (
					<Button variant="ghost" data-testid="logs-time-sort-btn" onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}>
						{t("column_labels.timestamp")}
						<ArrowUpDown className="ml-2 h-4 w-4" />
					</Button>
				);
			},
			size: 150,
			cell: ({ row }) => {
				const { i18n } = useTranslation("logs");
				const dateLocale: Locale = i18n.language.startsWith("zh") ? zhCN : enUS;
				const timestamp = row.original.timestamp;
				const date = timestamp ? new Date(timestamp) : null;
				const isValid = date && date.toString() !== "Invalid Date";
				if (!isValid) {
					return <div className="truncate text-xs">N/A</div>;
				}
				return (
					<div className="flex flex-col leading-tight">
						<span className="font-mono text-xs tabular-nums">{format(date, "MM-dd HH:mm:ss.SSS", { locale: dateLocale })}</span>
						<span className="text-muted-foreground text-[10.5px] tabular-nums">
							{formatDistanceToNow(date, { addSuffix: true, locale: dateLocale })}
						</span>
					</div>
				);
			},
		},
		{
			id: "request_type",
			header: ({ column }) => {
				const { t } = useTranslation("logs");
				return t("column_labels.request_type");
			},
			size: 110,
			cell: ({ row }) => {
				return (
					<Badge
						variant="outline"
						className={cn(
							"font-mono text-[11px] py-0.5 px-1.5 uppercase",
							RequestTypeColors[row.original.object as keyof typeof RequestTypeColors],
						)}
					>
						{RequestTypeLabels[row.original.object as keyof typeof RequestTypeLabels]}
					</Badge>
				);
			},
		},
		{
			accessorKey: "input",
			header: () => {
				const { t } = useTranslation("logs");
				return t("column_labels.input");
			},
			size: 330,
			cell: ({ row }) => <LogMessageCell log={row.original} />,
		},
		{
			accessorKey: "model",
			header: () => {
				const { t } = useTranslation("logs");
				return t("column_labels.model");
			},
			size: 170,
			cell: ({ row }) => {
				const provider = row.original.provider as ProviderName | undefined;
				const model = row.original.model;
				const keyName = row.original.selected_key_name;
				return (
					<div className="flex min-w-0 items-center gap-2">
						{provider ? <RenderProviderIcon provider={provider as ProviderIconType} size="xs" /> : null}
						<div className="flex min-w-0 flex-col leading-tight">
							<span className="truncate font-mono text-[12px]">{model || "N/A"}</span>
							<span className="text-muted-foreground truncate text-[10.5px]">
								{provider ? getProviderLabel(provider) : "N/A"}
								{keyName ? <span className="text-muted-foreground/60"> · {keyName}</span> : null}
							</span>
						</div>
					</div>
				);
			},
		},
		{
			id: "app",
			accessorKey: "app",
			header: () => {
				const { t } = useTranslation("logs");
				return t("column_labels.app");
			},
			size: 130,
			cell: ({ row }) => {
				const app = row.original.app ? mapAppToClientApp(row.original.app) : mapUserAgentToApp(row.original.user_agent);
				const icon = row.original.app ? customAppIcons[row.original.app] || app.icon : app.icon;
				const label = logAppDisplayName(app, row.original.user_agent);
				return (
					<div className="flex min-w-0 items-center gap-2" title={row.original.user_agent || undefined}>
						{icon ? (
							<img className="shrink-0 rounded-sm" src={icon} alt={label} width={20} height={20} loading="lazy" decoding="async" />
						) : null}
						<span className="max-w-[100px] min-w-0 truncate text-[12px]">{label}</span>
					</div>
				);
			},
		},
		{
			accessorKey: "latency",
			header: ({ column }) => {
				const { t } = useTranslation("logs");
				return (
					<Button variant="ghost" data-testid="logs-latency-sort-btn" onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}>
						{t("column_labels.latency")}
						<ArrowUpDown className="ml-2 h-4 w-4" />
					</Button>
				);
			},
			size: 100,
			cell: ({ row }) => {
				const latency = row.original.latency;
				if (latency === undefined || latency === null) {
					return null;
				}
				const isSuccess = row.original.status === "success";
				const tone = isSuccess
					? latency >= 5000
						? "text-red-500"
						: latency >= 2000
							? "text-amber-500"
							: "text-emerald-500"
					: "text-muted-foreground";
				return (
					<div className="text-right font-mono text-[12px] tabular-nums">
						<strong className={tone}>{Math.round(latency).toLocaleString()}</strong> ms
					</div>
				);
			},
		},
		{
			accessorKey: "tps",
			header: "TPS",
			size: 90,
			minSize: 90,
			maxSize: 90,
			cell: ({ row }) => {
				const { latency, token_usage } = row.original;
				const output = token_usage?.completion_tokens;
				if (latency == null || latency <= 0 || !output) {
					return <div className="text-right font-mono text-xs" />;
				}
				const tps = (output / latency) * 1000;
				const colorClass =
					tps < 20
						? "text-red-500 dark:text-red-400"
						: tps < 50
							? "text-amber-500 dark:text-amber-400"
							: tps < 80
								? "text-blue-500 dark:text-blue-400"
								: "text-green-600 dark:text-green-400";
				return (
					<div className="text-right font-mono text-[12px] tabular-nums">
						<strong className={colorClass}>{tps >= 100 ? Math.round(tps).toLocaleString() : tps.toFixed(1)}</strong> t/s
					</div>
				);
			},
		},
		{
			accessorKey: "tokens",
			header: ({ column }) => {
				const { t } = useTranslation("logs");
				return (
					<Button
						variant="ghost"
						className="w-full justify-end"
						data-testid="logs-tokens-sort-btn"
						onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
					>
						{t("column_labels.tokens")}
						<ArrowUpDown className="ml-2 h-4 w-4" />
					</Button>
				);
			},
			size: 174,
			cell: ({ row }) => {
				const tokenUsage = row.original.token_usage;
				if (!tokenUsage) {
					return null;
				}
				const prompt = tokenUsage.prompt_tokens ?? 0;
				const completion = tokenUsage.completion_tokens ?? 0;
				const total = tokenUsage.total_tokens ?? 0;
				const hasSplit = tokenUsage.completion_tokens != null && tokenUsage.prompt_tokens != null;
				const splitBase = prompt + completion || 1;
				const inPct = (prompt / splitBase) * 100;
				return (
					<div className="flex flex-col items-end gap-0.5 leading-tight">
						<div className="flex items-center gap-2">
							<span className="font-mono text-[12px] tabular-nums">{formatTokensAdaptive(total)}</span>
							{hasSplit && (
								<div className="flex h-1.5 w-[64px] overflow-hidden rounded-sm">
									<div className="bg-blue-400" style={{ width: `${inPct}%` }} />
									<div className="flex-1 bg-violet-400" />
								</div>
							)}
						</div>
						{hasSplit && (
							<div className="text-muted-foreground font-mono text-[10.5px] tabular-nums">
								<span className="text-blue-500">{formatTokensAdaptive(prompt)}</span>
								<span> / </span>
								<span className="text-violet-500">{formatTokensAdaptive(completion)}</span>
							</div>
						)}
					</div>
				);
			},
		},
		{
			id: "rtk",
			header: "RTK",
			size: 70,
			minSize: 50,
			maxSize: 100,
			cell: ({ row }) => {
				const ratio = row.original.metadata?.rtk_compression_ratio;
				if (ratio == null) return <div className="font-mono text-xs text-gray-300">—</div>;
				const pct = typeof ratio === "number" ? (ratio * 100).toFixed(1) : String(ratio);
				const tone =
					Number(ratio) >= 0.5
						? "text-emerald-600 dark:text-emerald-400"
						: Number(ratio) >= 0.2
							? "text-amber-600 dark:text-amber-400"
							: "text-muted-foreground";
				return <div className={`font-mono text-xs tabular-nums ${tone}`}>{pct}%</div>;
			},
		},
		{
			id: "compressed_before",
			header: () => {
				const { t } = useTranslation("logs");
				return t("column_labels.compressed_before");
			},
			size: 100,
			minSize: 80,
			maxSize: 130,
			cell: ({ row }) => {
				const tokens = row.original.metadata?.original_prompt_tokens;
				if (tokens == null) return <div className="font-mono text-xs text-gray-300">—</div>;
				return <div className="text-right font-mono text-xs tabular-nums">{formatTokensAdaptive(Number(tokens))}</div>;
			},
		},
		{
			id: "compressed_after",
			header: () => {
				const { t } = useTranslation("logs");
				return t("column_labels.compressed_after");
			},
			size: 100,
			minSize: 80,
			maxSize: 130,
			cell: ({ row }) => {
				const tokens = row.original.metadata?.compressed_prompt_tokens;
				if (tokens == null) return <div className="font-mono text-xs text-gray-300">—</div>;
				return <div className="text-right font-mono text-xs tabular-nums">{formatTokensAdaptive(Number(tokens))}</div>;
			},
		},
	];

	const attributionColumns: ColumnDef<LogEntry>[] = [
		{
			id: "virtual_key",
			header: ({ column }) => {
				const { t } = useTranslation("logs");
				return t("column_labels.virtual_key");
			},
			size: 170,
			cell: ({ row }) => <AttributionCell name={row.original.virtual_key_name} id={row.original.virtual_key_id} />,
		},
		{
			id: "routing_rule",
			header: ({ column }) => {
				const { t } = useTranslation("logs");
				return t("column_labels.routing_rule");
			},
			size: 170,
			cell: ({ row }) => <AttributionCell name={row.original.routing_rule_name} id={row.original.routing_rule_id} />,
		},
		{
			id: "routing_decision",
			header: ({ column }) => {
				const { t } = useTranslation("logs");
				return t("column_labels.routing_decision");
			},
			size: 90,
			cell: ({ row }) => {
				const count = row.original.routing_decision_count ?? 0;
				return <div className="font-mono text-xs tabular-nums">{count}</div>;
			},
		},
		{
			id: "team",
			header: ({ column }) => {
				const { t } = useTranslation("logs");
				return t("column_labels.team");
			},
			size: 150,
			cell: ({ row }) => (
				<AttributionCell
					names={row.original.team_names}
					name={row.original.team_name}
					ids={row.original.team_ids}
					id={row.original.team_id}
				/>
			),
		},
		{
			id: "customer",
			header: ({ column }) => {
				const { t } = useTranslation("logs");
				return t("column_labels.customer");
			},
			size: 150,
			cell: ({ row }) => (
				<AttributionCell
					names={row.original.customer_names}
					name={row.original.customer_name}
					ids={row.original.customer_ids}
					id={row.original.customer_id}
				/>
			),
		},
		{
			id: "user",
			header: ({ column }) => {
				const { t } = useTranslation("logs");
				return t("column_labels.user");
			},
			size: 150,
			cell: ({ row }) => <AttributionCell name={row.original.user_name} id={row.original.user_id} />,
		},
		{
			id: "business_unit",
			header: ({ column }) => {
				const { t } = useTranslation("logs");
				return t("column_labels.business_unit");
			},
			size: 150,
			cell: ({ row }) => (
				<AttributionCell
					names={row.original.business_unit_names}
					name={row.original.business_unit_name}
					ids={row.original.business_unit_ids}
					id={row.original.business_unit_id}
				/>
			),
		},
	];

	return [...expandColumn, ...baseColumns, ...attributionColumns];
};