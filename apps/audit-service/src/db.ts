import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

export interface AuditEvent {
  audit_event_id: string;
  ingestion_id: string;
  trace_id: string;
  agent_id: string;
  agent_version: string;
  source_format: string;
  target_format: string;
  transformation_step: string;
  status_transition: string;
  raw_payload_ref?: string | null;
  context_json?: string | null;
  created_at?: string;
}

export interface StoredPayload {
  payload_id: string;
  ingestion_id: string;
  raw_payload: string;
  content_type: string;
  stored_at?: string;
}

export interface AuditRepositoryConfig {
  databaseUrl: string;
  schema: string;
  migrationsDir?: string;
}

function resolveDefaultMigrationsDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "../migrations");
}

export class AuditRepository {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly migrationsDir: string;

  constructor(config: AuditRepositoryConfig) {
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

  async insert(event: AuditEvent): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO ${this.schema}.audit_events (
        audit_event_id,
        ingestion_id,
        trace_id,
        agent_id,
        agent_version,
        source_format,
        target_format,
        transformation_step,
        status_transition,
        raw_payload_ref,
        context_json,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `,
      [
        event.audit_event_id,
        event.ingestion_id,
        event.trace_id,
        event.agent_id,
        event.agent_version,
        event.source_format,
        event.target_format,
        event.transformation_step,
        event.status_transition,
        event.raw_payload_ref ?? null,
        event.context_json ?? null,
        event.created_at ?? new Date().toISOString()
      ]
    );
  }

  async storePayload(payload: StoredPayload): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO ${this.schema}.payloads (
        payload_id,
        ingestion_id,
        raw_payload,
        content_type,
        stored_at
      ) VALUES ($1, $2, $3, $4, $5)
      `,
      [
        payload.payload_id,
        payload.ingestion_id,
        payload.raw_payload,
        payload.content_type,
        payload.stored_at ?? new Date().toISOString()
      ]
    );
  }

  async getPayloadByIngestionId(ingestionId: string): Promise<StoredPayload | null> {
    const result = await this.pool.query<StoredPayload>(
      `
      SELECT payload_id, ingestion_id, raw_payload, content_type, stored_at
      FROM ${this.schema}.payloads
      WHERE ingestion_id = $1
      ORDER BY stored_at DESC, id DESC
      LIMIT 1
      `,
      [ingestionId]
    );

    return result.rows[0] ?? null;
  }

  async getByIngestionId(ingestionId: string): Promise<AuditEvent[]> {
    const result = await this.pool.query<AuditEvent>(
      `
      SELECT
        audit_event_id,
        ingestion_id,
        trace_id,
        agent_id,
        agent_version,
        source_format,
        target_format,
        transformation_step,
        status_transition,
        raw_payload_ref,
        context_json,
        created_at
      FROM ${this.schema}.audit_events
      WHERE ingestion_id = $1
      ORDER BY created_at ASC, id ASC
      `,
      [ingestionId]
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
