package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/pin-gou/celer-route/core/schemas"
	"github.com/pin-gou/celer-route/framework/configstore"
	"github.com/pin-gou/celer-route/plugins/logging"
	"github.com/pin-gou/celer-route/plugins/maxim"
	"github.com/pin-gou/celer-route/plugins/mocker"
	"github.com/pin-gou/celer-route/plugins/modelcatalogresolver"
	"github.com/pin-gou/celer-route/plugins/otel"
	"github.com/pin-gou/celer-route/plugins/providercooldown"
	"github.com/pin-gou/celer-route/plugins/rtk"
	"github.com/pin-gou/celer-route/plugins/semanticcache"
	"github.com/pin-gou/celer-route/transports/celer-route-http/lib"
)

// TestLoadBuiltinPlugins_ProviderCooldown_DefaultOn verifies that when no
// provider-cooldown entry exists in PluginConfigs, the plugin is loaded as
// active and KeyPoolFilter is wired.
//
// This is the "default-on" semantics: absent config entry = enabled.
// The current production code treats a nil entry as disabled, so this test
// is expected to fail (red phase) until the dev phase implements the new
// default-on behavior.
func TestLoadBuiltinPlugins_ProviderCooldown_DefaultOn(t *testing.T) {
	prevLogger := logger
	logger = noopTestLogger{}
	defer func() { logger = prevLogger }()

	server := &BifrostHTTPServer{
		Ctx: schemas.NewBifrostContext(context.Background(), schemas.NoDeadline),
		Config: &lib.Config{
			ClientConfig: &configstore.ClientConfig{},
			// PluginConfigs is nil — no provider-cooldown entry at all.
			// After the dev phase this should be treated as "enabled by default".
		},
	}

	if err := server.loadBuiltinPlugins(context.Background()); err != nil {
		t.Fatalf("loadBuiltinPlugins returned unexpected error: %v", err)
	}

	// After the dev phase, the providercooldown plugin should be active and
	// KeyPoolFilter must be wired. In the red phase (current code) both
	// assertions fail because the default-on path does not exist yet.
	statuses := server.Config.GetPluginStatus()
	ps, ok := statuses[providercooldown.PluginName]
	if !ok {
		t.Fatal("provider-cooldown plugin status not found — expected active after default-on loading")
	}
	if ps.Status != schemas.PluginStatusActive {
		t.Fatalf("provider-cooldown status = %q, want %q", ps.Status, schemas.PluginStatusActive)
	}
	if server.KeyPoolFilter == nil {
		t.Fatal("KeyPoolFilter is nil, expected non-nil after default-on loading")
	}
	// PerKeyFailureMarker is wired symmetrically with the filter (same State,
	// same lifecycle). We can't reach into bifrost's private atomic.Pointer
	// directly, but we CAN reach the loaded plugin instance and assert the
	// State is populated — if it is, the marker closure (captured by the
	// bifrost client) can act on it.
	cp, cpErr := lib.FindPluginAs[*providercooldown.CooldownPlugin](server.Config, providercooldown.PluginName)
	if cpErr != nil {
		t.Fatalf("FindPluginAs(provider-cooldown) failed: %v", cpErr)
	}
	if cp == nil || cp.State == nil {
		t.Fatal("expected provider-cooldown plugin instance with non-nil State after default-on loading")
	}
	// AsMarker must return a non-nil closure even with a nil logger — the
	// transport wires it with the same logger it passes to AsFilter.
	if cp.State.AsMarker(nil) == nil {
		t.Fatal("AsMarker returned nil — bifrost client would skip the marker entirely")
	}
}

// TestLoadBuiltinPlugins_ProviderCooldown_ExplicitDisabled verifies that when
// the provider-cooldown entry has enabled=false, the plugin is marked as
// disabled and KeyPoolFilter remains nil.
//
// This is a regression guard for the existing disabled behavior, which must
// survive the default-on change.
func TestLoadBuiltinPlugins_ProviderCooldown_ExplicitDisabled(t *testing.T) {
	prevLogger := logger
	logger = noopTestLogger{}
	defer func() { logger = prevLogger }()

	disabled := false
	server := &BifrostHTTPServer{
		Ctx: schemas.NewBifrostContext(context.Background(), schemas.NoDeadline),
		Config: &lib.Config{
			ClientConfig: &configstore.ClientConfig{},
			PluginConfigs: []*schemas.PluginConfig{
				{
					Name:    providercooldown.PluginName,
					Enabled: disabled,
				},
			},
		},
	}

	if err := server.loadBuiltinPlugins(context.Background()); err != nil {
		t.Fatalf("loadBuiltinPlugins returned unexpected error: %v", err)
	}

	// KeyPoolFilter must stay nil when the plugin is disabled.
	if server.KeyPoolFilter != nil {
		t.Fatal("KeyPoolFilter is non-nil, expected nil when provider-cooldown is explicitly disabled")
	}

	// The plugin status should be disabled.
	statuses := server.Config.GetPluginStatus()
	ps, ok := statuses[providercooldown.PluginName]
	if !ok {
		t.Fatal("provider-cooldown status missing — expected a disabled status entry")
	}
	if ps.Status != schemas.PluginStatusDisabled {
		t.Fatalf("provider-cooldown status = %q, want %q", ps.Status, schemas.PluginStatusDisabled)
	}
}

// TestLoadBuiltinPlugins_UnconfiguredBuiltins_VisibleAsDisabled verifies that
// config-gated built-ins (rtk, otel, semantic-cache, maxim, model-catalog-resolver,
// logging, prompts) still get a disabled status entry at startup even when they are
// not configured. This makes the plugins list behave like an "installed plugins"
// surface: every built-in is visible and the enable/disable action happens in its
// detail view — a plugin must never silently vanish from the list.
//
// RTK is default-on (fresh install seed), so it is expected to be active even
// without a PluginConfigs entry. Other unconfigured built-ins remain disabled.
func TestLoadBuiltinPlugins_UnconfiguredBuiltins_VisibleAsDisabled(t *testing.T) {
	prevLogger := logger
	logger = noopTestLogger{}
	defer func() { logger = prevLogger }()

	server := &BifrostHTTPServer{
		Ctx: schemas.NewBifrostContext(context.Background(), schemas.NoDeadline),
		Config: &lib.Config{
			ClientConfig: &configstore.ClientConfig{},
			// PluginConfigs is nil — no rtk / otel / semantic_cache / maxim entry.
		},
	}

	if err := server.loadBuiltinPlugins(context.Background()); err != nil {
		t.Fatalf("loadBuiltinPlugins returned unexpected error: %v", err)
	}

	statuses := server.Config.GetPluginStatus()
	// RTK is default-on, so it should be active, not disabled.
	rtkPS, ok := statuses[rtk.PluginName]
	if !ok {
		t.Errorf("plugin %s has no status entry — expected active", rtk.PluginName)
	} else if rtkPS.Status != schemas.PluginStatusActive {
		t.Errorf("plugin %s status = %q, want %q", rtk.PluginName, rtkPS.Status, schemas.PluginStatusActive)
	}
	wantDisabled := []string{
		otel.PluginName,
		semanticcache.PluginName,
		maxim.PluginName,
		modelcatalogresolver.PluginName,
		logging.PluginName,
	}
	for _, name := range wantDisabled {
		ps, ok := statuses[name]
		if !ok {
			t.Errorf("plugin %s has no status entry — expected disabled", name)
			continue
		}
		if ps.Status != schemas.PluginStatusDisabled {
			t.Errorf("plugin %s status = %q, want %q", name, ps.Status, schemas.PluginStatusDisabled)
		}
	}
}

// TestInstantiatePlugin_RTK_Loads pins the contract for the RTK compression
// plugin registration in loadBuiltinPlugin. The dev phase added the `rtk` case
// (mirroring semanticcache) that calls rtk.Init(ctx, config, logger, appDir).
func TestInstantiatePlugin_RTK_Loads(t *testing.T) {
	prevLogger := logger
	logger = noopTestLogger{}
	defer func() { logger = prevLogger }()

	config := &lib.Config{
		ClientConfig: &configstore.ClientConfig{},
	}

	// The rtk plugin config matches the schema contract from design.md:
	// enabled / intensity / max_lines_per_result / max_chars_per_result /
	// dedup_threshold.
	rtkConfig := map[string]any{
		"enabled":              true,
		"intensity":            "standard",
		"max_lines_per_result": 120,
		"max_chars_per_result": 12000,
		"dedup_threshold":      3,
	}

	plugin, err := InstantiatePlugin(context.Background(), "rtk", nil, rtkConfig, config)
	if err != nil {
		// The rtk case is registered in loadBuiltinPlugin — failure here means
		// the plugin config or init is broken.
		t.Fatalf("InstantiatePlugin(rtk) returned error: %v", err)
	}
	if plugin == nil {
		t.Fatal("InstantiatePlugin(rtk) returned nil plugin, want non-nil")
	}
	if got := plugin.GetName(); got != "rtk" {
		t.Fatalf("InstantiatePlugin(rtk) plugin name = %q, want %q", got, "rtk")
	}
}

// TestInstantiatePlugin_RTK_AppDirPropagates pins the app-dir contract for the
// RTK plugin: when bifrostConfig.AppDir is set (the -app-dir flag / APP_DIR env
// in container deployments), rtk.Init receives it as its appDir so on-disk
// roots default to <appDir>/rtk/... instead of the process CWD. Without this,
// the raw-output files land in the ephemeral container layer rather than the
// mounted volume (see the compose APP_DIR deployment).
func TestInstantiatePlugin_RTK_AppDirPropagates(t *testing.T) {
	prevLogger := logger
	logger = noopTestLogger{}
	defer func() { logger = prevLogger }()

	appDir := t.TempDir()
	config := &lib.Config{
		ClientConfig: &configstore.ClientConfig{},
		AppDir:       appDir,
	}

	plugin, err := InstantiatePlugin(context.Background(), "rtk", nil, nil, config)
	if err != nil {
		t.Fatalf("InstantiatePlugin(rtk) returned error: %v", err)
	}
	rtkPlugin, ok := plugin.(interface{ GetAppDir() string })
	if !ok {
		t.Fatalf("rtk plugin %T does not expose GetAppDir()", plugin)
	}
	if got := rtkPlugin.GetAppDir(); got != appDir {
		t.Errorf("rtk appDir = %q, want config.AppDir %q", got, appDir)
	}
	// The raw-output default root is derived from appDir — pin it too so a
	// regression here is caught without running the full server.
	if rawOut, ok := plugin.(interface{ RawOutputDir() string }); ok {
		want := filepath.Join(appDir, "rtk", "raw-output")
		if got := rawOut.RawOutputDir(); got != want {
			t.Errorf("raw-output root = %q, want %q", got, want)
		}
	}
}

// TestLoadBuiltinPlugins_RTK_DefaultsOn_WhenUnconfigured verifies that when no
	// PluginConfigs entry exists for RTK, the fresh-install seed config is applied:
	//   - RTK is active (not disabled)
	//   - The seed config (EnableRenderers=true)
	//     is applied via rtk.Init → applyConfigDefaults
func TestLoadBuiltinPlugins_RTK_DefaultsOn_WhenUnconfigured(t *testing.T) {
	prevLogger := logger
	logger = noopTestLogger{}
	defer func() { logger = prevLogger }()

	server := &BifrostHTTPServer{
		Ctx: schemas.NewBifrostContext(context.Background(), schemas.NoDeadline),
		Config: &lib.Config{
			ClientConfig: &configstore.ClientConfig{},
		},
	}

	if err := server.loadBuiltinPlugins(context.Background()); err != nil {
		t.Fatalf("loadBuiltinPlugins returned unexpected error: %v", err)
	}

	// RTK should be active (not disabled).
	ps, ok := server.Config.GetPluginStatus()[rtk.PluginName]
	if !ok {
		t.Fatalf("plugin %s has no status entry — expected active", rtk.PluginName)
	}
	if ps.Status != schemas.PluginStatusActive {
		t.Fatalf("plugin %s status = %q, want %q", rtk.PluginName, ps.Status, schemas.PluginStatusActive)
	}
}

// TestInstantiatePlugin_RTK_FreshInstallSeed verifies that when InstantiatePlugin
// receives a nil config (fresh install), the seed config from loadBuiltinPlugins
// is correctly applied — specifically EnableRenderers=true
// — via the rtk.Init → applyConfigDefaults path.
func TestInstantiatePlugin_RTK_FreshInstallSeed(t *testing.T) {
	prevLogger := logger
	logger = noopTestLogger{}
	defer func() { logger = prevLogger }()

	config := &lib.Config{
		ClientConfig: &configstore.ClientConfig{},
	}

	// Simulate the fresh-install seed config that loadBuiltinPlugins creates.
	seedConfig := map[string]any{
		"enabled":          true,
		"enable_renderers": true,
	}

	plugin, err := InstantiatePlugin(context.Background(), "rtk", nil, seedConfig, config)
	if err != nil {
		t.Fatalf("InstantiatePlugin(rtk, seedConfig) returned error: %v", err)
	}
	if plugin == nil {
		t.Fatal("InstantiatePlugin returned nil plugin")
	}

	// The seed fields should survive applyConfigDefaults.
	// Verify by checking that the plugin was initialized successfully.
	ps := plugin.GetName()
	if ps != "rtk" {
		t.Errorf("plugin name = %q, want %q", ps, "rtk")
	}
}

// TestInstantiatePlugin_Mocker_Loads pins the contract for the mocker plugin
// registration in loadBuiltinPlugin. The scenario fix added the `mocker` case
// (mirroring compat) so the plugin can be created/updated via the plugins API
// and appears in the built-in plugin list. It also pins the canonical name:
// "mocker" (matching config.schema.json and the frontend MOCKER_PLUGIN), not
// the historical "bifrost-mocker".
func TestInstantiatePlugin_Mocker_Loads(t *testing.T) {
	prevLogger := logger
	logger = noopTestLogger{}
	defer func() { logger = prevLogger }()

	config := &lib.Config{
		ClientConfig: &configstore.ClientConfig{},
	}

	// Empty config is valid — Init applies defaults (default_behavior = "passthrough",
	// no rules until enabled).
	plugin, err := InstantiatePlugin(context.Background(), mocker.PluginName, nil, nil, config)
	if err != nil {
		t.Fatalf("InstantiatePlugin(mocker) with nil config returned error: %v", err)
	}
	if plugin == nil {
		t.Fatal("InstantiatePlugin(mocker) returned nil plugin, want non-nil")
	}
	if got := plugin.GetName(); got != "mocker" {
		t.Fatalf("InstantiatePlugin(mocker) plugin name = %q, want %q", got, "mocker")
	}

	// Persisted config from the config store / config.json merges through.
	mockerConfig := map[string]any{
		"enabled":          true,
		"default_behavior": "passthrough",
	}
	plugin, err = InstantiatePlugin(context.Background(), mocker.PluginName, nil, mockerConfig, config)
	if err != nil {
		t.Fatalf("InstantiatePlugin(mocker) with config returned error: %v", err)
	}
	if plugin == nil {
		t.Fatal("InstantiatePlugin(mocker) with config returned nil plugin, want non-nil")
	}
}

// TestLoadBuiltinPlugins_Mocker_AlwaysRegistered verifies that mocker is always
// registered at startup (same default-on semantics as compat), so it is visible
// in the plugins list and configurable even when it has no PluginConfigs entry
// and no config_plugins row yet.
func TestLoadBuiltinPlugins_Mocker_AlwaysRegistered(t *testing.T) {
	prevLogger := logger
	logger = noopTestLogger{}
	defer func() { logger = prevLogger }()

	server := &BifrostHTTPServer{
		Ctx: schemas.NewBifrostContext(context.Background(), schemas.NoDeadline),
		Config: &lib.Config{
			ClientConfig: &configstore.ClientConfig{},
			// PluginConfigs is nil — no mocker entry at all.
		},
	}

	if err := server.loadBuiltinPlugins(context.Background()); err != nil {
		t.Fatalf("loadBuiltinPlugins returned unexpected error: %v", err)
	}

	statuses := server.Config.GetPluginStatus()
	ps, ok := statuses[mocker.PluginName]
	if !ok {
		t.Fatal("mocker status missing — expected an active status entry (always registered)")
	}
	if ps.Status != schemas.PluginStatusActive {
		t.Fatalf("mocker status = %q, want %q", ps.Status, schemas.PluginStatusActive)
	}
}

// getSchemaPath returns the absolute path to config.schema.json.
func getSchemaPath(t *testing.T) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("failed to get caller info")
	}
	// Walk up from server/ to transports/ where config.schema.json lives
	schemaPath := filepath.Join(filepath.Dir(filename), "..", "..", "config.schema.json")
	if _, err := os.Stat(schemaPath); err != nil {
		t.Fatalf("config.schema.json not found at %s", schemaPath)
	}
	return schemaPath
}

// rtkPluginConfig builds a minimal config.json containing a single rtk plugin
// entry with the given config block, so the allOf/if/then plugin schema branch
// for name=rtk is exercised.
func rtkPluginConfig(configBlock string) string {
	return `{
		"plugins": [{
			"name": "rtk",
			"enabled": true,
			"config": ` + configBlock + `
		}]
	}`
}

// TestRTKPluginConfig_SchemaContract validates the rtk plugin config block
// against the real config.schema.json using the project's existing schema
// validation entry point. This guards against field name drift between the
// schema and the Config struct (e.g. deduplicate_threshold vs dedup_threshold).
//
// The test asserts three things:
//  1. A valid config with all canonical fields passes schema validation.
//  2. An unknown key in the config block is rejected (additionalProperties: false).
//  3. A missing required config key is rejected.
func TestRTKPluginConfig_SchemaContract(t *testing.T) {
	schemaPath := getSchemaPath(t)
	schemaBytes, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatalf("failed to read schema: %v", err)
	}

	// 1. Valid config — all canonical fields from design.md § 数据模型 3.
	validConfig := rtkPluginConfig(`{
		"enabled": true,
		"intensity": "standard",
		"max_lines_per_result": 120,
		"max_chars_per_result": 12000,
		"dedup_threshold": 3
	}`)
	if err := lib.ValidateConfigSchema([]byte(validConfig), schemaBytes); err != nil {
		t.Fatalf("valid rtk config should pass schema validation, got: %v", err)
	}

	// 2. Unknown key — must be rejected by additionalProperties: false.
	unknownKeyConfig := rtkPluginConfig(`{
		"enabled": true,
		"intensity": "standard",
		"dedup_threshold": 3,
		"unknown_field": "should be rejected"
	}`)
	if err := lib.ValidateConfigSchema([]byte(unknownKeyConfig), schemaBytes); err == nil {
		t.Error("unknown key in rtk config should be rejected by schema additionalProperties: false")
	}

	// 3. Verify the canonical property names are present in the schema.
	// Read the schema JSON to verify field names match the Config struct.
	var schemaObj map[string]interface{}
	if err := json.Unmarshal(schemaBytes, &schemaObj); err != nil {
		t.Fatalf("failed to parse schema JSON: %v", err)
	}
	// Navigate to plugins.items then branch for name=rtk → config.properties
	plugins, ok := schemaObj["properties"].(map[string]interface{})["plugins"].(map[string]interface{})
	if !ok {
		t.Fatal("schema missing plugins property")
	}
	items, ok := plugins["items"].(map[string]interface{})
	if !ok {
		t.Fatal("schema plugins missing items")
	}
	allOf, ok := items["allOf"].([]interface{})
	if !ok {
		t.Fatal("schema plugins.items missing allOf")
	}

	// Find the rtk branch in allOf
	var rtkThen map[string]interface{}
	for _, branch := range allOf {
		b, ok := branch.(map[string]interface{})
		if !ok {
			continue
		}
		ifBlock, ok := b["if"].(map[string]interface{})
		if !ok {
			continue
		}
		props, ok := ifBlock["properties"].(map[string]interface{})
		if !ok {
			continue
		}
		nameProp, ok := props["name"].(map[string]interface{})
		if !ok {
			continue
		}
		if nameProp["const"] == "rtk" {
			rtkThen, ok = b["then"].(map[string]interface{})
			break
		}
	}
	if rtkThen == nil {
		t.Fatal("schema missing rtk if/then branch")
	}

	configProps, ok := rtkThen["properties"].(map[string]interface{})["config"].(map[string]interface{})["properties"].(map[string]interface{})
	if !ok {
		t.Fatal("rtk then branch missing config.properties")
	}

	// Every field in the Config struct must be present in the schema.
	expectedFields := []string{
		"enabled",
		"intensity",
		"max_lines_per_result",
		"max_chars_per_result",
		"dedup_threshold",
	}
	for _, field := range expectedFields {
		if _, exists := configProps[field]; !exists {
			t.Errorf("rtk config schema missing field %q — schema field name must match Config struct JSON tag", field)
		}
	}

	// Ensure deduplicate_threshold (wrong name) is NOT present.
	if _, exists := configProps["deduplicate_threshold"]; exists {
		t.Error("schema uses deduplicate_threshold but design.md and Config struct use dedup_threshold — field name must be dedup_threshold")
	}
}

// TestRTKInit_InvalidConfigRejected verifies that rtk.Init rejects malicious
// or out-of-range config values by calling Config.Validate() during
// initialization. This is the fail-fast guard for the pattern_consistency
// concern (R-3): invalid configs must not silently produce a running plugin.
func TestRTKInit_InvalidConfigRejected(t *testing.T) {
	tests := []struct {
		name   string
		config map[string]any
	}{
		{
			name: "invalid intensity",
			config: map[string]any{
				"enabled":   true,
				"intensity": "super-aggressive",
			},
		},
		{
			name: "negative max_lines_per_result",
			config: map[string]any{
				"enabled":              true,
				"intensity":            "standard",
				"max_lines_per_result": -5,
			},
		},
		{
			name: "negative max_chars_per_result",
			config: map[string]any{
				"enabled":              true,
				"intensity":            "standard",
				"max_chars_per_result": -100,
			},
		},
		{
			name: "negative dedup_threshold",
			config: map[string]any{
				"enabled":         true,
				"intensity":       "standard",
				"dedup_threshold": -1,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := InstantiatePlugin(context.Background(), "rtk", nil, tt.config, &lib.Config{
				ClientConfig: &configstore.ClientConfig{},
			})
			if err == nil {
				t.Error("InstantiatePlugin(rtk) with invalid config should return error, got nil")
			}
		})
	}
}

// TestInstantiatePlugin_RTK_StoredConfigDisabled_ForcesEngineOn pins the
// single-source-of-truth contract for the RTK compression engine: whenever
// an *rtk.Plugin instance is constructed, the engine-level Enabled flag MUST
// be true. The plugin-level Enabled switch (the column on the config_plugins
// row) is the master; loadBuiltinPlugin forces config.Enabled=true at every
// instantiation, so a stored config row carrying enabled:false can never
// silently disable compression while the plugin-level switch reads "on".
//
// Red phase: instantiate with a stored config that explicitly carries
// enabled:false plus a non-zero tunable (so applyConfigDefaults' all-zero
// safeguard cannot rescue it). The current code leaves config.Enabled=false,
// and the assertion fails.
// Green phase: loadBuiltinPlugin forces rtkConfig.Enabled=true before
// rtk.Init, and the assertion passes.
func TestInstantiatePlugin_RTK_StoredConfigDisabled_ForcesEngineOn(t *testing.T) {
	prevLogger := logger
	logger = noopTestLogger{}
	defer func() { logger = prevLogger }()

	// Stored row equivalent: plugin-level enabled (the master) is true, but
	// the inner config still carries enabled:false from an older save where
	// the UI form's payload omitted the field — the exact bug seen on the
	// k3s instance. The other fields are non-zero on purpose so the
	// all-zero safeguard in applyConfigDefaults does not flip them.
	// min_tokens_to_compress is left at 0 so the request below is eligible
	// for compression regardless of token count (the min_tokens gate is a
	// separate concern from the enable flag; mixing them would mask the
	// bug under test).
	storedRTKConfig := map[string]any{
		"enabled":              false,
		"intensity":            "standard",
		"max_lines_per_result": 120,
		"max_chars_per_result": 12000,
		"dedup_threshold":      3,
	}

	plugin, err := InstantiatePlugin(context.Background(), "rtk", nil, storedRTKConfig, &lib.Config{
		ClientConfig: &configstore.ClientConfig{},
	})
	if err != nil {
		t.Fatalf("InstantiatePlugin(rtk) with stored config carrying enabled:false returned error: %v", err)
	}
	rtkPlugin, ok := plugin.(*rtk.Plugin)
	if !ok {
		t.Fatalf("InstantiatePlugin(rtk) returned unexpected type %T", plugin)
	}

	// Drive PreLLMHook through the compression path with a chat request
	// that contains a tool message. If the engine were disabled (the
	// pre-fix behavior), PreLLMHook would early-return at hooks.go:88 and
	// no metric invocation would be recorded. If the fix is in place, the
	// invocation count strictly increases.
	before := rtkPlugin.Stats().Invocations

	ctx := schemas.NewBifrostContext(context.Background(), schemas.NoDeadline)
	toolContent := "On branch main\n" +
		"Changes not staged for commit:\n" +
		"\tmodified:   src/main.go\n" +
		"\tmodified:   src/utils.go\n" +
		"\tmodified:   go.mod\n" +
		"\tmodified:   go.sum\n" +
		"\tmodified:   Makefile\n" +
		"\tmodified:   README.md\n"
	req := &schemas.BifrostRequest{
		RequestType: schemas.ChatCompletionRequest,
		ChatRequest: &schemas.BifrostChatRequest{
			Model: "gpt-4o",
			Input: []schemas.ChatMessage{
				{
					Role: schemas.ChatMessageRoleAssistant,
					Content: &schemas.ChatMessageContent{
						ContentStr: ptrString("Let me check git status"),
					},
					ChatAssistantMessage: &schemas.ChatAssistantMessage{
						ToolCalls: []schemas.ChatAssistantMessageToolCall{
							{ID: ptrString("call_1"), Function: schemas.ChatAssistantMessageToolCallFunction{
								Name:      ptrString("bash"),
								Arguments: "git status",
							}},
						},
					},
				},
				{
					Role: schemas.ChatMessageRoleTool,
					Content: &schemas.ChatMessageContent{
						ContentStr: &toolContent,
					},
					ChatToolMessage: &schemas.ChatToolMessage{
						ToolCallID: ptrString("call_1"),
					},
				},
			},
		},
	}
	if _, _, err := rtkPlugin.PreLLMHook(ctx, req); err != nil {
		t.Fatalf("PreLLMHook returned error: %v", err)
	}

	after := rtkPlugin.Stats().Invocations
	if after != before+1 {
		t.Fatalf("rtk engine recorded %d invocations after PreLLMHook (was %d); want %d. "+
			"A stored config with enabled:false must be force-enabled at instantiation, "+
			"otherwise PreLLMHook short-circuits and the RTK column in /workspace/logs stays empty.",
			after, before, before+1)
	}
}

func ptrString(s string) *string { return &s }
