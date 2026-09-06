package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/fasthttp/router"
	"github.com/pin-gou/celer-route/framework/configstore"
	configstoreTables "github.com/pin-gou/celer-route/framework/configstore/tables"
	rtk "github.com/pin-gou/celer-route/plugins/rtk"
	"github.com/valyala/fasthttp"
	"gorm.io/gorm"
)

// ctxTest is a tiny helper that returns a fresh context.Context for the
// in-memory store methods that require a non-nil context.
func ctxTest() context.Context { return context.Background() }

// stubRtkResolver satisfies RtkPluginResolver for tests. It optionally
// embeds an RtkPluginAccessor implementation so handlers can be exercised
// with and without a loaded plugin.
type stubRtkResolver struct {
	accessor RtkPluginAccessor
	found    bool
	reloads  []string // names passed to ReloadRtkPlugin
	failNext error
}

func (s *stubRtkResolver) ResolveRtkPlugin() (RtkPluginAccessor, bool) {
	if !s.found {
		return nil, false
	}
	return s.accessor, true
}

func (s *stubRtkResolver) ReloadRtkPlugin(_ *fasthttp.RequestCtx, name string, _ map[string]any) error {
	if s.failNext != nil {
		err := s.failNext
		s.failNext = nil
		return err
	}
	s.reloads = append(s.reloads, name)
	return nil
}

// stubRtkAccessor is a deterministic in-memory implementation of
// RtkPluginAccessor used by the handler tests. The RawOutput field is
// returned verbatim by ReadRawOutput so the test can assert on the bytes
// served on the wire.
type stubRtkAccessor struct {
	catalog      rtk.FilterCatalog
	cavemanRules rtk.CavemanRuleCatalog
	rendererCat  rtk.RendererCatalog
	rawOutput    string
	rawFound     bool
	lastTest     rtk.TestPayload
	lastPrev     rtk.PreviewRequest
	stats        rtk.MetricsSnapshot
	statsCalls   int
	histogram    []rtk.RtkHistogramBucket
	histogramReq struct{ start, end, bucketSize int64 }
}

func (s *stubRtkAccessor) GetFilterCatalog() rtk.FilterCatalog           { return s.catalog }
func (s *stubRtkAccessor) GetCavemanRuleCatalog() rtk.CavemanRuleCatalog { return s.cavemanRules }
func (s *stubRtkAccessor) GetRendererCatalog() rtk.RendererCatalog       { return s.rendererCat }
func (s *stubRtkAccessor) RunTest(p rtk.TestPayload) rtk.TestResult {
	s.lastTest = p
	return rtk.TestResult{
		OriginalText: p.Output, CompressedText: "COMPRESSED:" + p.Output,
		OriginalTokens: len(p.Output) / 4, CompressedTokens: len("COMPRESSED:"+p.Output) / 4,
		FilterMatched: "stub", Techniques: []string{"linefilter"},
	}
}
func (s *stubRtkAccessor) PreviewCompression(r rtk.PreviewRequest) rtk.PreviewResponse {
	s.lastPrev = r
	return rtk.PreviewResponse{Mode: r.Mode, Result: rtk.TestResult{
		OriginalText: r.Payload.Output, CompressedText: r.Payload.Output,
		OriginalTokens: len(r.Payload.Output) / 4, CompressedTokens: len(r.Payload.Output) / 4,
	}}
}
func (s *stubRtkAccessor) ReadRawOutput(_ string) (string, bool) { return s.rawOutput, s.rawFound }
func (s *stubRtkAccessor) Stats() rtk.MetricsSnapshot {
	s.statsCalls++
	return s.stats
}
func (s *stubRtkAccessor) Histogram(start, end, bucketSize int64) []rtk.RtkHistogramBucket {
	s.histogramReq.start = start
	s.histogramReq.end = end
	s.histogramReq.bucketSize = bucketSize
	return s.histogram
}

// memoryConfigStore is an in-memory replacement for configstore.ConfigStore
// used by the RTK handler tests. Only the methods RtkHandler calls are
// implemented; everything else returns an error so accidental use is loud.
type memoryConfigStore struct {
	rows map[string]*configstoreTables.TablePlugin
}

func newMemoryConfigStore() *memoryConfigStore {
	return &memoryConfigStore{rows: map[string]*configstoreTables.TablePlugin{}}
}

func (m *memoryConfigStore) GetPlugin(_ context.Context, name string) (*configstoreTables.TablePlugin, error) {
	if row, ok := m.rows[name]; ok {
		return row, nil
	}
	return nil, configstore.ErrNotFound
}

func (m *memoryConfigStore) CreatePlugin(_ context.Context, p *configstoreTables.TablePlugin, _ ...*gorm.DB) error {
	if _, exists := m.rows[p.Name]; exists {
		return errors.New("plugin already exists")
	}
	clone := *p
	m.rows[p.Name] = &clone
	return nil
}

func (m *memoryConfigStore) UpdatePlugin(_ context.Context, p *configstoreTables.TablePlugin, _ ...*gorm.DB) error {
	if _, ok := m.rows[p.Name]; !ok {
		return configstore.ErrNotFound
	}
	clone := *p
	m.rows[p.Name] = &clone
	return nil
}

// newRtkTestServer builds a minimal fasthttp server hosting just the six
// RTK routes. The caller can issue requests via fasthttp.RequestCtx and
// inspect the response directly.
func newRtkTestServer(t *testing.T, cs *memoryConfigStore, resolver *stubRtkResolver) (*router.Router, func()) {
	t.Helper()
	r := router.New()
	h := NewRtkHandler(cs, resolver)
	h.RegisterRoutes(r)
	return r, func() {}
}

// callGET issues a GET request against r at path and returns the body and
// status code.
func callGET(t *testing.T, r *router.Router, path string) (int, []byte) {
	t.Helper()
	ctx := &fasthttp.RequestCtx{}
	ctx.Request.Header.SetMethod(http.MethodGet)
	ctx.Request.SetRequestURI(path)
	r.Handler(ctx)
	return ctx.Response.StatusCode(), ctx.Response.Body()
}

// callPOST issues a POST with the given JSON body.
func callPOST(t *testing.T, r *router.Router, path string, body any) (int, []byte) {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	ctx := &fasthttp.RequestCtx{}
	ctx.Request.Header.SetMethod(http.MethodPost)
	ctx.Request.SetRequestURI(path)
	ctx.Request.SetBody(buf.Bytes())
	ctx.Request.Header.SetContentType("application/json")
	r.Handler(ctx)
	return ctx.Response.StatusCode(), ctx.Response.Body()
}

// callPUT issues a PUT with the given JSON body.
func callPUT(t *testing.T, r *router.Router, path string, body any) (int, []byte) {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode body: %v", err)
		}
	}
	ctx := &fasthttp.RequestCtx{}
	ctx.Request.Header.SetMethod(http.MethodPut)
	ctx.Request.SetRequestURI(path)
	ctx.Request.SetBody(buf.Bytes())
	ctx.Request.Header.SetContentType("application/json")
	r.Handler(ctx)
	return ctx.Response.StatusCode(), ctx.Response.Body()
}

// ---------------------------------------------------------------------------
// GET /api/context/rtk/config
// ---------------------------------------------------------------------------

func TestRtkGetConfigMissingRow(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{accessor: &stubRtkAccessor{}, found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callGET(t, r, "/api/context/rtk/config")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var resp RtkConfigResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if !resp.Enabled {
		t.Error("Enabled should be true when the plugin resolver reports it loaded")
	}
}

func TestRtkGetConfigPresent(t *testing.T) {
	cs := newMemoryConfigStore()
	_ = cs.CreatePlugin(ctxTest(), &configstoreTables.TablePlugin{
		Name:    rtk.PluginName,
		Enabled: true,
		Config:  map[string]any{"intensity": "aggressive", "max_lines_per_result": 80},
	})
	resolver := &stubRtkResolver{found: false}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callGET(t, r, "/api/context/rtk/config")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var resp RtkConfigResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if !resp.Enabled {
		t.Error("Enabled should mirror the persisted row")
	}
	if resp.Config.Intensity != "aggressive" {
		t.Errorf("Intensity = %q, want aggressive", resp.Config.Intensity)
	}
	if resp.Config.MaxLinesPerResult != 80 {
		t.Errorf("MaxLinesPerResult = %d, want 80", resp.Config.MaxLinesPerResult)
	}
}

// ---------------------------------------------------------------------------
// PUT /api/context/rtk/config
// ---------------------------------------------------------------------------

func TestRtkPutConfigCreate(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callPUT(t, r, "/api/context/rtk/config", PutRtkConfigRequest{
		Enabled: ptrBool(true),
		Config:  rtk.Config{Intensity: "aggressive", MaxLinesPerResult: 60},
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	row, err := cs.GetPlugin(ctxTest(), rtk.PluginName)
	if err != nil {
		t.Fatalf("GetPlugin: %v", err)
	}
	if !row.Enabled {
		t.Error("row.Enabled = false, want true")
	}
	if got := resolver.reloads; len(got) != 1 || got[0] != rtk.PluginName {
		t.Errorf("expected one reload call for %q, got %v", rtk.PluginName, got)
	}
}

func TestRtkPutConfigUpdateExisting(t *testing.T) {
	cs := newMemoryConfigStore()
	_ = cs.CreatePlugin(ctxTest(), &configstoreTables.TablePlugin{
		Name:    rtk.PluginName,
		Enabled: true,
		Config:  map[string]any{"intensity": "standard"},
	})
	resolver := &stubRtkResolver{found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, _ := callPUT(t, r, "/api/context/rtk/config", PutRtkConfigRequest{
		Config: rtk.Config{Intensity: "minimal", MaxCharsPerResult: 8000},
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	row, err := cs.GetPlugin(ctxTest(), rtk.PluginName)
	if err != nil {
		t.Fatalf("GetPlugin: %v", err)
	}
	if row.Config.(map[string]any)["intensity"] != "minimal" {
		t.Errorf("intensity not updated: %v", row.Config)
	}
}

// TestRtkPutConfigPersistsEnabled asserts that PUT /api/context/rtk/config
// round-trips Config.Enabled through to the persisted row. This is the
// regression guard for the production incident where a null config_json
// deserialised to Config{Enabled: false} and silently disabled RTK: the
// handler must keep enabled=true in storage so the Init() zero-detect
// guard never has to recover from a save that drops the field.
func TestRtkPutConfigPersistsEnabled(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callPUT(t, r, "/api/context/rtk/config", PutRtkConfigRequest{
		Enabled: ptrBool(true),
		Config: rtk.Config{
			Enabled:           true,
			Intensity:         "standard",
			MaxLinesPerResult: 120,
		},
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	row, err := cs.GetPlugin(ctxTest(), rtk.PluginName)
	if err != nil {
		t.Fatalf("GetPlugin: %v", err)
	}
	cfgMap, ok := row.Config.(map[string]any)
	if !ok {
		t.Fatalf("row.Config is %T, want map[string]any", row.Config)
	}
	if enabled, ok := cfgMap["enabled"]; !ok || enabled != true {
		t.Errorf("cfgMap[enabled] = %v (present=%v), want true", enabled, ok)
	}

	// A subsequent PUT that explicitly disables the plugin must round-trip
	// the false value, not be silently turned into a zero-default. The
	// zero-detect safeguard in plugins/rtk/config.go only kicks in for
	// the all-zero storage shape — an explicit operator intent of
	// enabled=false is preserved end-to-end.
	status, body = callPUT(t, r, "/api/context/rtk/config", PutRtkConfigRequest{
		Enabled: ptrBool(false),
		Config: rtk.Config{
			Enabled:   false,
			Intensity: "standard",
		},
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	row, err = cs.GetPlugin(ctxTest(), rtk.PluginName)
	if err != nil {
		t.Fatalf("GetPlugin: %v", err)
	}
	cfgMap = row.Config.(map[string]any)
	if enabled, ok := cfgMap["enabled"]; !ok || enabled != false {
		t.Errorf("after disabling, cfgMap[enabled] = %v (present=%v), want false", enabled, ok)
	}
}

func TestRtkPutConfigInvalidIntensity(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callPUT(t, r, "/api/context/rtk/config", PutRtkConfigRequest{
		Config: rtk.Config{Intensity: "bogus"},
	})
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", status, body)
	}
}

// TestRtkGetConfigMirrorsPluginLevelEnabled pins the API contract that
// config.enabled in the response always equals the plugin-level Enabled
// flag. Without this, a stored config row carrying enabled:false (a legacy
// state from before the force-enabled-at-instantiation fix) is reported
// as "off" in the UI even when the runtime plugin-level switch is on —
// the exact trap that led to the empty RTK column on /workspace/logs.
func TestRtkGetConfigMirrorsPluginLevelEnabled(t *testing.T) {
	cs := newMemoryConfigStore()
	// Legacy row: plugin-level enabled (master switch) is true, but the
	// inner config still carries enabled:false from an older save where
	// the UI form's payload omitted the field.
	_ = cs.CreatePlugin(ctxTest(), &configstoreTables.TablePlugin{
		Name:    rtk.PluginName,
		Enabled: true,
		Config: map[string]any{
			"enabled":              false,
			"intensity":            "standard",
			"max_lines_per_result": 120,
		},
	})
	resolver := &stubRtkResolver{found: false}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callGET(t, r, "/api/context/rtk/config")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var resp RtkConfigResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if !resp.Enabled {
		t.Error("resp.Enabled = false, want true (plugin-level master switch)")
	}
	if !resp.Config.Enabled {
		t.Errorf("resp.Config.Enabled = false, want true (must mirror plugin-level Enabled); body=%s", body)
	}
	// Sanity: the user's other tunables survive the round-trip.
	if resp.Config.Intensity != "standard" {
		t.Errorf("Intensity = %q, want standard", resp.Config.Intensity)
	}
	if resp.Config.MaxLinesPerResult != 120 {
		t.Errorf("MaxLinesPerResult = %d, want 120", resp.Config.MaxLinesPerResult)
	}
}

// TestRtkPutConfigMirrorsPluginLevelEnabled pins the write contract: when
// the operator turns the master switch on (Enabled=true) but submits a
// config payload that still says enabled:false (e.g. a stale UI snapshot),
// the persisted row's inner config.enabled must be forced to true so the
// stored row is self-consistent. See getConfig comment for the same
// single-source-of-truth rationale.
func TestRtkPutConfigMirrorsPluginLevelEnabled(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callPUT(t, r, "/api/context/rtk/config", PutRtkConfigRequest{
		Enabled: ptrBool(true),
		Config: rtk.Config{
			Enabled:           false, // stale payload
			Intensity:         "standard",
			MaxLinesPerResult: 120,
		},
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	row, err := cs.GetPlugin(ctxTest(), rtk.PluginName)
	if err != nil {
		t.Fatalf("GetPlugin: %v", err)
	}
	if !row.Enabled {
		t.Error("row.Enabled = false, want true")
	}
	cfgMap, ok := row.Config.(map[string]any)
	if !ok {
		t.Fatalf("row.Config is %T, want map[string]any", row.Config)
	}
	if enabled, ok := cfgMap["enabled"]; !ok || enabled != true {
		t.Errorf("cfgMap[enabled] = %v (present=%v), want true (must mirror plugin-level Enabled)", enabled, ok)
	}
}

// TestRtkPutConfigMirrorsPluginLevelDisabledOnDisable confirms the inverse:
// turning the master switch off (Enabled=false) persists enabled:false in
// the inner config too. Symmetric with the on-case above.
func TestRtkPutConfigMirrorsPluginLevelDisabledOnDisable(t *testing.T) {
	cs := newMemoryConfigStore()
	_ = cs.CreatePlugin(ctxTest(), &configstoreTables.TablePlugin{
		Name:    rtk.PluginName,
		Enabled: true,
		Config:  map[string]any{"enabled": true, "intensity": "standard"},
	})
	resolver := &stubRtkResolver{found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callPUT(t, r, "/api/context/rtk/config", PutRtkConfigRequest{
		Enabled: ptrBool(false),
		Config: rtk.Config{
			Enabled:   true, // stale payload from a previous "on" state
			Intensity: "standard",
		},
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	row, err := cs.GetPlugin(ctxTest(), rtk.PluginName)
	if err != nil {
		t.Fatalf("GetPlugin: %v", err)
	}
	if row.Enabled {
		t.Error("row.Enabled = true, want false")
	}
	cfgMap := row.Config.(map[string]any)
	if enabled, ok := cfgMap["enabled"]; !ok || enabled != false {
		t.Errorf("after disable, cfgMap[enabled] = %v (present=%v), want false", enabled, ok)
	}
}

// ---------------------------------------------------------------------------
// GET /api/context/rtk/filters
// ---------------------------------------------------------------------------

func TestRtkGetFiltersRequiresLoadedPlugin(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{found: false}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, _ := callGET(t, r, "/api/context/rtk/filters")
	if status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", status)
	}
}

func TestRtkGetFiltersReturnsCatalog(t *testing.T) {
	cs := newMemoryConfigStore()
	accessor := &stubRtkAccessor{
		catalog: rtk.FilterCatalog{
			Filters: []rtk.FilterCatalogEntry{
				{ID: "git-status", Label: "git-status", Source: "builtin", Priority: 50, TestsCount: 1},
			},
			Counters: map[string]int{"builtin": 1, "total": 1},
		},
	}
	resolver := &stubRtkResolver{accessor: accessor, found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callGET(t, r, "/api/context/rtk/filters")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var cat rtk.FilterCatalog
	if err := json.Unmarshal(body, &cat); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if len(cat.Filters) != 1 {
		t.Fatalf("len(Filters) = %d, want 1", len(cat.Filters))
	}
	if cat.Filters[0].ID != "git-status" {
		t.Errorf("Filters[0].ID = %q, want git-status", cat.Filters[0].ID)
	}
	if cat.Counters["builtin"] != 1 {
		t.Errorf("Counters.builtin = %d, want 1", cat.Counters["builtin"])
	}
}

// ---------------------------------------------------------------------------
// POST /api/context/rtk/test
// ---------------------------------------------------------------------------

func TestRtkTestPayload(t *testing.T) {
	cs := newMemoryConfigStore()
	accessor := &stubRtkAccessor{}
	resolver := &stubRtkResolver{accessor: accessor, found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callPOST(t, r, "/api/context/rtk/test", rtk.TestPayload{
		Command: "git status",
		Output:  "On branch main",
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var res rtk.TestResult
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if res.FilterMatched != "stub" {
		t.Errorf("FilterMatched = %q, want stub", res.FilterMatched)
	}
	if accessor.lastTest.Command != "git status" {
		t.Errorf("resolver lastTest.Command = %q", accessor.lastTest.Command)
	}
}

func TestRtkTestEmptyPayloadRejected(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{accessor: &stubRtkAccessor{}, found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, _ := callPOST(t, r, "/api/context/rtk/test", rtk.TestPayload{Output: ""})
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", status)
	}
}

func TestRtkTestRequiresLoadedPlugin(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{found: false}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, _ := callPOST(t, r, "/api/context/rtk/test", rtk.TestPayload{Output: "x"})
	if status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", status)
	}
}

// ---------------------------------------------------------------------------
// GET /api/context/rtk/raw-output/{id}
// ---------------------------------------------------------------------------

func TestRtkRawOutput(t *testing.T) {
	cs := newMemoryConfigStore()
	accessor := &stubRtkAccessor{rawOutput: "hello raw", rawFound: true}
	resolver := &stubRtkResolver{accessor: accessor, found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callGET(t, r, "/api/context/rtk/raw-output/0123456789abcdef01234567")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	// Default response is wrapped with the server-side sentinel so the
	// compression pipeline can detect (and bypass) recovered bodies. The
	// persisted text must still be present after the sentinel prefix.
	if !strings.Contains(string(body), "hello raw") {
		t.Errorf("body = %q, want it to contain 'hello raw'", body)
	}
	if !strings.HasPrefix(string(body), "\x00RTK_RAW_OUTPUT_BEGIN\x00") {
		t.Errorf("body = %q, want it to start with the raw-output sentinel", body)
	}
}

// TestRtkRawOutputRawQuery bypasses the sentinel and returns the verbatim
// file body. Used by the ops UI (/workspace/plugins/rtk/raw-output) which
// renders the body in a <pre> and would otherwise see sentinel noise.
func TestRtkRawOutputRawQuery(t *testing.T) {
	cs := newMemoryConfigStore()
	accessor := &stubRtkAccessor{rawOutput: "hello raw", rawFound: true}
	resolver := &stubRtkResolver{accessor: accessor, found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callGET(t, r, "/api/context/rtk/raw-output/0123456789abcdef01234567?raw=1")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	if string(body) != "hello raw" {
		t.Errorf("body = %q, want %q (verbatim file body, no sentinel)", body, "hello raw")
	}
}

func TestRtkRawOutputBadID(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{accessor: &stubRtkAccessor{}, found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, _ := callGET(t, r, "/api/context/rtk/raw-output/not-hex")
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", status)
	}
}

func TestRtkRawOutputNotFound(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{accessor: &stubRtkAccessor{rawFound: false}, found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, _ := callGET(t, r, "/api/context/rtk/raw-output/0123456789abcdef01234567")
	if status != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", status)
	}
}

// ---------------------------------------------------------------------------
// POST /api/compression/preview
// ---------------------------------------------------------------------------

func TestRtkPreviewOff(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{accessor: &stubRtkAccessor{}, found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callPOST(t, r, "/api/compression/preview", rtk.PreviewRequest{
		Mode:    rtk.CompressionModeOff,
		Payload: rtk.TestPayload{Output: "abc"},
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var resp rtk.PreviewResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if resp.Mode != rtk.CompressionModeOff {
		t.Errorf("Mode = %q, want off", resp.Mode)
	}
}

func TestRtkPreviewInvalidMode(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{accessor: &stubRtkAccessor{}, found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, _ := callPOST(t, r, "/api/compression/preview", rtk.PreviewRequest{
		Mode:    "bogus",
		Payload: rtk.TestPayload{Output: "x"},
	})
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", status)
	}
}

func TestRtkPreviewWithoutLoadedPluginServesOff(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{found: false}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callPOST(t, r, "/api/compression/preview", rtk.PreviewRequest{
		Mode:    rtk.CompressionModeRTK,
		Payload: rtk.TestPayload{Output: "abc"},
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	var resp rtk.PreviewResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if resp.Mode != rtk.CompressionModeOff {
		t.Errorf("Mode = %q, want off (when plugin not loaded)", resp.Mode)
	}
}

// ptr returns a pointer for the given bool — used for optional PUT fields.
// Renamed ptrBool to avoid colliding with the helpers declared in
// providers_test.go that have the same generic name.
func ptrBool[T any](v T) *T { return &v }

// ensure http import is used (decoded via net/http constants)
var _ = io.EOF

// TestRtkHandler_GetStats verifies that GET /api/context/rtk/stats returns
// the accessor-provided MetricsSnapshot wrapped in the JSON envelope. The
// stub returns a known snapshot so the wire shape (camelCase keys,
// derived tokensSaved/compressionRatio already on the server side) can be
// asserted directly.
func TestRtkHandler_GetStats(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{
		found: true,
		accessor: &stubRtkAccessor{
			stats: rtk.MetricsSnapshot{
				Invocations:      42,
				CompressedCount:  17,
				OriginalTokens:   8000,
				CompressedTokens: 2000,
				TokensSaved:      6000,
				CompressionRatio: 0.75,
				EngineBreakdown: []rtk.EngineEngineStat{
					{ID: "caveman", Invocations: 5, InputBytes: 800, OutputBytes: 300, CompressedBy: 0.625},
					{ID: "rtk", Invocations: 20, InputBytes: 4000, OutputBytes: 1200, CompressedBy: 0.7},
				},
			},
		},
	}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callGET(t, r, "/api/context/rtk/stats")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, string(body))
	}
	var got struct {
		Plugin           string                 `json:"plugin"`
		Invocations      uint64                 `json:"invocations"`
		CompressedCount  uint64                 `json:"compressed_count"`
		OriginalTokens   uint64                 `json:"original_tokens"`
		CompressedTokens uint64                 `json:"compressed_tokens"`
		TokensSaved      uint64                 `json:"tokens_saved"`
		CompressionRatio float64                `json:"compression_ratio"`
		EngineBreakdown  []rtk.EngineEngineStat `json:"engine_breakdown"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode body: %v; body=%s", err, string(body))
	}
	if got.Plugin != "rtk" {
		t.Errorf("plugin = %q, want rtk", got.Plugin)
	}
	if got.Invocations != 42 || got.CompressedCount != 17 {
		t.Errorf("counters mismatch: invocations=%d compressed_count=%d", got.Invocations, got.CompressedCount)
	}
	if got.TokensSaved != 6000 || got.CompressionRatio != 0.75 {
		t.Errorf("derived fields mismatch: saved=%d ratio=%f", got.TokensSaved, got.CompressionRatio)
	}
	if len(got.EngineBreakdown) != 2 {
		t.Fatalf("engine_breakdown len = %d, want 2", len(got.EngineBreakdown))
	}
	if got.EngineBreakdown[0].ID != "caveman" || got.EngineBreakdown[0].Invocations != 5 {
		t.Errorf("engine_breakdown[0] = %+v, want caveman with 5 invocations", got.EngineBreakdown[0])
	}
	if got.EngineBreakdown[1].ID != "rtk" || got.EngineBreakdown[1].CompressedBy != 0.7 {
		t.Errorf("engine_breakdown[1] = %+v, want rtk with ratio 0.7", got.EngineBreakdown[1])
	}

	if acc := resolver.accessor.(*stubRtkAccessor); acc.statsCalls != 1 {
		t.Errorf("Stats() should be called exactly once per request, got %d", acc.statsCalls)
	}
}

// TestRtkHandler_GetStats_OmitsEngineBreakdownWhenEmpty verifies that an
// idle plugin (no pipeline runs yet) suppresses the engine_breakdown field
// from the wire response. The UI relies on the absence of the key (rather
// than an empty array) to detect "no engine activity yet".
func TestRtkHandler_GetStats_OmitsEngineBreakdownWhenEmpty(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{
		found: true,
		accessor: &stubRtkAccessor{
			stats: rtk.MetricsSnapshot{
				Invocations:     3,
				CompressedCount: 0,
			},
		},
	}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callGET(t, r, "/api/context/rtk/stats")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, string(body))
	}
	if strings.Contains(string(body), "engine_breakdown") {
		t.Errorf("engine_breakdown must be omitted when empty, got body=%s", string(body))
	}
}

// TestRtkHandler_GetStats_PluginNotLoaded ensures the handler mirrors the
// other RTK admin endpoints: a 503 when ResolveRtkPlugin returns false.
func TestRtkHandler_GetStats_PluginNotLoaded(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{found: false}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callGET(t, r, "/api/context/rtk/stats")
	if status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", status, string(body))
	}
}

// TestRtkHandler_GetStatsHistogram checks that the histogram endpoint returns
// the accessor's buckets, the derived window totals, and the lifetime totals
// in a single response. It also verifies the bucket_size_seconds is honoured
// when explicitly provided.
func TestRtkHandler_GetStatsHistogram(t *testing.T) {
	cs := newMemoryConfigStore()
	buckets := []rtk.RtkHistogramBucket{
		{Timestamp: 1600000000, Invocations: 2, CompressedCount: 2, OriginalTokens: 3000, CompressedTokens: 900, TokensSaved: 2100, CompressionRatio: 0.7},
		{Timestamp: 1600003600, Invocations: 1, CompressedCount: 0, OriginalTokens: 0, CompressedTokens: 0, TokensSaved: 0, CompressionRatio: 0},
	}
	resolver := &stubRtkResolver{
		found: true,
		accessor: &stubRtkAccessor{
			stats: rtk.MetricsSnapshot{
				Invocations:      99,
				CompressedCount:  80,
				OriginalTokens:   90000,
				CompressedTokens: 27000,
				TokensSaved:      63000,
				CompressionRatio: 0.7,
			},
			histogram: buckets,
		},
	}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callGET(t, r, "/api/context/rtk/stats/histogram?start_time=2020-09-13T12:26:40Z&end_time=2020-09-13T14:26:40Z&bucket_size_seconds=3600")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, string(body))
	}

	var got struct {
		Plugin            string                   `json:"plugin"`
		Buckets           []rtk.RtkHistogramBucket `json:"buckets"`
		BucketSizeSeconds int64                    `json:"bucket_size_seconds"`
		Totals            rtk.RtkHistogramBucket   `json:"totals"`
		LifetimeTotals    rtk.MetricsSnapshot      `json:"lifetime_totals"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode body: %v; body=%s", err, string(body))
	}
	if got.Plugin != "rtk" {
		t.Errorf("plugin = %q, want rtk", got.Plugin)
	}
	if got.BucketSizeSeconds != 3600 {
		t.Errorf("bucket_size_seconds = %d, want 3600", got.BucketSizeSeconds)
	}
	if len(got.Buckets) != 2 {
		t.Fatalf("buckets length = %d, want 2; body=%s", len(got.Buckets), string(body))
	}
	if got.Buckets[0].Timestamp != 1600000000 || got.Buckets[1].Timestamp != 1600003600 {
		t.Errorf("bucket timestamps not preserved: %+v", got.Buckets)
	}
	if got.Totals.Invocations != 3 || got.Totals.CompressedCount != 2 {
		t.Errorf("totals Invocations/Compressed = %d/%d, want 3/2", got.Totals.Invocations, got.Totals.CompressedCount)
	}
	if got.Totals.OriginalTokens != 3000 || got.Totals.TokensSaved != 2100 {
		t.Errorf("totals Original/Saved = %d/%d, want 3000/2100", got.Totals.OriginalTokens, got.Totals.TokensSaved)
	}
	if got.LifetimeTotals.Invocations != 99 {
		t.Errorf("lifetime Invocations = %d, want 99", got.LifetimeTotals.Invocations)
	}

	acc := resolver.accessor.(*stubRtkAccessor)
	if acc.histogramReq.start != 1600000000 || acc.histogramReq.end != 1600007200 || acc.histogramReq.bucketSize != 3600 {
		t.Errorf("accessor.Histogram() args = (%d, %d, %d), want (1600000000, 1600007200, 3600)",
			acc.histogramReq.start, acc.histogramReq.end, acc.histogramReq.bucketSize)
	}
}

// TestRtkHandler_GetStatsHistogram_MissingTimeRange ensures a 400 is returned
// when neither explicit start/end nor a period is supplied.
func TestRtkHandler_GetStatsHistogram_MissingTimeRange(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{found: true, accessor: &stubRtkAccessor{}}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, _ := callGET(t, r, "/api/context/rtk/stats/histogram")
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", status)
	}
}

// TestRtkHandler_GetStatsHistogram_Period verifies the period shorthand
// resolves into a concrete window (the accessor receives a non-zero window).
func TestRtkHandler_GetStatsHistogram_Period(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{
		found: true,
		accessor: &stubRtkAccessor{
			stats:     rtk.MetricsSnapshot{Invocations: 5},
			histogram: []rtk.RtkHistogramBucket{},
		},
	}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callGET(t, r, "/api/context/rtk/stats/histogram?period=1h")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, string(body))
	}
	var got struct {
		Buckets           []rtk.RtkHistogramBucket `json:"buckets"`
		BucketSizeSeconds int64                    `json:"bucket_size_seconds"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	// An empty bucket list must still be marshalled as [] (not null).
	if got.Buckets == nil {
		t.Errorf("buckets = nil, want []")
	}
	if got.BucketSizeSeconds <= 0 {
		t.Errorf("bucket_size_seconds = %d, want auto-calculated > 0", got.BucketSizeSeconds)
	}
	if acc := resolver.accessor.(*stubRtkAccessor); acc.histogramReq.start >= acc.histogramReq.end {
		t.Errorf("period did not resolve into start < end window: (%d, %d)", acc.histogramReq.start, acc.histogramReq.end)
	}
}

// TestRtkHandler_GetStatsHistogram_PluginNotLoaded mirrors the /stats 503
// contract for the histogram endpoint.
func TestRtkHandler_GetStatsHistogram_PluginNotLoaded(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{found: false}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, _ := callGET(t, r, "/api/context/rtk/stats/histogram?start_time=2020-09-13T12:26:40Z&end_time=2020-09-13T14:26:40Z")
	if status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", status)
	}
}

// ---------------------------------------------------------------------------
// GET /api/context/rtk/caveman/rules
// ---------------------------------------------------------------------------

func TestRtkGetCavemanRules_LoadedPlugin(t *testing.T) {
	cs := newMemoryConfigStore()
	accessor := &stubRtkAccessor{
		cavemanRules: rtk.CavemanRuleCatalog{
			Rules: []rtk.CavemanRuleCatalogEntry{
				{Name: "pleasantries", Label: "Strip conversational openers.", Category: "filler", Context: "all", Language: "en", MinIntensity: "lite"},
				{Name: "articles", Label: "Drop a/an/the.", Category: "terse", Context: "all", Language: "en", MinIntensity: "full"},
				{Name: "zh_filler_please", Label: "Strip Chinese 请…", Category: "filler", Context: "user", Language: "zh", MinIntensity: "lite"},
			},
			BuiltInPreservePatterns: []string{"frontmatter", "fenced-code", "url"},
		},
	}
	resolver := &stubRtkResolver{accessor: accessor, found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callGET(t, r, "/api/context/rtk/caveman/rules")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var cat rtk.CavemanRuleCatalog
	if err := json.Unmarshal(body, &cat); err != nil {
		t.Fatalf("decode body: %v; body=%s", err, body)
	}
	if len(cat.Rules) != 3 {
		t.Fatalf("len(Rules) = %d, want 3", len(cat.Rules))
	}
	if cat.Rules[0].Name != "pleasantries" {
		t.Errorf("Rules[0].Name = %q, want pleasantries", cat.Rules[0].Name)
	}
	if cat.Rules[2].Language != "zh" {
		t.Errorf("Rules[2].Language = %q, want zh", cat.Rules[2].Language)
	}
	if len(cat.BuiltInPreservePatterns) != 3 {
		t.Fatalf("len(BuiltInPreservePatterns) = %d, want 3", len(cat.BuiltInPreservePatterns))
	}
	if cat.BuiltInPreservePatterns[0] != "frontmatter" {
		t.Errorf("BuiltInPreservePatterns[0] = %q, want frontmatter", cat.BuiltInPreservePatterns[0])
	}
}

func TestRtkGetCavemanRules_PluginNotLoaded_ReturnsEmpty(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{found: false}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callGET(t, r, "/api/context/rtk/caveman/rules")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var cat rtk.CavemanRuleCatalog
	if err := json.Unmarshal(body, &cat); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	// Empty catalog (well-shaped, not null) so the UI can degrade gracefully.
	if cat.Rules == nil {
		t.Error("Rules should be a non-nil empty slice, not null")
	}
	if len(cat.Rules) != 0 {
		t.Errorf("len(Rules) = %d, want 0", len(cat.Rules))
	}
	if cat.BuiltInPreservePatterns == nil {
		t.Error("BuiltInPreservePatterns should be a non-nil empty slice, not null")
	}
	if strings.Contains(string(body), "null") {
		t.Errorf("body must not contain 'null' for any field; got %s", string(body))
	}
}

// ---------------------------------------------------------------------------
// GET /api/context/rtk/renderers
// ---------------------------------------------------------------------------

func TestRtkGetRenderers_LoadedPlugin(t *testing.T) {
	cs := newMemoryConfigStore()
	accessor := &stubRtkAccessor{
		rendererCat: rtk.RendererCatalog{
			Renderers: []rtk.RendererCatalogEntry{
				{Name: "git-diff", Category: "git"},
				{Name: "test-pytest", Category: "test"},
				{Name: "aws", Category: "structured"},
			},
		},
	}
	resolver := &stubRtkResolver{accessor: accessor, found: true}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callGET(t, r, "/api/context/rtk/renderers")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var cat rtk.RendererCatalog
	if err := json.Unmarshal(body, &cat); err != nil {
		t.Fatalf("decode body: %v; body=%s", err, body)
	}
	if len(cat.Renderers) != 3 {
		t.Fatalf("len(Renderers) = %d, want 3", len(cat.Renderers))
	}
	if cat.Renderers[0].Name != "git-diff" || cat.Renderers[0].Category != "git" {
		t.Errorf("Renderers[0] = %+v, want {git-diff, git}", cat.Renderers[0])
	}
}

func TestRtkGetRenderers_PluginNotLoaded_ReturnsEmpty(t *testing.T) {
	cs := newMemoryConfigStore()
	resolver := &stubRtkResolver{found: false}
	r, _ := newRtkTestServer(t, cs, resolver)

	status, body := callGET(t, r, "/api/context/rtk/renderers")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var cat rtk.RendererCatalog
	if err := json.Unmarshal(body, &cat); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if cat.Renderers == nil {
		t.Error("Renderers should be a non-nil empty slice, not null")
	}
	if len(cat.Renderers) != 0 {
		t.Errorf("len(Renderers) = %d, want 0", len(cat.Renderers))
	}
}
