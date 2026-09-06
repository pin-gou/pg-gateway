package rtk

import (
	"strconv"
	"strings"
	"testing"
)

// TestProcessRtkText_RawOutputBypass verifies that processRtkText short-
// circuits when the input carries the server-side sentinel prefix, returning
// the persisted body verbatim and recording the bypass in stats.Techniques.
// This is the contract that breaks the "raw-output recursion" bug: every
// LLM fetch of /api/context/rtk/raw-output/{id} must reach the LLM without
// triggering another round of compression + raw-output persistence.
func TestProcessRtkText_RawOutputBypass(t *testing.T) {
	originalBody := "PASS\nok github.com/foo/bar 0.123s\nFAIL\nfail github.com/foo/baz\n"
	wrapped := WrapRawOutputForHTTP(originalBody, "abc123456789abcdef01234567", len(originalBody), "")

	cfg := &Config{
		Enabled:            true,
		MaxCharsPerResult:  50, // would normally truncate; bypass must skip this
		MaxLinesPerResult:  1,
		RawOutputRetention: string(RawOutputRetentionAlways), // would normally persist; bypass must skip
	}

	out, stats := processRtkText(wrapped, cfg)

	if out != originalBody {
		t.Fatalf("bypass should return original body unchanged\n got: %q\nwant: %q", out, originalBody)
	}
	if stats.Truncated {
		t.Fatalf("bypass must not mark Truncated=true (would re-emit a marker)")
	}
	if !hasTechnique(stats.Techniques, "rtk-raw-output-bypass") {
		t.Fatalf("bypass technique should be recorded, got %v", stats.Techniques)
	}
	if len(stats.RawOutputPointers) != 0 {
		t.Fatalf("bypass must not produce new raw_output_pointers, got %d", len(stats.RawOutputPointers))
	}
}

// TestProcessRtkText_NoSentinel_Compresses confirms that input without the
// sentinel flows through the normal pipeline (no bypass). We use a string
// that produces a stable, easily-asserted result.
func TestProcessRtkText_NoSentinel_Compresses(t *testing.T) {
	// Empty input returns early without bypass (caught by the empty-input
	// guard); choose an input that does NOT match the sentinel and that
	// the normal pipeline will pass through.
	cfg := &Config{
		Enabled:            true,
		MaxCharsPerResult:  12_000,
		MaxLinesPerResult:  120,
		RawOutputRetention: string(RawOutputRetentionNever), // skip persistence side-effect
	}
	input := "short body without sentinel"

	out, stats := processRtkText(input, cfg)

	if out != input {
		t.Fatalf("non-sentinel input should round-trip; got %q want %q", out, input)
	}
	if hasTechnique(stats.Techniques, "rtk-raw-output-bypass") {
		t.Fatalf("non-sentinel input must not record bypass technique, got %v", stats.Techniques)
	}
}

// TestProcessRtkText_BypassEmptyBody covers the degenerate case where the
// sentinel wraps an empty body. The bypass must return "" and not crash.
func TestProcessRtkText_BypassEmptyBody(t *testing.T) {
	wrapped := WrapRawOutputForHTTP("", "0123456789abcdef01234567", 0, "")

	cfg := &Config{Enabled: true}
	out, stats := processRtkText(wrapped, cfg)

	if out != "" {
		t.Fatalf("bypass empty body should return empty string, got %q", out)
	}
	if !hasTechnique(stats.Techniques, "rtk-raw-output-bypass") {
		t.Fatalf("bypass technique should be recorded, got %v", stats.Techniques)
	}
}

// hasTechnique is a tiny local helper. Distinct from rtk_test.go's contains
// (which has a string×string signature); the two coexist in the same package.
func hasTechnique(haystack []string, needle string) bool {
	for _, h := range haystack {
		if h == needle {
			return true
		}
	}
	return false
}

// TestDenoiseVsTruncateHintPolicies (strategy C) pins the split between
// "denoise" and "truncate".
//
//   - Denoise path (line filter strips PASS/RUN noise from a go test run):
//     the body shrinks so it is persisted (maybePersistRawOutput gates on
//     CompressedTokens < OriginalTokens), but the shrunk output is NOT marked
//     Truncated and thus carries NO recovery hint. Inviting the LLM to fetch
//     back stripped PASS/RUN noise it never needed would waste a round-trip.
//     go-test FAIL lines are priority-protected, so short runs never hit
//     smartTruncate head/tail — Truncated stays false.
//
//   - Truncate path (a hard MaxCharsPerResult charlimit forces content to be
//     dropped regardless of what the filter preserved): Truncated=true → a
//     recovery hint IS appended, because truncation drops signal an actor may
//     genuinely need to recover.
//
// Both runs use retention=always, so persistence fires in both cases; only the
// hint is gated on a real truncation, not on the mere fact of persisting.
func TestDenoiseVsTruncateHintPolicies(t *testing.T) {
	buildGoRun := func(nPass, nFail int) string {
		var sb strings.Builder
		for i := 0; i < nPass; i++ {
			sb.WriteString("=== RUN   TestPass")
			sb.WriteString(strconv.Itoa(i))
			sb.WriteString("\n--- PASS: TestPass")
			sb.WriteString(strconv.Itoa(i))
			sb.WriteString(" (0.10s)\n")
		}
		for i := 0; i < nFail; i++ {
			sb.WriteString("--- FAIL: Fail")
			sb.WriteString(strconv.Itoa(i))
			sb.WriteString(" (0.03s)\n    svc_test.go:42: boom\n")
		}
		sb.WriteString("FAIL\nFAIL\tsvc/v2\t0.95s\nFAIL\n")
		return sb.String()
	}

	denoiseCfg := &Config{
		Enabled:            true,
		RawOutputRetention: string(RawOutputRetentionAlways),
		MaxCharsPerResult:  1 << 20, // no hard char limit → no charlimit truncation
		MaxLinesPerResult:  1 << 20,
	}
	denoiseLoader := NewFilterLoader(denoiseCfg)
	if err := denoiseLoader.Load(t.TempDir()); err != nil {
		t.Fatal(err)
	}

	// 1) Denoise-only: PASS lines stripped, a few FAILs survive (priority-
	// protected, ≤ any head/tail budget) → nothing truncated.
	denoised, denoiseStats := processRtkTextWithCommand(nil, buildGoRun(15, 3), denoiseCfg, denoiseLoader, "go test", "")
	if denoiseStats.Truncated {
		t.Fatalf("denoise-only must not set Truncated (got true): tech=%v", denoiseStats.Techniques)
	}
	if denoiseStats.CompressedTokens >= denoiseStats.OriginalTokens {
		t.Fatalf("denoise fixture must actually shrink for this test (orig=%d comp=%d)",
			denoiseStats.OriginalTokens, denoiseStats.CompressedTokens)
	}
	if len(denoiseStats.RawOutputPointers) == 0 {
		t.Errorf("denoise-only: expected the shrunk body to be persisted (operator diff), got no pointer")
	}
	if containsRecoveryHint(denoised) {
		t.Fatalf("denoise-only body must NOT carry a recovery hint; got:\n%s", denoised)
	}

	// 2) Truncate: a small MaxCharsPerResult forces charlimit to drop content.
	truncCfg := &Config{
		Enabled:            true,
		RawOutputRetention: string(RawOutputRetentionAlways),
		MaxCharsPerResult:  60, // ≤ the denoised body → charlimit drops the tail
		MaxLinesPerResult:  1 << 20,
	}
	truncLoader := NewFilterLoader(truncCfg)
	if err := truncLoader.Load(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	truncated, truncStats := processRtkTextWithCommand(nil, buildGoRun(15, 3), truncCfg, truncLoader, "go test", "")
	if !truncStats.Truncated {
		t.Fatalf("truncate path must set Truncated (got false): tech=%v", truncStats.Techniques)
	}
	if truncStats.CompressedTokens >= truncStats.OriginalTokens {
		t.Fatalf("expected a compressed result on the truncate path (orig=%d comp=%d)",
			truncStats.OriginalTokens, truncStats.CompressedTokens)
	}
	if len(truncStats.RawOutputPointers) == 0 {
		t.Errorf("truncate path: expected the original to be persisted for recovery, got no pointer")
	}
	if !containsRecoveryHint(truncated) {
		t.Fatalf("truncate path must append a recovery hint; got:\n%s", truncated)
	}
}

// containsRecoveryHint reports whether s contains the raw-output recovery hint.
func containsRecoveryHint(s string) bool {
	return strings.Contains(s, "[rtk:raw_output_id=")
}
