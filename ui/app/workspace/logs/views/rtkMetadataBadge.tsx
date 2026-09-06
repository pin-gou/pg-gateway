import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";

const RTK_METADATA_KEYS = new Set<string>([
	"rtk_compression_ratio",
	"rtk_techniques",
	"rtk_filter_matched",
	"rtk_raw_output_id",
	"rtk_raw_output_entries",
	"rtk_pipeline_scanned",
]);

interface Props {
	keyName: string;
	value: unknown;
}

// isRTKMetadataKey reports whether a given metadata key should be rendered
// with the RTK-specific badge styling instead of the generic label/value
// pair. Keeping the check in one place lets the metadata renderer in
// logDetailView stay declarative.
export function isRTKMetadataKey(key: string): boolean {
	return RTK_METADATA_KEYS.has(key);
}

// RTKMetadataBadge renders a single RTK observability field from the log
// entry's metadata. Each known key gets a dedicated visual treatment so the
// operator can scan a metadata block and immediately understand the
// compression outcome (ratio, filter matched, techniques fired, raw output
// pointer). Unknown rtk_* keys fall through to a flat badge.
export default function RTKMetadataBadge({ keyName, value }: Props) {
	const { t } = useTranslation("logs");

	switch (keyName) {
		case "rtk_compression_ratio": {
			const numeric = typeof value === "number" ? value : Number(value);
			const pct = Number.isFinite(numeric) ? (numeric * 100).toFixed(1) : "0.0";
			const tone =
				numeric >= 0.5
					? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
					: numeric >= 0.2
						? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
						: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
			return (
				<div className="flex w-full flex-col gap-2">
					<div className="text-muted-foreground text-xs font-medium">
						{t("detailView.rtk_compressionRatio").toUpperCase().replace(/_/g, " ")}
					</div>
					<div>
						<Badge variant="outline" className={`${tone} font-mono text-xs`}>
							{pct}%
						</Badge>
					</div>
				</div>
			);
		}
		case "rtk_techniques": {
			const techniques = Array.isArray(value) ? value.map((v) => String(v)) : [];
			if (techniques.length === 0) return null;
			return (
				<div className="flex w-full flex-col gap-2">
					<div className="text-muted-foreground text-xs font-medium">{t("detailView.rtk_techniques").toUpperCase().replace(/_/g, " ")}</div>
					<div className="flex flex-wrap gap-1.5">
						{techniques.map((tech) => (
							<Badge key={tech} variant="secondary" className="font-mono text-[10px]">
								{tech}
							</Badge>
						))}
					</div>
				</div>
			);
		}
		case "rtk_filter_matched":
			return (
				<div className="flex w-full flex-col gap-2">
					<div className="text-muted-foreground text-xs font-medium">
						{t("detailView.rtk_filterMatched").toUpperCase().replace(/_/g, " ")}
					</div>
					<div>
						<Badge variant="outline" className="font-mono text-xs">
							{String(value)}
						</Badge>
					</div>
				</div>
			);
		case "rtk_raw_output_id": {
			const id = String(value);
			return (
				<div className="flex w-full flex-col gap-2">
					<div className="text-muted-foreground text-xs font-medium">RTK RAW OUTPUT</div>
					<div>
						<Link
							to="/workspace/plugins/rtk/raw-output"
							search={{ id }}
							data-testid={`rtk-raw-output-link-${id}`}
							className="text-[13px] text-blue-600 hover:underline dark:text-blue-400"
						>
							{t("detailView.rtk_rawOutputLink")}
						</Link>
					</div>
				</div>
			);
		}
		case "rtk_raw_output_entries": {
			const entries = Array.isArray(value)
				? value.filter((e): e is { index: number; id: string } => {
						return e != null && typeof e === "object" && "id" in e && "index" in e;
					})
				: [];
			if (entries.length === 0) return null;
			return (
				<div className="flex w-full flex-col gap-2">
					<div className="text-muted-foreground text-xs font-medium">RTK RAW OUTPUT</div>
					<div className="flex flex-col gap-1.5">
						{entries.map((e) => (
							<div key={e.id} className="flex items-center gap-2">
								<Badge variant="secondary" className="font-mono text-[10px]">
									#{e.index}
								</Badge>
								<Link
									to="/workspace/plugins/rtk/raw-output"
									search={{ id: e.id }}
									data-testid={`rtk-raw-output-link-${e.id}`}
									className="text-[13px] text-blue-600 hover:underline dark:text-blue-400"
								>
									{t("detailView.rtk_rawOutputLink")}
								</Link>
							</div>
						))}
					</div>
				</div>
			);
		}
		case "rtk_pipeline_scanned": {
			const indices = Array.isArray(value) ? value.map((v) => Number(v)).filter((n) => Number.isFinite(n)) : [];
			if (indices.length === 0) return null;
			return (
				<div className="flex w-full flex-col gap-2">
					<div className="text-muted-foreground text-xs font-medium">
						{t("detailView.rtk_pipelineScanned").toUpperCase().replace(/_/g, " ")}
					</div>
					<div className="flex flex-wrap gap-1.5">
						{indices.map((idx) => (
							<Badge key={idx} variant="secondary" className="font-mono text-[10px]">
								#{idx}
							</Badge>
						))}
					</div>
				</div>
			);
		}
		default:
			return null;
	}
}