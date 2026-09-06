// Package logging provides utility functions and interfaces for the GORM-based logging plugin
package logging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	bifrost "github.com/pin-gou/celer-route/core"
	"github.com/pin-gou/celer-route/core/schemas"
	"github.com/pin-gou/celer-route/framework/logstore"
	"github.com/pin-gou/celer-route/framework/streaming"
)

// KeyPair represents an ID-Name pair for keys
type KeyPair struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// LogManager defines the main interface that combines all logging functionality
type LogManager interface {
	// GetLog retrieves a single log entry by ID (includes all fields, including raw_request/raw_response)
	GetLog(ctx context.Context, id string) (*logstore.Log, error)

	// Search searches for log entries based on filters and pagination
	Search(ctx context.Context, filters *logstore.SearchFilters, pagination *logstore.PaginationOptions) (*logstore.SearchResult, error)

	// GetSessionLogs returns paginated logs for a single parent_request_id session.
	GetSessionLogs(ctx context.Context, sessionID string, pagination *logstore.PaginationOptions) (*logstore.SessionDetailResult, error)

	// GetSessionSummary returns aggregate totals for a single parent_request_id session.
	GetSessionSummary(ctx context.Context, sessionID string) (*logstore.SessionSummaryResult, error)

	// GetStats calculates statistics for logs matching the given filters
	GetStats(ctx context.Context, filters *logstore.SearchFilters) (*logstore.SearchStats, error)

	// GetHistogram returns time-bucketed request counts for the given filters
	GetHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.HistogramResult, error)

	// GetTokenHistogram returns time-bucketed token usage for the given filters
	GetTokenHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.TokenHistogramResult, error)

	// GetCostHistogram returns time-bucketed cost data with model breakdown for the given filters
	GetCostHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.CostHistogramResult, error)

	// GetModelHistogram returns time-bucketed model usage with success/error breakdown for the given filters
	GetModelHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.ModelHistogramResult, error)

	// GetLatencyHistogram returns time-bucketed latency percentiles for the given filters
	GetLatencyHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.LatencyHistogramResult, error)

	// GetProviderCostHistogram returns time-bucketed cost data with provider breakdown for the given filters
	GetProviderCostHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.ProviderCostHistogramResult, error)

	// GetProviderTokenHistogram returns time-bucketed token usage with provider breakdown for the given filters
	GetProviderTokenHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.ProviderTokenHistogramResult, error)

	// GetProviderLatencyHistogram returns time-bucketed latency percentiles with provider breakdown for the given filters
	GetProviderLatencyHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.ProviderLatencyHistogramResult, error)

	// GetThroughputHistogram returns time-bucketed token-generation throughput (tokens/sec) for the given filters
	GetThroughputHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.ThroughputHistogramResult, error)

	// GetProviderThroughputHistogram returns time-bucketed tokens/sec with provider breakdown for the given filters
	GetProviderThroughputHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.ProviderThroughputHistogramResult, error)

	// GetModelRankings returns models ranked by usage with trend comparison
	GetModelRankings(ctx context.Context, filters *logstore.SearchFilters) (*logstore.ModelRankingResult, error)

	// GetProviderRankings returns providers ranked by usage with trend comparison
	GetProviderRankings(ctx context.Context, filters *logstore.SearchFilters) (*logstore.ProviderRankingResult, error)

	// GetDimensionRankings returns entities ranked by usage grouped by the given dimension
	GetDimensionRankings(ctx context.Context, filters *logstore.SearchFilters, dimension logstore.RankingDimension) (*logstore.DimensionRankingResult, error)

	// Get the number of dropped requests
	GetDroppedRequests(ctx context.Context) int64

	// GetAvailableModels returns all unique models from logs
	GetAvailableModels(ctx context.Context, limit int, query string) ([]string, error)

	// GetAvailableAliases returns all unique alias values from logs
	GetAvailableAliases(ctx context.Context, limit int, query string) ([]string, error)

	// GetAvailableSelectedKeys returns all unique selected key ID-Name pairs from logs
	GetAvailableSelectedKeys(ctx context.Context, limit int, query string) ([]KeyPair, error)

	// GetAvailableVirtualKeys returns all unique virtual key ID-Name pairs from logs
	GetAvailableVirtualKeys(ctx context.Context, limit int, query string) ([]KeyPair, error)

	// GetAvailableRoutingRules returns all unique routing rule ID-Name pairs from logs
	GetAvailableRoutingRules(ctx context.Context, limit int, query string) ([]KeyPair, error)

	// GetAvailableRoutingEngines returns all unique routing engine types from logs
	GetAvailableRoutingEngines(ctx context.Context, limit int, query string) ([]string, error)

	// GetAvailableStopReasons returns all unique stop reason values from logs
	GetAvailableStopReasons(ctx context.Context, limit int, query string) ([]string, error)

	// GetAvailableUserAgents returns all unique raw User-Agent strings from logs
	GetAvailableUserAgents(ctx context.Context, limit int, query string) ([]string, error)
	// GetAvailableApps returns all unique backend-detected app labels from logs
	GetAvailableApps(ctx context.Context, limit int, query string) ([]string, error)

	// GetAvailableTeams returns all unique team ID-Name pairs from logs
	GetAvailableTeams(ctx context.Context, limit int, query string) ([]KeyPair, error)

	// GetAvailableCustomers returns all unique customer ID-Name pairs from logs
	GetAvailableCustomers(ctx context.Context, limit int, query string) ([]KeyPair, error)

	// GetAvailableUsers returns all unique user IDs from logs
	GetAvailableUsers(ctx context.Context, limit int, query string) ([]KeyPair, error)

	// GetAvailableBusinessUnits returns all unique business unit ID-Name pairs from logs
	GetAvailableBusinessUnits(ctx context.Context, limit int, query string) ([]KeyPair, error)

	// GetAvailableMetadataKeys returns distinct metadata keys and their values from recent logs
	GetAvailableMetadataKeys(ctx context.Context, limit int, query string) (map[string][]string, error)

	// GetDimensionCostHistogram returns time-bucketed cost data grouped by the specified dimension
	GetDimensionCostHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64, dimension logstore.HistogramDimension) (*logstore.DimensionCostHistogramResult, error)

	// GetDimensionTokenHistogram returns time-bucketed token usage grouped by the specified dimension
	GetDimensionTokenHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64, dimension logstore.HistogramDimension) (*logstore.DimensionTokenHistogramResult, error)

	// GetDimensionLatencyHistogram returns time-bucketed latency percentiles grouped by the specified dimension
	GetDimensionLatencyHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64, dimension logstore.HistogramDimension) (*logstore.DimensionLatencyHistogramResult, error)

	// DeleteLog deletes a log entry by its ID
	DeleteLog(ctx context.Context, id string) error

	// DeleteLogs deletes multiple log entries by their IDs
	DeleteLogs(ctx context.Context, ids []string) error

	// RecalculateCosts recomputes missing costs for logs matching the filters
	RecalculateCosts(ctx context.Context, filters *logstore.SearchFilters, limit int) (*RecalculateCostResult, error)
	// RecalculateCostsWithProgress recomputes missing costs and emits batch progress updates
	RecalculateCostsWithProgress(ctx context.Context, filters *logstore.SearchFilters, limit int, progress func(RecalculateCostProgress)) (*RecalculateCostResult, error)
	// BuildCostRecalcJobMeta counts the in-scope rows and returns the initial
	// metadata JSON for a background cost-recalculation job. The caller must have
	// already resolved any period into filters.StartTime/EndTime.
	BuildCostRecalcJobMeta(ctx context.Context, filters logstore.SearchFilters, missingCostOnly bool) (string, error)
	// RunCostRecalcJob executes one background cost-recalculation job, resuming
	// from the cursor in metaJSON and checkpointing after each batch. It returns
	// the final metadata JSON to persist.
	RunCostRecalcJob(ctx context.Context, metaJSON string, checkpoint func(string) error) (string, error)

	// ErrorPatterns returns aggregated error buckets for a provider in the
	// given window. Used by the CooldownPolicy UI's error-sample browser.
	ErrorPatterns(ctx context.Context, provider schemas.ModelProvider, window string, limit int) ([]logstore.ErrorPattern, int64, error)

	// MCP Tool Log methods
	// GetMCPToolLog retrieves a single MCP tool log entry by ID.
	GetMCPToolLog(ctx context.Context, id string) (*logstore.MCPToolLog, error)

	// SearchMCPToolLogs searches for MCP tool log entries based on filters and pagination
	SearchMCPToolLogs(ctx context.Context, filters *logstore.MCPToolLogSearchFilters, pagination *logstore.PaginationOptions) (*logstore.MCPToolLogSearchResult, error)

	// GetMCPToolLogStats calculates statistics for MCP tool logs matching the given filters
	GetMCPToolLogStats(ctx context.Context, filters *logstore.MCPToolLogSearchFilters) (*logstore.MCPToolLogStats, error)

	// GetAvailableToolNames returns all unique tool names from MCP tool logs
	GetAvailableToolNames(ctx context.Context, limit int, query string) ([]string, error)

	// GetAvailableServerLabels returns all unique server labels from MCP tool logs
	GetAvailableServerLabels(ctx context.Context, limit int, query string) ([]string, error)

	// GetAvailableMCPUserAgents returns all unique raw User-Agent strings from MCP tool logs
	GetAvailableMCPUserAgents(ctx context.Context, limit int, query string) ([]string, error)
	// GetAvailableMCPApps returns all unique backend-detected app labels from MCP tool logs
	GetAvailableMCPApps(ctx context.Context, limit int, query string) ([]string, error)

	// GetAvailableMCPVirtualKeys returns all unique virtual key ID-Name pairs from MCP tool logs
	GetAvailableMCPVirtualKeys(ctx context.Context, limit int, query string) ([]KeyPair, error)

	// GetMCPHistogram returns time-bucketed MCP tool call volume
	GetMCPHistogram(ctx context.Context, filters logstore.MCPToolLogSearchFilters, bucketSizeSeconds int64) (*logstore.MCPHistogramResult, error)

	// GetMCPCostHistogram returns time-bucketed MCP cost data
	GetMCPCostHistogram(ctx context.Context, filters logstore.MCPToolLogSearchFilters, bucketSizeSeconds int64) (*logstore.MCPCostHistogramResult, error)

	// GetMCPTopTools returns the top N MCP tools by call count
	GetMCPTopTools(ctx context.Context, filters logstore.MCPToolLogSearchFilters, limit int) (*logstore.MCPTopToolsResult, error)

	// DeleteMCPToolLogs deletes multiple MCP tool log entries by their IDs
	DeleteMCPToolLogs(ctx context.Context, ids []string) error

	ListUserAgentMappings(ctx context.Context) ([]logstore.UserAgentMapping, error)
	CreateUserAgentMapping(ctx context.Context, mapping *logstore.UserAgentMapping) (*logstore.UserAgentMapping, error)
	UpdateUserAgentMapping(ctx context.Context, id string, mapping *logstore.UserAgentMapping) (*logstore.UserAgentMapping, error)
	DeleteUserAgentMapping(ctx context.Context, id string) error

	// ListTimelineEventsByLogID returns the plugin-pipeline stage events recorded
	// for a single log row (timeline_events), ordered for timeline aggregation.
	ListTimelineEventsByLogID(ctx context.Context, logID string) ([]logstore.TimelineEvent, error)

	// GetActiveLogs returns a snapshot of currently processing log entries.
	GetActiveLogs(ctx context.Context) ([]*logstore.Log, error)

	// SubscribeActiveLogStream returns a channel that receives Log status updates
	// (processing→success/error transitions and new processing entries).
	SubscribeActiveLogStream(ctx context.Context) (<-chan *logstore.Log, error)

	// UnsubscribeActiveLogStream stops the active log stream subscription for the
	// given channel and cleans up associated resources.
	UnsubscribeActiveLogStream(ctx context.Context, ch <-chan *logstore.Log) error
}

// PluginLogManager implements LogManager interface wrapping the plugin
type PluginLogManager struct {
	plugin *LoggerPlugin
}

func (p *PluginLogManager) GetLog(ctx context.Context, id string) (*logstore.Log, error) {
	return p.plugin.GetLog(ctx, id)
}

// ErrorPatterns returns aggregated error buckets for the provider in window.
// The RDBLogStore implements this for sqlite/postgres/clickhouse; other store
// wrappers (e.g. scoped store) fall back to an empty result — the UI degrades
// to the built-in catalog dropdown when the error browser has no data.
func (p *PluginLogManager) ErrorPatterns(ctx context.Context, provider schemas.ModelProvider, window string, limit int) ([]logstore.ErrorPattern, int64, error) {
	if p.plugin == nil || p.plugin.store == nil {
		return nil, 0, nil
	}
	rdb, ok := p.plugin.store.(*logstore.RDBLogStore)
	if !ok {
		return nil, 0, nil
	}
	return rdb.ErrorPatterns(ctx, provider, window, limit)
}

func (p *PluginLogManager) Search(ctx context.Context, filters *logstore.SearchFilters, pagination *logstore.PaginationOptions) (*logstore.SearchResult, error) {
	if filters == nil || pagination == nil {
		return nil, fmt.Errorf("filters and pagination cannot be nil")
	}
	return p.plugin.SearchLogs(ctx, *filters, *pagination)
}

func (p *PluginLogManager) GetSessionLogs(ctx context.Context, sessionID string, pagination *logstore.PaginationOptions) (*logstore.SessionDetailResult, error) {
	if pagination == nil {
		return nil, fmt.Errorf("pagination cannot be nil")
	}
	if strings.TrimSpace(sessionID) == "" {
		return nil, fmt.Errorf("sessionID cannot be empty")
	}
	return p.plugin.GetSessionLogs(ctx, sessionID, *pagination)
}

func (p *PluginLogManager) GetSessionSummary(ctx context.Context, sessionID string) (*logstore.SessionSummaryResult, error) {
	if strings.TrimSpace(sessionID) == "" {
		return nil, fmt.Errorf("sessionID cannot be empty")
	}
	return p.plugin.GetSessionSummary(ctx, sessionID)
}

func (p *PluginLogManager) GetStats(ctx context.Context, filters *logstore.SearchFilters) (*logstore.SearchStats, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetStats(ctx, *filters)
}

func (p *PluginLogManager) GetHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.HistogramResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetHistogram(ctx, *filters, bucketSizeSeconds)
}

func (p *PluginLogManager) GetTokenHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.TokenHistogramResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetTokenHistogram(ctx, *filters, bucketSizeSeconds)
}

func (p *PluginLogManager) GetCostHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.CostHistogramResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetCostHistogram(ctx, *filters, bucketSizeSeconds)
}

func (p *PluginLogManager) GetModelHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.ModelHistogramResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetModelHistogram(ctx, *filters, bucketSizeSeconds)
}

func (p *PluginLogManager) GetLatencyHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.LatencyHistogramResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetLatencyHistogram(ctx, *filters, bucketSizeSeconds)
}

func (p *PluginLogManager) GetProviderCostHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.ProviderCostHistogramResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetProviderCostHistogram(ctx, *filters, bucketSizeSeconds)
}

func (p *PluginLogManager) GetProviderTokenHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.ProviderTokenHistogramResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetProviderTokenHistogram(ctx, *filters, bucketSizeSeconds)
}

func (p *PluginLogManager) GetProviderLatencyHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.ProviderLatencyHistogramResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetProviderLatencyHistogram(ctx, *filters, bucketSizeSeconds)
}

func (p *PluginLogManager) GetThroughputHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.ThroughputHistogramResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetThroughputHistogram(ctx, *filters, bucketSizeSeconds)
}

func (p *PluginLogManager) GetProviderThroughputHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64) (*logstore.ProviderThroughputHistogramResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetProviderThroughputHistogram(ctx, *filters, bucketSizeSeconds)
}

func (p *PluginLogManager) GetModelRankings(ctx context.Context, filters *logstore.SearchFilters) (*logstore.ModelRankingResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetModelRankings(ctx, *filters)
}

func (p *PluginLogManager) GetProviderRankings(ctx context.Context, filters *logstore.SearchFilters) (*logstore.ProviderRankingResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetProviderRankings(ctx, *filters)
}

func (p *PluginLogManager) GetDimensionRankings(ctx context.Context, filters *logstore.SearchFilters, dimension logstore.RankingDimension) (*logstore.DimensionRankingResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetDimensionRankings(ctx, *filters, dimension)
}

func (p *PluginLogManager) GetDroppedRequests(ctx context.Context) int64 {
	return p.plugin.droppedRequests.Load()
}

// GetAvailableModels returns all unique models from logs
func (p *PluginLogManager) GetAvailableModels(ctx context.Context, limit int, query string) ([]string, error) {
	return p.plugin.GetAvailableModels(ctx, limit, query)
}

func (p *PluginLogManager) GetAvailableAliases(ctx context.Context, limit int, query string) ([]string, error) {
	return p.plugin.GetAvailableAliases(ctx, limit, query)
}

func (p *PluginLogManager) GetAvailableSelectedKeys(ctx context.Context, limit int, query string) ([]KeyPair, error) {
	return p.plugin.GetAvailableSelectedKeys(ctx, limit, query)
}

func (p *PluginLogManager) GetAvailableVirtualKeys(ctx context.Context, limit int, query string) ([]KeyPair, error) {
	return p.plugin.GetAvailableVirtualKeys(ctx, limit, query)
}

func (p *PluginLogManager) GetAvailableRoutingRules(ctx context.Context, limit int, query string) ([]KeyPair, error) {
	return p.plugin.GetAvailableRoutingRules(ctx, limit, query)
}

func (p *PluginLogManager) GetAvailableRoutingEngines(ctx context.Context, limit int, query string) ([]string, error) {
	return p.plugin.GetAvailableRoutingEngines(ctx, limit, query)
}

func (p *PluginLogManager) GetAvailableStopReasons(ctx context.Context, limit int, query string) ([]string, error) {
	return p.plugin.GetAvailableStopReasons(ctx, limit, query)
}

// GetAvailableUserAgents returns distinct raw User-Agent strings from logs for the logs "App" filter.
func (p *PluginLogManager) GetAvailableUserAgents(ctx context.Context, limit int, query string) ([]string, error) {
	return p.plugin.GetAvailableUserAgents(ctx, limit, query)
}

// GetAvailableApps returns distinct backend-detected app labels from logs for the logs "App" filter.
func (p *PluginLogManager) GetAvailableApps(ctx context.Context, limit int, query string) ([]string, error) {
	return p.plugin.GetAvailableApps(ctx, limit, query)
}

func (p *PluginLogManager) GetAvailableTeams(ctx context.Context, limit int, query string) ([]KeyPair, error) {
	return p.plugin.GetAvailableTeams(ctx, limit, query)
}

func (p *PluginLogManager) GetAvailableCustomers(ctx context.Context, limit int, query string) ([]KeyPair, error) {
	return p.plugin.GetAvailableCustomers(ctx, limit, query)
}

func (p *PluginLogManager) GetAvailableUsers(ctx context.Context, limit int, query string) ([]KeyPair, error) {
	return p.plugin.GetAvailableUsers(ctx, limit, query)
}

func (p *PluginLogManager) GetAvailableBusinessUnits(ctx context.Context, limit int, query string) ([]KeyPair, error) {
	return p.plugin.GetAvailableBusinessUnits(ctx, limit, query)
}

// GetDimensionCostHistogram returns time-bucketed cost data grouped by the specified dimension.
func (p *PluginLogManager) GetDimensionCostHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64, dimension logstore.HistogramDimension) (*logstore.DimensionCostHistogramResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetDimensionCostHistogram(ctx, *filters, bucketSizeSeconds, dimension)
}

// GetDimensionTokenHistogram returns time-bucketed token usage grouped by the specified dimension.
func (p *PluginLogManager) GetDimensionTokenHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64, dimension logstore.HistogramDimension) (*logstore.DimensionTokenHistogramResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetDimensionTokenHistogram(ctx, *filters, bucketSizeSeconds, dimension)
}

// GetDimensionLatencyHistogram returns time-bucketed latency percentiles grouped by the specified dimension.
func (p *PluginLogManager) GetDimensionLatencyHistogram(ctx context.Context, filters *logstore.SearchFilters, bucketSizeSeconds int64, dimension logstore.HistogramDimension) (*logstore.DimensionLatencyHistogramResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.GetDimensionLatencyHistogram(ctx, *filters, bucketSizeSeconds, dimension)
}

func (p *PluginLogManager) GetAvailableMetadataKeys(ctx context.Context, limit int, query string) (map[string][]string, error) {
	if p.plugin == nil || p.plugin.store == nil {
		return map[string][]string{}, nil
	}
	return p.plugin.store.GetDistinctMetadataKeys(ctx, limit, query)
}

// DeleteLog deletes a log from the log store
func (p *PluginLogManager) DeleteLog(ctx context.Context, id string) error {
	if p.plugin == nil || p.plugin.store == nil {
		return fmt.Errorf("log store not initialized")
	}
	return p.plugin.store.DeleteLog(ctx, id)
}

// DeleteLogs deletes multiple logs from the log store
func (p *PluginLogManager) DeleteLogs(ctx context.Context, ids []string) error {
	if p.plugin == nil || p.plugin.store == nil {
		return fmt.Errorf("log store not initialized")
	}
	return p.plugin.store.DeleteLogs(ctx, ids)
}

func (p *PluginLogManager) RecalculateCosts(ctx context.Context, filters *logstore.SearchFilters, limit int) (*RecalculateCostResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.RecalculateCosts(ctx, *filters, limit)
}

func (p *PluginLogManager) RecalculateCostsWithProgress(ctx context.Context, filters *logstore.SearchFilters, limit int, progress func(RecalculateCostProgress)) (*RecalculateCostResult, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.RecalculateCostsWithProgress(ctx, *filters, limit, progress)
}

func (p *PluginLogManager) BuildCostRecalcJobMeta(ctx context.Context, filters logstore.SearchFilters, missingCostOnly bool) (string, error) {
	if p.plugin == nil {
		return "", fmt.Errorf("logging plugin not initialized")
	}
	return p.plugin.BuildCostRecalcJobMeta(ctx, filters, missingCostOnly)
}

func (p *PluginLogManager) RunCostRecalcJob(ctx context.Context, metaJSON string, checkpoint func(string) error) (string, error) {
	if p.plugin == nil {
		return metaJSON, fmt.Errorf("logging plugin not initialized")
	}
	return p.plugin.RunCostRecalcJob(ctx, metaJSON, checkpoint)
}

// GetMCPToolLog retrieves a single MCP tool log entry by ID.
func (p *PluginLogManager) GetMCPToolLog(ctx context.Context, id string) (*logstore.MCPToolLog, error) {
	if p.plugin == nil || p.plugin.store == nil {
		return nil, fmt.Errorf("log store not initialized")
	}
	if strings.TrimSpace(id) == "" {
		return nil, fmt.Errorf("id cannot be empty")
	}
	return p.plugin.GetMCPToolLog(ctx, id)
}

// SearchMCPToolLogs searches for MCP tool log entries based on filters and pagination
func (p *PluginLogManager) SearchMCPToolLogs(ctx context.Context, filters *logstore.MCPToolLogSearchFilters, pagination *logstore.PaginationOptions) (*logstore.MCPToolLogSearchResult, error) {
	if filters == nil || pagination == nil {
		return nil, fmt.Errorf("filters and pagination cannot be nil")
	}
	return p.plugin.store.SearchMCPToolLogs(ctx, *filters, *pagination)
}

// GetMCPToolLogStats calculates statistics for MCP tool logs matching the given filters
func (p *PluginLogManager) GetMCPToolLogStats(ctx context.Context, filters *logstore.MCPToolLogSearchFilters) (*logstore.MCPToolLogStats, error) {
	if filters == nil {
		return nil, fmt.Errorf("filters cannot be nil")
	}
	return p.plugin.store.GetMCPToolLogStats(ctx, *filters)
}

// GetAvailableToolNames returns all unique tool names from MCP tool logs
func (p *PluginLogManager) GetAvailableToolNames(ctx context.Context, limit int, query string) ([]string, error) {
	if p == nil || p.plugin == nil || p.plugin.store == nil {
		return []string{}, nil
	}
	return p.plugin.store.GetAvailableToolNames(ctx, limit, query)
}

func (p *PluginLogManager) GetAvailableServerLabels(ctx context.Context, limit int, query string) ([]string, error) {
	if p == nil || p.plugin == nil || p.plugin.store == nil {
		return []string{}, nil
	}
	return p.plugin.store.GetAvailableServerLabels(ctx, limit, query)
}

// GetAvailableMCPUserAgents returns distinct raw User-Agent strings from MCP tool logs for the MCP "App" filter.
func (p *PluginLogManager) GetAvailableMCPUserAgents(ctx context.Context, limit int, query string) ([]string, error) {
	if p == nil || p.plugin == nil || p.plugin.store == nil {
		return []string{}, nil
	}
	return p.plugin.store.GetAvailableMCPUserAgents(ctx, limit, query)
}

// GetAvailableMCPApps returns distinct backend-detected app labels from MCP tool logs for the MCP "App" filter.
func (p *PluginLogManager) GetAvailableMCPApps(ctx context.Context, limit int, query string) ([]string, error) {
	if p == nil || p.plugin == nil || p.plugin.store == nil {
		return []string{}, nil
	}
	return p.plugin.store.GetAvailableMCPApps(ctx, limit, query)
}

func (p *PluginLogManager) GetAvailableMCPVirtualKeys(ctx context.Context, limit int, query string) ([]KeyPair, error) {
	if p == nil || p.plugin == nil {
		return []KeyPair{}, nil
	}
	return p.plugin.GetAvailableMCPVirtualKeys(ctx, limit, query)
}

// GetMCPHistogram returns time-bucketed MCP tool call volume
func (p *PluginLogManager) GetMCPHistogram(ctx context.Context, filters logstore.MCPToolLogSearchFilters, bucketSizeSeconds int64) (*logstore.MCPHistogramResult, error) {
	if p.plugin == nil || p.plugin.store == nil {
		return &logstore.MCPHistogramResult{}, nil
	}
	return p.plugin.store.GetMCPHistogram(ctx, filters, bucketSizeSeconds)
}

// GetMCPCostHistogram returns time-bucketed MCP cost data
func (p *PluginLogManager) GetMCPCostHistogram(ctx context.Context, filters logstore.MCPToolLogSearchFilters, bucketSizeSeconds int64) (*logstore.MCPCostHistogramResult, error) {
	if p.plugin == nil || p.plugin.store == nil {
		return &logstore.MCPCostHistogramResult{}, nil
	}
	return p.plugin.store.GetMCPCostHistogram(ctx, filters, bucketSizeSeconds)
}

// GetMCPTopTools returns the top N MCP tools by call count
func (p *PluginLogManager) GetMCPTopTools(ctx context.Context, filters logstore.MCPToolLogSearchFilters, limit int) (*logstore.MCPTopToolsResult, error) {
	if p.plugin == nil || p.plugin.store == nil {
		return &logstore.MCPTopToolsResult{}, nil
	}
	return p.plugin.store.GetMCPTopTools(ctx, filters, limit)
}

// DeleteMCPToolLogs deletes multiple MCP tool log entries by their IDs
func (p *PluginLogManager) DeleteMCPToolLogs(ctx context.Context, ids []string) error {
	if p.plugin == nil || p.plugin.store == nil {
		return fmt.Errorf("log store not initialized")
	}
	return p.plugin.store.DeleteMCPToolLogs(ctx, ids)
}

// ListUserAgentMappings returns all custom User-Agent mappings.
func (p *PluginLogManager) ListUserAgentMappings(ctx context.Context) ([]logstore.UserAgentMapping, error) {
	return p.plugin.ListUserAgentMappings(ctx)
}

// ListTimelineEventsByLogID returns the plugin-pipeline stage events for a log row.
func (p *PluginLogManager) ListTimelineEventsByLogID(ctx context.Context, logID string) ([]logstore.TimelineEvent, error) {
	return p.plugin.ListTimelineEventsByLogID(ctx, logID)
}

// GetActiveLogs returns a snapshot of currently processing log entries.
func (p *PluginLogManager) GetActiveLogs(ctx context.Context) ([]*logstore.Log, error) {
	return p.plugin.GetActiveLogs(ctx)
}

// SubscribeActiveLogStream returns a channel that receives Log status updates.
func (p *PluginLogManager) SubscribeActiveLogStream(ctx context.Context) (<-chan *logstore.Log, error) {
	return p.plugin.SubscribeActiveLogStream(ctx)
}

// UnsubscribeActiveLogStream stops the active log stream subscription.
func (p *PluginLogManager) UnsubscribeActiveLogStream(ctx context.Context, ch <-chan *logstore.Log) error {
	return p.plugin.UnsubscribeActiveLogStream(ctx, ch)
}

// CreateUserAgentMapping creates a custom User-Agent mapping through the logging plugin.
func (p *PluginLogManager) CreateUserAgentMapping(ctx context.Context, mapping *logstore.UserAgentMapping) (*logstore.UserAgentMapping, error) {
	if mapping == nil {
		return nil, fmt.Errorf("%w: mapping cannot be nil", ErrInvalidUserAgentMapping)
	}
	return p.plugin.CreateUserAgentMapping(ctx, mapping)
}

// UpdateUserAgentMapping updates a custom User-Agent mapping through the logging plugin.
func (p *PluginLogManager) UpdateUserAgentMapping(ctx context.Context, id string, mapping *logstore.UserAgentMapping) (*logstore.UserAgentMapping, error) {
	if strings.TrimSpace(id) == "" {
		return nil, fmt.Errorf("%w: id cannot be empty", ErrInvalidUserAgentMapping)
	}
	if mapping == nil {
		return nil, fmt.Errorf("%w: mapping cannot be nil", ErrInvalidUserAgentMapping)
	}
	return p.plugin.UpdateUserAgentMapping(ctx, id, mapping)
}

// DeleteUserAgentMapping deletes a custom User-Agent mapping through the logging plugin.
func (p *PluginLogManager) DeleteUserAgentMapping(ctx context.Context, id string) error {
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("%w: id cannot be empty", ErrInvalidUserAgentMapping)
	}
	return p.plugin.DeleteUserAgentMapping(ctx, id)
}

// GetPluginLogManager returns a LogManager interface for this plugin
func (p *LoggerPlugin) GetPluginLogManager() *PluginLogManager {
	return &PluginLogManager{
		plugin: p,
	}
}

// retryOnNotFound retries a function up to 3 times with 1-second delays if it returns logstore.ErrNotFound
func retryOnNotFound(ctx context.Context, operation func() error) error {
	const maxRetries = 3
	const retryDelay = time.Second

	var lastErr error
	for attempt := range maxRetries {
		err := operation()
		if err == nil {
			return nil
		}

		// Check if the error is logstore.ErrNotFound
		if !errors.Is(err, logstore.ErrNotFound) {
			return err
		}

		lastErr = err

		// Don't wait after the last attempt
		if attempt < maxRetries-1 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(retryDelay):
				// Continue to next retry
			}
		}
	}

	return lastErr
}

// extractInputHistory extracts input history from request input
func (p *LoggerPlugin) extractInputHistory(request *schemas.BifrostRequest) ([]schemas.ChatMessage, []schemas.ResponsesMessage) {
	if request.ChatRequest != nil {
		return request.ChatRequest.Input, []schemas.ResponsesMessage{}
	}
	if request.RequestType == schemas.RealtimeRequest && request.ResponsesRequest != nil {
		return extractRealtimeInputHistory(request.ResponsesRequest.Input), []schemas.ResponsesMessage{}
	}
	if request.ResponsesRequest != nil && len(request.ResponsesRequest.Input) > 0 {
		return []schemas.ChatMessage{}, request.ResponsesRequest.Input
	}
	if request.TextCompletionRequest != nil {
		if request.TextCompletionRequest.Input == nil {
			return []schemas.ChatMessage{}, []schemas.ResponsesMessage{}
		}
		var text string
		if request.TextCompletionRequest.Input.PromptStr != nil {
			text = *request.TextCompletionRequest.Input.PromptStr
		} else {
			var stringBuilder strings.Builder
			for _, prompt := range request.TextCompletionRequest.Input.PromptArray {
				stringBuilder.WriteString(prompt)
			}
			text = stringBuilder.String()
		}
		return []schemas.ChatMessage{
			{
				Role: schemas.ChatMessageRoleUser,
				Content: &schemas.ChatMessageContent{
					ContentStr: &text,
				},
			},
		}, []schemas.ResponsesMessage{}
	}
	if request.EmbeddingRequest != nil {
		// Large payload passthrough can intentionally leave Input nil to avoid
		// materializing giant request bodies. Logging should degrade gracefully.
		if request.EmbeddingRequest.Input == nil {
			return []schemas.ChatMessage{}, []schemas.ResponsesMessage{}
		}
		texts := request.EmbeddingRequest.Input.Texts

		if len(texts) == 0 && request.EmbeddingRequest.Input.Text != nil {
			texts = []string{*request.EmbeddingRequest.Input.Text}
		}

		contentBlocks := make([]schemas.ChatContentBlock, len(texts))
		for i, text := range texts {
			// Create a per-iteration copy to avoid reusing the same memory address
			t := text
			contentBlocks[i] = schemas.ChatContentBlock{
				Type: schemas.ChatContentBlockTypeText,
				Text: &t,
			}
		}
		return []schemas.ChatMessage{
			{
				Role: schemas.ChatMessageRoleUser,
				Content: &schemas.ChatMessageContent{
					ContentBlocks: contentBlocks,
				},
			},
		}, []schemas.ResponsesMessage{}
	}
	if request.RerankRequest != nil {
		query := request.RerankRequest.Query
		return []schemas.ChatMessage{
			{
				Role: schemas.ChatMessageRoleUser,
				Content: &schemas.ChatMessageContent{
					ContentStr: &query,
				},
			},
		}, []schemas.ResponsesMessage{}
	}
	if request.CountTokensRequest != nil && len(request.CountTokensRequest.Input) > 0 {
		return []schemas.ChatMessage{}, request.CountTokensRequest.Input
	}
	if request.CompactionRequest != nil && len(request.CompactionRequest.Input) > 0 {
		return []schemas.ChatMessage{}, request.CompactionRequest.Input
	}
	return []schemas.ChatMessage{}, []schemas.ResponsesMessage{}
}

func extractRealtimeInputHistory(input []schemas.ResponsesMessage) []schemas.ChatMessage {
	messages := make([]schemas.ChatMessage, 0, len(input))
	for _, item := range input {
		if item.Type == nil {
			continue
		}
		switch *item.Type {
		case schemas.ResponsesMessageTypeMessage:
			if item.Role == nil || item.Content == nil {
				continue
			}
			content := extractRealtimeResponsesContent(item.Content)
			if content == "" {
				continue
			}
			messages = append(messages, schemas.ChatMessage{
				Role: mapRealtimeResponsesRole(*item.Role),
				Content: &schemas.ChatMessageContent{
					ContentStr: schemas.Ptr(content),
				},
			})
		case schemas.ResponsesMessageTypeFunctionCallOutput,
			schemas.ResponsesMessageTypeCustomToolCallOutput,
			schemas.ResponsesMessageTypeLocalShellCallOutput,
			schemas.ResponsesMessageTypeComputerCallOutput:
			content := extractRealtimeToolOutputContent(item.ResponsesToolMessage)
			if content == "" {
				continue
			}
			messages = append(messages, schemas.ChatMessage{
				Role: schemas.ChatMessageRoleTool,
				Content: &schemas.ChatMessageContent{
					ContentStr: schemas.Ptr(content),
				},
				ChatToolMessage: &schemas.ChatToolMessage{
					ToolCallID: item.ResponsesToolMessage.CallID,
				},
			})
		}
	}
	return messages
}

func mapRealtimeResponsesRole(role schemas.ResponsesMessageRoleType) schemas.ChatMessageRole {
	switch role {
	case schemas.ResponsesInputMessageRoleAssistant:
		return schemas.ChatMessageRoleAssistant
	case schemas.ResponsesInputMessageRoleSystem:
		return schemas.ChatMessageRoleSystem
	case schemas.ResponsesInputMessageRoleDeveloper:
		return schemas.ChatMessageRoleDeveloper
	default:
		return schemas.ChatMessageRoleUser
	}
}

func extractRealtimeResponsesContent(content *schemas.ResponsesMessageContent) string {
	if content == nil {
		return ""
	}
	if content.ContentStr != nil {
		return strings.TrimSpace(*content.ContentStr)
	}
	parts := make([]string, 0, len(content.ContentBlocks))
	for _, block := range content.ContentBlocks {
		switch {
		case block.Text != nil && strings.TrimSpace(*block.Text) != "":
			parts = append(parts, strings.TrimSpace(*block.Text))
		case block.ResponsesOutputMessageContentRefusal != nil && strings.TrimSpace(block.Refusal) != "":
			parts = append(parts, strings.TrimSpace(block.Refusal))
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func extractRealtimeToolOutputContent(toolMessage *schemas.ResponsesToolMessage) string {
	if toolMessage == nil || toolMessage.Output == nil {
		return ""
	}
	switch {
	case toolMessage.Output.ResponsesToolCallOutputStr != nil:
		return strings.TrimSpace(*toolMessage.Output.ResponsesToolCallOutputStr)
	case len(toolMessage.Output.ResponsesFunctionToolCallOutputBlocks) > 0:
		content := &schemas.ResponsesMessageContent{ContentBlocks: toolMessage.Output.ResponsesFunctionToolCallOutputBlocks}
		return extractRealtimeResponsesContent(content)
	default:
		return ""
	}
}

// convertToProcessedStreamResponse converts a StreamAccumulatorResult to ProcessedStreamResponse
// for use with the logging plugin's streaming log update functionality.
func convertToProcessedStreamResponse(result *schemas.StreamAccumulatorResult, requestType schemas.RequestType) *streaming.ProcessedStreamResponse {
	if result == nil {
		return nil
	}

	// Determine stream type from request type
	var streamType streaming.StreamType
	switch requestType {
	case schemas.TextCompletionStreamRequest:
		streamType = streaming.StreamTypeText
	case schemas.ChatCompletionStreamRequest:
		streamType = streaming.StreamTypeChat
	case schemas.ResponsesStreamRequest, schemas.ResponsesRetrieveStreamRequest, schemas.WebSocketResponsesRequest:
		streamType = streaming.StreamTypeResponses
	case schemas.SpeechStreamRequest:
		streamType = streaming.StreamTypeAudio
	case schemas.TranscriptionStreamRequest:
		streamType = streaming.StreamTypeTranscription
	case schemas.ImageGenerationStreamRequest:
		streamType = streaming.StreamTypeImage
	case schemas.PassthroughStreamRequest:
		streamType = streaming.StreamTypePassthrough
	default:
		streamType = streaming.StreamTypeChat
	}

	// Build accumulated data
	data := &streaming.AccumulatedData{
		RequestID:             result.RequestID,
		Model:                 result.RequestedModel,
		Status:                result.Status,
		Stream:                true,
		Latency:               result.Latency,
		TimeToFirstToken:      result.TimeToFirstToken,
		OutputMessage:         result.OutputMessage,
		OutputMessages:        result.OutputMessages,
		ErrorDetails:          result.ErrorDetails,
		TokenUsage:            result.TokenUsage,
		CacheDebug:            result.CacheDebug,
		GuardrailDebug:        result.GuardrailDebug,
		Cost:                  result.Cost,
		AudioOutput:           result.AudioOutput,
		TranscriptionOutput:   result.TranscriptionOutput,
		ImageGenerationOutput: result.ImageGenerationOutput,
		PassthroughOutput:     result.PassthroughOutput,
		FinishReason:          result.FinishReason,
		RawResponse:           result.RawResponse,
	}

	// Handle tool calls if present
	if result.OutputMessage != nil && result.OutputMessage.ChatAssistantMessage != nil {
		data.ToolCalls = result.OutputMessage.ChatAssistantMessage.ToolCalls
	}

	resp := &streaming.ProcessedStreamResponse{
		RequestID:      result.RequestID,
		StreamType:     streamType,
		Provider:       result.Provider,
		RequestedModel: result.RequestedModel,
		ResolvedModel:  result.ResolvedModel,
		Data:           data,
	}

	if result.RawRequest != nil {
		rawReq := result.RawRequest
		resp.RawRequest = &rawReq
	}

	return resp
}

func mergeRealtimeMetadata(metadata map[string]interface{}, ctx *schemas.BifrostContext) map[string]interface{} {
	if ctx == nil {
		return metadata
	}
	set := func(key string, ctxKey schemas.BifrostContextKey) {
		if value := bifrost.GetStringFromContext(ctx, ctxKey); value != "" {
			if metadata == nil {
				metadata = make(map[string]interface{})
			}
			metadata[key] = value
		}
	}

	set("realtime_session_id", schemas.BifrostContextKeyRealtimeSessionID)
	set("provider_session_id", schemas.BifrostContextKeyRealtimeProviderSessionID)
	set("realtime_source", schemas.BifrostContextKeyRealtimeSource)
	set("realtime_event_type", schemas.BifrostContextKeyRealtimeEventType)
	set("realtime_transport", schemas.BifrostContextKeyRealtimeTransport)
	set("realtime_voice", schemas.BifrostContextKeyRealtimeVoice)
	if bifrost.GetStringFromContext(ctx, schemas.BifrostContextKeyRealtimeSessionID) != "" {
		if metadata == nil {
			metadata = make(map[string]interface{})
		}
		metadata["realtime"] = true
	}

	// Inject compression plugin token counts (RTK) into metadata when present.
	// These are set by the rtk plugin's PostLLMHook as int values on the context.
	if origTokens, ok := ctx.Value(schemas.BifrostContextKeyOriginalPromptTokens).(int); ok {
		if metadata == nil {
			metadata = make(map[string]interface{})
		}
		metadata["original_prompt_tokens"] = origTokens
	}
	if compTokens, ok := ctx.Value(schemas.BifrostContextKeyCompressedPromptTokens).(int); ok {
		if metadata == nil {
			metadata = make(map[string]interface{})
		}
		metadata["compressed_prompt_tokens"] = compTokens
	}

	// Inject RTK observability fields (techniques, filter matched, compression
	// ratio, raw output pointer). These power the "RTK compression" tab and
	// the metadata badges in the log detail view. All fields are optional —
	// they are only present when RTK ran and produced non-empty stats.
	if techniques, ok := ctx.Value(schemas.BifrostContextKeyRTKTechniques).([]string); ok && len(techniques) > 0 {
		if metadata == nil {
			metadata = make(map[string]interface{})
		}
		metadata["rtk_techniques"] = techniques
	}
	if filterMatched, ok := ctx.Value(schemas.BifrostContextKeyRTKFilterMatched).(string); ok && filterMatched != "" {
		if metadata == nil {
			metadata = make(map[string]interface{})
		}
		metadata["rtk_filter_matched"] = filterMatched
	}
	if ratio, ok := ctx.Value(schemas.BifrostContextKeyRTKCompressionRatio).(float64); ok {
		if metadata == nil {
			metadata = make(map[string]interface{})
		}
		metadata["rtk_compression_ratio"] = ratio
	}
	if rawOutputID, ok := ctx.Value(schemas.BifrostContextKeyRTKRawOutputID).(string); ok && rawOutputID != "" {
		if metadata == nil {
			metadata = make(map[string]interface{})
		}
		metadata["rtk_raw_output_id"] = rawOutputID
	}
	// PipelineScanned lets the log detail diff view distinguish "did not
	// participate" from "participated but not compressed" without storing any
	// message text. The original text for any compressed index is recovered
	// via rtk_raw_output_id (set above) or, when multiple tool outputs were
	// compressed, via rtk_raw_output_entries (one entry per compressed message
	// carrying the scanned index + its own pointer ID).
	if entries, ok := ctx.Value(schemas.BifrostContextKeyRTKRawOutputEntries).([]schemas.RTKRawOutputEntry); ok && len(entries) > 0 {
		if metadata == nil {
			metadata = make(map[string]interface{})
		}
		arr := make([]map[string]interface{}, len(entries))
		for i, e := range entries {
			arr[i] = map[string]interface{}{
				"index":    e.Index,
				"id":       e.ID,
				"bytes":    e.Bytes,
				"redacted": e.Redacted,
			}
		}
		metadata["rtk_raw_output_entries"] = arr
	}
	if scanned, ok := ctx.Value(schemas.BifrostContextKeyRTKPipelineScanned).([]int); ok && len(scanned) > 0 {
		if metadata == nil {
			metadata = make(map[string]interface{})
		}
		metadata["rtk_pipeline_scanned"] = scanned
	}

	return metadata
}

// coerceJSONForMetadata accepts any of the JSON value shapes that the RTK
// pipeline may store in the BifrostContext (map[string]any, []any,
// json.RawMessage, string, or []byte) and returns it as an interface{}
// suitable for the log entry metadata map.
//
// IMPORTANT: json.RawMessage / []byte must NOT be returned as a raw byte
// slice — the log store marshals metadata via sonic, which base64-encodes
// []byte. Instead the payload is parsed into a structured shape (map/slice)
// so it lands in the logs-db metadata as a nested JSON object the log detail
// view can consume directly. Invalid JSON falls back to the string form so
// no data is silently dropped. The boolean reports whether a non-nil value
// was extracted.
func coerceJSONForMetadata(v interface{}) (interface{}, bool) {
	if v == nil {
		return nil, false
	}
	switch t := v.(type) {
	case json.RawMessage:
		if len(t) == 0 {
			return nil, false
		}
		return decodeJSONBytes(t), true
	case string:
		if t == "" {
			return nil, false
		}
		// A string may itself be an embedded JSON payload (the RTK snapshot
		// builder sometimes stores the wire format as a string). Parse it so
		// the log entry keeps a structured shape; if it is not JSON, keep the
		// literal string.
		return decodeJSONString(t), true
	case []byte:
		if len(t) == 0 {
			return nil, false
		}
		return decodeJSONBytes(t), true
	case map[string]any, []any:
		return t, true
	}
	return nil, false
}

// decodeJSONBytes attempts to unmarshal raw JSON bytes into a structured
// value (map[string]any / []any); on failure it returns the bytes converted
// to a string so the metadata entry is non-nil and inspectable.
func decodeJSONBytes(raw []byte) interface{} {
	var out interface{}
	if err := json.Unmarshal(raw, &out); err == nil && out != nil {
		return out
	}
	return string(raw)
}

// decodeJSONString attempts to parse a string as JSON into a structured
// value; on failure it returns the original string unchanged.
func decodeJSONString(raw string) interface{} {
	var out interface{}
	if err := json.Unmarshal([]byte(raw), &out); err == nil && out != nil {
		return out
	}
	return raw
}

// formatRoutingEngineLogs formats routing engine logs into a human-readable string.
// Format: [timestamp] [engine] - message
// Parameters:
//   - logs: Slice of routing engine log entries
//
// Returns:
//   - string: Formatted log string (empty string if no logs)
func formatRoutingEngineLogs(logs []schemas.RoutingEngineLogEntry) string {
	if len(logs) == 0 {
		return ""
	}
	var sb strings.Builder
	for _, log := range logs {
		sb.WriteString(fmt.Sprintf("[%d] [%s] - %s\n", log.Timestamp, log.Engine, log.Message))
	}
	return sb.String()
}

// countRoutingEngineLogs returns the number of routing engine decision log
// entries encoded in a formatted log string (see formatRoutingEngineLogs).
// It must stay exactly consistent with the UI's
// `routing_engine_logs.split("\n").filter(Boolean).length`: empty strings (and
// strings of only newlines) count as 0, and a trailing newline does NOT add an
// extra entry.
func countRoutingEngineLogs(logs string) int {
	if logs == "" {
		return 0
	}
	count := 0
	for _, line := range strings.Split(logs, "\n") {
		if line != "" {
			count++
		}
	}
	return count
}
