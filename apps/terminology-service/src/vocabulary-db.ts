import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { from as copyFrom } from "pg-copy-streams";
import { Pool, type PoolClient } from "pg";
import type { TerminologySystem } from "./rules.js";
import { SYSTEM_TO_VOCABULARY, VOCABULARY_TO_SYSTEM } from "./rules.js";

interface DbConfig {
  databaseUrl: string;
  schema: string;
  migrationDir?: string;
}

export interface VocabularyLookupResult {
  source_system: TerminologySystem;
  source_code: string;
  source_display: string;
  target_system: TerminologySystem;
  target_code: string;
  target_display: string;
  context_domain: string;
  unit: string | null;
}

export interface Tier1Match {
  mapped_code: string;
  mapped_display: string;
  mapped_system: TerminologySystem;
}

function defaultMigrationDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "../migrations");
}

function normalizeSystemVocabulary(system: TerminologySystem): string | null {
  if (system === "LOCAL") return null;
  return SYSTEM_TO_VOCABULARY[system];
}

function inferContextDomain(domainId: string): string {
  const normalized = domainId.toLowerCase();
  if (normalized === "condition") return "diagnosis";
  if (normalized === "drug") return "medication";
  if (normalized === "measurement") return "lab";
  if (normalized === "observation") return "vital";
  if (normalized === "procedure") return "procedure";
  return "administrative";
}

function mapUnitFromConceptName(conceptName: string): string | null {
  const lower = conceptName.toLowerCase();
  if (lower.includes("mg/dl")) return "mg/dL";
  if (lower.includes("mmol/l")) return "mmol/L";
  if (lower.includes("g/dl")) return "g/dL";
  if (lower.includes("10*3/ul")) return "10*3/uL";
  if (lower.includes("%")) return "%";
  if (lower.includes("iu")) return "u[IU]/mL";
  return null;
}

export class VocabularyDb {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly migrationDir: string;

  constructor(config: DbConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl });
    this.schema = config.schema;
    this.migrationDir = config.migrationDir ?? defaultMigrationDir();
  }

  async init(): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.schema}.schema_migrations (
        id SERIAL PRIMARY KEY,
        version TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const appliedResult = await this.pool.query<{ version: string }>(
      `SELECT version FROM ${this.schema}.schema_migrations`
    );
    const applied = new Set(appliedResult.rows.map((row: { version: string }) => row.version));

    const files = fs
      .readdirSync(this.migrationDir)
      .filter((file) => file.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b));

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) continue;

      const sql = fs
        .readFileSync(path.join(this.migrationDir, file), "utf-8")
        .replaceAll("{{schema}}", this.schema);

      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          `INSERT INTO ${this.schema}.schema_migrations (version, file_name) VALUES ($1, $2)`,
          [version, file]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async getStats(): Promise<Record<string, number>> {
    const result = await this.pool.query<{ vocabulary_id: string; count: string }>(
      `
      SELECT vocabulary_id, COUNT(*)::text AS count
      FROM ${this.schema}.concept
      GROUP BY vocabulary_id
      ORDER BY vocabulary_id ASC
      `
    );

    const output: Record<string, number> = {};
    for (const row of result.rows) {
      output[row.vocabulary_id] = Number.parseInt(row.count, 10);
    }
    return output;
  }

  async getConceptCount(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${this.schema}.concept`
    );
    return Number.parseInt(result.rows[0]?.count ?? "0", 10);
  }

  async getLoadState(): Promise<{
    conceptCount: number;
    relationshipCount: number;
    synonymCount: number;
    loadMetadataCount: number;
  }> {
    const result = await this.pool.query<{
      concept_count: string;
      relationship_count: string;
      synonym_count: string;
      load_metadata_count: string;
    }>(
      `
      SELECT
        (SELECT COUNT(*)::text FROM ${this.schema}.concept) AS concept_count,
        (SELECT COUNT(*)::text FROM ${this.schema}.concept_relationship) AS relationship_count,
        (SELECT COUNT(*)::text FROM ${this.schema}.concept_synonym) AS synonym_count,
        (SELECT COUNT(*)::text FROM ${this.schema}.vocabulary_load_metadata) AS load_metadata_count
      `
    );
    const row = result.rows[0];
    return {
      conceptCount: Number.parseInt(row?.concept_count ?? "0", 10),
      relationshipCount: Number.parseInt(row?.relationship_count ?? "0", 10),
      synonymCount: Number.parseInt(row?.synonym_count ?? "0", 10),
      loadMetadataCount: Number.parseInt(row?.load_metadata_count ?? "0", 10)
    };
  }

  async lookupByCodeAndSystem(code: string, system: TerminologySystem): Promise<VocabularyLookupResult[]> {
    const sourceVocabulary = normalizeSystemVocabulary(system);
    if (!sourceVocabulary) return [];

    const sourceResult = await this.pool.query<{
      concept_id: number;
      concept_code: string;
      concept_name: string;
      domain_id: string;
    }>(
      `
      SELECT concept_id, concept_code, concept_name, domain_id
      FROM ${this.schema}.concept
      WHERE vocabulary_id = $1
        AND LOWER(concept_code) = LOWER($2)
      ORDER BY invalid_reason NULLS FIRST
      LIMIT 1
      `,
      [sourceVocabulary, code]
    );

    const source = sourceResult.rows[0];
    if (!source) return [];

    const relationshipMatches = await this.pool.query<{
      concept_code: string;
      concept_name: string;
      vocabulary_id: string;
    }>(
      `
      SELECT target.concept_code, target.concept_name, target.vocabulary_id
      FROM ${this.schema}.concept_relationship rel
      JOIN ${this.schema}.concept target
        ON target.concept_id = rel.concept_id_2
      WHERE rel.concept_id_1 = $1
        AND rel.relationship_id = 'Maps to'
        AND target.vocabulary_id IN ('SNOMED', 'LOINC', 'ICD10CM', 'RxNorm')
      `,
      [source.concept_id]
    );

    return relationshipMatches.rows
      .map((target) => {
        const targetSystem = VOCABULARY_TO_SYSTEM[target.vocabulary_id];
        if (!targetSystem) return null;
        return {
          source_system: system,
          source_code: source.concept_code,
          source_display: source.concept_name,
          target_system: targetSystem,
          target_code: target.concept_code,
          target_display: target.concept_name,
          context_domain: inferContextDomain(source.domain_id),
          unit: mapUnitFromConceptName(source.concept_name)
        } as VocabularyLookupResult;
      })
      .filter((row): row is VocabularyLookupResult => row !== null);
  }

  async tier1MapByCode(
    code: string,
    sourceSystem: TerminologySystem,
    targetSystem: TerminologySystem
  ): Promise<Tier1Match | null> {
    const sourceVocabulary = normalizeSystemVocabulary(sourceSystem);
    const targetVocabulary = normalizeSystemVocabulary(targetSystem);
    if (!sourceVocabulary || !targetVocabulary) return null;

    const sourceResult = await this.pool.query<{
      concept_id: number;
      concept_code: string;
      concept_name: string;
    }>(
      `
      SELECT concept_id, concept_code, concept_name
      FROM ${this.schema}.concept
      WHERE vocabulary_id = $1
        AND LOWER(concept_code) = LOWER($2)
        AND invalid_reason IS NULL
      ORDER BY concept_id ASC
      LIMIT 1
      `,
      [sourceVocabulary, code]
    );
    const source = sourceResult.rows[0];
    if (!source) return null;

    if (sourceVocabulary === targetVocabulary) {
      return {
        mapped_code: source.concept_code,
        mapped_display: source.concept_name,
        mapped_system: targetSystem
      };
    }

    const targetResult = await this.pool.query<{
      concept_code: string;
      concept_name: string;
    }>(
      `
      SELECT target.concept_code, target.concept_name
      FROM ${this.schema}.concept_relationship rel
      JOIN ${this.schema}.concept target
        ON target.concept_id = rel.concept_id_2
      WHERE rel.concept_id_1 = $1
        AND rel.relationship_id = 'Maps to'
        AND target.vocabulary_id = $2
        AND target.invalid_reason IS NULL
      ORDER BY target.standard_concept DESC NULLS LAST, target.concept_id ASC
      LIMIT 1
      `,
      [source.concept_id, targetVocabulary]
    );

    const target = targetResult.rows[0];
    if (!target) return null;

    return {
      mapped_code: target.concept_code,
      mapped_display: target.concept_name,
      mapped_system: targetSystem
    };
  }

  async getIndexRows(
    limit?: number
  ): Promise<Array<{ code: string; display: string; system: Exclude<TerminologySystem, "LOCAL">; domain: string }>> {
    const rows = await this.pool.query<{
      concept_code: string;
      concept_name: string;
      vocabulary_id: string;
      domain_id: string;
      synonym: string | null;
    }>(
      `
      SELECT concept_code, concept_name, vocabulary_id, domain_id, synonym
      FROM (
        SELECT c.concept_code,
               c.concept_name,
               c.vocabulary_id,
               c.domain_id,
               NULL::text AS synonym
        FROM ${this.schema}.concept c
        WHERE c.vocabulary_id IN ('SNOMED', 'LOINC', 'ICD10CM', 'RxNorm')
          AND c.invalid_reason IS NULL
        UNION ALL
        SELECT c.concept_code,
               c.concept_name,
               c.vocabulary_id,
               c.domain_id,
               cs.concept_synonym_name AS synonym
        FROM ${this.schema}.concept c
        JOIN ${this.schema}.concept_synonym cs
          ON cs.concept_id = c.concept_id
        WHERE c.vocabulary_id IN ('SNOMED', 'LOINC', 'ICD10CM', 'RxNorm')
          AND c.invalid_reason IS NULL
      ) idx
      ORDER BY
        CASE idx.vocabulary_id
          WHEN 'LOINC' THEN 0
          WHEN 'SNOMED' THEN 1
          WHEN 'RxNorm' THEN 2
          WHEN 'ICD10CM' THEN 3
          ELSE 4
        END,
        CASE idx.domain_id
          WHEN 'Measurement' THEN 0
          WHEN 'Observation' THEN 1
          WHEN 'Condition' THEN 2
          WHEN 'Drug' THEN 3
          WHEN 'Procedure' THEN 4
          ELSE 5
        END,
        idx.concept_code ASC
      ${limit && limit > 0 ? `LIMIT ${limit}` : ""}
      `
    );

    return rows.rows
      .map((row) => {
        const system = VOCABULARY_TO_SYSTEM[row.vocabulary_id];
        if (!system) return null;
        return {
          code: row.concept_code,
          display: row.synonym || row.concept_name,
          system,
          domain: row.domain_id
        };
      })
      .filter(
        (row): row is { code: string; display: string; system: Exclude<TerminologySystem, "LOCAL">; domain: string } =>
          row !== null
      );
  }

  async loadVocabularyFromDirectory(directory: string, releaseId: string): Promise<void> {
    const conceptPath = path.join(directory, "CONCEPT.csv");
    const relationshipPath = path.join(directory, "CONCEPT_RELATIONSHIP.csv");
    const synonymPath = path.join(directory, "CONCEPT_SYNONYM.csv");

    if (!fs.existsSync(conceptPath) || !fs.existsSync(relationshipPath) || !fs.existsSync(synonymPath)) {
      throw new Error("Missing Athena OMOP CSV files (CONCEPT.csv, CONCEPT_RELATIONSHIP.csv, CONCEPT_SYNONYM.csv)");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `
        CREATE UNLOGGED TABLE IF NOT EXISTS ${this.schema}.staging_concept (
          concept_id TEXT,
          concept_name TEXT,
          domain_id TEXT,
          vocabulary_id TEXT,
          concept_class_id TEXT,
          standard_concept TEXT,
          concept_code TEXT,
          valid_start_date TEXT,
          valid_end_date TEXT,
          invalid_reason TEXT
        )
        `
      );
      await client.query(
        `
        CREATE UNLOGGED TABLE IF NOT EXISTS ${this.schema}.staging_concept_relationship (
          concept_id_1 TEXT,
          concept_id_2 TEXT,
          relationship_id TEXT,
          valid_start_date TEXT,
          valid_end_date TEXT,
          invalid_reason TEXT
        )
        `
      );
      await client.query(
        `
        CREATE UNLOGGED TABLE IF NOT EXISTS ${this.schema}.staging_concept_synonym (
          concept_id TEXT,
          concept_synonym_name TEXT,
          language_concept_id TEXT
        )
        `
      );

      await client.query(`TRUNCATE TABLE ${this.schema}.staging_concept`);
      await client.query(`TRUNCATE TABLE ${this.schema}.staging_concept_relationship`);
      await client.query(`TRUNCATE TABLE ${this.schema}.staging_concept_synonym`);
      await client.query(`TRUNCATE TABLE ${this.schema}.concept_synonym`);
      await client.query(`TRUNCATE TABLE ${this.schema}.concept_relationship`);
      await client.query(`TRUNCATE TABLE ${this.schema}.concept`);

      console.log("terminology: bulk loading CONCEPT.csv...");
      await this.copyTsvIntoTable(client, conceptPath, `${this.schema}.staging_concept`, [
        "concept_id",
        "concept_name",
        "domain_id",
        "vocabulary_id",
        "concept_class_id",
        "standard_concept",
        "concept_code",
        "valid_start_date",
        "valid_end_date",
        "invalid_reason"
      ]);

      console.log("terminology: bulk loading CONCEPT_RELATIONSHIP.csv...");
      await this.copyTsvIntoTable(client, relationshipPath, `${this.schema}.staging_concept_relationship`, [
        "concept_id_1",
        "concept_id_2",
        "relationship_id",
        "valid_start_date",
        "valid_end_date",
        "invalid_reason"
      ]);

      console.log("terminology: bulk loading CONCEPT_SYNONYM.csv...");
      await this.copyTsvIntoTable(client, synonymPath, `${this.schema}.staging_concept_synonym`, [
        "concept_id",
        "concept_synonym_name",
        "language_concept_id"
      ]);

      console.log("terminology: materializing filtered vocabulary tables...");
      await client.query(
        `
        INSERT INTO ${this.schema}.concept (
          concept_id, concept_name, domain_id, vocabulary_id, concept_class_id,
          standard_concept, concept_code, valid_start_date, valid_end_date, invalid_reason
        )
        SELECT
          sc.concept_id::integer,
          sc.concept_name,
          sc.domain_id,
          sc.vocabulary_id,
          sc.concept_class_id,
          NULLIF(sc.standard_concept, ''),
          sc.concept_code,
          sc.valid_start_date::date,
          sc.valid_end_date::date,
          NULLIF(sc.invalid_reason, '')
        FROM ${this.schema}.staging_concept sc
        WHERE sc.vocabulary_id IN ('SNOMED', 'LOINC', 'RxNorm', 'ICD10CM')
          AND sc.concept_id ~ '^[0-9]+$'
          AND sc.valid_start_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND sc.valid_end_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        `
      );

      await client.query(
        `
        INSERT INTO ${this.schema}.concept_relationship (
          concept_id_1, concept_id_2, relationship_id, valid_start_date, valid_end_date, invalid_reason
        )
        SELECT
          sr.concept_id_1::integer,
          sr.concept_id_2::integer,
          sr.relationship_id,
          sr.valid_start_date::date,
          sr.valid_end_date::date,
          NULLIF(sr.invalid_reason, '')
        FROM ${this.schema}.staging_concept_relationship sr
        JOIN ${this.schema}.concept source_concept
          ON source_concept.concept_id = sr.concept_id_1::integer
        JOIN ${this.schema}.concept target_concept
          ON target_concept.concept_id = sr.concept_id_2::integer
        WHERE sr.relationship_id = 'Maps to'
          AND sr.concept_id_1 ~ '^[0-9]+$'
          AND sr.concept_id_2 ~ '^[0-9]+$'
          AND sr.valid_start_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND sr.valid_end_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        `
      );

      await client.query(
        `
        INSERT INTO ${this.schema}.concept_synonym (
          concept_id, concept_synonym_name, language_concept_id
        )
        SELECT
          ss.concept_id::integer,
          ss.concept_synonym_name,
          ss.language_concept_id::integer
        FROM ${this.schema}.staging_concept_synonym ss
        JOIN ${this.schema}.concept concept_ref
          ON concept_ref.concept_id = ss.concept_id::integer
        WHERE ss.concept_id ~ '^[0-9]+$'
          AND ss.language_concept_id ~ '^[0-9]+$'
        `
      );

      await client.query(
        `
        INSERT INTO ${this.schema}.vocabulary_load_metadata (release_id, source)
        VALUES ($1, $2)
        `,
        [releaseId, directory]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async copyTsvIntoTable(
    client: PoolClient,
    filePath: string,
    tableName: string,
    columns: string[]
  ): Promise<void> {
    const copySql = `COPY ${tableName} (${columns.join(", ")}) FROM STDIN WITH (FORMAT csv, HEADER true, DELIMITER E'\\t')`;
    const pgStream = client.query(copyFrom(copySql));
    await pipeline(fs.createReadStream(filePath), pgStream);
  }
}
