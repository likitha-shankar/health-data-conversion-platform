import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

export interface ErrorRecord {
  id?: number;
  error_code: string;
  error_category: string;
  layer: string;
  severity: string;
  is_retryable: boolean;
  requires_human_review: boolean;
  ingestion_id: string;
  trace_id: string;
  source_system_id?: string;
  source_format: string;
  target_format: string;
  timestamp: string;
  layer_context: string;
  resolved_at?: string | null;
  resolution_action?: "approved" | "rejected" | null;
}

export interface ErrorRepositoryConfig {
  databaseUrl: string;
  schema: string;
  migrationsDir?: string;
}

function resolveDefaultMigrationsDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "../migrations");
}

export class ErrorRepository {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly migrationsDir: string;

  constructor(config: ErrorRepositoryConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl });
    this.schema = config.schema;
    this.migrationsDir = config.migrationsDir ?? resolveDefaultMigrationsDir();
  }

  async init(): Promise<void> {
    await this.runMigrations();
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async insert(error: ErrorRecord): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO ${this.schema}.errors (
        error_code,
        error_category,
        layer,
        severity,
        is_retryable,
        requires_human_review,
        ingestion_id,
        trace_id,
        source_system_id,
        source_format,
        target_format,
        timestamp,
        layer_context,
        resolved_at,
        resolution_action
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      `,
      [
        error.error_code,
        error.error_category,
        error.layer,
        error.severity,
        error.is_retryable,
        error.requires_human_review,
        error.ingestion_id,
        error.trace_id,
        error.source_system_id ?? null,
        error.source_format,
        error.target_format,
        error.timestamp,
        error.layer_context,
        error.resolved_at ?? null,
        error.resolution_action ?? null
      ]
    );
  }

  async resolveById(id: number, resolutionAction: "approved" | "rejected"): Promise<boolean> {
    const result = await this.pool.query(
      `
      UPDATE ${this.schema}.errors
      SET resolved_at = NOW(),
          resolution_action = $2
      WHERE id = $1
      `,
      [id, resolutionAction]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getByIngestionId(ingestionId: string): Promise<ErrorRecord[]> {
    const result = await this.pool.query<ErrorRecord>(
      `
      SELECT
        id,
        error_code,
        error_category,
        layer,
        severity,
        is_retryable,
        requires_human_review,
        ingestion_id,
        trace_id,
        source_system_id,
        source_format,
        target_format,
        timestamp,
        layer_context,
        resolved_at,
        resolution_action
      FROM ${this.schema}.errors
      WHERE ingestion_id = $1
      ORDER BY timestamp ASC, id ASC
      `,
      [ingestionId]
    );

    return result.rows;
  }

  async getByErrorCode(errorCode: string): Promise<ErrorRecord[]> {
    const result = await this.pool.query<ErrorRecord>(
      `
      SELECT
        id,
        error_code,
        error_category,
        layer,
        severity,
        is_retryable,
        requires_human_review,
        ingestion_id,
        trace_id,
        source_system_id,
        source_format,
        target_format,
        timestamp,
        layer_context,
        resolved_at,
        resolution_action
      FROM ${this.schema}.errors
      WHERE error_code = $1
      ORDER BY timestamp DESC, id DESC
      `,
      [errorCode]
    );

    return result.rows;
  }

  async getReviewQueue(): Promise<ErrorRecord[]> {
    const result = await this.pool.query<ErrorRecord>(
      `
      SELECT
        id,
        error_code,
        error_category,
        layer,
        severity,
        is_retryable,
        requires_human_review,
        ingestion_id,
        trace_id,
        source_system_id,
        source_format,
        target_format,
        timestamp,
        layer_context,
        resolved_at,
        resolution_action
      FROM ${this.schema}.errors
      WHERE requires_human_review = true
        AND resolved_at IS NULL
      ORDER BY timestamp ASC, id ASC
      `
    );

    return result.rows;
  }

  private async runMigrations(): Promise<void> {
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

    const migrationFiles = fs
      .readdirSync(this.migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b));

    for (const file of migrationFiles) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) {
        continue;
      }

      const migrationPath = path.join(this.migrationsDir, file);
      const sql = fs.readFileSync(migrationPath, "utf-8").replaceAll("{{schema}}", this.schema);

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
}
