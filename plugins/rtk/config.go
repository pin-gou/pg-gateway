package rtk

import (
	"fmt"
	"path/filepath"
)

// Config holds the configuration for the RTK (Rule-based Tool-output Kompression) plugin.
// It controls which tool outputs are compressed and how aggressively.
type Config struct {
	// Enabled enables or disables the RTK compression plugin.
	Enabled bool `json:"enabled"`

	// Intensity controls the compression aggressiveness: minimal | standard | aggressive.
	Intensity string `json:"intensity"`

	// MaxLinesPerResult is the maximum number of lines to keep per tool result after compression.
	MaxLinesPerResult int `json:"max_lines_per_result"`

	// MaxCharsPerResult is the maximum number of characters to keep per tool result after compression.
	MaxCharsPerResult int `json:"max_chars_per_result"`

	// DedupThreshold is the number of consecutive identical lines before deduplication kicks in.
	DedupThreshold int `json:"dedup_threshold"`

	// EnableGrouping enables fuzzy grouping of near-equivalent consecutive lines
	// (lines that differ only by timestamps/hex IDs/numbers/versions).
	EnableGrouping bool `json:"enable_grouping"`

	// GroupingThreshold is the minimum run length of near-equivalent lines before
	// grouping kicks in. Values below 2 are clamped to 2 at runtime.
	GroupingThreshold int `json:"grouping_threshold"`

	// CustomFiltersEnabled enables loading of project/global custom filters from
	// the filesystem (default true). When false, only builtin filters are used.
	CustomFiltersEnabled bool `json:"custom_filters_enabled"`

	// TrustProjectFilters bypasses the trust.json SHA256 check for project-level
	// filters (default false). When false, project filters are only loaded when
	// their filters.json SHA256 matches trust.json (or the trust env var is set).
	TrustProjectFilters bool `json:"trust_project_filters"`

	// EnabledFilters whitelists filter IDs (canonical) or names (legacy) to load.
	// Empty means all filters are enabled. Filters are matched by ID first, then Name.
	EnabledFilters []string `json:"enabled_filters"`

	// DisabledFilters blacklists filter IDs (canonical) or names (legacy) from loading.
	// Empty means no filters are disabled. Applied after EnabledFilters.
	DisabledFilters []string `json:"disabled_filters"`

	// RawOutputRetention controls when raw tool outputs are persisted to disk
	// under <appDir>/rtk/raw-output/ for debugging: "always" (default) |
	// "failures" | "never".
	RawOutputRetention string `json:"raw_output_retention"`

	// RawOutputMaxBytes caps the persisted raw output size in UTF-8 bytes
	// (default 1048576, minimum 1024).
	RawOutputMaxBytes int `json:"raw_output_max_bytes"`

	// RawOutputDir overrides the on-disk root for raw-output persistence.
	// Empty string = use <appDir>/rtk/raw-output/. Must be an absolute path
	// when set. The directory is created lazily on first persist call.
	RawOutputDir string `json:"raw_output_dir,omitempty"`

	// RawOutputTTLHours controls how long raw-output files live on disk before
	// the janitor reaps them. 0 disables the janitor (files live forever).
	// Default 24, range [0, 168] (max 7 days). Only enforced when janitor is
	// running; the file mtime + filename `<id24>.log` is the source of
	// truth.
	RawOutputTTLHours int `json:"raw_output_ttl_hours,omitempty"`

	// Pipeline defines the ordered list of compression engines to run.
	// When nil or empty, applyConfigDefaults fills it with [{id:"rtk"}].
	// Each step specifies an engine ID and optional engine-specific config.
	Pipeline []PipelineStep `json:"pipeline,omitempty"`

	// MinTokensToCompress is the minimum estimated request token count
	// required to trigger compression. When > 0 and the estimated tokens
	// are below this threshold, the entire compression pipeline is skipped.
	// 0 means "no minimum threshold, always compress" (the default).
	MinTokensToCompress int `json:"min_tokens_to_compress"`

	// EnableRenderers enables semantic renderers (opt-in, default false).
	// When enabled, the pipeline looks up a renderer by detection.Type and,
	// if one is registered, applies a semantic rewrite (e.g. git-diff
	// strips context lines, test-green collapses an all-green test suite
	// into a single summary line, terraform-plan summarises a plan,
	// structured-table parses JSON arrays into TSV). Renderers are
	// fail-open: a panic or error returns the original text untouched.
	// Aligned with OmniRoute's RtkConfig.enableRenderers.
	EnableRenderers bool `json:"enable_renderers"`

	// DisabledRenderers is an optional blacklist of detection types whose
	// renderers should be skipped. Empty (the default) means every registered
	// renderer may run. When non-empty, renderers whose detection Type appears
	// in this list pass through unchanged.
	DisabledRenderers []string `json:"disabled_renderers,omitempty"`

	// Caveman configures the Caveman prose-compression engine. Default is
	// disabled (opt-in); when enabled it compresses user-role message text
	// via rule-based transformations. Runs as the "caveman" engine in the
	// pipeline.
	Caveman CavemanConfig `json:"caveman"`
}

// Validate checks the config for valid values and returns an error if any field
// is out of range or invalid. This is called during Init to fail fast on
// misconfiguration, protecting against malicious or accidental bad config.
func (c *Config) Validate() error {
	validIntensities := map[string]bool{"minimal": true, "standard": true, "aggressive": true}
	if c.Intensity != "" && !validIntensities[c.Intensity] {
		return fmt.Errorf("rtk: invalid intensity %q: must be one of minimal, standard, aggressive", c.Intensity)
	}
	if c.MaxLinesPerResult < 0 {
		return fmt.Errorf("rtk: max_lines_per_result must be >= 0, got %d", c.MaxLinesPerResult)
	}
	if c.MaxCharsPerResult < 0 {
		return fmt.Errorf("rtk: max_chars_per_result must be >= 0, got %d", c.MaxCharsPerResult)
	}
	if c.DedupThreshold < 0 {
		return fmt.Errorf("rtk: dedup_threshold must be >= 0, got %d", c.DedupThreshold)
	}
	// The 4 new fields (CustomFiltersEnabled, TrustProjectFilters, EnabledFilters,
	// DisabledFilters) are validated for type only — they can be nil/empty/false.
	// CustomFiltersEnabled and TrustProjectFilters are booleans (no invalid states).
	// EnabledFilters/DisabledFilters are string slices — empty is valid.

	// RawOutputRetention validation: must be one of never, failures, always.
	if c.RawOutputRetention != "" {
		switch c.RawOutputRetention {
		case "never", "failures", "always":
		default:
			return fmt.Errorf("rtk: invalid raw_output_retention %q: must be one of never, failures, always", c.RawOutputRetention)
		}
	}
	// RawOutputMaxBytes validation: negative is invalid, positive but < 1024 is invalid.
	if c.RawOutputMaxBytes < 0 {
		return fmt.Errorf("rtk: raw_output_max_bytes must be >= 0, got %d", c.RawOutputMaxBytes)
	}
	if c.RawOutputMaxBytes > 0 && c.RawOutputMaxBytes < 1024 {
		return fmt.Errorf("rtk: raw_output_max_bytes must be >= 1024 when set, got %d", c.RawOutputMaxBytes)
	}
	// RawOutputDir validation: when non-empty, must be an absolute path. This
	// protects against operators pointing persistence at a relative working
	// directory that moves under the plugin's feet (and against accidentally
	// resolving against CWD inside a relocated container).
	if c.RawOutputDir != "" && !filepath.IsAbs(c.RawOutputDir) {
		return fmt.Errorf("rtk: raw_output_dir must be an absolute path, got %q", c.RawOutputDir)
	}
	// RawOutputTTLHours validation: 0 disables the janitor; positive values
	// are clamped to a 7-day ceiling to prevent unbounded retention.
	if c.RawOutputTTLHours < 0 {
		return fmt.Errorf("rtk: raw_output_ttl_hours must be >= 0, got %d", c.RawOutputTTLHours)
	}
	if c.RawOutputTTLHours > 168 {
		return fmt.Errorf("rtk: raw_output_ttl_hours must be <= 168 (7 days), got %d", c.RawOutputTTLHours)
	}
	// MinTokensToCompress validation: negative is invalid.
	if c.MinTokensToCompress < 0 {
		return fmt.Errorf("rtk: min_tokens_to_compress must be >= 0, got %d", c.MinTokensToCompress)
	}
	// Caveman sub-config validation — only meaningful when the Caveman engine
	// is enabled, but always checked so misconfiguration fails fast.
	if err := c.Caveman.Validate(); err != nil {
		return fmt.Errorf("rtk: invalid caveman config: %w", err)
	}
	return nil
}

// looksLikeAllZero reports whether c has every field at its zero value.
// We use it as a heuristic to distinguish "the operator never saved a config
// (storage held null/{} and round-tripped to all-zeros)" from "the operator
// explicitly tuned every value and landed on zero by design". The former is
// the only case where zero-valued Enabled is a footgun: the plain-bool zero
// value cannot distinguish "explicit false" from "unset", so a null/empty
// stored config deserialises to Enabled=false and silently turns RTK into a
// no-op. Promoting it to Enabled=true here closes that hole without changing
// the semantics of explicit configurations (an operator who sets Intensity,
// MaxLinesPerResult or any other tunable will have at
// least one non-zero field and therefore opt out of this guard).
func looksLikeAllZero(c *Config) bool {
	if c == nil {
		return true
	}
	return c.Intensity == "" &&
		c.MaxLinesPerResult == 0 &&
		c.MaxCharsPerResult == 0 &&
		c.DedupThreshold == 0 &&
		c.GroupingThreshold == 0 &&
		!c.EnableGrouping &&
		!c.CustomFiltersEnabled &&
		!c.TrustProjectFilters &&
		!c.EnableRenderers &&
		c.RawOutputRetention == "" &&
		c.RawOutputMaxBytes == 0 &&
		c.MinTokensToCompress == 0 &&
		len(c.Pipeline) == 0
}

// ApplyConfigDefaults is the exported entry point for the defaulting logic.
// The RTK runtime applies defaults during Init; HTTP handlers that surface
// the persisted config (e.g. GET /api/context/rtk/config) call this so API
// consumers see the same effective values as the running plugin instead of
// raw zero-value fields from the config store.
func ApplyConfigDefaults(c *Config) {
	if c == nil {
		return
	}
	applyConfigDefaults(c)
}

// applyConfigDefaults fills in zero-value fields with sensible defaults.
func applyConfigDefaults(c *Config) {
	// Zero-detect safeguard: when storage produced an all-zero Config (the
	// usual signature of a never-saved / null config_json), the absence of
	// any explicit operator intent means we should *enable* RTK rather than
	// leave it disabled. See looksLikeAllZero for the rationale.
	if looksLikeAllZero(c) && !c.Enabled {
		c.Enabled = true
	}
	if c.Intensity == "" {
		c.Intensity = "standard"
	}
	if c.MaxLinesPerResult == 0 {
		c.MaxLinesPerResult = 120
	}
	if c.MaxCharsPerResult == 0 {
		c.MaxCharsPerResult = 12000
	}
	if c.DedupThreshold == 0 {
		c.DedupThreshold = 3
	}
	// Grouping defaults: zero value → 3 (default off for EnableGrouping).
	if c.GroupingThreshold == 0 {
		c.GroupingThreshold = 3
	} else if c.GroupingThreshold < 2 {
		// Clamp values below 2 to 2, logging a WARN with the original value.
		fmt.Printf("WARN: rtk: grouping_threshold %d is below minimum 2, clamping to 2\n", c.GroupingThreshold)
		c.GroupingThreshold = 2
	}
	// CustomFiltersEnabled defaults to true (design.md). The plain-bool zero
	// value cannot distinguish "explicit false" from "unset", so the defaulting
	// happens in FilterLoader.customFiltersEnabled() at load time: a config that
	// leaves all four custom-filter fields at zero is treated as "defaults
	// enabled". We deliberately do NOT force the field here so an explicit
	// custom_filters_enabled=false in config.json survives to the loader.

	// RawOutputRetention defaults to "always". The plain-bool zero value cannot
	// distinguish "explicit never" from "unset", so on first load we enable
	// persistence; an operator who wants the old behaviour can set the field
	// to "never" explicitly. The retention-default flip pairs with the LLM
	// raw-output recovery hint: with persistence always on, every truncated
	// tool result lands on disk and the LLM can recover the original via the
	// /api/context/rtk/raw-output/{id} endpoint.
	if c.RawOutputRetention == "" {
		c.RawOutputRetention = "always"
	}

	// RawOutputMaxBytes defaults to 1048576.
	if c.RawOutputMaxBytes == 0 {
		c.RawOutputMaxBytes = 1048576
	}

	// RawOutputTTLHours defaults to 24. The janitor runs every 30 minutes
	// regardless of TTL — a value of 0 simply means "do not reap".
	if c.RawOutputTTLHours == 0 {
		c.RawOutputTTLHours = 24
	}

	// Pipeline defaults: nil or empty → [{id:"rtk"}]
	if len(c.Pipeline) == 0 {
		c.Pipeline = []PipelineStep{{ID: "rtk"}}
	}

	// MinTokensToCompress stays at 0 (zero value = no threshold).
	// Do not overwrite an explicit positive value.

	// EnableRenderers stays at false (opt-in). Renderers whitelist stays
	// empty (== all registered renderers enabled when EnableRenderers=true).

	// Caveman defaults: Caveman stays opt-in (Enabled=false unless the
	// operator sets it), but its tunables are defaulted so the engine
	// behaves predictably the moment it is switched on.
	normalizeCavemanConfig(&c.Caveman)
}
