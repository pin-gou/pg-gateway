import { formatCost, formatLatency } from "@/app/workspace/dashboard/utils/chartUtils";
import { TimelineDetail } from "@/app/workspace/logs/timeline/views/timelineDetail";
import { useGetLogTimelineQuery } from "@/lib/store/apis/logsApi";
import { useGetProviderQuery } from "@/lib/store/apis/providersApi";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alertDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/codeEditor";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdownMenu";
import { DottedSeparator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { ProviderIconType, RenderProviderIcon, RoutingEngineUsedIcons } from "@/lib/constants/icons";
import {
	logAppDisplayName,
	mapAppToClientApp,
	mapUserAgentToApp,
	RequestTypeColors,
	RequestTypeLabels,
	RoutingEngineUsedColors,
	RoutingEngineUsedLabels,
	Status,
} from "@/lib/constants/logs";
import { ContentBlock, LogEntry, ResponsesMessage } from "@/lib/types/logs";
import { useGetUserAgentMappingsQuery } from "@/lib/store";
import { cn } from "@/lib/utils";
import { downloadAsJson } from "@/lib/utils/browser-download";
import { formatCompactNumber, formatTokensAdaptive } from "@/lib/utils/numbers";
import { applyRedactionMapping, hasRedactionMappingEntries } from "@/lib/utils/redaction";
import { isJson } from "@/lib/utils/validation";
import { Link } from "@tanstack/react-router";
import { addMilliseconds, format } from "date-fns";
import { AlertCircle, ChevronDown, Clipboard, Copy, Download, Loader2, Trash2, Wrench } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import i18n from "@/lib/i18n/config";
import BlockHeader from "../views/blockHeader";
import CollapsibleBox from "../views/collapsibleBox";
import ImageView from "../views/imageView";
import { LazyJsonBlock } from "../views/lazyJsonBlock";
import LogChatMessageView, { LogChatFileBlockView } from "../views/logChatMessageView";
import LogEntryDetailsView from "../views/logEntryDetailsView";
import OCRView from "../views/ocrView";
import PluginLogsView from "../views/pluginLogsView";
import RTKCompressionDiffView from "../views/rtkCompressionDiffView";
import RTKMetadataBadge, { isRTKMetadataKey } from "../views/rtkMetadataBadge";
import SpeechView from "../views/speechView";
import TranscriptionView from "../views/transcriptionView";
import VideoView from "../views/videoView";

const rateColorClass = (rate: number): string => {
	if (rate < 20) return "text-red-500 dark:text-red-400";
	if (rate < 50) return "text-amber-500 dark:text-amber-400";
	if (rate < 80) return "text-blue-500 dark:text-blue-400";
	return "text-green-600 dark:text-green-400";
};

const formatRealtimeTransport = (value: unknown, t?: (k: string) => string): string => {
	const transport = String(value ?? "").trim();
	switch (transport.toLowerCase()) {
		case "websocket":
			return t ? t("detailView.websocket") : "WebSocket";
		case "webrtc":
			return t ? t("detailView.webrtc") : "WebRTC";
		default:
			return transport || (t ? t("detailView.unknown") : "Unknown");
	}
};

const getRealtimeTransportBadgeClass = (value: unknown): string => {
	switch (String(value ?? "").toLowerCase()) {
		case "websocket":
			return "border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-600 dark:bg-indigo-950 dark:text-indigo-300";
		case "webrtc":
			return "border-purple-300 bg-purple-50 text-purple-700 dark:border-purple-600 dark:bg-purple-950 dark:text-purple-300";
		default:
			return "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-300";
	}
};

const formatRealtimeSource = (value: unknown, t?: (k: string) => string): string => {
	const source = String(value ?? "").trim();
	switch (source.toLowerCase()) {
		case "ei":
			return t ? t("detailView.eventInitiated") : "Event Initiated";
		case "lm":
			return t ? t("detailView.languageModel") : "Language Model";
		default:
			return source || (t ? t("detailView.unknown") : "Unknown");
	}
};

const extractResponsesText = (msg: ResponsesMessage, mapping?: Record<string, string>): string => {
	let text: string;
	if (msg.type === "reasoning") {
		const summaryText = (msg.summary ?? [])
			.map((s) => s.text)
			.filter(Boolean)
			.join("\n")
			.trim();
		if (summaryText) text = summaryText;
		else if (msg.encrypted_content) text = msg.encrypted_content;
		else text = "";
	} else if (typeof msg.content === "string") {
		text = msg.content;
	} else if (Array.isArray(msg.content)) {
		text = msg.content
			.filter(
				(b: any) =>
					b && b.text && (b.type === "input_text" || b.type === "output_text" || b.type === "reasoning_text" || b.type === "refusal"),
			)
			.map((b: any) => b.text as string)
			.join("\n");
	} else if (typeof (msg as any).arguments === "string") {
		text = (msg as any).arguments as string;
	} else {
		text = "";
	}
	if (mapping && text) {
		for (const [key, value] of Object.entries(mapping)) {
			text = text.replaceAll(`[${key}]`, value);
		}
	}
	return text;
};

type ReasoningParts = {
	summaries: string[];
	encrypted?: string;
	signatures: string[];
	contentText?: string;
};

const collectReasoningFromBlocks = (blocks: any[]): { text: string; signatures: string[] } => {
	const texts: string[] = [];
	const signatures: string[] = [];
	for (const b of blocks) {
		if (!b || typeof b !== "object") continue;
		const isReasoningish =
			b.type === "input_text" || b.type === "output_text" || b.type === "reasoning_text" || b.type === "refusal" || !b.type;
		if (isReasoningish && typeof b.text === "string" && b.text.trim()) {
			texts.push(b.text);
		}
		if (typeof b.signature === "string" && b.signature.trim()) {
			signatures.push(b.signature.trim());
		}
	}
	return { text: texts.join("\n"), signatures };
};

const extractReasoningParts = (msg: ResponsesMessage, mapping?: Record<string, string>): ReasoningParts => {
	let summaries = (msg.summary ?? []).map((s) => (s?.text ?? "").trim()).filter(Boolean);
	const encryptedRaw = (msg as any).encrypted_content?.trim?.();
	let encrypted = encryptedRaw ? encryptedRaw : undefined;
	const signatures: string[] = [];
	let contentText = "";
	if (typeof msg.content === "string") {
		contentText = msg.content;
	} else if (Array.isArray(msg.content)) {
		const fromContent = collectReasoningFromBlocks(msg.content as any[]);
		contentText = fromContent.text;
		signatures.push(...fromContent.signatures);
	}
	// Some providers stash reasoning under `output` instead of `content`
	const out = (msg as any).output;
	if (out !== undefined) {
		if (typeof out === "string" && out.trim() && !contentText) {
			contentText = out;
		} else if (Array.isArray(out)) {
			const fromOutput = collectReasoningFromBlocks(out as any[]);
			if (!contentText && fromOutput.text) contentText = fromOutput.text;
			signatures.push(...fromOutput.signatures);
		}
	}
	// Defensive: top-level text-bearing fields some variants use
	if (!contentText) {
		const topText =
			(typeof (msg as any).text === "string" && (msg as any).text) ||
			(typeof (msg as any).thinking === "string" && (msg as any).thinking) ||
			"";
		if (topText.trim()) contentText = topText;
	}
	if (mapping) {
		summaries = summaries.map((s) => {
			for (const [key, value] of Object.entries(mapping)) {
				s = s.replaceAll(`[${key}]`, value);
			}
			return s;
		});
		if (encrypted) {
			for (const [key, value] of Object.entries(mapping)) {
				encrypted = encrypted.replaceAll(`[${key}]`, value);
			}
		}
		if (contentText) {
			for (const [key, value] of Object.entries(mapping)) {
				contentText = contentText.replaceAll(`[${key}]`, value);
			}
		}
	}
	return {
		summaries,
		encrypted,
		signatures,
		contentText: contentText || undefined,
	};
};

const extractChatReasoning = (message: any, mapping?: Record<string, string>): string => {
	if (!message) return "";
	let text = "";
	if (typeof message.reasoning === "string" && message.reasoning.trim()) {
		text = message.reasoning;
	} else if (Array.isArray(message.reasoning_details)) {
		const parts = (message.reasoning_details as any[])
			.map((d) => (typeof d?.text === "string" ? d.text : (d?.summary ?? "")))
			.map((t: string) => (typeof t === "string" ? t.trim() : ""))
			.filter(Boolean);
		if (parts.length > 0) text = parts.join("\n");
	}
	if (mapping && text) {
		for (const [key, value] of Object.entries(mapping)) {
			text = text.replaceAll(`[${key}]`, value);
		}
	}
	return text;
};

const getResponsesRole = (msg: ResponsesMessage): MessageRole => {
	if (msg.type === "reasoning") return "reasoning";
	if (
		msg.type &&
		(msg.type.endsWith("_call") ||
			msg.type.endsWith("_call_output") ||
			msg.type === "tool_search_output" ||
			msg.type === "additional_tools" ||
			msg.type === "mcp_list_tools" ||
			msg.type === "mcp_approval_request" ||
			msg.type === "mcp_approval_responses")
	) {
		return "tool";
	}
	const r = msg.role;
	if (r === "user") return "user";
	if (r === "assistant") return "assistant";
	if (r === "system" || r === "developer") return "system";
	return "assistant";
};

const isPlainAssistantResponsesMessage = (m: ResponsesMessage): boolean => {
	if (m.type && m.type !== "message") return false;
	return getResponsesRole(m) === "assistant";
};

const isReasoningResponsesMessage = (m: ResponsesMessage): boolean => m.type === "reasoning";

// Streaming providers can emit a single logical assistant turn (or reasoning
// item) as many small messages. Collapse adjacent ones so the UI shows one
// bubble per turn instead of N "1 line" bubbles.
// Expands namespace tool declarations into their callable children
// (`namespace.tool` names), leaving plain declarations untouched.
const flattenDeclaredTools = (tools: any[]): any[] =>
	tools.flatMap((tool) =>
		tool?.type === "namespace" && Array.isArray(tool.tools)
			? (tool.tools as any[]).map((nested) => ({ ...nested, name: `${tool.name ?? "namespace"}.${nested?.name ?? ""}` }))
			: [tool],
	);

// Later declarations of the same tool replace earlier ones — a conversation
// history can carry multiple `additional_tools` items, each a point-in-time
// update, so the effective tool set is last-write-wins by name. Unnamed
// declarations are kept as-is.
const dedupeDeclaredTools = (tools: any[]): any[] => {
	const byName = new Map<string, number>();
	const out: any[] = [];
	for (const tool of tools) {
		const name = tool?.name ?? tool?.function?.name;
		if (typeof name === "string" && name) {
			const idx = byName.get(name);
			if (idx !== undefined) {
				out[idx] = tool;
				continue;
			}
			byName.set(name, out.length);
		}
		out.push(tool);
	}
	return out;
};

const coalesceResponsesMessages = (msgs: ResponsesMessage[]): ResponsesMessage[] => {
	const out: ResponsesMessage[] = [];
	for (const m of msgs) {
		const last = out[out.length - 1];
		if (last && isPlainAssistantResponsesMessage(last) && isPlainAssistantResponsesMessage(m)) {
			const merged = extractResponsesText(last) + extractResponsesText(m);
			out[out.length - 1] = {
				...last,
				content: [{ type: "output_text", text: merged } as any],
			};
			continue;
		}
		if (last && isReasoningResponsesMessage(last) && isReasoningResponsesMessage(m)) {
			const aSum = last.summary ?? [];
			const bSum = m.summary ?? [];
			const aEnc = (last as any).encrypted_content ?? "";
			const bEnc = (m as any).encrypted_content ?? "";
			const joinedEnc = `${aEnc}${bEnc}`;
			out[out.length - 1] = {
				...last,
				summary: [...aSum, ...bSum],
				encrypted_content: joinedEnc ? joinedEnc : undefined,
			} as ResponsesMessage;
			continue;
		}
		out.push(m);
	}
	return out.filter((m) => {
		if (!isPlainAssistantResponsesMessage(m)) return true;
		return extractResponsesText(m).length > 0;
	});
};

const extractMessageText = (message: any, mapping?: Record<string, string>): string => {
	if (!message || message.content == null) return "";
	let text: string;
	if (typeof message.content === "string") {
		text = message.content;
	} else if (Array.isArray(message.content)) {
		text = message.content
			.filter((block: any) => block && (block.type === "text" || block.type === "input_text" || block.type === "output_text") && block.text)
			.map((block: any) => block.text)
			.join("\n");
	} else {
		text = "";
	}
	if (mapping && text) {
		for (const [key, value] of Object.entries(mapping)) {
			text = text.replaceAll(`[${key}]`, value);
		}
	}
	return text;
};

const formatJsonSafe = (str: string | undefined): string => {
	try {
		return JSON.stringify(JSON.parse(str || ""), null, 2);
	} catch {
		return str || "";
	}
};

const formatToolChoice = (value: unknown): string => {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

// Role set for the messages-tab filter. Module-level constant so the derived
// sections below (memoized on `visibleRoles`) stay referentially stable.
const ALL_ROLES: MessageRole[] = ["system", "user", "assistant", "tool", "reasoning"];

// Incremental messages-tab rendering: only this many rows mount on first paint;
// the rest are revealed in chunks as the user scrolls / clicks "show more".
const INITIAL_MESSAGE_LIMIT = 20;
const MESSAGE_LOAD_CHUNK = 50;

type MessagesSectionOptions = {
	isPassthrough: boolean;
	visibleRoles: Set<MessageRole>;
	activeInputRevealMapping?: Record<string, string>;
	activeOutputRevealMapping?: Record<string, string>;
	audioFormat?: string;
	t: (key: string, options?: Record<string, unknown>) => string;
};

// Builds the chat-completion message rows once per relevant state change, so
// unrelated re-renders (reveal toggle, role filter, background refetches) don't
// re-run text extraction over 400-800KB payloads.
const buildChatRows = (log: LogEntry, opts: MessagesSectionOptions): ReactNode[] | null => {
	const { isPassthrough, visibleRoles, activeInputRevealMapping, activeOutputRevealMapping, audioFormat, t } = opts;
	if (isPassthrough) return null;
	const showSection =
		(log.input_history && log.input_history.length > 0) ||
		(log.output_message && !log.error_details?.error.message) ||
		log.stop_reason === "refusal" ||
		log.stop_reason === "content_filter" ||
		log.stop_reason === "safety";
	if (!showSection) return null;

	const rows: ReactNode[] = [];
	const showAll = visibleRoles.size === ALL_ROLES.length;
	const inputHistory = log.input_history ?? [];
	const filteredMessages = showAll
		? inputHistory.filter(Boolean)
		: inputHistory.filter((m) => {
				if (!m) return false;
				const mainRole = ((m.role as string) || "user") as MessageRole;
				const hasReasoning = !!extractChatReasoning(m);
				return visibleRoles.has(mainRole) || (hasReasoning && visibleRoles.has("reasoning"));
			});

	filteredMessages.forEach((message, index) => {
		const role = ((message.role as string) || "user") as MessageRole;
		const text = extractMessageText(message, activeInputRevealMapping);
		const reasoningText = extractChatReasoning(message, activeInputRevealMapping);
		const showMain = showAll || visibleRoles.has(role);
		const showReasoning = !!reasoningText && (showAll || visibleRoles.has("reasoning"));
		const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
		const isOverallLast = index === inputHistory.length - 1 && !log.output_message && !log.error_details?.error.message;
		const lineCount = text ? text.split("\n").length : 0;
		const approxTokens = text ? Math.max(1, Math.round(text.length / 4)) : 0;
		const reasoningTokens = reasoningText ? Math.max(1, Math.round(reasoningText.length / 4)) : 0;
		const meta = text
			? role === "system" || role === "tool"
				? `${lineCount} line${lineCount === 1 ? "" : "s"} · ~${approxTokens} tokens`
				: `${lineCount} line${lineCount === 1 ? "" : "s"}`
			: hasToolCalls
				? `${message.tool_calls!.length} tool call${message.tool_calls!.length === 1 ? "" : "s"}`
				: undefined;
		const usePlainText = role === "user" || role === "assistant";
		if (showReasoning) {
			rows.push(
				<MessageRow key={`${index}-reasoning`} role="reasoning" meta={`~${reasoningTokens} tokens`} last={isOverallLast && !showMain}>
					<CollapsibleCode text={reasoningText} preview={3} mono={false} />
				</MessageRow>,
			);
		}
		if (showMain) {
			rows.push(
				<MessageRow key={index} role={role} meta={meta} last={isOverallLast}>
					{text ? (
						usePlainText && isJson(text) ? (
							<LazyJsonBlock text={text} mono={false} bordered={false} />
						) : usePlainText ? (
							<CollapsibleCode text={text} preview={3} mono={false} />
						) : (
							<CollapsibleCode text={text} preview={3} lang={role === "system" ? "xml" : undefined} />
						)
					) : (
						<LogChatMessageView message={message} audioFormat={audioFormat} />
					)}
					{text &&
						Array.isArray(message.content) &&
						(message.content as ContentBlock[])
							.filter((b) => b.type === "image_url")
							.map((b, i) => {
								const src = b.image_url?.url;
								if (!src) return null;
								return <img key={`${i}-${src}`} src={src} alt={t("views.attachedImage")} className="mt-2 max-w-full rounded border" />;
							})}
					{text &&
						Array.isArray(message.content) &&
						(message.content as ContentBlock[])
							.filter((b) => b.type === "file" && b.file)
							.map((b, i) => (
								<LogChatFileBlockView key={`${i}-${b.file?.filename || b.file?.file_id || "file"}`} block={b} className="mt-2" />
							))}
					{hasToolCalls && text ? (
						<div className="text-muted-foreground mt-2 text-[11px]">
							{message
								.tool_calls!.map((tc) => tc.function?.name)
								.filter(Boolean)
								.join(", ") || `${message.tool_calls!.length} tool call${message.tool_calls!.length === 1 ? "" : "s"}`}
						</div>
					) : null}
				</MessageRow>,
			);
		}
	});

	if (log.output_message && !log.error_details?.error.message) {
		const reasoningText = extractChatReasoning(log.output_message, activeOutputRevealMapping);
		const showReasoning = !!reasoningText && (showAll || visibleRoles.has("reasoning"));
		const showAssistant = visibleRoles.has("assistant");
		if (showReasoning || showAssistant) {
			const text = extractMessageText(log.output_message, activeOutputRevealMapping);
			const refusalText = applyRedactionMapping(log.output_message.refusal, activeOutputRevealMapping);
			const isStopReasonRefusal = log.stop_reason === "refusal" || log.stop_reason === "content_filter" || log.stop_reason === "safety";
			const showRefusal = refusalText || (!text && isStopReasonRefusal);
			const lineCount = text ? text.split("\n").length : 0;
			const tokenMeta = log.token_usage?.completion_tokens ? `${log.token_usage.completion_tokens} tokens` : undefined;
			const meta = text
				? tokenMeta
					? `${lineCount} line${lineCount === 1 ? "" : "s"} · ${tokenMeta}`
					: `${lineCount} line${lineCount === 1 ? "" : "s"}`
				: showRefusal
					? "refusal"
					: tokenMeta;
			const reasoningTokens = reasoningText
				? log.token_usage?.completion_tokens_details?.reasoning_tokens || Math.max(1, Math.round(reasoningText.length / 4))
				: 0;
			if (showReasoning) {
				rows.push(
					<MessageRow key="output-reasoning" role="reasoning" meta={`~${reasoningTokens} tokens`} last={!showAssistant}>
						<CollapsibleCode text={reasoningText} preview={3} mono={false} />
					</MessageRow>,
				);
			}
			if (showAssistant) {
				rows.push(
					<MessageRow key="output" role="assistant" meta={meta} last>
						{showRefusal ? (
							<div className="rounded-sm border border-red-200 bg-red-50/70 p-3 dark:border-red-900 dark:bg-red-950/30">
								<div className="flex items-center gap-2 text-red-700 dark:text-red-400">
									<AlertCircle className="h-4 w-4 shrink-0" />
									<span className="text-[12.5px] font-semibold">{t("detailView.refusal")}</span>
								</div>
								{refusalText && (
									<div className="mt-2 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-red-700 dark:text-red-400">
										{refusalText}
									</div>
								)}
							</div>
						) : text ? (
							isJson(text) ? (
								<LazyJsonBlock text={text} mono={false} bordered={false} />
							) : (
								<CollapsibleCode text={text} preview={3} mono={false} />
							)
						) : (
							<LogChatMessageView message={log.output_message} audioFormat={audioFormat} />
						)}
					</MessageRow>,
				);
			}
		}
	}

	if (
		!log.output_message &&
		!log.error_details?.error.message &&
		(log.stop_reason === "refusal" || log.stop_reason === "content_filter" || log.stop_reason === "safety")
	) {
		rows.push(
			<MessageRow key="output-refusal" role="assistant" meta="refusal" last>
				<div className="rounded-sm border border-red-200 bg-red-50/70 p-3 dark:border-red-900 dark:bg-red-950/30">
					<div className="flex items-center gap-2 text-red-700 dark:text-red-400">
						<AlertCircle className="h-4 w-4 shrink-0" />
						<span className="text-[12.5px] font-semibold">{t("detailView.refusal")}</span>
					</div>
				</div>
			</MessageRow>,
		);
	}

	return rows;
};

// Builds the Responses-API message rows once per relevant state change. Same
// rationale as buildChatRows above.
const buildResponsesRows = (log: LogEntry, opts: MessagesSectionOptions): ReactNode[] | null => {
	const { visibleRoles, activeInputRevealMapping, activeOutputRevealMapping, t } = opts;
	const showFiltered = visibleRoles.size !== ALL_ROLES.length;
	const rawInput = log.responses_input_history ?? [];
	const inputMsgs = showFiltered ? rawInput.filter((m) => visibleRoles.has(getResponsesRole(m))) : rawInput;
	const rawOutput = log.status !== "processing" && !log.error_details?.error.message ? (log.responses_output ?? []) : [];
	const outputMsgs = showFiltered ? rawOutput.filter((m) => visibleRoles.has(getResponsesRole(m))) : rawOutput;
	const all: Array<{ msg: ResponsesMessage; mapping?: Record<string, string> }> = [
		...coalesceResponsesMessages(inputMsgs).map((msg) => ({ msg, mapping: activeInputRevealMapping })),
		...coalesceResponsesMessages(outputMsgs).map((msg) => ({ msg, mapping: activeOutputRevealMapping })),
	];
	if (all.length === 0) return null;
	return all.map(({ msg, mapping }, index) => {
		const role = getResponsesRole(msg);
		const isLast = index === all.length - 1;
		const reasoningParts = role === "reasoning" ? extractReasoningParts(msg, mapping) : null;
		const reasoningHasAny =
			!!reasoningParts &&
			(reasoningParts.summaries.length > 0 ||
				!!reasoningParts.encrypted ||
				!!reasoningParts.contentText ||
				reasoningParts.signatures.length > 0);
		const text = role === "reasoning" ? "" : extractResponsesText(msg, mapping);
		const lineCount = text ? text.split("\n").length : 0;
		const approxTokens = text ? Math.max(1, Math.round(text.length / 4)) : 0;
		let meta: string | undefined;
		if (role === "reasoning" && reasoningParts) {
			const totalLen =
				reasoningParts.summaries.reduce((acc, s) => acc + s.length, 0) +
				(reasoningParts.contentText?.length ?? 0) +
				(reasoningParts.encrypted?.length ?? 0);
			const totalApprox = totalLen ? Math.max(1, Math.round(totalLen / 4)) : 0;
			const hasOpaqueOnly =
				(!!reasoningParts.encrypted || reasoningParts.signatures.length > 0) &&
				reasoningParts.summaries.length === 0 &&
				!reasoningParts.contentText;
			meta = totalApprox ? `~${totalApprox} tokens${hasOpaqueOnly ? " · encrypted" : ""}` : hasOpaqueOnly ? "encrypted" : undefined;
		} else {
			meta = text
				? role === "system" || role === "tool"
					? msg.name
						? `${msg.name} · ${lineCount} line${lineCount === 1 ? "" : "s"} · ~${approxTokens} tokens`
						: `${lineCount} line${lineCount === 1 ? "" : "s"} · ~${approxTokens} tokens`
					: `${lineCount} line${lineCount === 1 ? "" : "s"}`
				: msg.name
					? msg.name
					: msg.type === "function_call_output" && msg.call_id
						? msg.call_id
						: Array.isArray(msg.tools)
							? (() => {
									const callable = flattenDeclaredTools(msg.tools).length;
									return callable !== msg.tools.length
										? `${msg.type} · ${msg.tools.length} declarations · ${callable} callable tools`
										: `${msg.type} · ${msg.tools.length} tool${msg.tools.length === 1 ? "" : "s"}`;
								})()
							: msg.type || undefined;
		}
		const usePlainText = role === "user" || role === "assistant";
		return (
			<MessageRow key={index} role={role} meta={meta} last={isLast}>
				{role === "reasoning" ? (
					reasoningHasAny && reasoningParts ? (
						<div className="space-y-3">
							{reasoningParts.contentText ? <CollapsibleCode text={reasoningParts.contentText} preview={3} mono={false} /> : null}
							{reasoningParts.summaries.map((s, i) => (
								<div key={`s-${i}`} className="space-y-1">
									{reasoningParts.summaries.length > 1 ? (
										<div className="text-muted-foreground text-[10.5px] font-semibold tracking-wider uppercase">
											{t("detailView.summaryIndex", { count: i + 1 })}
										</div>
									) : null}
									<CollapsibleCode text={s} preview={3} mono={false} />
								</div>
							))}
							{reasoningParts.encrypted ? (
								<div className="space-y-1">
									<div className="text-muted-foreground text-[10.5px] font-semibold tracking-wider uppercase">
										{t("detailView.encrypted")}
									</div>
									<CollapsibleCode text={reasoningParts.encrypted} preview={2} />
								</div>
							) : null}
							{reasoningParts.signatures.length > 0 ? (
								<EncryptedReveal
									text={reasoningParts.signatures.join("\n\n")}
									label={reasoningParts.signatures.length > 1 ? t("detailView.encryptedSignatures") : t("detailView.encryptedSignature")}
								/>
							) : null}
						</div>
					) : (
						<div className="text-muted-foreground text-[12px] italic">{t("detailView.noReasoningContent")}</div>
					)
				) : text ? (
					usePlainText ? (
						<CollapsibleCode text={text} preview={3} mono={false} />
					) : (
						<CollapsibleCode text={text} preview={3} lang={role === "system" ? "xml" : undefined} />
					)
				) : msg.output !== undefined ? (
					<CollapsibleCode text={typeof msg.output === "string" ? msg.output : JSON.stringify(msg.output, null, 2)} preview={3} />
				) : Array.isArray(msg.tools) && msg.tools.length > 0 ? (
					<CollapsibleCode text={JSON.stringify(msg.tools, null, 2)} preview={3} />
				) : Array.isArray(msg.tools) ? (
					<div className="text-muted-foreground text-[12px] italic">{t("detailView.noToolsDeclared")}</div>
				) : (
					<div className="text-muted-foreground text-[12px] italic">{t("detailView.noContent")}</div>
				)}
				{Array.isArray(msg.content) &&
					msg.content
						.filter((b) => b?.type === "input_image" && b.image_url)
						.map((b, i) => (
							<img
								key={`${i}-${b.image_url}`}
								src={b.image_url}
								alt={t("views.attachedImage")}
								className="mt-2 max-w-full rounded border"
							/>
						))}
			</MessageRow>
		);
	});
};

// Helper to detect passthrough operations
const isPassthroughOperation = (object: string) => object === "passthrough" || object === "passthrough_stream";

// extractCompressedToolContents walks a log entry's request body for the
// post-compression tool messages and indexes them by the same `index` value
// the RTK pipeline recorded on the pre-compression snapshot side. The diff
// view aligns the two sides on this key.
//
// Coverage:
//   - Chat Completions: each tool-role message in input_history contributes
//     one entry keyed by its position in the array.
//   - Responses API: each function_call_output item in
//     responses_input_history contributes one entry keyed by its position.
//   - Anthropic-style tool_result blocks nested inside a user message use a
//     synthetic index (i*100+j) on the Go side; those don't currently have a
//     TS surface in ContentBlock, so they fall through and the diff view
//     falls back to the original text on both sides — matching the prior
//     behaviour when the compressed snapshot was missing.
function extractCompressedToolContents(log: LogEntry): { index: number; content: string }[] {
	const items: { index: number; content: string }[] = [];

	if (Array.isArray(log.input_history)) {
		log.input_history.forEach((msg, i) => {
			if (msg?.role !== "tool") return;
			const text = readMessageContentAsText(msg.content);
			if (text === "") return;
			items.push({ index: i, content: text });
		});
	}

	if (Array.isArray(log.responses_input_history)) {
		log.responses_input_history.forEach((msg, i) => {
			if (msg?.type !== "function_call_output") return;
			const output = (msg as { output?: unknown }).output;
			if (typeof output === "string") {
				if (output !== "") items.push({ index: i, content: output });
				return;
			}
			if (Array.isArray(output)) {
				const text = output
					.map((block) =>
						block && typeof block === "object" && "text" in block && typeof (block as { text?: unknown }).text === "string"
							? (block as { text: string }).text
							: "",
					)
					.filter((s) => s.length > 0)
					.join("");
				if (text !== "") items.push({ index: i, content: text });
			}
		});
	}

	return items;
}

function readMessageContentAsText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (!block || typeof block !== "object") return "";
				const text = (block as { text?: unknown }).text;
				return typeof text === "string" ? text : "";
			})
			.join("");
	}
	return "";
}

// Helper to detect container operations (for hiding irrelevant fields like Model/Tokens)
const isContainerOperation = (object: string) => {
	const containerTypes = [
		"container_create",
		"container_list",
		"container_retrieve",
		"container_delete",
		"container_file_create",
		"container_file_list",
		"container_file_retrieve",
		"container_file_content",
		"container_file_delete",
	];
	return containerTypes.includes(object?.toLowerCase());
};

const statusPillStyles: Record<string, string> = {
	success: "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-900",
	error: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900",
	processing: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900",
	cancelled: "bg-gray-50 text-gray-700 border-gray-200 dark:bg-gray-900/40 dark:text-gray-400 dark:border-gray-800",
};
const statusDotStyles: Record<string, string> = {
	success: "bg-green-500",
	error: "bg-red-500",
	processing: "bg-blue-500",
	cancelled: "bg-gray-400",
};

function StatusPill({ status }: { status: Status }) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-[11px] font-semibold uppercase",
				statusPillStyles[status] ?? statusPillStyles.cancelled,
			)}
		>
			<span className={cn("h-1.5 w-1.5 rounded-sm", statusDotStyles[status] ?? statusDotStyles.cancelled)} />
			{status}
		</span>
	);
}

function HeroStat({
	label,
	value,
	sub,
	mono = false,
	valueClass,
	hasRightBorder = false,
}: {
	label: string;
	value: ReactNode;
	sub?: ReactNode;
	mono?: boolean;
	valueClass?: string;
	hasRightBorder?: boolean;
}) {
	return (
		<div className={cn("border-border/70 border-b px-5 py-3 md:border-b-0", hasRightBorder && "md:border-r")}>
			<div className="text-muted-foreground text-[10.5px] font-semibold tracking-wider uppercase">{label}</div>
			<div className={cn("mt-0.5 truncate text-[18px] font-semibold tabular-nums", mono && "font-mono text-[15px]", valueClass)}>
				{value}
			</div>
			{sub ? <div className="text-muted-foreground mt-0.5 truncate text-[11px]">{sub}</div> : null}
		</div>
	);
}

function CopyInlineButton({ text, testId }: { text: string; testId?: string }) {
	const { t } = useTranslation("logs");
	const { copy } = useCopyToClipboard({ successMessage: t("detailView.copied") });
	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				copy(text);
			}}
			className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-6 w-6 items-center justify-center rounded-sm transition"
			aria-label={t("detailView.copied")}
			data-testid={testId}
		>
			<Clipboard className="h-3.5 w-3.5" />
		</button>
	);
}

type MessageRole = "system" | "user" | "assistant" | "reasoning" | "tool";
const messageToneClass: Record<MessageRole, string> = {
	system: "bg-zinc-50 border-zinc-200 dark:bg-zinc-900/40 dark:border-zinc-800",
	user: "bg-blue-50/60 border-blue-200 dark:bg-blue-950/30 dark:border-blue-900",
	assistant: "bg-white border-zinc-200 dark:bg-zinc-900 dark:border-zinc-800",
	reasoning: "bg-violet-50/70 border-violet-200 dark:bg-violet-950/30 dark:border-violet-900",
	tool: "bg-amber-50/70 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900",
};
const messageDotClass: Record<MessageRole, string> = {
	system: "bg-zinc-400",
	user: "bg-blue-500",
	assistant: "bg-zinc-900 dark:bg-zinc-100",
	reasoning: "bg-violet-500",
	tool: "bg-amber-500",
};
function RoutingDecisionLogs({ logs }: { logs: string }) {
	const { t } = useTranslation("logs");
	const { copy } = useCopyToClipboard({ successMessage: t("detailView.copied") });
	return (
		<div className="w-full rounded-sm border">
			<div className="flex items-center justify-between border-b py-2 pl-6">
				<div className="text-sm font-medium">{t("detailView.routingDecisionLogs")}</div>
				<button
					type="button"
					onClick={() => copy(logs)}
					className="text-muted-foreground mx-2 flex h-6 items-center rounded px-1 py-1 hover:text-black dark:hover:text-white"
				>
					<Copy className="h-3 w-3" />
				</button>
			</div>
			<div>
				{logs
					.split("\n")
					.filter((l) => l.trim())
					.map((line, i) => {
						const m = line.match(/^\[(\d+)\]\s+\[([^\]]+)\]\s+-\s+(.*)$/);
						const ts = m ? Number(m[1]) : null;
						const scope = m ? m[2] : null;
						const message = m ? m[3] : line;
						return (
							<div key={i} className="flex items-start gap-3 border-b px-4 py-1.5 font-mono text-xs last:border-b-0">
								{ts != null ? <span className="text-muted-foreground shrink-0">{format(new Date(ts), "HH:mm:ss.SSS")}</span> : null}
								{scope ? (
									<span
										className={cn(
											"inline-block w-24 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase",
											RoutingEngineUsedColors[scope as keyof typeof RoutingEngineUsedColors] ??
												"bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
										)}
									>
										{RoutingEngineUsedLabels[scope as keyof typeof RoutingEngineUsedLabels] ?? scope}
									</span>
								) : null}
								<span className="break-words whitespace-pre-wrap">{message}</span>
							</div>
						);
					})}
			</div>
		</div>
	);
}

function EncryptedReveal({ text, label }: { text: string; label: string }) {
	const { t } = useTranslation("logs");
	const [open, setOpen] = useState(false);
	return (
		<div className="space-y-1">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[10.5px] font-semibold tracking-wider uppercase"
			>
				<ChevronDown className={cn("h-3 w-3 transition-transform", open ? "rotate-180" : "-rotate-90")} />
				{label}
				{!open ? (
					<span className="text-muted-foreground/70 ml-1 font-mono text-[10px] tracking-normal normal-case">
						{text.length} {t("detailView.chars", { count: text.length })}
					</span>
				) : null}
			</button>
			{open ? <pre className="font-mono text-[12.5px] leading-[1.6] break-all whitespace-pre-wrap">{text}</pre> : null}
		</div>
	);
}

const CollapsibleCode = memo(function CollapsibleCode({
	text,
	preview = 3,
	lang,
	mono = true,
}: {
	text: string;
	preview?: number;
	lang?: string;
	mono?: boolean;
}) {
	const { t } = useTranslation("logs");
	const [open, setOpen] = useState(false);
	const lines = text.split("\n");
	const shown = open ? lines : lines.slice(0, preview);
	const hasMore = lines.length > preview;
	const moreCount = lines.length - preview;
	return (
		<>
			{mono ? (
				<pre className="font-mono text-[12.5px] leading-[1.6] break-words whitespace-pre-wrap">{shown.join("\n")}</pre>
			) : (
				<div className="text-[13px] leading-relaxed break-words whitespace-pre-wrap">{shown.join("\n")}</div>
			)}
			{hasMore && (
				<div className="mt-1.5 flex items-center justify-between">
					<button
						type="button"
						onClick={() => setOpen((o) => !o)}
						className="text-primary inline-flex items-center gap-1 text-[11.5px] font-medium hover:underline"
					>
						{open ? t("detailView.showLess") : t("detailView.showMoreLines", { count: moreCount })}
						<ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
					</button>
					<span className="text-muted-foreground font-mono text-[10.5px]">
						{t("detailView.lines", { count: lines.length })}
						{lang ? ` · ${lang}` : ""}
					</span>
				</div>
			)}
		</>
	);
});

const MessageRow = memo(function MessageRow({
	role,
	meta,
	children,
	last = false,
}: {
	role: MessageRole;
	meta?: string;
	children: ReactNode;
	last?: boolean;
}) {
	const { t } = useTranslation("logs");
	return (
		<div className="flex gap-3">
			<div className="flex flex-col items-center pt-1.5">
				<span className={cn("h-2 w-2 rounded-sm", messageDotClass[role])} />
				{!last && <div className="bg-border my-1 w-px flex-1" />}
			</div>
			<div className="min-w-0 flex-1 pb-4">
				<div className="mb-1 flex items-center gap-2">
					<span className="text-foreground text-[11.5px] font-semibold">
						{role === "tool" ? t("detailView.toolResult") : t("detailView." + role)}
					</span>
					{meta ? <span className="text-muted-foreground text-[11px]">{meta}</span> : null}
				</div>
				<div className={cn("rounded-sm border p-3 text-[13px] leading-relaxed", messageToneClass[role])}>{children}</div>
			</div>
		</div>
	);
});

// Reveals the next chunk of message rows when the button is clicked or the
// sentinel scrolls near the viewport. Self-limiting: once a chunk is appended
// the sentinel usually drops out of range, so it does not cascade through a long
// conversation without further scrolling.
const MessagesLoadMore = memo(function MessagesLoadMore({
	remaining,
	onLoadMore,
	dataTestId,
}: {
	remaining: number;
	onLoadMore: () => void;
	dataTestId?: string;
}) {
	const { t } = useTranslation("logs");
	const sentinelRef = useRef<HTMLDivElement>(null);
	const onLoadMoreRef = useRef(onLoadMore);

	useEffect(() => {
		onLoadMoreRef.current = onLoadMore;
	});

	useEffect(() => {
		const el = sentinelRef.current;
		if (!el) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					onLoadMoreRef.current();
				}
			},
			{ rootMargin: "0px 0px 600px 0px", threshold: 0 },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	return (
		<div className="mt-3 flex flex-col items-center gap-2">
			<div ref={sentinelRef} className="h-1 w-full" />
			<Button type="button" variant="outline" size="sm" onClick={onLoadMore} className="gap-1.5" data-testid={dataTestId}>
				<ChevronDown className="h-3.5 w-3.5" />
				{t("detailView.loadMoreMessages", { count: remaining })}
			</Button>
		</div>
	);
});

interface LogDetailViewProps {
	log: LogEntry | null;
	resolvedSelectedPromptName?: string; // Current prompt name from prompt-repo when `selected_prompt_id` is set; falls back to stored log name
	loading?: boolean;
	handleDelete?: (log: LogEntry) => void;
	canReveal?: boolean;
	onClose?: () => void;
	headerAction?: ReactNode;
	onFilterByParentRequestId?: (parentRequestId: string) => void;
}

export function LogDetailView({
	log,
	resolvedSelectedPromptName,
	loading = false,
	handleDelete,
	canReveal = false,
	onClose,
	headerAction,
	onFilterByParentRequestId,
}: LogDetailViewProps) {
	const { t } = useTranslation("logs");
	const { copy: copyBody } = useCopyToClipboard({
		successMessage: t("toast.requestBodyCopied"),
		errorMessage: t("toast.copyRequestBodyFailed"),
	});
	const [showRevealedValues, setShowRevealedValues] = useState(false);
	const revealMapping = log?.redaction_mapping;
	const revealAvailable = canReveal && hasRedactionMappingEntries(revealMapping);
	const revealEnabled = revealAvailable && showRevealedValues;
	const activeInputRevealMapping = revealEnabled ? revealMapping?.input : undefined;
	const activeOutputRevealMapping = revealEnabled ? revealMapping?.output : undefined;

	useEffect(() => {
		setShowRevealedValues(false);
	}, [log?.id, revealAvailable]);

	const allRoles = ALL_ROLES;
	const [visibleRoles, setVisibleRoles] = useState<Set<MessageRole>>(new Set(allRoles));

	const handleToggleReveal = (checked: boolean) => {
		setShowRevealedValues(checked && revealAvailable);
	};

	if (!log) return null;

	const selectedPromptDisplayName = resolvedSelectedPromptName ?? log.selected_prompt_name ?? "";

	const { data: userAgentMappingsData } = useGetUserAgentMappingsQuery();
	const customAppIcons = useMemo(() => {
		const icons: Record<string, string> = {};
		for (const mapping of userAgentMappingsData?.mappings ?? []) {
			if (mapping.app && mapping.logo && mapping.logo_mime) {
				icons[mapping.app] = `data:${mapping.logo_mime};base64,${mapping.logo}`;
			}
		}
		return icons;
	}, [userAgentMappingsData?.mappings]);

	const isContainer = isContainerOperation(log.object);
	const detectedApp = log.app ? mapAppToClientApp(log.app) : log.user_agent ? mapUserAgentToApp(log.user_agent) : null;
	const detectedAppIcon = log.app && detectedApp ? customAppIcons[log.app] || detectedApp.icon : detectedApp?.icon;
	const detectedAppLabel = detectedApp ? logAppDisplayName(detectedApp, log.user_agent) : "";
	const showTabs = !isContainer;
	const isPassthrough = isPassthroughOperation(log.object);
	const isRealtimeTurn = log.object === "realtime.turn";
	const passthroughParams = isPassthrough
		? (log.params as {
				method?: string;
				path?: string;
				raw_query?: string;
				status_code?: number;
			})
		: null;

	// Tools can also be declared inside Responses input items instead of the
	// top-level tools param (codex code-mode models send an `additional_tools`
	// input item with the tool definitions, including namespace groupings).
	const inputDeclaredToolEntries = (log.responses_input_history ?? [])
		.filter((m) => m.type === "additional_tools" && Array.isArray(m.tools))
		.flatMap((m) => m.tools as any[]);
	const inputDeclaredTools = flattenDeclaredTools(inputDeclaredToolEntries);
	const declaredTools = dedupeDeclaredTools([...flattenDeclaredTools((log.params?.tools as any[]) ?? []), ...inputDeclaredTools]);
	let toolsParameter = null;
	if (declaredTools.length) {
		try {
			toolsParameter = JSON.stringify(declaredTools, null, 2);
		} catch {}
	}

	const audioFormat = (log.params as any)?.audio?.format || (log.params as any)?.extra_params?.audio?.format || undefined;
	const rawRequest = applyRedactionMapping(log.raw_request, activeInputRevealMapping);
	const rawResponse = applyRedactionMapping(log.raw_response, activeOutputRevealMapping);
	const passthroughRequestBody = applyRedactionMapping(log.passthrough_request_body, activeInputRevealMapping);
	const passthroughResponseBody = applyRedactionMapping(log.passthrough_response_body, activeOutputRevealMapping);
	const videoOutput = log.video_generation_output || log.video_retrieve_output || log.video_download_output || log.video_delete_output;
	const videoListOutput = log.video_list_output;
	const pluginLogCount = (() => {
		if (!log.plugin_logs) return 0;
		try {
			const parsed = JSON.parse(log.plugin_logs);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return Object.values(parsed).reduce<number>((sum, v) => sum + (Array.isArray(v) ? v.length : 0), 0);
			}
		} catch {}
		return 0;
	})();

	// Check current provider's raw storage config
	const { data: providerConfig } = useGetProviderQuery(log.provider ?? "", {
		skip: !log?.provider,
	});
	const storeRawConfigEnabled = providerConfig?.store_raw_request_response ?? false;

	// Timeline data
	const {
		data: timelineData,
		isLoading: timelineLoading,
		error: timelineError,
		refetch: timelineRefetch,
	} = useGetLogTimelineQuery(log.id, {
		skip: !log?.id,
	});

	// Messages tab sections — derived once so role-filter toggles, reveal toggles
	// and background refetches don't re-run the full 400-800KB extraction pipeline.
	const chatRows = useMemo(
		() =>
			buildChatRows(log, {
				isPassthrough,
				visibleRoles,
				activeInputRevealMapping,
				activeOutputRevealMapping,
				audioFormat,
				t,
			}),
		[log, isPassthrough, visibleRoles, activeInputRevealMapping, activeOutputRevealMapping, audioFormat, t],
	);
	const responsesRows = useMemo(
		() =>
			buildResponsesRows(log, {
				isPassthrough,
				visibleRoles,
				activeInputRevealMapping,
				activeOutputRevealMapping,
				audioFormat,
				t,
			}),
		[log, isPassthrough, visibleRoles, activeInputRevealMapping, activeOutputRevealMapping, audioFormat, t],
	);

	// Post-compression tool message bodies, keyed by the snapshot index the
	// RTK pipeline recorded. Passed into the RTK compression diff view so the
	// "compressed" side is sourced from the in-place-mutated request rather
	// than duplicated in metadata.
	const compressedToolContents = useMemo(() => extractCompressedToolContents(log), [log]);

	// Incremental rendering: only mount a few rows on first paint; reveal more
	// chunks as the user scrolls or clicks "show more".
	const [chatVisibleCount, setChatVisibleCount] = useState(INITIAL_MESSAGE_LIMIT);
	const [responsesVisibleCount, setResponsesVisibleCount] = useState(INITIAL_MESSAGE_LIMIT);

	useEffect(() => {
		setChatVisibleCount(INITIAL_MESSAGE_LIMIT);
	}, [chatRows]);
	useEffect(() => {
		setResponsesVisibleCount(INITIAL_MESSAGE_LIMIT);
	}, [responsesRows]);

	const loadMoreChat = useCallback(() => {
		setChatVisibleCount((c) => c + MESSAGE_LOAD_CHUNK);
	}, []);
	const loadMoreResponses = useCallback(() => {
		setResponsesVisibleCount((c) => c + MESSAGE_LOAD_CHUNK);
	}, []);

	return loading ? (
		<div className="flex h-full items-center justify-center">
			<Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
		</div>
	) : (
		<>
			{/* Breadcrumb header with actions */}
			<div className="flex items-center justify-between gap-3">
				<div className="text-muted-foreground flex items-center gap-2 text-sm">
					{headerAction}
					<span className="text-foreground font-medium">{t("detailView.requestDetails")}</span>
				</div>
				<div className="flex items-center gap-3">
					{revealAvailable && (
						<div className="flex items-center gap-2">
							<label htmlFor="logdetails-reveal-toggle" className="text-muted-foreground text-[11px] font-medium">
								{t("detailView.showOriginalValues")}
							</label>
							<Switch
								id="logdetails-reveal-toggle"
								checked={revealEnabled}
								onCheckedChange={handleToggleReveal}
								data-testid="logdetails-reveal-toggle"
							/>
						</div>
					)}
					{onClose ? (
						<AlertDialog>
							<div className="flex items-center gap-1">
								{!isPassthrough && (
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												variant="ghost"
												size="icon"
												className="size-8"
												type="button"
												onClick={() => copyRequestBody(log, copyBody)}
												data-testid="logdetails-copy-request-body-button"
												aria-label={t("detailView.copyRequestBody")}
											>
												<Clipboard className="h-4 w-4" />
											</Button>
										</TooltipTrigger>
										<TooltipContent sideOffset={6}>{t("detailView.copyRequestBody")}</TooltipContent>
									</Tooltip>
								)}
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant="ghost"
											size="icon"
											className="size-8"
											type="button"
											onClick={() => downloadAsJson(log, `log-${log.id ?? "export"}.json`)}
											data-testid="logdetails-export-log-button"
											aria-label={t("detailView.exportAsJson")}
										>
											<Download className="h-4 w-4" />
										</Button>
									</TooltipTrigger>
									<TooltipContent sideOffset={6}>{t("detailView.exportAsJson")}</TooltipContent>
								</Tooltip>
								{handleDelete ? (
									<Tooltip>
										<TooltipTrigger asChild>
											<AlertDialogTrigger asChild>
												<Button
													variant="ghost"
													size="icon"
													className="text-destructive hover:text-destructive size-8"
													type="button"
													data-testid="logdetails-delete-item"
													aria-label={t("detailView.deleteLog")}
												>
													<Trash2 className="h-4 w-4" />
												</Button>
											</AlertDialogTrigger>
										</TooltipTrigger>
										<TooltipContent sideOffset={6}>{t("detailView.deleteLog")}</TooltipContent>
									</Tooltip>
								) : null}
							</div>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>{t("detailView.deleteDialogTitle")}</AlertDialogTitle>
									<AlertDialogDescription>{t("detailView.deleteDialogDescription")}</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel data-testid="logdetails-delete-cancel-button">{t("detailView.cancel")}</AlertDialogCancel>
									<AlertDialogAction
										data-testid="logdetails-delete-confirm-button"
										onClick={() => {
											if (handleDelete) handleDelete(log);
											onClose();
										}}
									>
										{t("detailView.delete")}
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					) : null}
				</div>
			</div>
			<div className="border-border rounded-sm border">
				<div className="flex items-start justify-between gap-6 px-5 pt-5 pb-4">
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<StatusPill status={log.status as Status} />
							<Badge
								variant="outline"
								className={cn(
									"rounded-sm px-2 py-0.5 font-medium",
									RequestTypeColors[log.object as keyof typeof RequestTypeColors] ?? "bg-gray-100 text-gray-800",
								)}
							>
								{RequestTypeLabels[log.object as keyof typeof RequestTypeLabels] ?? log.object}
							</Badge>
							{log.routing_rule && (
								<Link
									to="/workspace/logs"
									search={(prev) => ({ ...prev, offset: 0, routing_rule_ids: [log.routing_rule!.id] })}
									data-testid="logdetails-header-routing-rule-link"
								>
									<Badge variant="outline" className="bg-card text-muted-foreground rounded-sm px-2 py-0.5 font-normal hover:underline">
										{t("detailView.rule")}: {log.routing_rule.name}
									</Badge>
								</Link>
							)}
							{log.metadata?.isAsyncRequest ? (
								<Badge variant="outline" className="rounded-sm bg-teal-100 px-2 py-0.5 text-teal-800 dark:bg-teal-900 dark:text-teal-200">
									{t("detailView.async")}
								</Badge>
							) : null}
							{log.cache_debug?.hit_type === "direct" ? (
								<Badge
									variant="outline"
									className="rounded-sm bg-indigo-100 px-2 py-0.5 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200"
								>
									{t("detailView.directCache")}
								</Badge>
							) : null}
							{log.cache_debug?.hit_type === "semantic" ? (
								<Badge variant="outline" className="rounded-sm bg-rose-100 px-2 py-0.5 text-rose-800 dark:bg-rose-900 dark:text-rose-200">
									{t("detailView.semanticCache")}
								</Badge>
							) : null}
							{(log.is_large_payload_request || log.is_large_payload_response) && (
								<Badge
									variant="outline"
									className="rounded-sm border-amber-300 bg-amber-50 px-2 py-0.5 text-amber-700 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-400"
								>
									{t("detailView.largePayload")}
								</Badge>
							)}
							{isRealtimeTurn && log.metadata?.realtime_transport && (
								<Badge
									variant="outline"
									className={cn("rounded-sm px-2 py-0.5 font-medium", getRealtimeTransportBadgeClass(log.metadata.realtime_transport))}
								>
									{formatRealtimeTransport(log.metadata.realtime_transport, t)}
								</Badge>
							)}
							{isRealtimeTurn && log.metadata?.realtime_voice && (
								<Badge
									variant="outline"
									className="rounded-sm border-amber-300 bg-amber-50 px-2 py-0.5 font-medium text-amber-700 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-300"
								>
									{log.metadata.realtime_voice}
								</Badge>
							)}
						</div>
						<div className="mt-3 flex items-center gap-2">
							<div className="text-muted-foreground w-24 shrink-0 text-[10.5px] font-semibold tracking-wider uppercase">
								{t("detailView.request")}
							</div>
							<code className="text-foreground truncate font-mono text-[13px]">{log.id || "—"}</code>
							{log.id ? <CopyInlineButton text={log.id} testId="logdetails-copy-request-id-button" /> : null}
						</div>
						{log.cache_debug?.cache_id && (
							<div className="mt-1 flex items-center gap-2">
								<div className="text-muted-foreground w-24 shrink-0 text-[10.5px] font-semibold tracking-wider uppercase">
									{log.cache_debug.cache_hit ? t("detailView.cacheHit") : t("detailView.cacheMiss")}
								</div>
								<code className="text-foreground truncate font-mono text-[13px]">{log.cache_debug.cache_id}</code>
								<CopyInlineButton text={log.cache_debug.cache_id} testId="logdetails-copy-cache-id-button" />
							</div>
						)}
						{log.routing_rule && (
							<div className="mt-1 flex items-center gap-2">
								<div className="text-muted-foreground w-24 shrink-0 text-[10.5px] font-semibold tracking-wider uppercase">
									{t("detailView.rule")}
								</div>
								<Link
									to="/workspace/logs"
									search={(prev) => ({ ...prev, offset: 0, routing_rule_ids: [log.routing_rule!.id] })}
									className="truncate text-[13px] font-medium text-blue-600 hover:underline dark:text-blue-400"
									data-testid="logdetails-header-rule-link"
								>
									&ldquo;{log.routing_rule.name}&rdquo;
								</Link>
							</div>
						)}
						{log.selected_key && (
							<div className="mt-1 flex items-center gap-2">
								<div className="text-muted-foreground w-24 shrink-0 text-[10.5px] font-semibold tracking-wider uppercase">
									{t("detailView.key")}
								</div>
								<Link
									to="/workspace/logs"
									search={(prev) => ({ ...prev, offset: 0, selected_key_ids: [log.selected_key_id] })}
									className="truncate font-mono text-[13px] text-blue-600 hover:underline dark:text-blue-400"
									data-testid="logdetails-header-selected-key-link"
								>
									{log.selected_key.name}
								</Link>
							</div>
						)}
					</div>
					<Link
						to="/workspace/providers/$id"
						params={{ id: log.provider }}
						className="hover:bg-muted flex shrink-0 items-center gap-1.5 rounded-sm border bg-white px-2 py-1 text-[12px] font-medium transition-colors dark:bg-zinc-900"
						data-testid="logdetails-header-provider-link"
					>
						<RenderProviderIcon provider={log.provider as ProviderIconType} size="xs" />
						<span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">{t("detailView.provider")}</span>
						<span>{log.provider}</span>
					</Link>
				</div>
				<div className="border-border grid grid-cols-2 border-t md:grid-cols-5">
					<HeroStat
						label={t("detailView.latency")}
						valueClass="text-primary"
						value={log.latency == null || isNaN(log.latency) ? "—" : formatLatency(log.latency)}
						sub={(() => {
							if (!log.timestamp) return "";
							const start = new Date(log.timestamp);
							if (isNaN(start.getTime())) return "";
							const startStr = format(start, "HH:mm:ss");
							if (log.latency == null || isNaN(log.latency)) return startStr;
							return `${startStr} → ${format(addMilliseconds(start, log.latency), "HH:mm:ss")}`;
						})()}
						hasRightBorder
					/>
					<HeroStat
						label={t("detailView.model")}
						mono
						value={log.model || "—"}
						sub={log.provider?.toLowerCase() || ""}
						valueClass="whitespace-normal overflow-visible break-all"
						hasRightBorder
					/>
					<HeroStat
						label={t("detailView.tokensInOut")}
						mono
						value={
							log.token_usage
								? `${formatTokensAdaptive(log.token_usage.prompt_tokens ?? 0)} / ${formatTokensAdaptive(log.token_usage.completion_tokens ?? 0)}`
								: "—"
						}
						sub={
							log.token_usage ? (
								<>
									<span>{t("detailView.tokenSubTotal")} </span>
									<strong>{formatTokensAdaptive(log.token_usage.total_tokens ?? 0)}</strong>
									{log.token_usage.completion_tokens_details?.reasoning_tokens ? (
										<>
											<span> {t("detailView.tokenSubReasoning")} </span>
											<strong>{formatCompactNumber(log.token_usage.completion_tokens_details.reasoning_tokens)}</strong>
										</>
									) : null}
									{log.latency != null && log.latency > 0 && log.token_usage.total_tokens ? (
										<>
											<span> · </span>
											<strong className={rateColorClass((log.token_usage.total_tokens / log.latency) * 1000)}>
												{((log.token_usage.total_tokens / log.latency) * 1000).toFixed(1)}
											</strong>
											<span> {t("detailView.tokenSubRate")}</span>
										</>
									) : null}
								</>
							) : (
								"\u2014"
							)
						}
						hasRightBorder
					/>
					<HeroStat
						label={t("detailView.cost")}
						value={log.cost != null ? formatCost(log.cost) : "—"}
						sub={
							log.cost != null && log.token_usage?.total_tokens
								? t("detailView.costPer1k", { rate: ((log.cost / log.token_usage.total_tokens) * 1000).toFixed(6) })
								: ""
						}
						hasRightBorder
					/>
					{isRealtimeTurn ? (
						<HeroStat
							label={t("detailView.voice")}
							value={log.metadata?.realtime_voice ? String(log.metadata.realtime_voice) : "\u2014"}
							sub={log.metadata?.realtime_transport ? formatRealtimeTransport(log.metadata.realtime_transport, t) : ""}
						/>
					) : (
						<HeroStat
							label={t("detailView.toolsAvailable")}
							value={declaredTools.length.toString()}
							sub={
								(log.params as any)?.tool_choice != null
									? t("detailView.toolChoice", { value: formatToolChoice((log.params as any).tool_choice) })
									: ""
							}
						/>
					)}
				</div>
			</div>
			<details className="group bg-card rounded-sm border" open={false}>
				<summary className="hover:bg-muted/30 flex cursor-pointer items-center justify-between px-4 py-2.5 text-sm transition">
					<span className="text-foreground font-medium">{t("detailView.moreDetails")}</span>
					<span className="text-muted-foreground flex items-center gap-2 text-xs">
						<span className="hidden md:inline">{t("detailView.moreDetailsHint")}</span>
						<ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
					</span>
				</summary>
				<div className="space-y-4 border-t px-6 py-4">
					<div className="space-y-4">
						<BlockHeader title={t("detailView.timings")} />
						<div className="grid w-full grid-cols-3 items-center justify-between gap-4">
							<LogEntryDetailsView
								className="w-full"
								label={t("detailView.startTimestamp")}
								value={(() => {
									const d = log.timestamp ? new Date(log.timestamp) : null;
									return d && !isNaN(d.getTime()) ? format(d, "yyyy-MM-dd HH:mm:ss") : "N/A";
								})()}
							/>
							<LogEntryDetailsView
								className="w-full"
								label={t("detailView.endTimestamp")}
								value={(() => {
									const d = log.timestamp ? new Date(log.timestamp) : null;
									return d && !isNaN(d.getTime()) ? format(addMilliseconds(d, log.latency || 0), "yyyy-MM-dd HH:mm:ss") : "N/A";
								})()}
							/>
							<LogEntryDetailsView
								className="w-full"
								label={t("detailView.latency")}
								value={log.latency == null || isNaN(log.latency) ? "N/A" : <div>{log.latency.toFixed(2)}ms</div>}
							/>
						</div>
					</div>
					<DottedSeparator />
					<div className="space-y-4">
						<BlockHeader title={t("detailView.requestDetailsTitle")} />
						<div className="grid w-full grid-cols-3 items-start justify-between gap-4">
							<LogEntryDetailsView
								className="w-full"
								label={t("detailView.provider")}
								value={
									<Badge variant="secondary" className="uppercase">
										<RenderProviderIcon provider={log.provider as ProviderIconType} size="sm" />
										{log.provider}
									</Badge>
								}
							/>
							{!isContainer && <LogEntryDetailsView className="w-full" label={t("detailView.model")} value={log.model} />}
							{!isContainer && log.alias && <LogEntryDetailsView className="w-full" label={t("detailView.alias")} value={log.alias} />}
							{!isContainer && log.canonical_model_name && (
								<LogEntryDetailsView className="w-full" label={t("detailView.canonicalModel")} value={log.canonical_model_name} />
							)}
							{!isContainer && log.alias_model_family && (
								<LogEntryDetailsView className="w-full" label={t("detailView.modelFamily")} value={log.alias_model_family} />
							)}
							{!isContainer && log.server_side_fallback_model && (
								<LogEntryDetailsView className="w-full" label={t("detailView.servedByFallback")} value={log.server_side_fallback_model} />
							)}
							{detectedApp && (
								<LogEntryDetailsView
									className="w-full"
									label={t("detailView.app")}
									value={
										<div className="flex min-w-0 items-center gap-2" title={log.user_agent || undefined}>
											{detectedAppIcon ? (
												<img
													className="rounded-sm"
													src={detectedAppIcon}
													alt={detectedAppLabel}
													width={20}
													height={20}
													loading="lazy"
													decoding="async"
												/>
											) : null}
											<span className="truncate">{detectedAppLabel}</span>
										</div>
									}
								/>
							)}
							<LogEntryDetailsView
								className="w-full"
								label={t("detailView.type")}
								value={
									<div
										className={`${RequestTypeColors[log.object as keyof typeof RequestTypeColors] ?? "bg-gray-100 text-gray-800"} rounded-sm px-3 py-1`}
									>
										{RequestTypeLabels[log.object as keyof typeof RequestTypeLabels] ?? log.object ?? "unknown"}
									</div>
								}
							/>
							{log.stop_reason && (
								<LogEntryDetailsView
									className="w-full"
									label={t("detailView.stopReason")}
									value={
										<Badge
											variant="secondary"
											className={cn(
												"uppercase",
												log.stop_reason === "content_filter" || log.stop_reason === "safety" || log.stop_reason === "refusal"
													? "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
													: log.stop_reason === "length" || log.stop_reason === "max_tokens"
														? "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300"
														: "",
											)}
										>
											{log.stop_reason}
										</Badge>
									}
								/>
							)}
							{log.parent_request_id && (
								<LogEntryDetailsView
									className="w-full"
									label={t("detailView.parentRequestId")}
									value={
										onFilterByParentRequestId ? (
											<Tooltip>
												<TooltipTrigger asChild>
													<code
														className="block min-w-0 cursor-pointer font-normal break-all text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
														onClick={() => onFilterByParentRequestId(log.parent_request_id as string)}
													>
														{log.parent_request_id}
													</code>
												</TooltipTrigger>
												<TooltipContent sideOffset={6}>{t("detailView.filterThisSession")}</TooltipContent>
											</Tooltip>
										) : (
											<code className="block min-w-0 font-normal break-all">{log.parent_request_id}</code>
										)
									}
								/>
							)}
							{log.selected_key && (
								<LogEntryDetailsView
									className="w-full"
									label={t("detailView.selectedKey")}
									value={
										<Link
											to="/workspace/logs"
											search={(prev) => ({ ...prev, offset: 0, selected_key_ids: [log.selected_key_id] })}
											className="text-blue-600 hover:underline dark:text-blue-400"
											data-testid="logdetails-selected-key-link"
										>
											{log.selected_key.name}
										</Link>
									}
								/>
							)}
							{(log.selected_prompt_id || log.selected_prompt_name || log.selected_prompt_version) && (
								<LogEntryDetailsView
									className="w-full"
									label={t("detailView.selectedPrompt")}
									value={
										<Link
											to="/workspace/prompt-repo"
											className="text-blue-600 hover:underline dark:text-blue-400"
											data-testid="logdetails-selected-prompt-link"
										>
											<span className="break-words">
												{selectedPromptDisplayName}
												{selectedPromptDisplayName && log.selected_prompt_version ? " · " : ""}
												{log.selected_prompt_version ? <>v{log.selected_prompt_version}</> : null}
											</span>
										</Link>
									}
								/>
							)}
							{log.number_of_retries > 0 && (
								<LogEntryDetailsView className="w-full" label={t("detailView.numberOfRetries")} value={log.number_of_retries} />
							)}
							{(log.team_ids?.length || log.team_id) && (
								<LogEntryDetailsView
									className="w-full"
									label={(log.team_ids?.length ?? 0) > 1 ? t("detailView.teams") : t("detailView.team")}
									value={
										<span className="inline-flex flex-wrap gap-x-1">
											{(log.team_ids?.length
												? log.team_ids.map((id, i) => ({ id, name: log.team_names?.[i] || id }))
												: [{ id: log.team_id!, name: log.team_name || log.team_id! }]
											).map((t, i, arr) => (
												<Link
													key={t.id}
													to="/workspace/logs"
													search={(prev) => ({ ...prev, offset: 0, team_ids: [t.id] })}
													className="text-blue-600 hover:underline dark:text-blue-400"
													data-testid={`logdetails-team-link-${t.id}`}
												>
													{t.name}
													{i < arr.length - 1 ? "," : ""}
												</Link>
											))}
										</span>
									}
								/>
							)}
							{(log.customer_ids?.length || log.customer_id) && (
								<LogEntryDetailsView
									className="w-full"
									label={(log.customer_ids?.length ?? 0) > 1 ? t("detailView.customers") : t("detailView.customer")}
									value={
										<span className="inline-flex flex-wrap gap-x-1">
											{(log.customer_ids?.length
												? log.customer_ids.map((id, i) => ({ id, name: log.customer_names?.[i] || id }))
												: [{ id: log.customer_id!, name: log.customer_name || log.customer_id! }]
											).map((c, i, arr) => (
												<Link
													key={c.id}
													to="/workspace/logs"
													search={(prev) => ({ ...prev, offset: 0, customer_ids: [c.id] })}
													className="text-blue-600 hover:underline dark:text-blue-400"
													data-testid={`logdetails-customer-link-${c.id}`}
												>
													{c.name}
													{i < arr.length - 1 ? "," : ""}
												</Link>
											))}
										</span>
									}
								/>
							)}
							{(log.business_unit_ids?.length || log.business_unit_id) && (
								<LogEntryDetailsView
									className="w-full"
									label={(log.business_unit_ids?.length ?? 0) > 1 ? t("detailView.businessUnits") : t("detailView.businessUnit")}
									value={
										<span className="inline-flex flex-wrap gap-x-1">
											{(log.business_unit_ids?.length
												? log.business_unit_ids.map((id, i) => ({ id, name: log.business_unit_names?.[i] || id }))
												: [{ id: log.business_unit_id!, name: log.business_unit_name || log.business_unit_id! }]
											).map((b, i, arr) => (
												<Link
													key={b.id}
													to="/workspace/logs"
													search={(prev) => ({ ...prev, offset: 0, business_unit_ids: [b.id] })}
													className="text-blue-600 hover:underline dark:text-blue-400"
													data-testid={`logdetails-business-unit-link-${b.id}`}
												>
													{b.name}
													{i < arr.length - 1 ? "," : ""}
												</Link>
											))}
										</span>
									}
								/>
							)}
							{log.user_id && (
								<LogEntryDetailsView
									className="w-full"
									label={t("detailView.user")}
									value={
										<Tooltip>
											<TooltipTrigger asChild>
												<Link
													to="/workspace/logs"
													search={(prev) => ({ ...prev, offset: 0, user_ids: [log.user_id] })}
													className={`block min-w-0 cursor-pointer text-sm font-normal break-all text-blue-600 underline-offset-2 hover:underline dark:text-blue-400${log.user_name ? "" : " font-mono"}`}
													data-testid="logdetails-user-link"
												>
													{log.user_name || log.user_id}
												</Link>
											</TooltipTrigger>
											<TooltipContent sideOffset={6}>{log.user_name ? log.user_id : t("detailView.filterByUser")}</TooltipContent>
										</Tooltip>
									}
								/>
							)}
							{log.fallback_index > 0 && (
								<LogEntryDetailsView className="w-full" label={t("detailView.fallbackIndex")} value={log.fallback_index} />
							)}
							{log.virtual_key && (
								<LogEntryDetailsView
									className="w-full"
									label={t("detailView.virtualKey")}
									value={
										<Link
											to="/workspace/config/api-keys"
											search={{ selected_vk: log.virtual_key.id }}
											className="text-blue-600 hover:underline dark:text-blue-400"
											data-testid="logdetails-virtual-key-link"
										>
											{log.virtual_key.name}
										</Link>
									}
								/>
							)}
							{log.routing_engines_used && log.routing_engines_used.length > 0 && (
								<LogEntryDetailsView
									className="w-full"
									label={t("detailView.routingEnginesUsed")}
									value={
										<div className="flex flex-wrap gap-2">
											{log.routing_engines_used.map((engine) => (
												<Badge
													key={engine}
													className={cn(
														"border-0 py-1 uppercase",
														RoutingEngineUsedColors[engine as keyof typeof RoutingEngineUsedColors] ?? "bg-gray-100 text-gray-800",
													)}
												>
													<div className="flex items-center gap-2">
														{RoutingEngineUsedIcons[engine as keyof typeof RoutingEngineUsedIcons]?.({ className: "h-3.5 w-3.5" })}
														<span>{RoutingEngineUsedLabels[engine as keyof typeof RoutingEngineUsedLabels] ?? engine}</span>
													</div>
												</Badge>
											))}
										</div>
									}
								/>
							)}
							{log.routing_rule && (
								<LogEntryDetailsView
									className="w-full"
									label={t("detailView.routingRule")}
									value={
										<Link
											to="/workspace/logs"
											search={(prev) => ({ ...prev, offset: 0, routing_rule_ids: [log.routing_rule!.id] })}
											className="text-blue-600 hover:underline dark:text-blue-400"
											data-testid="logdetails-routing-rule-link"
										>
											{log.routing_rule.name}
										</Link>
									}
								/>
							)}

							{(log.params as any)?.audio && (
								<>
									{(log.params as any).audio.format && (
										<LogEntryDetailsView className="w-full" label={t("detailView.audioFormat")} value={(log.params as any).audio.format} />
									)}
									{(log.params as any).audio.voice && (
										<LogEntryDetailsView className="w-full" label={t("detailView.audioVoice")} value={(log.params as any).audio.voice} />
									)}
								</>
							)}

							{isRealtimeTurn && (
								<>
									{log.metadata?.realtime_session_id && (
										<LogEntryDetailsView
											className="w-full"
											label={t("detailView.realtimeSession")}
											value={
												<span className="flex items-center gap-1">
													<code className="font-mono text-xs">{log.metadata.realtime_session_id}</code>
													<CopyInlineButton
														text={String(log.metadata.realtime_session_id)}
														testId="logdetails-copy-realtime-session-id-button"
													/>
												</span>
											}
										/>
									)}
									{log.metadata?.provider_session_id && (
										<LogEntryDetailsView
											className="w-full"
											label={t("detailView.providerSession")}
											value={
												<span className="flex items-center gap-1">
													<code className="font-mono text-xs">{log.metadata.provider_session_id}</code>
													<CopyInlineButton
														text={String(log.metadata.provider_session_id)}
														testId="logdetails-copy-provider-session-id-button"
													/>
												</span>
											}
										/>
									)}
									{log.metadata?.realtime_transport && (
										<LogEntryDetailsView
											className="w-full"
											label={t("detailView.transport")}
											value={formatRealtimeTransport(log.metadata.realtime_transport, t)}
										/>
									)}
									{log.metadata?.realtime_voice && (
										<LogEntryDetailsView className="w-full" label={t("detailView.voice")} value={String(log.metadata.realtime_voice)} />
									)}
									{log.metadata?.realtime_source && (
										<LogEntryDetailsView
											className="w-full"
											label={t("detailView.turnSource")}
											value={formatRealtimeSource(log.metadata.realtime_source, t)}
										/>
									)}
									{log.metadata?.realtime_event_type && (
										<LogEntryDetailsView
											className="w-full"
											label={t("detailView.triggerEvent")}
											value={<code className="font-mono text-xs">{log.metadata.realtime_event_type}</code>}
										/>
									)}
								</>
							)}

							{passthroughParams && (
								<>
									{passthroughParams.method && (
										<LogEntryDetailsView className="w-full" label={t("detailView.method")} value={passthroughParams.method} />
									)}
									{passthroughParams.path && (
										<LogEntryDetailsView className="w-full" label={t("detailView.path")} value={passthroughParams.path} />
									)}
									{passthroughParams.raw_query && (
										<LogEntryDetailsView className="w-full" label={t("detailView.query")} value={passthroughParams.raw_query} />
									)}
									{(passthroughParams.status_code ?? 0) !== 0 && (
										<LogEntryDetailsView className="w-full" label={t("detailView.statusCode")} value={passthroughParams.status_code} />
									)}
								</>
							)}

							{log.params &&
								Object.keys(log.params).length > 0 &&
								Object.entries(log.params)
									.filter(([key]) => {
										const passthroughKeys = ["method", "path", "raw_query", "status_code"];
										return (
											key !== "tools" && key !== "instructions" && key !== "audio" && !(isPassthrough && passthroughKeys.includes(key))
										);
									})
									.filter(([_, value]) => typeof value === "boolean" || typeof value === "number" || typeof value === "string")
									.map(([key, value]) => <LogEntryDetailsView key={key} className="w-full" label={key} value={value} />)}
						</div>
					</div>
					{log.status === "success" && !isContainer && !isPassthrough && (
						<>
							<DottedSeparator />
							<div className="space-y-4">
								<BlockHeader title={t("detailView.tokens")} />
								<div className="grid w-full grid-cols-3 items-center justify-between gap-4">
									<LogEntryDetailsView
										className="w-full"
										label={t("detailView.inputTokens")}
										value={log.token_usage?.prompt_tokens != null ? formatTokensAdaptive(log.token_usage.prompt_tokens) : "-"}
									/>
									<LogEntryDetailsView
										className="w-full"
										label={t("detailView.outputTokens")}
										value={log.token_usage?.completion_tokens != null ? formatTokensAdaptive(log.token_usage.completion_tokens) : "-"}
									/>
									<LogEntryDetailsView
										className="w-full"
										label={t("detailView.totalTokens")}
										value={log.token_usage?.total_tokens != null ? formatTokensAdaptive(log.token_usage.total_tokens) : "-"}
									/>
									<LogEntryDetailsView
										className="w-full"
										label={t("detailView.cost")}
										value={log.cost != null ? `$${parseFloat(log.cost.toFixed(6))}` : "-"}
									/>
									{isRealtimeTurn && (
										<>
											<LogEntryDetailsView
												className="w-full"
												label={t("detailView.inputTextTokens")}
												value={(log.token_usage?.prompt_tokens ?? 0) - (log.token_usage?.prompt_tokens_details?.audio_tokens ?? 0)}
											/>
											<LogEntryDetailsView
												className="w-full"
												label={t("detailView.inputAudioTokens")}
												value={log.token_usage?.prompt_tokens_details?.audio_tokens ?? 0}
											/>
											<LogEntryDetailsView
												className="w-full"
												label={t("detailView.outputTextTokens")}
												value={
													(log.token_usage?.completion_tokens ?? 0) -
													(log.token_usage?.completion_tokens_details?.audio_tokens ?? 0) -
													(log.token_usage?.completion_tokens_details?.reasoning_tokens ?? 0)
												}
											/>
											<LogEntryDetailsView
												className="w-full"
												label={t("detailView.outputAudioTokens")}
												value={log.token_usage?.completion_tokens_details?.audio_tokens ?? 0}
											/>
											{(log.token_usage?.completion_tokens_details?.reasoning_tokens ?? 0) > 0 && (
												<LogEntryDetailsView
													className="w-full"
													label={t("detailView.reasoningTokens")}
													value={log.token_usage?.completion_tokens_details?.reasoning_tokens ?? 0}
												/>
											)}
										</>
									)}
									{!isRealtimeTurn && log.token_usage?.prompt_tokens_details && (
										<>
											{log.token_usage.prompt_tokens_details.cached_read_tokens && (
												<LogEntryDetailsView
													className="w-full"
													label={t("detailView.cacheReadTokens")}
													value={log.token_usage.prompt_tokens_details.cached_read_tokens ?? 0}
												/>
											)}
											{log.token_usage.prompt_tokens_details.cached_write_tokens && (
												<LogEntryDetailsView
													className="w-full"
													label={t("detailView.cacheWriteTokens")}
													value={log.token_usage.prompt_tokens_details.cached_write_tokens ?? 0}
												/>
											)}
											{log.token_usage.prompt_tokens_details.audio_tokens && (
												<LogEntryDetailsView
													className="w-full"
													label={t("detailView.inputAudioTokens")}
													value={log.token_usage.prompt_tokens_details.audio_tokens || "-"}
												/>
											)}
										</>
									)}
									{!isRealtimeTurn && log.token_usage?.completion_tokens_details && (
										<>
											{log.token_usage.completion_tokens_details.reasoning_tokens && (
												<LogEntryDetailsView
													className="w-full"
													label={t("detailView.reasoningTokens")}
													value={log.token_usage.completion_tokens_details.reasoning_tokens || "-"}
												/>
											)}
											{log.token_usage.completion_tokens_details.audio_tokens && (
												<LogEntryDetailsView
													className="w-full"
													label={t("detailView.outputAudioTokens")}
													value={log.token_usage.completion_tokens_details.audio_tokens || "-"}
												/>
											)}
											{log.token_usage.completion_tokens_details.accepted_prediction_tokens && (
												<LogEntryDetailsView
													className="w-full"
													label={t("detailView.acceptedPredictionTokens")}
													value={log.token_usage.completion_tokens_details.accepted_prediction_tokens || "-"}
												/>
											)}
											{log.token_usage.completion_tokens_details.rejected_prediction_tokens && (
												<LogEntryDetailsView
													className="w-full"
													label={t("detailView.rejectedPredictionTokens")}
													value={log.token_usage.completion_tokens_details.rejected_prediction_tokens || "-"}
												/>
											)}
										</>
									)}
								</div>
							</div>
							{(() => {
								const params = log.params as any;
								const reasoning = params?.reasoning;
								if (!reasoning || typeof reasoning !== "object" || Object.keys(reasoning).length === 0) {
									return null;
								}
								return (
									<>
										<DottedSeparator />
										<div className="space-y-4">
											<BlockHeader title={t("detailView.reasoningParameters")} />
											<div className="grid w-full grid-cols-3 items-center justify-between gap-4">
												{reasoning.effort && (
													<LogEntryDetailsView
														className="w-full"
														label={t("detailView.effort")}
														value={
															<Badge variant="secondary" className="uppercase">
																{reasoning.effort}
															</Badge>
														}
													/>
												)}
												{reasoning.summary && (
													<LogEntryDetailsView
														className="w-full"
														label={t("detailView.summary")}
														value={
															<Badge variant="secondary" className="uppercase">
																{reasoning.summary}
															</Badge>
														}
													/>
												)}
												{reasoning.generate_summary && (
													<LogEntryDetailsView
														className="w-full"
														label={t("detailView.generateSummary")}
														value={
															<Badge variant="secondary" className="uppercase">
																{reasoning.generate_summary}
															</Badge>
														}
													/>
												)}
												{reasoning.max_tokens && (
													<LogEntryDetailsView className="w-full" label={t("detailView.maxTokens")} value={reasoning.max_tokens} />
												)}
											</div>
										</div>
									</>
								);
							})()}
							{log.cache_debug && (
								<>
									<DottedSeparator />
									<div className="space-y-4">
										<BlockHeader
											title={log.cache_debug.cache_hit ? t("detailView.cachingDetailsHit") : t("detailView.cachingDetailsMiss")}
										/>
										<div className="grid w-full grid-cols-3 items-center justify-between gap-4">
											{log.cache_debug.cache_hit ? (
												<>
													<LogEntryDetailsView
														className="w-full"
														label={t("detailView.cacheType")}
														value={
															<Badge variant="secondary" className="uppercase">
																{log.cache_debug.hit_type}
															</Badge>
														}
													/>
													{log.cache_debug.hit_type === "semantic" && (
														<>
															{log.cache_debug.provider_used && (
																<LogEntryDetailsView
																	className="w-full"
																	label={t("detailView.embeddingProvider")}
																	value={
																		<Badge variant="secondary" className="uppercase">
																			{log.cache_debug.provider_used}
																		</Badge>
																	}
																/>
															)}
															{log.cache_debug.model_used && (
																<LogEntryDetailsView
																	className="w-full"
																	label={t("detailView.embeddingModel")}
																	value={log.cache_debug.model_used}
																/>
															)}
															{log.cache_debug.threshold && (
																<LogEntryDetailsView
																	className="w-full"
																	label={t("detailView.threshold")}
																	value={log.cache_debug.threshold || "-"}
																/>
															)}
															{log.cache_debug.similarity && (
																<LogEntryDetailsView
																	className="w-full"
																	label={t("detailView.similarityScore")}
																	value={log.cache_debug.similarity?.toFixed(2) || "-"}
																/>
															)}
															{log.cache_debug.input_tokens && (
																<LogEntryDetailsView
																	className="w-full"
																	label={t("detailView.embeddingInputTokens")}
																	value={log.cache_debug.input_tokens}
																/>
															)}
														</>
													)}
												</>
											) : (
												<>
													{log.cache_debug.provider_used && (
														<LogEntryDetailsView
															className="w-full"
															label={t("detailView.embeddingProvider")}
															value={
																<Badge variant="secondary" className="uppercase">
																	{log.cache_debug.provider_used}
																</Badge>
															}
														/>
													)}
													{log.cache_debug.model_used && (
														<LogEntryDetailsView
															className="w-full"
															label={t("detailView.embeddingModel")}
															value={log.cache_debug.model_used}
														/>
													)}
													{log.cache_debug.input_tokens && (
														<LogEntryDetailsView
															className="w-full"
															label={t("detailView.embeddingInputTokens")}
															value={log.cache_debug.input_tokens}
														/>
													)}
												</>
											)}
										</div>
									</div>
								</>
							)}
						</>
					)}
					{!isContainer && !isPassthrough && log.guardrail_debug?.judge_calls && log.guardrail_debug.judge_calls.length > 0 && (
						<>
							<DottedSeparator />
							<div className="space-y-4">
								<BlockHeader title={t("detailView.guardrailDetails")} />
								<div className="space-y-4">
									{log.guardrail_debug.judge_calls.map((call, index) => (
										<div
											key={`${call.rule_id ?? call.rule_name ?? "guardrail"}-${call.guardrail_name ?? "judge"}-${index}`}
											className={cn("grid w-full grid-cols-1 gap-4 md:grid-cols-3", index > 0 && "border-border border-t pt-4")}
										>
											{call.rule_name && <LogEntryDetailsView className="w-full" label={t("detailView.rule")} value={call.rule_name} />}
											{call.phase && (
												<LogEntryDetailsView
													className="w-full"
													label={t("detailView.phase")}
													value={
														<Badge variant="secondary" className="uppercase">
															{call.phase}
														</Badge>
													}
												/>
											)}
											{call.action && (
												<LogEntryDetailsView
													className="w-full"
													label={t("detailView.action")}
													value={
														<Badge variant={call.action === "GUARDRAIL_INTERVENED" ? "destructive" : "success"}>
															{call.action === "GUARDRAIL_INTERVENED" ? t("detailView.blocked") : t("detailView.allowed")}
														</Badge>
													}
												/>
											)}
											{call.guardrail_name && (
												<LogEntryDetailsView className="w-full" label={t("detailView.guardrail")} value={call.guardrail_name} />
											)}
											{call.guardrail_provider && (
												<LogEntryDetailsView className="w-full" label={t("detailView.guardrailProvider")} value={call.guardrail_provider} />
											)}
											{call.judge_provider && (
												<LogEntryDetailsView
													className="w-full"
													label={t("detailView.judgeProvider")}
													value={
														<Badge variant="secondary" className="uppercase">
															{call.judge_provider}
														</Badge>
													}
												/>
											)}
											{call.judge_model && (
												<LogEntryDetailsView className="w-full" label={t("detailView.judgeModel")} value={call.judge_model} />
											)}
											<LogEntryDetailsView
												className="w-full"
												label={t("detailView.promptTokens")}
												value={call.prompt_tokens != null ? formatTokensAdaptive(call.prompt_tokens) : 0}
											/>
											<LogEntryDetailsView
												className="w-full"
												label={t("detailView.completionTokens")}
												value={call.completion_tokens != null ? formatTokensAdaptive(call.completion_tokens) : 0}
											/>
											<LogEntryDetailsView
												className="w-full"
												label={t("detailView.totalTokens")}
												value={call.total_tokens != null ? formatTokensAdaptive(call.total_tokens) : 0}
											/>
											{call.reason && (
												<LogEntryDetailsView className="w-full md:col-span-3" label={t("detailView.reason")} value={call.reason} />
											)}
										</div>
									))}
								</div>
							</div>
						</>
					)}
					{!isContainer &&
						!isPassthrough &&
						log.metadata &&
						Object.keys(log.metadata).filter((k) => {
							if (k === "isAsyncRequest") return false;
							if (k === "rtk_raw_output_id" && "rtk_raw_output_entries" in log.metadata!) return false;
							if (
								isRealtimeTurn &&
								[
									"realtime_session_id",
									"provider_session_id",
									"realtime_source",
									"realtime_event_type",
									"realtime_transport",
									"realtime_voice",
									"realtime",
								].includes(k)
							)
								return false;
							return true;
						}).length > 0 && (
							<>
								<DottedSeparator />
								<div className="space-y-4">
									<BlockHeader title={t("detailView.metadata")} />
									<div className="grid w-full grid-cols-3 items-start justify-between gap-4">
										{Object.entries(log.metadata)
											.filter(([key]) => {
												if (key === "isAsyncRequest") return false;
												if (key === "rtk_raw_output_id" && "rtk_raw_output_entries" in log.metadata!) return false;
												if (
													isRealtimeTurn &&
													[
														"realtime_session_id",
														"provider_session_id",
														"realtime_source",
														"realtime_event_type",
														"realtime_transport",
														"realtime_voice",
														"realtime",
													].includes(key)
												)
													return false;
												return true;
											})
											.map(([key, value]) =>
												isRTKMetadataKey(key) ? (
													<RTKMetadataBadge key={key} keyName={key} value={value} />
												) : (
													<LogEntryDetailsView key={key} className="w-full" label={key} value={String(value)} />
												),
											)}
									</div>
								</div>
							</>
						)}
				</div>
			</details>
			<Tabs key={log.id} defaultValue={showTabs ? "messages" : "plugins"} className="gap-2">
				<TabsList className="bg-muted sticky top-0 z-10 h-10 w-fit">
					{showTabs && (
						<TabsTrigger value="messages" className="px-3">
							{t("detailView.messages")}
							{log.input_history?.length ? (
								<span className="bg-background text-muted-foreground ml-1.5 rounded-sm border px-2 py-0.5 text-[10px] tabular-nums">
									{log.input_history.length + (log.output_message ? 1 : 0)}
								</span>
							) : null}
						</TabsTrigger>
					)}

					{showTabs && !isPassthrough && !log.list_models_output && (
						<TabsTrigger value="tools" className="px-3">
							{t("detailView.tools")}
							{declaredTools.length ? (
								<span className="bg-background text-muted-foreground ml-1.5 rounded-sm border px-2 py-0.5 text-[10px] tabular-nums">
									{declaredTools.length}
								</span>
							) : null}
						</TabsTrigger>
					)}
					{showTabs && (
						<TabsTrigger value="routing" className="px-3">
							{t("detailView.routing")}
							{log.routing_engine_logs ? (
								<span className="bg-background text-muted-foreground ml-1.5 rounded-sm border px-2 py-0.5 text-[10px] tabular-nums">
									{log.routing_engine_logs.split("\n").filter(Boolean).length}
								</span>
							) : null}
						</TabsTrigger>
					)}
					<TabsTrigger value="plugins" className="px-3">
						{t("detailView.pluginLogs")}
						{pluginLogCount > 0 ? (
							<span className="bg-background text-muted-foreground ml-1.5 rounded-sm border px-2 py-0.5 text-[10px] tabular-nums">
								{pluginLogCount}
							</span>
						) : null}
					</TabsTrigger>
					<TabsTrigger value="rtk" className="px-3" data-testid="logdetails-tab-rtk">
						{t("detailView.rtkTabTitle")}
						{log.metadata?.rtk_compression_ratio != null ? (
							<span className="bg-background text-muted-foreground ml-1.5 rounded-sm border px-2 py-0.5 text-[10px] tabular-nums">
								{(Number(log.metadata.rtk_compression_ratio) * 100).toFixed(0)}%
							</span>
						) : null}
					</TabsTrigger>
					{!isPassthrough && (
						<TabsTrigger value="raw" className="px-3">
							{t("detailView.rawJson")}
						</TabsTrigger>
					)}
					<TabsTrigger value="timeline" className="px-3" data-testid="logdetails-tab-timeline">
						{t("detailView.timeline")}
					</TabsTrigger>
				</TabsList>

				<TabsContent value="messages" className="space-y-4">
					{log.content_hidden && (
						<div className="text-muted-foreground rounded-sm border border-dashed p-5 text-center text-sm">
							{t("detailView.contentLoggingDisabled")}
						</div>
					)}
					<div className={cn("flex justify-end", log.content_hidden && "hidden")}>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									className={cn(
										"inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-[11.5px] font-medium transition",
										visibleRoles.size < allRoles.length
											? "bg-muted text-foreground border-border"
											: "text-muted-foreground hover:text-foreground border-transparent hover:border-border",
									)}
								>
									{t("detailView.messages")}
									{visibleRoles.size < allRoles.length && (
										<span className="bg-primary text-primary-foreground rounded-sm px-1 py-0.5 text-[10px] tabular-nums">
											{visibleRoles.size}/{allRoles.length}
										</span>
									)}
									<ChevronDown className="h-3 w-3" />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-48">
								<DropdownMenuCheckboxItem
									checked={visibleRoles.size === allRoles.length}
									onCheckedChange={(checked) => setVisibleRoles(checked ? new Set(allRoles) : new Set())}
								>
									{t("detailView.showAllMessages")}
								</DropdownMenuCheckboxItem>
								<DropdownMenuSeparator />
								{(["system", "user", "assistant", "tool", "reasoning"] as MessageRole[]).map((role) => (
									<DropdownMenuCheckboxItem
										key={role}
										checked={visibleRoles.has(role)}
										onCheckedChange={(checked) =>
											setVisibleRoles((prev) => {
												const next = new Set(prev);
												checked ? next.add(role) : next.delete(role);
												return next;
											})
										}
									>
										<span className={cn("mr-1.5 inline-block h-2 w-2 rounded-sm", messageDotClass[role])} />
										{t("detailView." + role)}
									</DropdownMenuCheckboxItem>
								))}
								<DropdownMenuSeparator />
								<DropdownMenuItem onClick={() => setVisibleRoles(new Set())} className="text-muted-foreground justify-center text-[12px]">
									{t("detailView.clearAll")}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
					{(log.ocr_input || log.ocr_output) && <OCRView ocrInput={log.ocr_input} ocrOutput={log.ocr_output} />}
					{(log.speech_input || log.speech_output) && (
						<SpeechView speechInput={log.speech_input} speechOutput={log.speech_output} isStreaming={log.stream} />
					)}
					{(log.transcription_input || log.transcription_output) && (
						<TranscriptionView
							transcriptionInput={log.transcription_input}
							transcriptionOutput={log.transcription_output}
							isStreaming={log.stream}
						/>
					)}
					{(log.image_generation_input || log.image_edit_input || log.image_variation_input || log.image_generation_output) && (
						<ImageView
							imageInput={log.image_generation_input}
							imageEditInput={log.image_edit_input}
							imageVariationInput={log.image_variation_input}
							imageOutput={log.image_generation_output}
							requestType={log.object}
						/>
					)}
					{(log.video_generation_input || videoOutput || videoListOutput) && (
						<VideoView
							videoInput={log.video_generation_input}
							videoOutput={videoOutput}
							videoListOutput={videoListOutput}
							requestType={log.object}
						/>
					)}

					{isPassthrough && passthroughRequestBody && (
						<CollapsibleBox
							title={t("detailView.requestBody")}
							onCopy={() => {
								try {
									return JSON.stringify(JSON.parse(passthroughRequestBody || ""), null, 2);
								} catch {
									return passthroughRequestBody || "";
								}
							}}
						>
							<CodeEditor
								className="z-0 w-full"
								shouldAdjustInitialHeight={true}
								maxHeight={450}
								wrap={true}
								code={(() => {
									try {
										return JSON.stringify(JSON.parse(passthroughRequestBody || ""), null, 2);
									} catch {
										return passthroughRequestBody || "";
									}
								})()}
								lang="json"
								readonly={true}
								options={{
									collapsibleBlocks: true,
									showVerticalScrollbar: true,
									scrollBeyondLastLine: false,
									lineNumbers: "off",
									alwaysConsumeMouseWheel: false,
								}}
							/>
						</CollapsibleBox>
					)}
					{isPassthrough && passthroughResponseBody && log.status !== "processing" && (
						<CollapsibleBox
							title={t("detailView.responseBody")}
							onCopy={() => {
								try {
									return JSON.stringify(JSON.parse(passthroughResponseBody || ""), null, 2);
								} catch {
									return passthroughResponseBody || "";
								}
							}}
						>
							<CodeEditor
								className="z-0 w-full"
								shouldAdjustInitialHeight={true}
								maxHeight={450}
								wrap={true}
								code={(() => {
									try {
										return JSON.stringify(JSON.parse(passthroughResponseBody || ""), null, 2);
									} catch {
										return passthroughResponseBody || "";
									}
								})()}
								lang="json"
								readonly={true}
								options={{
									collapsibleBlocks: true,
									showVerticalScrollbar: true,
									scrollBeyondLastLine: false,
									lineNumbers: "off",
									alwaysConsumeMouseWheel: false,
								}}
							/>
						</CollapsibleBox>
					)}

					{chatRows && (
						<div className="bg-card rounded-sm border p-5">
							{chatRows.slice(0, chatVisibleCount)}
							{chatVisibleCount < chatRows.length && (
								<MessagesLoadMore
									remaining={chatRows.length - chatVisibleCount}
									onLoadMore={loadMoreChat}
									dataTestId="logdetails-chat-load-more"
								/>
							)}
						</div>
					)}

					{responsesRows && (
						<div className="bg-card rounded-sm border p-5">
							{responsesRows.slice(0, responsesVisibleCount)}
							{responsesVisibleCount < responsesRows.length && (
								<MessagesLoadMore
									remaining={responsesRows.length - responsesVisibleCount}
									onLoadMore={loadMoreResponses}
									dataTestId="logdetails-responses-load-more"
								/>
							)}
						</div>
					)}

					{log.is_large_payload_request && !log.input_history?.length && !log.responses_input_history?.length && (
						<div className="rounded-sm border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
							{t("detailView.largePayloadRequest")}
							{log.raw_request && ` ${t("detailView.truncatedPreview")}`}
						</div>
					)}
					{log.is_large_payload_response && !log.output_message && !log.responses_output?.length && log.status !== "processing" && (
						<div className="rounded-sm border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
							{t("detailView.largePayloadResponse")}
							{log.raw_response && ` ${t("detailView.truncatedPreview")}`}
						</div>
					)}

					{log.status !== "processing" && log.embedding_output && log.embedding_output.length > 0 && !log.error_details?.error.message && (
						<div className="bg-card space-y-3 rounded-sm border p-5">
							<div className="text-sm font-medium">{t("detailView.embedding")}</div>
							<LogChatMessageView
								message={{
									role: "assistant",
									content: JSON.stringify(
										log.embedding_output.map((embedding) => embedding.embedding),
										null,
										2,
									),
								}}
							/>
						</div>
					)}
					{log.status !== "processing" && log.rerank_output && !log.error_details?.error.message && (
						<CollapsibleBox
							title={t("detailView.rerankOutput", { count: log.rerank_output.length })}
							onCopy={() => JSON.stringify(log.rerank_output, null, 2)}
						>
							<CodeEditor
								className="z-0 w-full"
								shouldAdjustInitialHeight={true}
								maxHeight={450}
								wrap={true}
								code={JSON.stringify(log.rerank_output, null, 2)}
								lang="json"
								readonly={true}
								options={{
									collapsibleBlocks: true,
									showVerticalScrollbar: true,
									scrollBeyondLastLine: false,
									lineNumbers: "off",
									alwaysConsumeMouseWheel: false,
								}}
							/>
						</CollapsibleBox>
					)}

					{log.list_models_output && (
						<CollapsibleBox
							title={t("detailView.listModelsOutput", { count: log.list_models_output.length })}
							onCopy={() => JSON.stringify(log.list_models_output, null, 2)}
						>
							<CodeEditor
								className="z-0 w-full"
								shouldAdjustInitialHeight={true}
								maxHeight={450}
								wrap={true}
								code={JSON.stringify(log.list_models_output, null, 2)}
								lang="json"
								readonly={true}
								options={{
									collapsibleBlocks: true,
									showVerticalScrollbar: true,
									scrollBeyondLastLine: false,
									lineNumbers: "off",
									alwaysConsumeMouseWheel: false,
								}}
							/>
						</CollapsibleBox>
					)}

					{(log.error_details?.error.message || log.error_details?.error.error != null) && (
						<div className="rounded-sm border border-red-200 bg-red-50/70 p-5 dark:border-red-900 dark:bg-red-950/30">
							<div className="flex items-center gap-2 text-red-700 dark:text-red-400">
								<AlertCircle className="h-4 w-4 shrink-0" />
								<span className="text-[12.5px] font-semibold">{t("detailView.error")}</span>
								{log.error_details?.error.message ? <CopyInlineButton text={log.error_details.error.message} /> : null}
							</div>
							{log.error_details?.error.message ? (
								<div className="mt-2 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-red-700 dark:text-red-400">
									{log.error_details.error.message}
								</div>
							) : null}
							{log.error_details?.error.error != null ? (
								<details className="group mt-3 rounded-sm border border-red-200/70 bg-white/40 dark:border-red-900/70 dark:bg-red-950/40">
									<summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-[12px] text-red-700 hover:bg-red-50/80 dark:text-red-400 dark:hover:bg-red-950/60">
										<span className="font-medium">{t("detailView.details")}</span>
										<ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
									</summary>
									<div className="custom-scrollbar max-h-[400px] overflow-y-auto border-t border-red-200/70 px-3 py-2 font-mono text-[11.5px] leading-[1.6] break-words whitespace-pre-wrap text-red-900 dark:border-red-900/70 dark:text-red-300">
										{typeof log.error_details.error.error === "string"
											? log.error_details.error.error
											: JSON.stringify(log.error_details.error.error, null, 2)}
									</div>
								</details>
							) : null}
						</div>
					)}
				</TabsContent>

				<TabsContent value="tools" className="space-y-3">
					{toolsParameter ? (
						<div className="bg-card rounded-sm border p-5">
							<div className="text-muted-foreground mb-3 text-[12px]">
								{t("detailView.toolsExposed", { count: declaredTools.length })}
								{inputDeclaredTools.length ? (
									<>
										{" "}
										{t("detailView.viaInputItems", { count: inputDeclaredTools.length })}
										{inputDeclaredTools.length !== inputDeclaredToolEntries.length ? t("detailView.namespacesExpanded") : ""}
									</>
								) : null}
								{(log.params as any)?.tool_choice != null ? (
									<>
										{" "}
										· tool_choice ={" "}
										<span className="text-foreground font-mono break-all">{formatToolChoice((log.params as any).tool_choice)}</span>
									</>
								) : null}
							</div>
							<div className="grid grid-cols-1 gap-2 md:grid-cols-2">
								{declaredTools.map((tool, i) => {
									const name = tool?.name ?? tool?.function?.name ?? `tool_${i}`;
									const description = tool?.function?.description ?? tool?.description ?? "";
									const schema = tool?.function?.parameters ?? tool?.input_schema ?? tool?.parameters ?? null;
									const schemaJson = schema != null ? JSON.stringify(schema, null, 2) : "";
									return (
										<details key={i} className="group bg-card rounded-sm border">
											<summary className="hover:bg-muted/30 flex cursor-pointer list-none items-start gap-2 p-3 transition">
												<div className="grid h-7 w-7 shrink-0 place-items-center rounded-sm border border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-400">
													<Wrench className="h-3 w-3" strokeWidth={1.5} />
												</div>
												<div className="min-w-0 flex-1">
													<div className="text-foreground truncate font-mono text-[12.5px] font-medium">{name}</div>
													{description ? <div className="text-muted-foreground mt-0.5 line-clamp-2 text-[12px]">{description}</div> : null}
												</div>
												<ChevronDown
													className={cn(
														"text-muted-foreground mt-1 h-3.5 w-3.5 shrink-0 transition-transform",
														"group-open:rotate-180",
														!schemaJson && "opacity-30",
													)}
												/>
											</summary>
											{schemaJson ? (
												<div className="border-t">
													<div className="text-muted-foreground flex items-center justify-between px-3 py-1.5 text-[10.5px] tracking-wider uppercase">
														<span className="font-semibold">{t("detailView.parameters")}</span>
														<CopyInlineButton text={schemaJson} />
													</div>
													<pre className="custom-scrollbar max-h-[300px] overflow-auto border-t px-3 py-2 font-mono text-[11.5px] leading-[1.6] whitespace-pre">
														{schemaJson}
													</pre>
												</div>
											) : (
												<div className="text-muted-foreground border-t px-3 py-2 text-[11.5px]">{t("detailView.noParameterSchema")}</div>
											)}
										</details>
									);
								})}
							</div>
						</div>
					) : null}
					{log.params?.instructions && (
						<CollapsibleBox title={t("detailView.instructions")} onCopy={() => log.params?.instructions || ""}>
							<div className="custom-scrollbar max-h-[400px] overflow-y-auto px-6 py-2 font-mono text-xs break-words whitespace-pre-wrap">
								{log.params.instructions}
							</div>
						</CollapsibleBox>
					)}
					{!toolsParameter && !log.params?.instructions && (
						<div className="text-muted-foreground rounded-sm border border-dashed p-5 text-center text-sm">
							{t("detailView.noToolsOrInstructions")}
						</div>
					)}
				</TabsContent>

				<TabsContent value="routing" className="space-y-3">
					{log.attempt_trail && log.attempt_trail.length > 1 && (
						<CollapsibleBox
							title={t("detailView.attemptTrail", { count: log.attempt_trail.length })}
							onCopy={() => JSON.stringify(log.attempt_trail, null, 2)}
						>
							<div className="overflow-x-auto px-6 py-3">
								<table className="w-full border-collapse text-xs">
									<thead>
										<tr className="border-border text-muted-foreground border-b">
											<th className="py-1 pr-6 text-left font-medium">{t("detailView.attemptNumber")}</th>
											<th className="py-1 pr-6 text-left font-medium">{t("detailView.key")}</th>
											<th className="py-1 text-left font-medium">{t("detailView.result")}</th>
										</tr>
									</thead>
									<tbody>
										{log.attempt_trail.map((record) => (
											<tr key={record.attempt} className="border-border/50 border-b last:border-0">
												<td className="text-muted-foreground py-1.5 pr-6 tabular-nums">{record.attempt + 1}</td>
												<td className="py-1.5 pr-6 font-mono">{record.key_name || record.key_id}</td>
												<td className="py-1.5">
													{record.fail_reason ? (
														<span className="text-destructive">{record.fail_reason}</span>
													) : (
														<span className="text-green-600 dark:text-green-400">{t("detailView.success")}</span>
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</CollapsibleBox>
					)}
					{log.routing_engine_logs ? (
						<RoutingDecisionLogs logs={log.routing_engine_logs} />
					) : (
						<div className="text-muted-foreground rounded-sm border border-dashed p-5 text-center text-sm">
							{t("detailView.noRoutingLogs")}
						</div>
					)}
				</TabsContent>

				<TabsContent value="plugins" className="space-y-3">
					{log.plugin_logs ? (
						<PluginLogsView pluginLogs={log.plugin_logs} />
					) : (
						<div className="text-muted-foreground rounded-sm border border-dashed p-5 text-center text-sm">
							{t("detailView.noPluginLogs")}
						</div>
					)}
				</TabsContent>

				<TabsContent value="rtk" className="space-y-3">
					<RTKCompressionDiffView metadata={log.metadata as Record<string, unknown> | undefined} compressedItems={compressedToolContents} />
				</TabsContent>

				<TabsContent value="raw" className="space-y-3">
					{rawRequest && (
						<>
							<div className="text-muted-foreground text-[12px]">
								{t("detailView.rawRequestSentTo")} <span className="text-foreground font-medium capitalize">{log.provider}</span>
								{log.is_large_payload_request && (
									<span className="ml-2 text-xs font-normal text-amber-600 dark:text-amber-400">
										{t("detailView.truncatedPreviewParen")}
									</span>
								)}
							</div>
							<CollapsibleBox
								title={log.is_large_payload_request ? t("detailView.rawRequestTruncated") : t("detailView.rawRequest")}
								onCopy={() => formatJsonSafe(rawRequest)}
							>
								<CodeEditor
									className="z-0 w-full"
									shouldAdjustInitialHeight={true}
									maxHeight={450}
									wrap={true}
									code={formatJsonSafe(rawRequest)}
									lang="json"
									readonly={true}
									options={{
										collapsibleBlocks: true,
										showVerticalScrollbar: true,
										scrollBeyondLastLine: false,
										lineNumbers: "off",
										alwaysConsumeMouseWheel: false,
									}}
								/>
							</CollapsibleBox>
						</>
					)}
					{rawResponse && log.status !== "processing" && (
						<>
							<div className="text-muted-foreground pt-4 text-[12px]">
								{t("detailView.rawResponseFrom")} <span className="text-foreground font-medium capitalize">{log.provider}</span>
								{log.is_large_payload_response && (
									<span className="ml-2 text-xs font-normal text-amber-600 dark:text-amber-400">
										{t("detailView.truncatedPreviewParen")}
									</span>
								)}
							</div>
							<CollapsibleBox
								title={log.is_large_payload_response ? t("detailView.rawResponseTruncated") : t("detailView.rawResponse")}
								onCopy={() => formatJsonSafe(rawResponse)}
							>
								<CodeEditor
									className="z-0 w-full"
									shouldAdjustInitialHeight={true}
									maxHeight={450}
									wrap={true}
									code={formatJsonSafe(rawResponse)}
									lang="json"
									readonly={true}
									options={{
										collapsibleBlocks: true,
										showVerticalScrollbar: true,
										scrollBeyondLastLine: false,
										lineNumbers: "off",
										alwaysConsumeMouseWheel: false,
									}}
								/>
							</CollapsibleBox>
						</>
					)}
					{!rawRequest && !rawResponse && !passthroughRequestBody && !passthroughResponseBody && (
						<div
							className="text-muted-foreground mx-auto max-w-md rounded-sm border border-dashed p-5 text-center text-sm"
							data-testid="logdetails-no-raw-json"
						>
							{t("detailView.noRawJson")}
							<div className="text-muted-foreground/80 mt-2 text-xs leading-relaxed">
								{storeRawConfigEnabled ? t("detailView.noRawJsonReasonEnabled") : t("detailView.noRawJsonReason")}
							</div>
							{!storeRawConfigEnabled && (
								<div className="mt-3 border-t pt-3 text-xs">
									<Link
										to="/workspace/providers/$id"
										params={{ id: log.provider ?? "" }}
										className="text-primary font-medium hover:underline"
										data-testid="logdetails-no-raw-enable-link"
									>
										{t("detailView.noRawJsonHowTo", { provider: log.provider ?? "" })}
									</Link>
								</div>
							)}
						</div>
					)}
				</TabsContent>

				<TabsContent value="timeline" className="space-y-3">
					<TimelineDetail
						data={timelineData ?? null}
						isLoading={timelineLoading}
						error={timelineError ? i18n.t("logs:toast.timelineDataFailed") : null}
						onRetry={() => {
							void timelineRefetch();
						}}
					/>
				</TabsContent>
			</Tabs>
		</>
	);
}

const copyRequestBody = async (log: LogEntry, copy: (text: string) => Promise<void>) => {
	try {
		const isChat = log.object === "chat.completion" || log.object === "chat_completion" || log.object === "chat.completion.chunk";
		const isResponses = log.object === "response" || log.object === "response.completion.chunk" || log.object === "compaction";
		const isRealtimeTurn = log.object === "realtime.turn";
		const isSpeech = log.object === "audio.speech" || log.object === "audio.speech.chunk";
		const isTextCompletion = log.object === "text.completion" || log.object === "text.completion.chunk";
		const isEmbedding = log.object === "list";

		const extractTextFromMessage = (message: any): string => {
			if (!message || !message.content) {
				return "";
			}
			if (typeof message.content === "string") {
				return message.content;
			}
			if (Array.isArray(message.content)) {
				return message.content
					.filter((block: any) => block && block.type === "text" && block.text)
					.map((block: any) => block.text)
					.join("\n");
			}
			return "";
		};

		const extractTextsFromMessage = (message: any): string[] => {
			if (!message || !message.content) {
				return [];
			}
			if (typeof message.content === "string") {
				return message.content ? [message.content] : [];
			}
			if (Array.isArray(message.content)) {
				return message.content.filter((block: any) => block && block.type === "text" && block.text).map((block: any) => block.text);
			}
			return [];
		};

		const isSupportedType = isChat || isResponses || isRealtimeTurn || isSpeech || isTextCompletion || isEmbedding;
		if (!isSupportedType) {
			if (log.object === "audio.transcription" || log.object === "audio.transcription.chunk") {
				toast.error(i18n.t("logs:toast.copyRequestBodyUnavailableTranscription"));
			} else {
				toast.error(i18n.t("logs:toast.copyRequestBodyUnavailableType"));
			}
			return;
		}

		const requestBody: any = {
			model: log.provider && log.model ? `${log.provider}/${log.model}` : log.model || "",
		};

		if (isRealtimeTurn) {
			if (log.input_history && log.input_history.length > 0) {
				requestBody.messages = log.input_history;
			}
			if (log.output_message) {
				requestBody.output = log.output_message;
			}
		} else if (isChat && log.input_history && log.input_history.length > 0) {
			requestBody.messages = log.input_history;
		} else if (isResponses && log.responses_input_history && log.responses_input_history.length > 0) {
			requestBody.input = log.responses_input_history;
		} else if (isSpeech && log.speech_input) {
			requestBody.input = log.speech_input.input;
		} else if (isTextCompletion && log.input_history && log.input_history.length > 0) {
			const firstMessage = log.input_history[0];
			const prompt = extractTextFromMessage(firstMessage);
			if (prompt) {
				requestBody.prompt = prompt;
			}
		} else if (isEmbedding && log.input_history && log.input_history.length > 0) {
			const texts: string[] = [];
			for (const message of log.input_history) {
				const messageTexts = extractTextsFromMessage(message);
				texts.push(...messageTexts);
			}
			if (texts.length > 0) {
				requestBody.input = texts.length === 1 ? texts[0] : texts;
			}
		}

		if (log.params) {
			const paramsCopy = { ...log.params };
			delete paramsCopy.tools;
			delete paramsCopy.instructions;
			Object.assign(requestBody, paramsCopy);
		}

		if ((isChat || isResponses || isRealtimeTurn) && log.params?.tools && Array.isArray(log.params.tools) && log.params.tools.length > 0) {
			requestBody.tools = log.params.tools;
		}
		if ((isResponses || isRealtimeTurn) && log.params?.instructions) {
			requestBody.instructions = log.params.instructions;
		}

		const requestBodyJson = JSON.stringify(requestBody, null, 2);
		await copy(requestBodyJson);
	} catch {
		toast.error(i18n.t("logs:toast.copyFailed"));
	}
};