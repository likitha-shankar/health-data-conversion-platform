CREATE TABLE IF NOT EXISTS {{schema}}.errors (
  id SERIAL PRIMARY KEY,
  error_code TEXT NOT NULL,
  error_category TEXT NOT NULL,
  layer TEXT NOT NULL,
  severity TEXT NOT NULL,
  is_retryable BOOLEAN NOT NULL,
  requires_human_review BOOLEAN NOT NULL,
  ingestion_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  source_system_id TEXT,
  source_format TEXT NOT NULL,
  target_format TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  layer_context TEXT NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolution_action TEXT
);

CREATE INDEX IF NOT EXISTS idx_error_ingestion
  ON {{schema}}.errors (ingestion_id);

CREATE INDEX IF NOT EXISTS idx_error_code
  ON {{schema}}.errors (error_code);

CREATE INDEX IF NOT EXISTS idx_error_review_queue
  ON {{schema}}.errors (requires_human_review, resolved_at);
