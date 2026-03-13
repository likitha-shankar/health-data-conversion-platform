CREATE TABLE IF NOT EXISTS {{schema}}.audit_events (
  id SERIAL PRIMARY KEY,
  audit_event_id TEXT NOT NULL,
  ingestion_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  source_format TEXT NOT NULL,
  target_format TEXT NOT NULL,
  transformation_step TEXT NOT NULL,
  status_transition TEXT NOT NULL,
  raw_payload_ref TEXT,
  context_json TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS {{schema}}.payloads (
  id SERIAL PRIMARY KEY,
  payload_id TEXT NOT NULL,
  ingestion_id TEXT NOT NULL,
  raw_payload TEXT NOT NULL,
  content_type TEXT NOT NULL,
  stored_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_ingestion_created
  ON {{schema}}.audit_events (ingestion_id, created_at);

CREATE INDEX IF NOT EXISTS idx_payload_ingestion
  ON {{schema}}.payloads (ingestion_id, stored_at);
