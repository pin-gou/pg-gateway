package tables

import "time"

// ModelListCacheAll is the cache row key for the aggregate GET /v1/models list
// (all configured providers, no ?provider= narrowing). It is intentionally a
// small, stable sentinel so the handler and store agree without importing each
// other's constants.
const ModelListCacheAll = "__all__"

// TableModelListCache is a DB-backed cache of the fully-aggregated /v1/models
// response. The /v1/models handler reads this row first and only falls back to
// fanning out to every provider when no row exists (cold cache). Rows are
// invalidated by any provider or key config write, so the cached list can never
// drift from the configured provider/key set.
type TableModelListCache struct {
	Provider        string    `gorm:"primaryKey;type:varchar(50)" json:"provider"`
	ModelsJSON      string    `gorm:"type:text;not null" json:"-"`
	KeyStatusesJSON string    `gorm:"type:text;not null" json:"-"`
	UpdatedAt       time.Time `gorm:"index;not null" json:"updated_at"`
}

// TableName sets the table name for the model list cache.
func (TableModelListCache) TableName() string { return "config_model_list_cache" }
