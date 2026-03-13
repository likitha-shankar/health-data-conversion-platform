CREATE TABLE IF NOT EXISTS {{schema}}.concept (
  concept_id INTEGER PRIMARY KEY,
  concept_name TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  vocabulary_id TEXT NOT NULL,
  concept_class_id TEXT NOT NULL,
  standard_concept TEXT,
  concept_code TEXT NOT NULL,
  valid_start_date DATE NOT NULL,
  valid_end_date DATE NOT NULL,
  invalid_reason TEXT
);

CREATE TABLE IF NOT EXISTS {{schema}}.concept_relationship (
  concept_id_1 INTEGER NOT NULL,
  concept_id_2 INTEGER NOT NULL,
  relationship_id TEXT NOT NULL,
  valid_start_date DATE NOT NULL,
  valid_end_date DATE NOT NULL,
  invalid_reason TEXT
);

CREATE TABLE IF NOT EXISTS {{schema}}.concept_synonym (
  concept_id INTEGER NOT NULL,
  concept_synonym_name TEXT NOT NULL,
  language_concept_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS {{schema}}.vocabulary_load_metadata (
  id SERIAL PRIMARY KEY,
  release_id TEXT NOT NULL,
  source TEXT NOT NULL,
  loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_concept_vocab_code ON {{schema}}.concept (vocabulary_id, concept_code);
CREATE INDEX IF NOT EXISTS idx_concept_vocab_name ON {{schema}}.concept (vocabulary_id, concept_name);
CREATE INDEX IF NOT EXISTS idx_concept_rel_c1 ON {{schema}}.concept_relationship (concept_id_1, relationship_id);
CREATE INDEX IF NOT EXISTS idx_concept_synonym_cid ON {{schema}}.concept_synonym (concept_id);
