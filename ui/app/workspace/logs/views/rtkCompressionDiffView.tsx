import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useGetRtkRawOutputQuery } from "@/lib/store/apis/rtkAdminApi";

interface ScannedIndexEntry {
	index: number;
}

// CompressedItem is the post-compression tool message body for one message,
// indexed by the same `index` value the RTK pipeline recorded on the
// pre-compression side (input_history index for chat tool messages,
// responses_input_history index for function_call_output items). The log
// detail view builds this map once from the log entry's request body and
// passes it in; the diff view is otherwise read-only.
export interface CompressedItem {
	index: number;
	content: string;
}

interface RawOutputEntry {
	index: number;
	id: string;
}

interface Props {
	metadata: Record<string, unknown> | undefined;
	compressedItems?: CompressedItem[];
}

// RTKCompressionDiffView renders the diff between the pre-compression raw tool
// output and the post-compression message body. The pre-compression text is
// recovered on demand via `GET /api/context/rtk/raw-output/{id}?raw=1`.
//
// Two metadata shapes are supported:
//   - rtk_raw_output_entries: [{index, id, bytes, redacted}, ...] — the
//     current schema. Each compressed tool output has its own raw-output
//     file and pointer ID. Each message row independently fetches its own
//     original by pointer ID, so the diff is precise per message.
//   - rtk_raw_output_id: single string (first pointer only) — the legacy
//     schema. The single raw-output file is fetched once and split across
//     message slots by "\n\n" separator (matching the legacy snapshot.go
//     merged-mode wire shape). This path is kept for logs recorded before
//     the multi-entry change.
//
// A `rtk_pipeline_scanned` metadata entry marks messages the pipeline
// evaluated but did not compress — the diff view surfaces those as
// "participated but not compressed" so operators can see the pipeline ran.
export default function RTKCompressionDiffView({ metadata, compressedItems }: Props) {
	const { t: tFn } = useTranslation("logs");

	const ratio = numberFromMetadata(metadata?.rtk_compression_ratio);
	const techniques = stringArrayFromMetadata(metadata?.rtk_techniques);
	const filterMatched = stringFromMetadata(metadata?.rtk_filter_matched);
	const rawOutputID = stringFromMetadata(metadata?.rtk_raw_output_id);
	const rawOutputEntries = rawOutputEntriesFromMetadata(metadata?.rtk_raw_output_entries);
	const scannedIndices = numberArrayFromMetadata(metadata?.rtk_pipeline_scanned);

	// Empty / not-triggered state: no raw-output pointer AND no scanned indices.
	const compressedFlag = techniques.length > 0 || (scannedIndices.length ?? 0) > 0 || !!rawOutputID || rawOutputEntries.length > 0;
	if (!compressedFlag && ratio === null) {
		return (
			<div
				className="text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-sm border border-dashed py-12 text-sm"
				data-testid="rtk-diff-uncompressed"
			>
				<div className="text-base font-medium">{tFn("detailView.rtkUncompressed")}</div>
				<div className="text-xs">{tFn("detailView.rtkNoSnapshots")}</div>
			</div>
		);
	}

	// No raw-output pointer: the pipeline ran (scanned or marked techniques)
	// but no compression fired (or retention is "never"). Show the post-
	// compression message bodies alongside a banner prompting the operator
	// to enable raw-output retention if they want the diff.
	if (!rawOutputID && rawOutputEntries.length === 0) {
		return (
			<div className="space-y-4" data-testid="rtk-diff-disabled">
				<RTKHeader ratio={ratio} techniques={techniques} filterMatched={filterMatched} />
				<Alert className="border-amber-300 bg-amber-50 dark:border-amber-600 dark:bg-amber-950">
					<AlertDescription className="text-amber-800 dark:text-amber-200">
						<span>{tFn("detailView.rtkSnapshotDisabled")}</span>
						<Link
							to="/workspace/plugins"
							search={{ plugin: "rtk" }}
							className="ml-1 text-blue-600 underline underline-offset-2 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
						>
							{tFn("detailView.rtkSnapshotGoToConfig")}
						</Link>
					</AlertDescription>
				</Alert>
				{compressedItems != null && compressedItems.length > 0 && (
					<div className="space-y-3">
						<p className="text-muted-foreground text-xs">{tFn("detailView.rtkCompressedOnlyHint")}</p>
						<div className="flex flex-col gap-4">
							{compressedItems.map((item) => (
								<div key={`comp-only-${item.index}`} className="rounded-sm border" data-testid={`rtk-compressed-only-${item.index}`}>
									<div className="bg-muted/20 rounded-t-sm border-b px-4 py-2 text-xs font-medium">
										{tFn("detailView.rtkMessageLabel", { index: item.index >= 0 ? item.index : 0 })}
									</div>
									<DiffPane label={tFn("detailView.rtkCompressedLabel")} content={item.content} side="compressed" />
								</div>
							))}
						</div>
					</div>
				)}
			</div>
		);
	}

	// Multi-entry path (current schema): each compressed tool output has its
	// own raw-output file. Each message row independently fetches its own
	// original by pointer ID, so the diff is precise per message.
	if (rawOutputEntries.length > 0) {
		return (
			<PopulatedDiffMulti
				metadata={metadata}
				rawOutputEntries={rawOutputEntries}
				compressedItems={compressedItems}
				scannedIndices={scannedIndices}
			/>
		);
	}

	// Legacy single-ID path (old logs): fetch one file and split it.
	return <PopulatedDiff metadata={metadata} rawOutputID={rawOutputID!} compressedItems={compressedItems} scannedIndices={scannedIndices} />;
}

// ---------------------------------------------------------------------------
// Multi-entry path
// ---------------------------------------------------------------------------

interface PopulatedDiffMultiProps {
	metadata: Record<string, unknown> | undefined;
	rawOutputEntries: RawOutputEntry[];
	compressedItems?: CompressedItem[];
	scannedIndices: ScannedIndexEntry[];
}

function PopulatedDiffMulti({ metadata, rawOutputEntries, compressedItems, scannedIndices }: PopulatedDiffMultiProps) {
	const { t: tFn } = useTranslation("logs");

	const ratio = numberFromMetadata(metadata?.rtk_compression_ratio);
	const techniques = stringArrayFromMetadata(metadata?.rtk_techniques);
	const filterMatched = stringFromMetadata(metadata?.rtk_filter_matched);

	// Build index → entry map so each message row can look up its pointer.
	const entryByIndex = new Map<number, RawOutputEntry>();
	for (const e of rawOutputEntries) {
		entryByIndex.set(e.index, e);
	}

	const scannedSet = new Set(scannedIndices.map((entry) => entry.index));

	return (
		<div className="space-y-4" data-testid="rtk-diff-populated-multi">
			<RTKHeader ratio={ratio} techniques={techniques} filterMatched={filterMatched} />
			{compressedItems == null || compressedItems.length === 0 ? (
				<div className="text-muted-foreground rounded-sm border border-dashed p-6 text-center text-sm">
					{tFn("detailView.rtkNoSnapshots")}
				</div>
			) : (
				<div className="flex flex-col gap-4">
					{compressedItems.map((comp) => (
						<MessageDiffRow
							key={`msg-${comp.index}`}
							index={comp.index}
							compressedContent={comp.content}
							participated={scannedSet.has(comp.index)}
							entry={entryByIndex.get(comp.index)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// MessageDiffRow fetches its own original text by pointer ID (multi-entry
// path) or shows an empty ORIGINAL pane when the message was scanned but
// not compressed (no entry for this index).
function MessageDiffRow({
	index,
	compressedContent,
	participated,
	entry,
}: {
	index: number;
	compressedContent: string;
	participated: boolean;
	entry?: RawOutputEntry;
}) {
	const { t } = useTranslation("logs");

	// Only fetch when this message has a raw-output pointer (i.e. it was
	// actually compressed and persisted). Scanned-but-not-compressed
	// messages have no entry, so skip the fetch entirely.
	const {
		data: rawText,
		isLoading,
		isError,
	} = useGetRtkRawOutputQuery(entry?.id ?? "", {
		skip: !entry?.id,
	});

	return (
		<div className="rounded-sm border" data-testid={`rtk-diff-message-${index}`}>
			<div className="bg-muted/20 flex items-center justify-between rounded-t-sm border-b px-4 py-2 text-xs">
				<div className="flex items-center gap-2 font-medium">
					<span>{t("detailView.rtkMessageLabel", { index: index >= 0 ? index : 0 })}</span>
					{participated && (
						<Badge variant="outline" className="text-[10px]" data-testid={`rtk-diff-participated-${index}`}>
							{t("detailView.rtkParticipated")}
						</Badge>
					)}
				</div>
			</div>
			<div className="relative grid grid-cols-1 gap-0 md:grid-cols-2">
				<DiffPane label={t("detailView.rtkOriginalLabel")} content={rawText ?? ""} side="original" loading={isLoading} error={isError} />
				<DiffPane label={t("detailView.rtkCompressedLabel")} content={compressedContent} side="compressed" />
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Legacy single-ID path (old logs)
// ---------------------------------------------------------------------------

interface PopulatedDiffProps {
	metadata: Record<string, unknown> | undefined;
	rawOutputID: string;
	compressedItems?: CompressedItem[];
	scannedIndices: ScannedIndexEntry[];
}

function PopulatedDiff({ metadata, rawOutputID, compressedItems, scannedIndices }: PopulatedDiffProps) {
	const { t: tFn } = useTranslation("logs");

	const ratio = numberFromMetadata(metadata?.rtk_compression_ratio);
	const techniques = stringArrayFromMetadata(metadata?.rtk_techniques);
	const filterMatched = stringFromMetadata(metadata?.rtk_filter_matched);

	const { data: rawText, isLoading, isError } = useGetRtkRawOutputQuery(rawOutputID);

	const originalByIndex = splitRawOutputByIndex(rawText, compressedItems);

	return (
		<div className="space-y-4" data-testid="rtk-diff-populated">
			<RTKHeader ratio={ratio} techniques={techniques} filterMatched={filterMatched} />
			{isError && (
				<Alert className="border-amber-300 bg-amber-50 dark:border-amber-600 dark:bg-amber-950" data-testid="rtk-diff-fetch-error-banner">
					<AlertDescription className="text-amber-800 dark:text-amber-200">{tFn("detailView.rtkRawOutputFetchError")}</AlertDescription>
				</Alert>
			)}
			{isLoading && (
				<Alert className="border-muted" data-testid="rtk-diff-fetch-loading-banner">
					<AlertDescription className="text-muted-foreground text-sm">{tFn("detailView.rtkRawOutputFetchLoading")}</AlertDescription>
				</Alert>
			)}
			<RTKSplitDiff originalByIndex={originalByIndex} compressedItems={compressedItems ?? []} scannedIndices={scannedIndices} />
		</div>
	);
}

function RTKHeader({ ratio, techniques, filterMatched }: { ratio: number | null; techniques: string[]; filterMatched: string | null }) {
	const { t } = useTranslation("logs");
	const ratioPct = ratio !== null ? `${(ratio * 100).toFixed(1)}%` : "—";
	return (
		<div className="bg-muted/30 flex flex-wrap items-center gap-3 rounded-sm border px-4 py-3 text-sm">
			<div className="flex items-center gap-2">
				<span className="text-muted-foreground text-xs font-medium">{t("detailView.rtk_compressionRatio").toUpperCase()}</span>
				<Badge variant="outline" className="font-mono text-xs">
					{ratioPct}
				</Badge>
			</div>
			{filterMatched && (
				<div className="flex items-center gap-2">
					<span className="text-muted-foreground text-xs font-medium">{t("detailView.rtk_filterMatched")}</span>
					<Badge variant="outline" className="font-mono text-xs">
						{filterMatched}
					</Badge>
				</div>
			)}
			{techniques.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-muted-foreground text-xs font-medium">{t("detailView.rtk_techniques")}</span>
					{techniques.map((tech) => (
						<Badge key={tech} variant="secondary" className="font-mono text-[10px]">
							{tech}
						</Badge>
					))}
				</div>
			)}
		</div>
	);
}

function RTKSplitDiff({
	originalByIndex,
	compressedItems,
	scannedIndices,
}: {
	originalByIndex: Map<number, string>;
	compressedItems: CompressedItem[];
	scannedIndices: ScannedIndexEntry[];
}) {
	const { t } = useTranslation("logs");

	if (compressedItems.length === 0) {
		return (
			<div className="text-muted-foreground rounded-sm border border-dashed p-6 text-center text-sm">{t("detailView.rtkNoSnapshots")}</div>
		);
	}

	const scannedSet = new Set(scannedIndices.map((entry) => entry.index));

	return (
		<div className="flex flex-col gap-4">
			{compressedItems.map((comp) => {
				const origContent = originalByIndex.get(comp.index);
				const participated = scannedSet.has(comp.index);
				return (
					<div key={`msg-${comp.index}`} className="rounded-sm border" data-testid={`rtk-diff-message-${comp.index}`}>
						<div className="bg-muted/20 flex items-center justify-between rounded-t-sm border-b px-4 py-2 text-xs">
							<div className="flex items-center gap-2 font-medium">
								<span>{t("detailView.rtkMessageLabel", { index: comp.index >= 0 ? comp.index : 0 })}</span>
								{participated && (
									<Badge variant="outline" className="text-[10px]" data-testid={`rtk-diff-participated-${comp.index}`}>
										{t("detailView.rtkParticipated")}
									</Badge>
								)}
							</div>
						</div>
						<div className="grid grid-cols-1 gap-0 md:grid-cols-2">
							<DiffPane label={t("detailView.rtkOriginalLabel")} content={origContent ?? ""} side="original" />
							<DiffPane label={t("detailView.rtkCompressedLabel")} content={comp.content} side="compressed" />
						</div>
					</div>
				);
			})}
		</div>
	);
}

function DiffPane({
	label,
	content,
	side,
	loading,
	error,
}: {
	label: string;
	content: string;
	side: "original" | "compressed";
	loading?: boolean;
	error?: boolean;
}) {
	const { t: tFn } = useTranslation("logs");
	const sideClass =
		side === "original"
			? "border-border bg-muted/10"
			: "border-emerald-200/60 bg-emerald-50/40 dark:border-emerald-800/60 dark:bg-emerald-950/20";
	return (
		<div className={`flex min-h-0 flex-col border-l first:border-l-0 md:border-l ${sideClass}`}>
			<div className="text-muted-foreground border-b px-3 py-1.5 text-xs font-medium tracking-wide uppercase">{label}</div>
			{loading ? (
				<div className="text-muted-foreground px-3 py-2 text-[11px] italic">{tFn("detailView.rtkRawOutputFetchLoading")}</div>
			) : error ? (
				<div className="px-3 py-2 text-[11px] text-amber-600 italic dark:text-amber-400">{tFn("detailView.rtkRawOutputFetchError")}</div>
			) : (
				<pre className="max-h-[60vh] overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
					{content}
				</pre>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function numberFromMetadata(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string") {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

function stringFromMetadata(v: unknown): string | null {
	if (typeof v === "string" && v.length > 0) return v;
	return null;
}

function stringArrayFromMetadata(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((entry) => typeof entry === "string") as string[];
}

function numberArrayFromMetadata(v: unknown): ScannedIndexEntry[] {
	if (!Array.isArray(v)) return [];
	return v.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry)).map((index) => ({ index }));
}

function rawOutputEntriesFromMetadata(v: unknown): RawOutputEntry[] {
	if (!Array.isArray(v)) return [];
	return v
		.filter((entry): entry is Record<string, unknown> => entry != null && typeof entry === "object")
		.map((entry) => ({
			index: typeof entry.index === "number" ? entry.index : Number(entry.index) || 0,
			id: typeof entry.id === "string" ? entry.id : String(entry.id ?? ""),
		}))
		.filter((entry) => entry.id.length > 0);
}

// splitRawOutputByIndex partitions the raw-output file body across the
// compressedItems slots (legacy single-ID path only). The RTK plugin stores
// one raw-output file per actually-compressed tool_result, but several
// messages may be persisted in sequence joined by "\n\n" — the same
// separator the legacy snapshot.go merged-mode builder used. We split on
// that marker and assign the i-th chunk to compressedItems[i]. When the
// count doesn't match we fall back to "all chunks to the first item" so
// the operator sees something rather than a silent zero-row table.
function splitRawOutputByIndex(rawText: string | undefined, compressedItems?: CompressedItem[]): Map<number, string> {
	const out = new Map<number, string>();
	if (!rawText || compressedItems == null || compressedItems.length === 0) {
		return out;
	}

	const chunks = rawText
		.split(/\n\n/)
		.map((c) => c.trim())
		.filter((c) => c.length > 0);
	if (chunks.length === 0) {
		return out;
	}

	if (chunks.length === compressedItems.length) {
		compressedItems.forEach((item, idx) => out.set(item.index, chunks[idx]));
		return out;
	}

	// Mismatch — put everything in the first slot, leave the rest empty so
	// the operator still sees the original text rather than nothing.
	out.set(compressedItems[0].index, chunks.join("\n\n"));
	return out;
}