// Package handlers — RTK-specific HTTP endpoints.
//
// This file implements the six admin endpoints that OmniRoute exposes for
// its RTK engine, aligned to the same path layout operators are used to:
//
//	GET  /api/context/rtk/config           — read the active RTK config
//	PUT  /api/context/rtk/config           — replace the active RTK config
//	GET  /api/context/rtk/filters          — list the loaded filter catalog
//	GET  /api/context/rtk/caveman/rules    — built-in Caveman rule catalog (for skip_rules multi-select)
//	POST /api/context/rtk/test             — dry-run compression against a payload
//	GET  /api/context/rtk/raw-output/{id}  — read a persisted raw-output file
//	GET  /api/context/rtk/stats            — process-lifetime compression counters
//	GET  /api/context/rtk/stats/histogram — time-bucketed histogram of compression stats
//	POST /api/compression/preview          — preview rtk / stacked / off modes
//
// The handler relies on the existing plugins loader for persistence and
// reload, so /api/context/rtk/config and /api/plugins/rtk share the same
// underlying row in the config store. The dedicated path is purely a
// convenience for the RTK admin UI.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/fasthttp/router"
	"github.com/pin-gou/celer-route/core/schemas"
	"github.com/pin-gou/celer-route/framework/configstore"
	configstoreTables "github.com/pin-gou/celer-route/framework/configstore/tables"
	rtk "github.com/pin-gou/celer-route/plugins/rtk"
	"github.com/pin-gou/celer-route/transports/celer-route-http/lib"
	"github.com/valyala/fasthttp"
	"gorm.io/gorm"
)

// RtkPluginAccessor is the bridge between this handler and the loaded RTK
// plugin instance. It exposes the admin helpers (GetFilterCatalog, RunTest,
// PreviewCompression) and the raw-output reader so the handler can serve
// /api/context/rtk/* without importing the rtk package's internals.
//
// The interface is satisfied by *rtk.Plugin and by a small server-side
// adapter that resolves the live plugin instance on each call.
type RtkPluginAccessor interface {
	GetFilterCatalog() rtk.FilterCatalog
	GetCavemanRuleCatalog() rtk.CavemanRuleCatalog
	GetRendererCatalog() rtk.RendererCatalog
	RunTest(payload rtk.TestPayload) rtk.TestResult
	PreviewCompression(req rtk.PreviewRequest) rtk.PreviewResponse
	ReadRawOutput(id string) (string, bool)
	Stats() rtk.MetricsSnapshot
	Histogram(start, end, bucketSize int64) []rtk.RtkHistogramBucket
}

// RtkPluginResolver returns the active RTK plugin or false when the plugin
// is not loaded. Implementations are expected to look the plugin up via the
// server's runtime registry so that reloads are honoured transparently.
type RtkPluginResolver interface {
	ResolveRtkPlugin() (RtkPluginAccessor, bool)
}

// RtkConfigStore is the narrow subset of configstore.ConfigStore that the
// RTK handler actually needs. Splitting it out keeps the handler testable
// without bringing in the full provider-key CRUD surface that
// configstore.ConfigStore requires. Method signatures match
// configstore.ConfigStore (including the variadic gorm tx argument) so
// the live store can be passed in directly.
type RtkConfigStore interface {
	GetPlugin(ctx context.Context, name string) (*configstoreTables.TablePlugin, error)
	CreatePlugin(ctx context.Context, p *configstoreTables.TablePlugin, tx ...*gorm.DB) error
	UpdatePlugin(ctx context.Context, p *configstoreTables.TablePlugin, tx ...*gorm.DB) error
}

// RtkHandler serves the five RTK admin endpoints. It is safe for concurrent
// use: all state lives behind RtkPluginResolver and the config store.
type RtkHandler struct {
	configStore RtkConfigStore
	resolver    RtkPluginResolver
	pluginName  string // canonical name, always "rtk"
}

// NewRtkHandler constructs a handler with the dependencies it needs to
// serve /api/context/rtk/* and /api/compression/preview.
func NewRtkHandler(cs RtkConfigStore, resolver RtkPluginResolver) *RtkHandler {
	return &RtkHandler{
		configStore: cs,
		resolver:    resolver,
		pluginName:  rtk.PluginName,
	}
}

// RegisterRoutes installs the eight routes on r, applying the supplied
// middleware chain to each handler (matches the pattern used by every other
// admin handler in this package).
//
// Exception: the GET /api/context/rtk/raw-output/{id} endpoint is intentionally
// installed WITHOUT middlewares, so the LLM can recover a truncated tool_result
// by issuing a plain GET to the URL embedded in the [rtk:raw_output_id=...;
// fetch=GET <url>] marker (no Authorization header required). The id itself
// (24 lowercase hex chars, ~96 bits of entropy) is the capability — anyone
// holding it can read the persisted raw output. This is a deliberate
// capability-URL design: the alternative (requiring the chat-completion
// bearer) would mean the LLM would have to read the operator's API key from
// disk to recover the original output, which is far more dangerous than
// exposing 96-bit random ids that expire after raw_output_ttl_hours. The id
// is also recorded in log metadata, so logging access is a stricter boundary
// than this endpoint's access by design.
//
// Additionally, the response body is wrapped with a server-side sentinel
// prefix by default (see rtk.WrapRawOutputForHTTP); pass ?raw=1 to retrieve
// the verbatim file body for operator inspection.
func (h *RtkHandler) RegisterRoutes(r *router.Router, middlewares ...schemas.BifrostHTTPMiddleware) {
	r.GET("/api/context/rtk/config", lib.ChainMiddlewares(h.getConfig, middlewares...))
	r.PUT("/api/context/rtk/config", lib.ChainMiddlewares(h.putConfig, middlewares...))
	r.GET("/api/context/rtk/filters", lib.ChainMiddlewares(h.getFilters, middlewares...))
	r.GET("/api/context/rtk/caveman/rules", lib.ChainMiddlewares(h.getCavemanRules, middlewares...))
	r.GET("/api/context/rtk/renderers", lib.ChainMiddlewares(h.getRenderers, middlewares...))
	r.POST("/api/context/rtk/test", lib.ChainMiddlewares(h.postTest, middlewares...))
	r.GET("/api/context/rtk/raw-output/{id}", h.getRawOutput)
	r.GET("/api/context/rtk/stats", lib.ChainMiddlewares(h.getStats, middlewares...))
	r.GET("/api/context/rtk/stats/histogram", lib.ChainMiddlewares(h.getStatsHistogram, middlewares...))
	r.POST("/api/compression/preview", lib.ChainMiddlewares(h.postPreview, middlewares...))
}

// ---------------------------------------------------------------------------
// /api/context/rtk/config
// ---------------------------------------------------------------------------

// RtkConfigResponse is the response shape for GET/PUT /api/context/rtk/config.
// It is the typed RTK config plus the boolean the UI needs to know whether
// the plugin is currently active in the runtime registry.
type RtkConfigResponse struct {
	Enabled bool       `json:"enabled"`
	Config  rtk.Config `json:"config"`
}

// getConfig returns the active RTK config. The persisted row (if any) wins
// over the runtime initial config so that reloads survive a server restart.
func (h *RtkHandler) getConfig(ctx *fasthttp.RequestCtx) {
	if h.configStore == nil {
		SendError(ctx, fasthttp.StatusServiceUnavailable, "Config store is not configured; RTK admin endpoints require a config store")
		return
	}

	stored, err := h.configStore.GetPlugin(ctx, h.pluginName)
	if err != nil && !errors.Is(err, configstore.ErrNotFound) {
		logger.Error("rtk: failed to read plugin row: %v", err)
		SendError(ctx, fasthttp.StatusInternalServerError, "Failed to read RTK configuration")
		return
	}

	resp := RtkConfigResponse{Enabled: false, Config: rtk.Config{}}
	if stored != nil {
		resp.Enabled = stored.Enabled
		if cfg, ok := stored.Config.(map[string]any); ok {
			// Round-trip through JSON so the typed Config fields (with their
			// json tags and defaults) drive the response shape.
			if raw, mErr := json.Marshal(cfg); mErr == nil {
				if uErr := json.Unmarshal(raw, &resp.Config); uErr != nil {
					logger.Warn("rtk: stored config did not round-trip cleanly: %v", uErr)
				}
			}
		}
	} else if accessor, ok := h.resolver.ResolveRtkPlugin(); ok && accessor != nil {
		// Fall back to the live plugin's existence when the row is missing —
		// the plugin was loaded by built-in defaults rather than by an
		// explicit config entry. Config stays empty (defaults), enabled is
		// reflected so the UI doesn't try to enable a plugin that's already
		// running.
		resp.Enabled = true
		_ = accessor
	}

	// Apply the same defaults the runtime plugin uses (via Init →
	// applyConfigDefaults). The persisted row stores raw zero-value fields
	// (e.g. raw_output_retention=""), and without this the API would return
	// the raw row rather than the effective config — so the UI (and any
	// external consumer) would see "unset" instead of the default "always".
	rtk.ApplyConfigDefaults(&resp.Config)
	// Mirror the plugin-level Enabled into config.Enabled so the API never
	// reports the two flags out of sync. The plugin-level Enabled is the
	// single source of truth (the framework removes disabled plugins from
	// the pipeline entirely; loadBuiltinPlugin forces rtkConfig.Enabled=true
	// at instantiation so the engine follows the plugin-level switch). The
	// stored config.enabled may legitimately be false on legacy rows that
	// predate this enforcement; surfacing it as false here is what led
	// operators to believe RTK was on (switch reads "enabled") while
	// compression never ran.
	resp.Config.Enabled = resp.Enabled

	SendJSON(ctx, resp)
}

// putConfig replaces the active RTK config. The body shape matches the
// typed rtk.Config (no wrapper envelope); enabled defaults to true.
type PutRtkConfigRequest struct {
	Enabled *bool      `json:"enabled,omitempty"`
	Config  rtk.Config `json:"config"`
}

func (h *RtkHandler) putConfig(ctx *fasthttp.RequestCtx) {
	if h.configStore == nil {
		SendError(ctx, fasthttp.StatusServiceUnavailable, "Config store is not configured; RTK admin endpoints require a config store")
		return
	}

	var req PutRtkConfigRequest
	if err := json.Unmarshal(ctx.PostBody(), &req); err != nil {
		logger.Warn("rtk: failed to unmarshal PUT body: %v", err)
		SendError(ctx, fasthttp.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate the incoming config before writing — same surface as the
	// generic /api/plugins/rtk PUT path, scoped to RTK fields only.
	if err := req.Config.Validate(); err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, fmt.Sprintf("Invalid RTK config: %v", err))
		return
	}

	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	// Mirror the plugin-level Enabled into the inner config so the stored
	// row never carries a divergent value. See getConfig for rationale
	// (single source of truth = plugin-level Enabled; the engine gate in
	// plugins/rtk/hooks.go reads config.Enabled at runtime).
	req.Config.Enabled = enabled

	// Encode the typed config back to a map[string]any so the existing
	// CreatePlugin/UpdatePlugin path can persist it without a bespoke
	// marshaller.
	rawCfg, err := json.Marshal(req.Config)
	if err != nil {
		SendError(ctx, fasthttp.StatusInternalServerError, fmt.Sprintf("Failed to marshal RTK config: %v", err))
		return
	}
	var cfgMap map[string]any
	if uErr := json.Unmarshal(rawCfg, &cfgMap); uErr != nil {
		SendError(ctx, fasthttp.StatusInternalServerError, fmt.Sprintf("Failed to encode RTK config: %v", uErr))
		return
	}

	existing, err := h.configStore.GetPlugin(ctx, h.pluginName)
	switch {
	case errors.Is(err, configstore.ErrNotFound):
		if err := h.configStore.CreatePlugin(ctx, &configstoreTables.TablePlugin{
			Name:     h.pluginName,
			Enabled:  enabled,
			Config:   cfgMap,
			IsCustom: false,
		}); err != nil {
			logger.Error("rtk: failed to create plugin row: %v", err)
			SendError(ctx, fasthttp.StatusInternalServerError, "Failed to persist RTK configuration")
			return
		}
	case err != nil:
		logger.Error("rtk: failed to read existing plugin row: %v", err)
		SendError(ctx, fasthttp.StatusInternalServerError, "Failed to read existing RTK configuration")
		return
	default:
		existing.Config = cfgMap
		existing.Enabled = enabled
		if err := h.configStore.UpdatePlugin(ctx, existing); err != nil {
			logger.Error("rtk: failed to update plugin row: %v", err)
			SendError(ctx, fasthttp.StatusInternalServerError, "Failed to persist RTK configuration")
			return
		}
	}

	// The reload is delegated to the loader. If the loader is not present
	// (no in-memory plugin manager yet) we still return 200 — the next
	// server restart will pick up the row from the config store.
	if loader, ok := h.loader(); ok && loader != nil {
		if err := loader.ReloadRtkPlugin(ctx, h.pluginName, cfgMap); err != nil {
			logger.Error("rtk: persisted config but failed to reload plugin: %v", err)
			SendError(ctx, fasthttp.StatusInternalServerError, "Configuration persisted but plugin reload failed")
			return
		}
	}

	resp := RtkConfigResponse{Enabled: enabled, Config: req.Config}
	SendJSON(ctx, resp)
}

// loader is an internal accessor that returns a reload-capable handle when
// the resolver supports it. Defined as a method so the type assertion does
// not pollute the public RtkPluginResolver interface.
func (h *RtkHandler) loader() (RtkReloader, bool) {
	if r, ok := h.resolver.(RtkReloader); ok {
		return r, true
	}
	return nil, false
}

// RtkReloader is the optional interface implemented by RtkPluginResolver
// when the resolver also owns the plugin reload pipeline. The interface is
// kept separate so other resolver implementations can satisfy just the
// read-only surface (e.g. test stubs).
type RtkReloader interface {
	ReloadRtkPlugin(ctx *fasthttp.RequestCtx, name string, config map[string]any) error
}

// ---------------------------------------------------------------------------
// /api/context/rtk/filters
// ---------------------------------------------------------------------------

// getFilters returns the filter catalog plus the load-time diagnostics.
// Requires the plugin to be loaded — without a live loader there is no
// catalog to expose.
func (h *RtkHandler) getFilters(ctx *fasthttp.RequestCtx) {
	accessor, ok := h.resolver.ResolveRtkPlugin()
	if !ok || accessor == nil {
		SendError(ctx, fasthttp.StatusServiceUnavailable, "RTK plugin is not enabled")
		return
	}
	SendJSON(ctx, accessor.GetFilterCatalog())
}

// getCavemanRules returns the built-in Caveman rule catalog so the RTK
// admin UI can render skip_rules as a multi-select with search, grouping
// and per-rule descriptions. The catalog is package-static, so the
// endpoint is safe to call even before the plugin is fully initialised;
// when the plugin is missing we still return a well-shaped empty catalog
// so the UI can degrade gracefully (the multi-select falls back to its
// text-input path).
func (h *RtkHandler) getCavemanRules(ctx *fasthttp.RequestCtx) {
	accessor, ok := h.resolver.ResolveRtkPlugin()
	if !ok || accessor == nil {
		SendJSON(ctx, rtk.CavemanRuleCatalog{
			Rules:                   []rtk.CavemanRuleCatalogEntry{},
			BuiltInPreservePatterns: []string{},
		})
		return
	}
	SendJSON(ctx, accessor.GetCavemanRuleCatalog())
}

// getRenderers returns the static renderer catalog (detection Types
// mapped to a renderer + a static category label) so the RTK admin UI
// can render disabled_renderers as a multi-select with search, grouping
// and per-renderer descriptions. Mirrors getCavemanRules' degradation:
// when the plugin is missing we still return a well-shaped empty
// catalog so the multi-select falls back to its text-input path.
func (h *RtkHandler) getRenderers(ctx *fasthttp.RequestCtx) {
	accessor, ok := h.resolver.ResolveRtkPlugin()
	if !ok || accessor == nil {
		SendJSON(ctx, rtk.RendererCatalog{
			Renderers: []rtk.RendererCatalogEntry{},
		})
		return
	}
	SendJSON(ctx, accessor.GetRendererCatalog())
}

// ---------------------------------------------------------------------------
// /api/context/rtk/test
// ---------------------------------------------------------------------------

// postTest runs a compression trial against an arbitrary payload. The
// payload is bounded at 1 MiB on the wire to prevent the endpoint being
// used as an amplification surface.
func (h *RtkHandler) postTest(ctx *fasthttp.RequestCtx) {
	accessor, ok := h.resolver.ResolveRtkPlugin()
	if !ok || accessor == nil {
		SendError(ctx, fasthttp.StatusServiceUnavailable, "RTK plugin is not enabled")
		return
	}
	if len(ctx.PostBody()) > 1<<20 {
		SendError(ctx, fasthttp.StatusRequestEntityTooLarge, "test payload exceeds 1 MiB")
		return
	}

	var payload rtk.TestPayload
	if err := json.Unmarshal(ctx.PostBody(), &payload); err != nil {
		logger.Warn("rtk: failed to unmarshal test payload: %v", err)
		SendError(ctx, fasthttp.StatusBadRequest, "Invalid request body")
		return
	}
	if payload.Output == "" {
		SendError(ctx, fasthttp.StatusBadRequest, "output is required")
		return
	}

	SendJSON(ctx, accessor.RunTest(payload))
}

// ---------------------------------------------------------------------------
// /api/context/rtk/raw-output/{id}
// ---------------------------------------------------------------------------

// getRawOutput reads a persisted raw-output file. The {id} path parameter
// is validated against rtk.IsValidRawOutputID before any disk lookup.
//
// Two response shapes share this endpoint:
//
//   - Default (LLM-bound): the body is wrapped with a server-side sentinel
//     prefix (see rtk.WrapRawOutputForHTTP). The compression pipeline
//     recognises the sentinel and bypasses re-compression for messages
//     carrying it, which breaks the raw-output recursion bug (LLM fetches
//     → response gets re-compressed → smaller subset → new marker → fetch
//     again → ...).
//
//   - ?raw=1 (operator/UI): the body is returned verbatim. The ops UI at
//     /workspace/plugins/rtk/raw-output reads through this endpoint and
//     renders the body in a <pre>; sentinel noise would corrupt that
//     view.
func (h *RtkHandler) getRawOutput(ctx *fasthttp.RequestCtx) {
	idValue := ctx.UserValue("id")
	if idValue == nil {
		SendError(ctx, fasthttp.StatusBadRequest, "missing {id} path parameter")
		return
	}
	id, ok := idValue.(string)
	if !ok {
		SendError(ctx, fasthttp.StatusBadRequest, "{id} must be a string")
		return
	}
	if !rtk.IsValidRawOutputID(id) {
		SendError(ctx, fasthttp.StatusBadRequest, "invalid raw-output id (expected 24 lowercase hex characters)")
		return
	}

	accessor, ok := h.resolver.ResolveRtkPlugin()
	if !ok || accessor == nil {
		SendError(ctx, fasthttp.StatusServiceUnavailable, "RTK plugin is not enabled")
		return
	}
	data, found := accessor.ReadRawOutput(id)
	if !found {
		SendError(ctx, fasthttp.StatusNotFound, "raw output not found")
		return
	}

	if string(ctx.QueryArgs().Peek("raw")) == "1" {
		ctx.SetContentType("text/plain; charset=utf-8")
		ctx.SetStatusCode(fasthttp.StatusOK)
		ctx.SetBodyString(data)
		return
	}

	ctx.SetContentType("text/plain; charset=utf-8")
	ctx.SetStatusCode(fasthttp.StatusOK)
	ctx.SetBodyString(rtk.WrapRawOutputForHTTP(data, id, len(data), ""))
}

// ---------------------------------------------------------------------------
// /api/context/rtk/stats
// ---------------------------------------------------------------------------

// rtkStatsResponse is the JSON shape returned by GET /api/context/rtk/stats.
// It pairs the lifetime counters with a pre-computed compression ratio so
// the UI doesn't have to handle the "nothing compressed yet → divide by
// zero" edge case itself.
//
// EngineBreakdown carries the per-engine lifetime view when at least one
// pipeline engine has executed; omitted when empty so the UI can detect
// "no engine activity yet" without inspecting the array length.
type rtkStatsResponse struct {
	Plugin           string                 `json:"plugin"`
	Invocations      uint64                 `json:"invocations"`
	CompressedCount  uint64                 `json:"compressed_count"`
	OriginalTokens   uint64                 `json:"original_tokens"`
	CompressedTokens uint64                 `json:"compressed_tokens"`
	TokensSaved      uint64                 `json:"tokens_saved"`
	CompressionRatio float64                `json:"compression_ratio"`
	EngineBreakdown  []rtk.EngineEngineStat `json:"engine_breakdown,omitempty"`
}

// getStats returns the RTK plugin's process-lifetime compression counters.
// The endpoint is intentionally cheap: the counters are atomic, no locking
// is involved, and a single Load per field runs in a few nanoseconds even
// under heavy request load. Returns a 503 when the plugin is not loaded
// (matches the behaviour of the other RTK admin endpoints).
func (h *RtkHandler) getStats(ctx *fasthttp.RequestCtx) {
	accessor, ok := h.resolver.ResolveRtkPlugin()
	if !ok || accessor == nil {
		SendError(ctx, fasthttp.StatusServiceUnavailable, "RTK plugin is not enabled")
		return
	}
	snap := accessor.Stats()
	SendJSON(ctx, rtkStatsResponse{
		Plugin:           rtk.PluginName,
		Invocations:      snap.Invocations,
		CompressedCount:  snap.CompressedCount,
		OriginalTokens:   snap.OriginalTokens,
		CompressedTokens: snap.CompressedTokens,
		TokensSaved:      snap.TokensSaved,
		CompressionRatio: snap.CompressionRatio,
		EngineBreakdown:  snap.EngineBreakdown,
	})
}

// ---------------------------------------------------------------------------
// /api/context/rtk/stats/histogram
// ---------------------------------------------------------------------------

// rtkStatsHistogramResponse is the response shape for
// GET /api/context/rtk/stats/histogram. It wraps the time-bucketed histogram
// alongside the lifetime totals (same shape as /stats) so the UI can render
// both the time series and the "since startup" figures in one request.
type rtkStatsHistogramResponse struct {
	Plugin            string                   `json:"plugin"`
	Buckets           []rtk.RtkHistogramBucket `json:"buckets"`
	BucketSizeSeconds int64                    `json:"bucket_size_seconds"`
	Totals            rtk.RtkHistogramBucket   `json:"totals"`
	LifetimeTotals    rtk.MetricsSnapshot      `json:"lifetime_totals"`
}

// getStatsHistogram handles GET /api/context/rtk/stats/histogram.
// Query parameters:
//   - start_time (RFC3339Nano) — start of the window (required unless period is set)
//   - end_time   (RFC3339Nano) — end of the window (required unless period is set)
//   - period     (string)      — shorthand like "1h", "7d" (overrides start/end)
//   - bucket_size_seconds (int) — optional; auto-calculated from window duration if omitted
//
// Returns 503 when the RTK plugin is not enabled.
func (h *RtkHandler) getStatsHistogram(ctx *fasthttp.RequestCtx) {
	accessor, ok := h.resolver.ResolveRtkPlugin()
	if !ok || accessor == nil {
		SendError(ctx, fasthttp.StatusServiceUnavailable, "RTK plugin is not enabled")
		return
	}

	var startTime, endTime *time.Time

	if period := string(ctx.QueryArgs().Peek("period")); period != "" {
		if s, e := ResolvePeriod(period); s != nil {
			startTime = s
			endTime = e
		}
	}

	if startTime == nil {
		if s := string(ctx.QueryArgs().Peek("start_time")); s != "" {
			if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
				startTime = &t
			}
		}
	}
	if endTime == nil {
		if e := string(ctx.QueryArgs().Peek("end_time")); e != "" {
			if t, err := time.Parse(time.RFC3339Nano, e); err == nil {
				endTime = &t
			}
		}
	}

	if startTime == nil || endTime == nil {
		SendError(ctx, fasthttp.StatusBadRequest, "start_time and end_time (or period) are required")
		return
	}

	bucketSize := int64(0)
	if bs := string(ctx.QueryArgs().Peek("bucket_size_seconds")); bs != "" {
		if v, err := strconv.ParseInt(bs, 10, 64); err == nil && v > 0 {
			bucketSize = v
		}
	}
	if bucketSize <= 0 {
		bucketSize = calculateBucketSize(startTime, endTime)
	}

	startUnix := startTime.Unix()
	endUnix := endTime.Unix()
	buckets := accessor.Histogram(startUnix, endUnix, bucketSize)
	if buckets == nil {
		buckets = []rtk.RtkHistogramBucket{}
	}

	// Compute totals from the window buckets.
	totals := computeBucketTotals(buckets)

	SendJSON(ctx, rtkStatsHistogramResponse{
		Plugin:            rtk.PluginName,
		Buckets:           buckets,
		BucketSizeSeconds: bucketSize,
		Totals:            totals,
		LifetimeTotals:    accessor.Stats(),
	})
}

// computeBucketTotals aggregates a slice of histogram buckets into a single
// RtkHistogramBucket representing the window totals.
func computeBucketTotals(buckets []rtk.RtkHistogramBucket) rtk.RtkHistogramBucket {
	var t rtk.RtkHistogramBucket
	for _, b := range buckets {
		t.Invocations += b.Invocations
		t.CompressedCount += b.CompressedCount
		t.OriginalTokens += b.OriginalTokens
		t.CompressedTokens += b.CompressedTokens
	}
	if t.OriginalTokens > t.CompressedTokens {
		t.TokensSaved = t.OriginalTokens - t.CompressedTokens
	}
	if t.OriginalTokens > 0 {
		t.CompressionRatio = math.Min(1.0, math.Max(0.0, float64(t.TokensSaved)/float64(t.OriginalTokens)))
	}
	return t
}

// ---------------------------------------------------------------------------
// /api/compression/preview
// ---------------------------------------------------------------------------

// postPreview evaluates a compression strategy against a payload without
// touching runtime state. The mode field is validated to one of the three
// known strategies; an empty body defaults to "rtk".
func (h *RtkHandler) postPreview(ctx *fasthttp.RequestCtx) {
	if len(ctx.PostBody()) > 1<<20 {
		SendError(ctx, fasthttp.StatusRequestEntityTooLarge, "preview payload exceeds 1 MiB")
		return
	}

	var req rtk.PreviewRequest
	if err := json.Unmarshal(ctx.PostBody(), &req); err != nil {
		logger.Warn("rtk: failed to unmarshal preview request: %v", err)
		SendError(ctx, fasthttp.StatusBadRequest, "Invalid request body")
		return
	}
	if req.Mode != "" {
		switch req.Mode {
		case rtk.CompressionModeRTK, rtk.CompressionModeCaveman, rtk.CompressionModeStacked, rtk.CompressionModeOff:
		default:
			SendError(ctx, fasthttp.StatusBadRequest,
				fmt.Sprintf("invalid mode %q (expected rtk | caveman | stacked | off)", req.Mode))
			return
		}
	}

	// Without a live plugin we still serve "off" so the UI can preview
	// the un-compressed baseline without an admin having to enable RTK.
	accessor, ok := h.resolver.ResolveRtkPlugin()
	if !ok || accessor == nil {
		// Force "off" semantics regardless of what the caller asked for so
		// the response accurately reflects that the engine did not run.
		req.Mode = rtk.CompressionModeOff
		SendJSON(ctx, noopPreviewResponse(req))
		return
	}

	SendJSON(ctx, accessor.PreviewCompression(req))
}

// noopPreviewResponse returns a PreviewResponse that reflects the input
// unchanged. Used when the RTK plugin is not loaded — callers still get a
// well-formed response so the UI can render an "off / no plugin" baseline.
func noopPreviewResponse(req rtk.PreviewRequest) rtk.PreviewResponse {
	mode := req.Mode
	if mode == "" {
		mode = rtk.CompressionModeOff
	}
	return rtk.PreviewResponse{
		Mode: mode,
		Result: rtk.TestResult{
			OriginalText:     req.Payload.Output,
			CompressedText:   req.Payload.Output,
			OriginalTokens:   estimateTokens(req.Payload.Output),
			CompressedTokens: estimateTokens(req.Payload.Output),
			Techniques:       []string{},
		},
	}
}

// estimateTokens is a tiny helper that approximates the same heuristic the
// RTK plugin uses (chars/4, with the +1 carry for long text). Keeping a
// local copy avoids importing rtk's unexported estimator through the plugin
// accessor surface.
func estimateTokens(text string) int {
	if text == "" {
		return 0
	}
	tokens := (len(text) + 3) / 4
	if len(text) > 40 {
		tokens++
	}
	return tokens
}
