import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

interface UseCopyToClipboardOptions {
	successMessage?: string;
	errorMessage?: string;
	resetDelay?: number;
	toastOnSuccess?: boolean;
}

/**
 * Best-effort clipboard write. `navigator.clipboard` only exists in secure
 * contexts (https, or http://localhost) — on plain-HTTP hosts such as
 * `http://<hostname>:3008` it is `undefined` and every copy would fail. When
 * the modern API is missing or throws, fall back to the legacy hidden-textarea
 * + `document.execCommand("copy")` path.
 */
export async function writeClipboard(text: string): Promise<boolean> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// fall through to the legacy path (e.g. permission denied)
		}
	}
	return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.top = "-9999px";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);
	textarea.focus();
	textarea.select();
	textarea.setSelectionRange(0, text.length);
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	}
	document.body.removeChild(textarea);
	return ok;
}

export function useCopyToClipboard(options: UseCopyToClipboardOptions = {}) {
	const { successMessage = "Copied to clipboard", errorMessage = "Failed to copy", resetDelay = 2000, toastOnSuccess = true } = options;
	const [copied, setCopied] = useState(false);
	const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

	const copy = useCallback(
		async (text: string) => {
			const ok = await writeClipboard(text);
			if (!ok) {
				toast.error(errorMessage);
				return;
			}
			setCopied(true);
			if (toastOnSuccess) toast.success(successMessage);

			if (timeoutRef.current) clearTimeout(timeoutRef.current);
			timeoutRef.current = setTimeout(() => setCopied(false), resetDelay);
		},
		[successMessage, errorMessage, resetDelay, toastOnSuccess],
	);

	return { copy, copied };
}