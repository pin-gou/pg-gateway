package server

import (
	"context"
	"fmt"
	"math"
	"os"

	"github.com/pin-gou/celer-route/core/schemas"
	"github.com/pin-gou/celer-route/plugins/compat"
	"github.com/pin-gou/celer-route/plugins/governance"
	"github.com/pin-gou/celer-route/plugins/logging"
	"github.com/pin-gou/celer-route/plugins/maxim"
	"github.com/pin-gou/celer-route/plugins/mocker"
	"github.com/pin-gou/celer-route/plugins/modelcatalogresolver"
	"github.com/pin-gou/celer-route/plugins/otel"
	"github.com/pin-gou/celer-route/plugins/prompts"
	"github.com/pin-gou/celer-route/plugins/providercooldown"
	"github.com/pin-gou/celer-route/plugins/rtk"
	"github.com/pin-gou/celer-route/plugins/semanticcache"
	"github.com/pin-gou/celer-route/plugins/telemetry"
	"github.com/pin-gou/celer-route/transports/celer-route-http/handlers"
	"github.com/pin-gou/celer-route/transports/celer-route-http/lib"
)

// InferPluginTypes determines which interface types a plugin implements
func InferPluginTypes(plugin schemas.BasePlugin) []schemas.PluginType {
	var types []schemas.PluginType
	if _, ok := plugin.(schemas.LLMPlugin); ok {
		types = append(types, schemas.PluginTypeLLM)
	}
	if _, ok := plugin.(schemas.MCPPlugin); ok {
		types = append(types, schemas.PluginTypeMCP)
	}
	if _, ok := plugin.(schemas.HTTPTransportPlugin); ok {
		types = append(types, schemas.PluginTypeHTTP)
	}
	return types
}

// Single-plugin methods used plugin create/update

// InstantiatePlugin creates a plugin instance but does NOT register it
// Registration is done separately via Config.RegisterPlugin()
func InstantiatePlugin(ctx context.Context, name string, path *string, pluginConfig any, bifrostConfig *lib.Config) (schemas.BasePlugin, error) {
	// Custom plugin (has path)
	if path != nil {
		return loadCustomPlugin(ctx, path, pluginConfig, bifrostConfig)
	}

	// Built-in plugin (by name)
	return loadBuiltinPlugin(ctx, name, pluginConfig, bifrostConfig)
}

// loadBuiltinPlugin instantiates a built-in plugin by name
func loadBuiltinPlugin(ctx context.Context, name string, pluginConfig any, bifrostConfig *lib.Config) (schemas.BasePlugin, error) {
	switch name {
	case telemetry.PluginName:
		telConfig := &telemetry.Config{
			CustomLabels: bifrostConfig.ClientConfig.PrometheusLabels,
		}
		// Merge persisted config if provided.
		if pluginConfig != nil {
			extraConfig, err := MarshalPluginConfig[telemetry.Config](pluginConfig)
			if err != nil {
				return nil, fmt.Errorf("failed to marshal telemetry plugin config: %w", err)
			}
			if extraConfig != nil {
				if extraConfig.PushGateway != nil {
					telConfig.PushGateway = extraConfig.PushGateway
				}
				if extraConfig.MetricsEnabled != nil {
					telConfig.MetricsEnabled = extraConfig.MetricsEnabled
				}
			}
		}
		return telemetry.Init(telConfig, bifrostConfig.ModelCatalog, logger)

	case prompts.PluginName:
		return prompts.Init(ctx, bifrostConfig.ConfigStore, logger)

	case logging.PluginName:
		loggingConfig, err := MarshalPluginConfig[logging.Config](pluginConfig)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal logging plugin config: %w", err)
		}
		if loggingConfig != nil {
			loggingConfig.ObjectStorageEnabled = bifrostConfig.LogsStoreConfig != nil &&
				bifrostConfig.LogsStoreConfig.ObjectStorage != nil
		}
		return logging.Init(ctx, loggingConfig, logger, bifrostConfig.LogsStore,
			bifrostConfig.ModelCatalog, bifrostConfig.MCPCatalog)

	case governance.PluginName:
		governanceConfig, err := MarshalPluginConfig[governance.Config](pluginConfig)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal governance plugin config: %w", err)
		}
		// All governance config fields mirror ClientConfig — ignore any stored
		// plugin config values so the native settings pages are the single entry
		// point for each field.
		governanceConfig.IsVkMandatory = &bifrostConfig.ClientConfig.EnforceAuthOnInference
		governanceConfig.RequiredHeaders = &bifrostConfig.ClientConfig.RequiredHeaders
		governanceConfig.DisableAutoToolInject = &bifrostConfig.ClientConfig.MCPDisableAutoToolInject
		governanceConfig.RoutingChainMaxDepth = &bifrostConfig.ClientConfig.RoutingChainMaxDepth
		inMemoryStore := &GovernanceInMemoryStore{Config: bifrostConfig}
		return governance.Init(ctx, governanceConfig, logger, bifrostConfig.ConfigStore,
			bifrostConfig.GovernanceConfig, bifrostConfig.ModelCatalog,
			bifrostConfig.MCPCatalog, inMemoryStore)

	case maxim.PluginName:
		maximConfig, err := MarshalPluginConfig[maxim.Config](pluginConfig)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal maxim plugin config: %w", err)
		}
		return maxim.Init(maximConfig, logger)

	case semanticcache.PluginName:
		semanticConfig, err := MarshalPluginConfig[semanticcache.Config](pluginConfig)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal semantic cache plugin config: %w", err)
		}
		return semanticcache.Init(ctx, semanticConfig, logger, bifrostConfig.VectorStore)

	case rtk.PluginName:
		rtkConfig, err := MarshalPluginConfig[rtk.Config](pluginConfig)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal rtk plugin config: %w", err)
		}
		// Force the engine-level Enabled flag to true at every instantiation.
		// An *rtk.Plugin instance only ever exists when the plugin-level
		// Enabled switch is on (the framework removes disabled plugins from
		// the pipeline, so their hooks never run); the inner config.Enabled
		// gate in PreLLMHook (plugins/rtk/hooks.go) must therefore mirror the
		// plugin-level switch. Without this, a stored config row carrying
		// enabled:false (e.g. because the UI form save never wrote the
		// inner field, and applyConfigDefaults' all-zero safeguard does not
		// trip once any other field is non-zero) silently disables the
		// entire compression engine — invocations stay at 0, the RTK column
		// in /workspace/logs stays empty, and the operator believes RTK is
		// on because the switch reads "enabled". Single source of truth =
		// plugin-level Enabled.
		rtkConfig.Enabled = true
		// Base the RTK on-disk roots (raw-output, custom filters) on the
		// application data directory (-app-dir / APP_DIR) when configured, so
		// container deployments persist them on the mounted volume instead of
		// the process CWD. Falls back to os.Getwd() for bare local runs (no
		// -app-dir flag) to keep the historical behaviour.
		appDir := bifrostConfig.AppDir
		if appDir == "" {
			appDir, _ = os.Getwd()
		}
		return rtk.Init(ctx, rtkConfig, logger, appDir)

	case otel.PluginName:
		otelConfig, err := MarshalPluginConfig[otel.Config](pluginConfig)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal otel plugin config: %w", err)
		}
		return otel.Init(ctx, otelConfig, logger, bifrostConfig.ModelCatalog, handlers.GetVersion())

	case compat.PluginName:
		compatConfig, err := MarshalPluginConfig[compat.Config](pluginConfig)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal compat plugin config: %w", err)
		}
		// All compat config fields mirror ClientConfig.Compat — ignore any stored
		// plugin config values so the client-settings compatibility page is the
		// single entry point.
		cc := bifrostConfig.ClientConfig.Compat
		compatConfig.ConvertTextToChat = cc.ConvertTextToChat
		compatConfig.ConvertChatToResponses = cc.ConvertChatToResponses
		compatConfig.ShouldDropParams = cc.ShouldDropParams
		compatConfig.ShouldConvertParams = cc.ShouldConvertParams
		return compat.Init(*compatConfig, logger, bifrostConfig.ModelCatalog)

	case mocker.PluginName:
		var mockerCfg *mocker.MockerConfig
		if pluginConfig != nil {
			var err error
			mockerCfg, err = MarshalPluginConfig[mocker.MockerConfig](pluginConfig)
			if err != nil {
				return nil, fmt.Errorf("failed to marshal mocker plugin config: %w", err)
			}
		}
		if mockerCfg == nil {
			mockerCfg = &mocker.MockerConfig{}
		}
		return mocker.Init(*mockerCfg)

	case modelcatalogresolver.PluginName:
		return modelcatalogresolver.Init(bifrostConfig.ModelCatalog, logger)

	case providercooldown.PluginName:
		plugin := providercooldown.NewPlugin(logger)
		if err := plugin.Init(pluginConfig); err != nil {
			return nil, fmt.Errorf("provider-cooldown: %w", err)
		}
		return plugin, nil

	default:
		return nil, fmt.Errorf("unknown built-in plugin: %s", name)
	}
}

// loadCustomPlugin loads a plugin from a shared object file
func loadCustomPlugin(ctx context.Context, path *string, pluginConfig any, bifrostConfig *lib.Config) (schemas.BasePlugin, error) {
	logger.Info("loading custom plugin from path %s", *path)

	plugin, err := bifrostConfig.PluginLoader.LoadPlugin(*path, pluginConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to load custom plugin: %w", err)
	}
	return plugin, nil
}

// LoadPlugins loads the plugins for the server.
func (s *BifrostHTTPServer) LoadPlugins(ctx context.Context) error {
	// Load built-in plugins first (order matters)
	if err := s.loadBuiltinPlugins(ctx); err != nil {
		return err
	}
	// Load custom plugins from config
	if err := s.loadCustomPlugins(ctx); err != nil {
		return err
	}
	// Sort all plugins by placement group and order
	s.Config.SortAndRebuildPlugins()
	return nil
}

// getPluginConfig retrieves a plugin's config from PluginConfigs by name
func (s *BifrostHTTPServer) getPluginConfig(name string) *schemas.PluginConfig {
	for _, cfg := range s.Config.PluginConfigs {
		if cfg.Name == name {
			return cfg
		}
	}
	return nil
}

// loadBuiltinPlugins loads required built-in plugins in specific order
func (s *BifrostHTTPServer) loadBuiltinPlugins(ctx context.Context) error {
	builtinPlacement := schemas.Ptr(schemas.PluginPlacementBuiltin)

	// 1. Telemetry (always first - tracks everything).
	// Default-on: absent PluginConfig entry is treated as enabled, matching pre-#3269 behavior
	// so upgraders don't silently lose /metrics. Only an explicit Enabled=false disables it.
	telemetryPluginConfig := s.getPluginConfig(telemetry.PluginName)
	var pluginConfig any
	if telemetryPluginConfig != nil {
		pluginConfig = telemetryPluginConfig.Config
	}
	if telemetryPluginConfig == nil || telemetryPluginConfig.Enabled {
		s.registerPluginWithStatus(ctx, telemetry.PluginName, nil, pluginConfig, false)
	} else {
		s.markPluginDisabled(telemetry.PluginName)
	}
	s.Config.SetPluginOrderInfo(telemetry.PluginName, builtinPlacement, schemas.Ptr(1))

	// 2. Prompts (requires config store for prompt repository; disabled in enterprise)
	if s.Config.ConfigStore != nil && ctx.Value(schemas.BifrostContextKeyIsEnterprise) == nil {
		s.registerPluginWithStatus(ctx, prompts.PluginName, nil, nil, false)
	} else {
		s.markPluginDisabled(prompts.PluginName)
	}
	s.Config.SetPluginOrderInfo(prompts.PluginName, builtinPlacement, schemas.Ptr(2))

	// 3. Logging (if enabled)
	if (s.Config.ClientConfig.EnableLogging == nil || *s.Config.ClientConfig.EnableLogging) && s.Config.LogsStore != nil {
		config := &logging.Config{
			DisableContentLogging:        &s.Config.ClientConfig.DisableContentLogging,
			RetainContentInObjectStorage: &s.Config.ClientConfig.RetainContentInObjectStorage,
			LoggingHeaders:               &s.Config.ClientConfig.LoggingHeaders,
		}
		if s.Config.LogsStoreConfig != nil {
			config.Writer = s.Config.LogsStoreConfig.Writer
		}
		s.registerPluginWithStatus(ctx, logging.PluginName, nil, config, false)
	} else {
		s.markPluginDisabled(logging.PluginName)
	}
	s.Config.SetPluginOrderInfo(logging.PluginName, builtinPlacement, schemas.Ptr(3))

	// 4. Governance (if enabled and not enterprise)
	if ctx.Value(schemas.BifrostContextKeyIsEnterprise) == nil {
		config := &governance.Config{
			IsVkMandatory:         &s.Config.ClientConfig.EnforceAuthOnInference,
			RequiredHeaders:       &s.Config.ClientConfig.RequiredHeaders,
			DisableAutoToolInject: &s.Config.ClientConfig.MCPDisableAutoToolInject,
			RoutingChainMaxDepth:  &s.Config.ClientConfig.RoutingChainMaxDepth,
		}
		s.registerPluginWithStatus(ctx, governance.PluginName, nil, config, false)
	} else {
		s.markPluginDisabled(governance.PluginName)
	}
	s.Config.SetPluginOrderInfo(governance.PluginName, builtinPlacement, schemas.Ptr(4))

	// 5. OTEL (if configured in PluginConfigs)
	otelConfig := s.getPluginConfig(otel.PluginName)
	if otelConfig != nil && otelConfig.Enabled {
		s.registerPluginWithStatus(ctx, otel.PluginName, nil, otelConfig.Config, false)
	} else {
		s.markPluginDisabled(otel.PluginName)
	}
	s.Config.SetPluginOrderInfo(otel.PluginName, builtinPlacement, schemas.Ptr(5))

	// 6. Semantic Cache (if configured in PluginConfigs)
	semanticCacheConfig := s.getPluginConfig(semanticcache.PluginName)
	if semanticCacheConfig != nil && semanticCacheConfig.Enabled {
		s.registerPluginWithStatus(ctx, semanticcache.PluginName, nil, semanticCacheConfig.Config, false)
	} else {
		s.markPluginDisabled(semanticcache.PluginName)
	}
	s.Config.SetPluginOrderInfo(semanticcache.PluginName, builtinPlacement, schemas.Ptr(6))

	// 7. RTK (default-on: nil entry in PluginConfigs → enabled with fresh-install seed config)
	rtkConfig := s.getPluginConfig(rtk.PluginName)
	if rtkConfig == nil || rtkConfig.Enabled {
		if rtkConfig == nil {
			// Fresh install: seed a default config that applies the user's preferred defaults
			// (applyConfigDefaults cannot distinguish "unset" from "false" for booleans, so we
			// set the opinionated choices here and let applyConfigDefaults fill the rest).
			rtkConfig = &schemas.PluginConfig{
				Name:    rtk.PluginName,
				Enabled: true,
				Config: &rtk.Config{
					Enabled:         true,
					EnableRenderers: true,
				},
			}
		}
		rtkPlugin, err := InstantiatePlugin(ctx, rtk.PluginName, nil, rtkConfig.Config, s.Config)
		if err != nil {
			return fmt.Errorf("failed to initialize rtk plugin: %w", err)
		}
		s.Config.ReloadPlugin(rtkPlugin)
		s.Config.UpdatePluginOverallStatus(rtk.PluginName, rtk.PluginName,
			schemas.PluginStatusActive,
			[]string{fmt.Sprintf("%s plugin initialized successfully", rtk.PluginName)},
			InferPluginTypes(rtkPlugin))
		// Cache the typed pointer so the admin API can resolve it.
		if rp, ok := rtkPlugin.(*rtk.Plugin); ok && rp != nil {
			s.rtkPluginMu.Lock()
			s.rtkPlugin = rp
			s.rtkPluginMu.Unlock()
		}
	} else {
		s.markPluginDisabled(rtk.PluginName)
	}
	s.Config.SetPluginOrderInfo(rtk.PluginName, builtinPlacement, schemas.Ptr(7))

	// 8. Compat (if any compat feature is enabled in ClientConfig)
	cc := s.Config.ClientConfig.Compat
	compatCfg := &compat.Config{
		ConvertTextToChat:      cc.ConvertTextToChat,
		ConvertChatToResponses: cc.ConvertChatToResponses,
		ShouldDropParams:       cc.ShouldDropParams,
		ShouldConvertParams:    cc.ShouldConvertParams,
	}
	s.registerPluginWithStatus(ctx, compat.PluginName, nil, compatCfg, false)
	s.Config.SetPluginOrderInfo(compat.PluginName, builtinPlacement, schemas.Ptr(8))

	// 8. Maxim (if configured in PluginConfigs)
	maximConfig := s.getPluginConfig(maxim.PluginName)
	if maximConfig != nil && maximConfig.Enabled {
		s.registerPluginWithStatus(ctx, maxim.PluginName, nil, maximConfig.Config, false)
	} else {
		s.markPluginDisabled(maxim.PluginName)
	}
	s.Config.SetPluginOrderInfo(maxim.PluginName, builtinPlacement, schemas.Ptr(8))

	// 9. ModelCatalogResolver (last routing layer — fills req.Provider from catalog only when
	// no earlier routing plugin (governance routing rules, governance VK LB, enterprise LB)
	// already set one. CEL rules can still match on provider == "" because this runs last.
	// Requires a model catalog; only register when one is configured.
	if s.Config.ModelCatalog != nil {
		s.registerPluginWithStatus(ctx, modelcatalogresolver.PluginName, nil, nil, false)
	} else {
		s.markPluginDisabled(modelcatalogresolver.PluginName)
	}
	// Place it in post_builtin with a max order so it runs after every other routing plugin,
	// including post_builtin ones like the enterprise load balancer (which would otherwise run
	// after this builtin and never get a chance to pick the provider first).
	s.Config.SetPluginOrderInfo(modelcatalogresolver.PluginName, schemas.Ptr(schemas.PluginPlacementPostBuiltin), schemas.Ptr(math.MaxInt))

	// 10. Provider cooldown (default-on: absent config.json entry is treated as enabled).
	// The plugin runs as an LLMPlugin (PostLLMHook marks quota-exhausted (provider, key)
	// pairs in an in-memory map) and exposes its key-pool filter via s.KeyPoolFilter,
	// which the server consumes at the bifrost core boundary. Both must be wired for
	// the feature to take effect: the LLMPlugin records events, the filter applies them.
	//
	// The PerKeyFailureMarker is the third wire of the same feature: bifrost's
	// retry loop invokes it on every per-key failure (transient 429/quota), so
	// cross-request cooldown bookkeeping sees the 429 a later retry succeeded
	// around — which PostLLMHook alone would miss. Wire it symmetrically with
	// the filter; both consume the same plugin State and must be re-pointed on
	// every plugin reload (see SyncLoadedPlugin in server.go).
	//
	// Default-on semantics: no entry in PluginConfigs, or an explicit entry with
	// enabled=true, both result in the plugin being loaded. Only an explicit
	// enabled=false disables the plugin. This matches telemetry's default-on behavior
	// (see plugin #1 above).
	cooldownCfg := s.getPluginConfig(providercooldown.PluginName)
	if cooldownCfg == nil || cooldownCfg.Enabled {
		plugin := providercooldown.NewPlugin(logger)
		var cfg any
		if cooldownCfg != nil {
			cfg = cooldownCfg.Config
		}
		if err := plugin.Init(cfg); err != nil {
			s.Config.UpdatePluginOverallStatus(providercooldown.PluginName, providercooldown.PluginName,
				schemas.PluginStatusError,
				[]string{fmt.Sprintf("provider-cooldown init failed: %v", err)}, []schemas.PluginType{})
			return fmt.Errorf("provider-cooldown: init failed: %w", err)
		}
		s.Config.ReloadPlugin(plugin)
		s.Config.UpdatePluginOverallStatus(providercooldown.PluginName, providercooldown.PluginName,
			schemas.PluginStatusActive,
			[]string{fmt.Sprintf("%s plugin initialized successfully", providercooldown.PluginName)},
			InferPluginTypes(plugin))
		// Wire the filter into the bifrost core boundary. This runs BEFORE
		// bifrost.Init at server.go:2466 (LoadPlugins fires at server.go:2425),
		// so the very first request sees the filter.
		s.KeyPoolFilter = plugin.State.AsFilter(logger)
		// Same lifecycle for the marker: stash it on the server struct so
		// Bootstrap / ReloadConfig can wire it into bifrost after Init —
		// s.Client is nil at this point (loadBuiltinPlugins runs pre-Init),
		// and SetPerKeyFailureMarker would panic on a nil receiver. The
		// wire itself happens symmetrically with KeyPoolFilter at the same
		// Bootstrap + ReloadConfig + SyncLoadedPlugin boundaries.
		s.PerKeyFailureMarker = plugin.State.AsMarker(logger)
	} else {
		s.markPluginDisabled(providercooldown.PluginName)
		// When explicitly disabled, ensure KeyPoolFilter is nil so no stale
		// filter from a previous reload leaks through.
		s.KeyPoolFilter = nil
	}
	s.Config.SetPluginOrderInfo(providercooldown.PluginName, builtinPlacement, schemas.Ptr(9))

	// 11. Mocker (always registered so it is visible in the plugins list for
	// configuration — same default-on semantics as compat above). The plugin is
	// inert until explicitly enabled: Init applies defaults (default_behavior
	// "passthrough") and PreLLMHook short-circuits when config.enabled is false.
	// Persisted config from the config store / config.json is passed through when
	// present, otherwise an empty config is used.
	mockerCfgEntry := s.getPluginConfig(mocker.PluginName)
	var mockerConfig any
	if mockerCfgEntry != nil {
		mockerConfig = mockerCfgEntry.Config
	}
	s.registerPluginWithStatus(ctx, mocker.PluginName, nil, mockerConfig, false)
	s.Config.SetPluginOrderInfo(mocker.PluginName, builtinPlacement, schemas.Ptr(10))

	return nil
}

// loadCustomPlugins loads plugins from PluginConfigs
func (s *BifrostHTTPServer) loadCustomPlugins(ctx context.Context) error {
	for _, cfg := range s.Config.PluginConfigs {
		// Skip built-ins (already loaded)
		if lib.IsBuiltinPlugin(cfg.Name) {
			continue
		}
		// Handle disabled plugins
		if !cfg.Enabled {
			// For custom plugins with a path, verify to get the real plugin name
			if cfg.Path != nil {
				pluginName, err := s.Config.PluginLoader.VerifyBasePlugin(*cfg.Path)
				if err != nil {
					logger.Error("failed to verify disabled plugin %s: %v", cfg.Name, err)
					continue
				}
				// Store plugin status without instantiating (no Init() call, no resource usage)
				// Note: We can't determine types without instantiating, so pass empty slice
				s.Config.UpdatePluginOverallStatus(pluginName, cfg.Name, schemas.PluginStatusDisabled,
					[]string{fmt.Sprintf("plugin %s is disabled", cfg.Name)}, []schemas.PluginType{})
			} else {
				// Built-in plugin - use cfg.Name directly
				s.Config.UpdatePluginOverallStatus(cfg.Name, cfg.Name, schemas.PluginStatusDisabled,
					[]string{fmt.Sprintf("plugin %s is disabled", cfg.Name)}, []schemas.PluginType{})
			}
			continue
		}

		// Plugin is enabled - instantiate it
		plugin, err := InstantiatePlugin(ctx, cfg.Name, cfg.Path, cfg.Config, s.Config)
		if err != nil {
			logger.Error("failed to load plugin %s: %v", cfg.Name, err)
			// Use cfg.Name since plugin may be nil when InstantiatePlugin returns an error
			s.Config.UpdatePluginOverallStatus(cfg.Name, cfg.Name, schemas.PluginStatusError,
				[]string{fmt.Sprintf("error loading plugin %s: %v", cfg.Name, err)}, []schemas.PluginType{})
			continue
		}

		// Ensure plugin is not nil before using it (defensive check)
		if plugin == nil {
			logger.Error("plugin %s instantiated but returned nil", cfg.Name)
			s.Config.UpdatePluginOverallStatus(cfg.Name, cfg.Name, schemas.PluginStatusError,
				[]string{fmt.Sprintf("plugin %s instantiated but returned nil", cfg.Name)}, []schemas.PluginType{})
			continue
		}

		// Register enabled plugin and mark as active
		s.Config.ReloadPlugin(plugin)
		s.Config.SetPluginOrderInfo(plugin.GetName(), cfg.Placement, cfg.Order)
		s.Config.UpdatePluginOverallStatus(plugin.GetName(), cfg.Name, schemas.PluginStatusActive,
			[]string{fmt.Sprintf("plugin %s initialized successfully", cfg.Name)}, InferPluginTypes(plugin))
	}
	return nil
}
