// Package rtk — Stage 4: Raw output persistence (design D2).
//
// Provides secret redaction, failure detection, and best-effort disk persistence
// of raw tool outputs for debugging. Retention policy (never/failures/always) is
// configurable per the plugin Config. All disk errors are best-effort — the
// compression pipeline never blocks on I/O failures.
package rtk

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/pin-gou/celer-route/core/schemas"
)

// RtkRawOutputRetention controls when raw tool outputs are persisted to disk.
type RtkRawOutputRetention string

const (
	// RawOutputRetentionNever disables raw output persistence entirely.
	RawOutputRetentionNever RtkRawOutputRetention = "never"
	// RawOutputRetentionFailures persists only output that IsLikelyFailureOutput.
	RawOutputRetentionFailures RtkRawOutputRetention = "failures"
	// RawOutputRetentionAlways persists every output that is actually compressed.
	RawOutputRetentionAlways RtkRawOutputRetention = "always"
)

// RtkRawOutputPointer carries the result of a single raw-output persist operation.
type RtkRawOutputPointer struct {
	ID       string `json:"id"`       // sha256(<prefix>)[:24]
	Path     string `json:"path"`     // absolute path to the persisted .log file
	Bytes    int    `json:"bytes"`    // UTF-8 byte count of the written (redacted) text
	SHA256   string `json:"sha256"`   // full hex(sha256(redactedText)) 64 chars
	Redacted bool   `json:"redacted"` // any of the 5 redaction patterns matched
}

// PersistOptions configures a single MaybePersistRtkRawOutput call.
type PersistOptions struct {
	Retention RtkRawOutputRetention // never | failures | always
	Command   string                // used for command slug in filename
	MaxBytes  int                   // default 1048576, minimum 1024
	Failure   *bool                 // explicit override of IsLikelyFailureOutput
	AppDir    string                // root directory for <appDir>/rtk/raw-output/
	// Dir overrides the on-disk root entirely. When non-empty, takes priority
	// over AppDir (which is otherwise appended with /rtk/raw-output/). Operators
	// use this to point persistence at a separate volume or sandboxed tmpfs.
	// Callers MUST pass an absolute path; PersistRtkRawOutput creates the
	// directory if it does not exist.
	Dir string
}

// rawOutputPaths is a package-level registry mapping pointer ID → absolute path,
// so ReadRtkRawOutput can locate a file when only the ID is known.
var rawOutputPaths sync.Map

// 5 pre-compiled secret redaction regexes (ReDoS-safe, all with \b markers).
var (
	// reSecretOpenAI redacts OpenAI-style API keys: sk- + ≥16 alnum.
	reSecretOpenAI = regexp.MustCompile(`\bsk-[A-Za-z0-9]{16,}`)
	// reSecretSlack redacts Slack tokens: xox<type>- + token chars.
	reSecretSlack = regexp.MustCompile(`\bxox[a-zA-Z]-[A-Za-z0-9-]{8,}`)
	// reSecretAWS redacts AWS access key IDs: AKIA + 16 alnum.
	reSecretAWS = regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`)
	// reSecretAuthHeader redacts (Proxy-)Authorization: Bearer|Basic|Token values.
	reSecretAuthHeader = regexp.MustCompile(`(?i)(^|\n)([ \t]*(?:Proxy-)?Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)\S+`)
	// reSecretCredField redacts credential field values in key=value / key: "value" form.
	// Group 1 captures the field name + separator (e.g. "api_key="), which is preserved.
	reSecretCredField = regexp.MustCompile(`(?i)(\b[a-z0-9_.-]*(?:key|token|secret|password|passwd|credential)[a-z0-9_-]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)`)
)

// reFailureOutput matches the 9 failure keywords (V-plugins-3).
var reFailureOutput = regexp.MustCompile(`(?i)\b(error|failed|failure|exception|traceback|panic|fatal|critical|ts\d{4}|fail)\b`)

// reSlugInvalid matches characters that are not valid in a filename slug.
var reSlugInvalid = regexp.MustCompile(`[^A-Za-z0-9_-]+`)

// RedactRtkRawOutput applies the 5 secret-redaction patterns to the input text
// and returns the redacted text and whether any redaction occurred.
//
// Replacement order: explicit key patterns (sk-, xox, AKIA) → auth header →
// credential field patterns. This order ensures that a secret embedded in a
// credential value (e.g. "api_key=sk-abc...") is fully redacted.
func RedactRtkRawOutput(value string) (text string, redacted bool) {
	text = value
	orig := text

	// 1. OpenAI keys
	text = reSecretOpenAI.ReplaceAllString(text, "[REDACTED_OPENAI_KEY]")
	// 2. Slack tokens
	text = reSecretSlack.ReplaceAllString(text, "[REDACTED_SLACK_TOKEN]")
	// 3. AWS keys
	text = reSecretAWS.ReplaceAllString(text, "[REDACTED_AWS_KEY]")
	// 4. Authorization headers
	text = reSecretAuthHeader.ReplaceAllString(text, "${1}${2}[REDACTED]")
	// 5. Credential field values
	text = reSecretCredField.ReplaceAllString(text, "${1}[REDACTED]")

	return text, text != orig
}

// IsLikelyFailureOutput reports whether the text contains any of the 9 failure
// keywords (V-plugins-3). Word boundaries are used to prevent false positives
// on partial-word matches (e.g. "errorsome" does not match "error").
func IsLikelyFailureOutput(value string) bool {
	if value == "" {
		return false
	}
	return reFailureOutput.MatchString(value)
}

// MaybePersistRtkRawOutput writes the raw output to disk under
// <appDir>/rtk/raw-output/ when the retention policy allows it, and returns
// a pointer to the persisted file. Disk errors (EACCES, ENOSPC, etc.) are
// handled best-effort: nil is returned and the caller should proceed without
// the pointer. The pointer's ID is the filename: <id24>.log.
//
// The filename is deterministic — it is the 24-char content hash, not a
// timestamp+slug+ID triple. This means the same tool output content (after
// redaction) always maps to the same file path, so an Agent loop that
// re-sends the same tool_result in successive requests does not create
// duplicate files: the first call writes, subsequent calls detect the
// existing file, skip the write, and refresh the mtime so the janitor
// keeps the file alive as long as any active request references it.
func MaybePersistRtkRawOutput(raw string, opts PersistOptions) *RtkRawOutputPointer {
	// Retention "never" or empty → skip.
	if opts.Retention == RawOutputRetentionNever || opts.Retention == "" {
		return nil
	}
	// Blank/whitespace-only output → skip.
	if strings.TrimSpace(raw) == "" {
		return nil
	}

	// Determine failure state.
	failure := IsLikelyFailureOutput(raw)
	if opts.Failure != nil {
		failure = *opts.Failure
	}
	// Retention "failures" and this is not a failure → skip.
	if opts.Retention == RawOutputRetentionFailures && !failure {
		return nil
	}

	// Apply redaction.
	redactedText, redacted := RedactRtkRawOutput(raw)

	// Compute MaxBytes default/clamp.
	maxBytes := opts.MaxBytes
	if maxBytes == 0 {
		maxBytes = 1048576
	} else if maxBytes < 1024 {
		maxBytes = 1024
	}

	// UTF-8 byte-level truncation.
	if len(redactedText) > maxBytes {
		redactedText = safeUtf8Slice(redactedText, maxBytes)
	}

	// Compute SHA-256 of the redacted text (full 64-char hex).
	shaSum := sha256.Sum256([]byte(redactedText))
	shaHex := hex.EncodeToString(shaSum[:])

	// Build ID: first 24 hex chars of the sha256 of the content.
	id := shaHex[:24]

	// Ensure the output directory exists. Dir takes priority; AppDir is the
	// historical fallback so existing callers stay source-compatible.
	dir := opts.Dir
	if dir == "" {
		dir = filepath.Join(opts.AppDir, "rtk", "raw-output")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		// Best-effort: return nil, no panic.
		return nil
	}

	// Deterministic filename: <id24>.log. Same content → same ID → same
	// path, so duplicate writes are naturally deduped.
	logPath := filepath.Join(dir, id+".log")
	metaPath := filepath.Join(dir, id+".meta.json")

	// Dedup: if the file already exists with the expected byte count, the
	// content is guaranteed identical (ID is a content hash). Skip the
	// write entirely and refresh the mtime so the janitor treats the file
	// as recently active. This is the hot path in an Agent loop where the
	// same tool_result appears in successive requests.
	pointer := &RtkRawOutputPointer{
		ID:       id,
		Path:     logPath,
		Bytes:    len(redactedText),
		SHA256:   shaHex,
		Redacted: redacted,
	}
	if info, err := os.Stat(logPath); err == nil && info.Size() == int64(len(redactedText)) {
		now := time.Now()
		_ = os.Chtimes(logPath, now, now)
		rawOutputPaths.Store(id, logPath)
		return pointer
	}

	// Write the main .log file.
	if err := os.WriteFile(logPath, []byte(redactedText), 0o644); err != nil {
		// Best-effort: return nil, no panic.
		return nil
	}

	// Register the path for ReadRtkRawOutput.
	rawOutputPaths.Store(id, logPath)

	// Write the sidecar .meta.json (best-effort: failure does not block).
	// Timestamp in milliseconds — used by the meta sidecar for operator
	// inspection, not by the janitor (which uses file mtime).
	ts := time.Now().UnixMilli()
	meta := struct {
		Command   string `json:"command"`
		Timestamp int64  `json:"timestamp"`
		Failure   bool   `json:"failure"`
		Redacted  bool   `json:"redacted"`
		Bytes     int    `json:"bytes"`
	}{
		Command:   opts.Command,
		Timestamp: ts,
		Failure:   failure,
		Redacted:  redacted,
		Bytes:     len(redactedText),
	}
	if metaData, err := json.Marshal(meta); err == nil {
		_ = os.WriteFile(metaPath, metaData, 0o644) // best-effort
	}

	return pointer
}

// ReadRtkRawOutput reads the persisted raw output file for the given pointer ID.
// It first checks the package-level registry, then falls back to a glob search
// under the current working directory. Returns the file content as a string, or
// empty string if the file cannot be found or read.
func ReadRtkRawOutput(pointerID string) string {
	if pointerID == "" {
		return ""
	}
	// Check the registry first.
	if v, ok := rawOutputPaths.Load(pointerID); ok {
		path, _ := v.(string)
		if data, err := os.ReadFile(path); err == nil {
			return string(data)
		}
	}
	// Fallback: glob search.
	// Try <cwd>/rtk/raw-output/*-<id>.log
	cwd, err := os.Getwd()
	if err == nil {
		pattern := filepath.Join(cwd, "rtk", "raw-output", "*"+pointerID+".log")
		matches, err := filepath.Glob(pattern)
		if err == nil && len(matches) > 0 {
			if data, err := os.ReadFile(matches[0]); err == nil {
				return string(data)
			}
		}
	}
	return ""
}

// reRawOutputID matches the 24-hex pointer ID produced by MaybePersistRtkRawOutput.
// Compile at package init for hot-path reuse. Case-insensitive so an
// operator pasting a SHA-256 prefix from a shell that uppercased it still
// resolves to the right file.
var reRawOutputID = regexp.MustCompile(`(?i)^[0-9a-f]{24}$`)

// IsValidRawOutputID reports whether the string matches the raw-output ID
// format (24 lowercase hex characters). Handlers should use this to validate
// path parameters before doing any disk lookup.
func IsValidRawOutputID(id string) bool {
	if id == "" {
		return false
	}
	return reRawOutputID.MatchString(id)
}

const (
	// rawOutputSentinelMagic / rawOutputSentinelClose are NUL-prefixed markers
	// bracketing a server-injected metadata region on every response from
	// /api/context/rtk/raw-output/{id}. They exist so the compression pipeline
	// can recognise "this tool message is a recovery fetch, do not re-compress
	// it" with zero heuristic guessing about tool name, message role, or
	// content shape. NUL-prefixed because (a) the marker can never appear in
	// legitimate UTF-8 prose by accident, and (b) HTTP body is byte-safe for
	// any byte sequence including NUL.
	//
	// The closing token is intentionally a different string from the opening
	// one so a truncated fetch response (network drop mid-stream) cannot be
	// mistaken for a sentineled one: StripRawOutputSentinel requires both
	// tokens to be present.
	rawOutputSentinelMagic = "\x00RTK_RAW_OUTPUT_BEGIN\x00"
	rawOutputSentinelClose = "\x00RTK_RAW_OUTPUT_BODY_FOLLOWS\x00"
)

// WrapRawOutputForHTTP attaches the sentinel prefix to a raw-output body
// before it leaves the gateway. Callers MUST go through this helper so the
// sentinel layout has a single source of truth.
//
// Layout:
//
//	\x00RTK_RAW_OUTPUT_BEGIN\x00<id>:<bytes>:<sha256-prefix-12>\x00RTK_RAW_OUTPUT_BODY_FOLLOWS\x00<body>
//
// The metadata region (between Magic and Close) is opaque to the LLM and only
// consumed by StripRawOutputSentinel when the body re-enters the compression
// pipeline via the WebFetch tool result. sha256Hex may be empty when the
// caller has not computed it; the metadata is informational and the stripper
// never parses it.
func WrapRawOutputForHTTP(body, pointerID string, bytes int, sha256Hex string) string {
	var b strings.Builder
	b.Grow(len(rawOutputSentinelMagic) + len(pointerID) + 32 +
		len(rawOutputSentinelClose) + len(body))
	b.WriteString(rawOutputSentinelMagic)
	b.WriteString(pointerID)
	b.WriteByte(':')
	b.WriteString(strconv.Itoa(bytes))
	b.WriteByte(':')
	if len(sha256Hex) >= 12 {
		b.WriteString(sha256Hex[:12])
	}
	b.WriteString(rawOutputSentinelClose)
	b.WriteString(body)
	return b.String()
}

// StripRawOutputSentinel returns (body, true) when the input starts with the
// raw-output sentinel, removing the entire metadata region (including the
// Close token) and returning only the original body. Returns (s, false) when
// no sentinel is present so callers can safely no-op; a truncated sentinel
// (Close token missing) is treated as no sentinel rather than dropping
// arbitrary bytes, so a malformed fetch response cannot silently lose data.
//
// StripRawOutputSentinel is consumed by two call sites that must stay in sync:
// processRtkTextWithCommand uses it as the bypass-detector for the in-pipeline
// anti-recursion short-circuit, and the PreLLMHook entry strip uses it to
// remove the sentinel from tool messages before they leave the plugin boundary
// (so the model never sees the wire-protocol prefix). The PreLLMHook entry
// records a count in BifrostContextKeyRTKSentinelStripped so the in-pipeline
// caller can skip its own sentinel check on the same request — otherwise the
// stripper would run twice on the same body.
func StripRawOutputSentinel(s string) (string, bool) {
	if !strings.HasPrefix(s, rawOutputSentinelMagic) {
		return s, false
	}
	rest := s[len(rawOutputSentinelMagic):]
	closeIdx := strings.Index(rest, rawOutputSentinelClose)
	if closeIdx < 0 {
		return s, false
	}
	return rest[closeIdx+len(rawOutputSentinelClose):], true
}

// StripSentinelFromChatToolMessages walks the chat message slice and strips the
// raw-output sentinel from every role=tool / role=function message it finds.
// Content is rewritten in place — string Content fields and Text content blocks
// are scanned; non-text blocks (image_url, input_audio, file, refusal) are left
// untouched because they cannot carry a sentinel in legitimate use. Other
// roles (user / assistant / system / developer) are also left untouched so a
// user pasting a sentinel into a prompt is preserved verbatim.
//
// Returns the number of fields actually rewritten (not the number of messages
// with the sentinel — one tool message can carry a sentinel in both its
// Content string and a Text block). Returned unchanged is the count of tool
// messages scanned (caller can sanity-check that stripped + scanned ==
// expected tool-message count).
//
// Allocation-conscious: when the sentinel is absent on a field the pointer is
// left alone (no string copy). When present, a single alloc per affected
// string is unavoidable.
func StripSentinelFromChatToolMessages(messages []schemas.ChatMessage) (stripped, toolScanned int) {
	for i := range messages {
		msg := &messages[i]
		if msg.Role != schemas.ChatMessageRoleTool && msg.Role != "function" {
			continue
		}
		toolScanned++
		if msg.Content == nil {
			continue
		}
		if msg.Content.ContentStr != nil {
			if body, ok := StripRawOutputSentinel(*msg.Content.ContentStr); ok {
				updated := body
				msg.Content.ContentStr = &updated
				stripped++
			}
		}
		for j := range msg.Content.ContentBlocks {
			block := &msg.Content.ContentBlocks[j]
			if block.Text == nil {
				continue
			}
			if body, ok := StripRawOutputSentinel(*block.Text); ok {
				updated := body
				block.Text = &updated
				stripped++
			}
		}
	}
	return stripped, toolScanned
}

// StripSentinelFromResponsesToolMessages walks the responses message slice and
// strips the raw-output sentinel from every function_call_output / custom_tool_call_output
// message it finds. Output is rewritten in place — both the flat output string
// (ResponsesToolCallOutputStr) and the per-block Text fields (input_text /
// output_text) are scanned; other output variants (computer_tool_call_output,
// image_generation_call) are left untouched because they cannot carry a
// sentinel in legitimate use.
//
// tool message detection uses ResponsesMessage.ResponsesToolMessage != nil,
// which covers every embedded tool-output variant (function_call_output,
// custom_tool_call_output, code_interpreter_call output, local_shell_call
// output, web_fetch_call output, advisor_call result, tool_search_output,
// mcp_call output, etc.). Other ResponsesMessage variants (user / assistant /
// system messages and tool_call *request* items) are left untouched.
//
// Returns the number of fields actually rewritten, plus the number of tool
// output messages scanned (caller can sanity-check that scanned matches the
// expected count).
//
// Allocation-conscious: when the sentinel is absent on a field the pointer is
// left alone (no string copy). When present, a single alloc per affected
// string is unavoidable.
func StripSentinelFromResponsesToolMessages(messages []schemas.ResponsesMessage) (stripped, toolScanned int) {
	for i := range messages {
		msg := &messages[i]
		if msg.ResponsesToolMessage == nil {
			continue
		}
		toolScanned++
		if msg.Output != nil {
			if msg.Output.ResponsesToolCallOutputStr != nil {
				if body, ok := StripRawOutputSentinel(*msg.Output.ResponsesToolCallOutputStr); ok {
					updated := body
					msg.Output.ResponsesToolCallOutputStr = &updated
					stripped++
				}
			}
			for j := range msg.Output.ResponsesFunctionToolCallOutputBlocks {
				block := &msg.Output.ResponsesFunctionToolCallOutputBlocks[j]
				if block.Text == nil {
					continue
				}
				if body, ok := StripRawOutputSentinel(*block.Text); ok {
					updated := body
					block.Text = &updated
					stripped++
				}
			}
		}
		if msg.Arguments != nil {
			if body, ok := StripRawOutputSentinel(*msg.Arguments); ok {
				updated := body
				msg.Arguments = &updated
				stripped++
			}
		}
	}
	return stripped, toolScanned
}

// ReadRtkRawOutputByID reads the persisted raw output by pointer ID, preferring
// the explicit appDir for path resolution when set. Falls back to the in-memory
// registry and finally a glob search under the current working directory, the
// same as ReadRtkRawOutput. Returns (data, found): when found is false the
// data is empty and callers should surface a 404 to the client.
func ReadRtkRawOutputByID(pointerID, appDir string) (string, bool) {
	return ReadRtkRawOutputByIDInDir(pointerID, appDir, "")
}

// ReadRtkRawOutputByIDInDir is ReadRtkRawOutputByID with an explicit dir override.
// When dir is non-empty it short-circuits the in-memory registry and the
// <appDir>/rtk/raw-output fallback and searches `<dir>/<id>.log` directly
// (falling back to a glob `<dir>/*<id>.log` for legacy timestamp-prefixed files).
// This is the path used by the HTTP handler once the plugin's resolved
// RawOutputDir (config.RawOutputDir || <appDir>/rtk/raw-output) is known.
func ReadRtkRawOutputByIDInDir(pointerID, appDir, dir string) (string, bool) {
	if !IsValidRawOutputID(pointerID) {
		return "", false
	}

	// 1. Explicit dir wins (used by handler once it knows the operator-configured path).
	// Try the deterministic path first (current format), then glob for legacy files.
	if dir != "" {
		directPath := filepath.Join(dir, pointerID+".log")
		if data, err := os.ReadFile(directPath); err == nil {
			return string(data), true
		}
		if data, ok := readFirstMatch(filepath.Join(dir, "*"+pointerID+".log")); ok {
			return data, true
		}
	}

	// 2. Try the in-memory registry (most recent persist call sites it directly).
	if v, ok := rawOutputPaths.Load(pointerID); ok {
		path, _ := v.(string)
		if data, err := os.ReadFile(path); err == nil {
			return string(data), true
		}
	}

	// 3. Try under the provided appDir (production path — handler passes p.AppDir()).
	if appDir != "" {
		appRoot := filepath.Join(appDir, "rtk", "raw-output")
		if dir == "" || appRoot != dir {
			directPath := filepath.Join(appRoot, pointerID+".log")
			if data, err := os.ReadFile(directPath); err == nil {
				return string(data), true
			}
			if data, ok := readFirstMatch(filepath.Join(appRoot, "*"+pointerID+".log")); ok {
				return data, true
			}
		}
	}

	// 4. Fallback: glob under the current working directory.
	if cwd, err := os.Getwd(); err == nil {
		pattern := filepath.Join(cwd, "rtk", "raw-output", "*"+pointerID+".log")
		if data, ok := readFirstMatch(pattern); ok {
			return data, true
		}
	}

	return "", false
}

// readFirstMatch performs a glob search and returns the content of the first
// matching file. Used by ReadRtkRawOutputByID to fan out over the available
// raw-output directories without exposing glob internals to callers.
func readFirstMatch(pattern string) (string, bool) {
	matches, err := filepath.Glob(pattern)
	if err != nil || len(matches) == 0 {
		return "", false
	}
	data, err := os.ReadFile(matches[0])
	if err != nil {
		return "", false
	}
	return string(data), true
}

// safeUtf8Slice truncates the string to the given byte limit, ensuring the
// result is valid UTF-8 (backing off the last incomplete rune).
func safeUtf8Slice(value string, maxBytes int) string {
	if maxBytes <= 0 || len(value) <= maxBytes {
		return value
	}
	// Fast path: if the byte at maxBytes is not a continuation byte, it's a
	// rune boundary. UTF-8 lead bytes never have the form 10xxxxxx.
	b := []byte(value)
	if maxBytes < len(b) && b[maxBytes]&0xC0 != 0x80 {
		return string(b[:maxBytes])
	}
	// Slow path: back off through the last rune until valid.
	slice := value[:maxBytes]
	for len(slice) > 0 && !utf8.ValidString(slice) {
		_, size := utf8.DecodeLastRuneInString(slice)
		if size <= 0 {
			slice = slice[:len(slice)-1]
		} else {
			slice = slice[:len(slice)-size]
		}
	}
	return slice
}

// commandSlug converts a shell command string into a filename-safe slug.
func commandSlug(command string) string {
	slug := strings.ToLower(strings.TrimSpace(command))
	slug = reSlugInvalid.ReplaceAllString(slug, "-")
	slug = strings.Trim(slug, "-")
	if slug == "" {
		slug = "unknown-command"
	}
	return slug
}

// RtkRawOutputJanitor is a best-effort TTL reaper for persisted raw-output
// files. It walks <dir> on a fixed interval (default 30 min) and deletes any
// file whose filename-encoded mtime is older than ttl. An empty ttl disables
// the janitor entirely — the Start method becomes a no-op so plugin.Close can
// stay symmetric.
//
// Filenames encode the persist timestamp as the leading `<unix-ms>-` prefix,
// so the janitor can parse expiry without stat'ing the filesystem (cheaper on
// large directories) and without trusting the OS mtime (which can be touched
// by operator tooling).
type RtkRawOutputJanitor struct {
	dir      string
	ttl      time.Duration
	interval time.Duration
	logger   schemas.Logger

	done chan struct{}
	once sync.Once
}

// NewRtkRawOutputJanitor wires a janitor with the given directory and TTL.
// A ttl <= 0 returns nil so callers can simply check `if janitor != nil` to
// decide whether to start one. interval <= 0 falls back to 30 minutes — the
// granularity discussed in design (we don't want TTL precision to mask
// accidental misconfiguration toward 0).
func NewRtkRawOutputJanitor(dir string, ttl time.Duration, logger schemas.Logger) *RtkRawOutputJanitor {
	if ttl <= 0 {
		return nil
	}
	return &RtkRawOutputJanitor{
		dir:      dir,
		ttl:      ttl,
		interval: 30 * time.Minute,
		logger:   logger,
		done:     make(chan struct{}),
	}
}

// Start spawns the janitor loop. It is safe to call exactly once; further
// calls are ignored thanks to sync.Once. ctx cancellation triggers a final
// sweep on the way out so files that aged out during shutdown still get
// reaped before the process exits.
func (j *RtkRawOutputJanitor) Start(ctx context.Context) {
	if j == nil {
		return
	}
	j.once.Do(func() {
		go j.loop(ctx)
	})
}

// Stop signals the loop to exit and blocks until it returns. After Stop the
// janitor cannot be restarted.
func (j *RtkRawOutputJanitor) Stop() {
	if j == nil {
		return
	}
	close(j.done)
}

// loop runs reapOnce on a ticker until ctx cancels or Stop is called.
// A nil ctx disables cancellation entirely — the loop is then only bounded
// by Stop() and the lifetime of the process. This is the behaviour the
// plugin's tests rely on (they pass nil to Init to avoid a t.Context()).
func (j *RtkRawOutputJanitor) loop(ctx context.Context) {
	ticker := time.NewTicker(j.interval)
	defer ticker.Stop()
	// Run once immediately so a server restart doesn't carry stale files from
	// the previous process.
	j.reapOnce()
	if ctx == nil {
		<-j.done
		return
	}
	for {
		select {
		case <-ctx.Done():
			j.reapOnce()
			return
		case <-j.done:
			return
		case <-ticker.C:
			j.reapOnce()
		}
	}
}

// reapOnce deletes every *.log file under j.dir whose age exceeds j.ttl.
// Companion *.meta.json files are removed when their .log sibling is removed.
// Errors are logged at WARN and skipped — best-effort behaviour is the
// contract.
//
// Two filename formats are supported:
//   - Legacy: `<unix-ms>-<slug>-<id24>.log` — the leading timestamp is parsed
//     from the filename (no stat needed).
//   - Current: `<id24>.log` — no timestamp in the name; the file's mtime is
//     used instead. MaybePersistRtkRawOutput refreshes mtime on dedup hits
//     so the file stays alive as long as any active request references it.
func (j *RtkRawOutputJanitor) reapOnce() {
	if j == nil || j.dir == "" {
		return
	}
	entries, err := os.ReadDir(j.dir)
	if err != nil {
		if j.logger != nil {
			j.logger.Warn("rtk.janitor", "read dir failed: %v", err)
		}
		return
	}
	cutoff := time.Now().Add(-j.ttl).UnixMilli()
	removed := 0
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".log") {
			continue
		}
		// Try filename-encoded timestamp first (legacy format). When that
		// fails (current deterministic format has no dash prefix), fall
		// back to the file's mtime.
		ts, ok := rawOutputFilenameTimestamp(name)
		if !ok {
			info, statErr := e.Info()
			if statErr != nil {
				continue
			}
			ts = info.ModTime().UnixMilli()
		}
		if ts > cutoff {
			continue
		}
		logPath := filepath.Join(j.dir, name)
		metaPath := logPath[:len(logPath)-len(".log")] + ".meta.json"
		if rmErr := os.Remove(logPath); rmErr != nil && !os.IsNotExist(rmErr) {
			if j.logger != nil {
				j.logger.Warn("rtk.janitor", "remove %s: %v", logPath, rmErr)
			}
			continue
		}
		_ = os.Remove(metaPath) // best-effort, ignore missing
		removed++
	}
	if removed > 0 && j.logger != nil {
		j.logger.Info("rtk.janitor", "reaped %d expired raw-output file(s) under %s", removed, j.dir)
	}
}

// rawOutputFilenameTimestamp extracts the leading unix-ms timestamp from a
// raw-output filename of the form `<unix-ms>-<slug>-<id>.log`. Returns false
// when the name does not match the expected shape — non-matching files are
// skipped by the janitor so unrelated files in the directory are safe.
func rawOutputFilenameTimestamp(name string) (int64, bool) {
	firstDash := strings.IndexByte(name, '-')
	if firstDash <= 0 {
		return 0, false
	}
	ts, err := strconv.ParseInt(name[:firstDash], 10, 64)
	if err != nil {
		return 0, false
	}
	return ts, true
}