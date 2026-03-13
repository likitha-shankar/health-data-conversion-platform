import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

export interface ApiKeyRecord {
  key_id: string;
  key_hash: string;
  key_prefix: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  is_active: boolean;
}

export interface OrchestratorDbConfig {
  databaseUrl: string;
  schema: string;
  migrationsDir?: string;
}

function resolveDefaultMigrationsDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "../migrations");
}

export class OrchestratorRepository {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly migrationsDir: string;

  constructor(config: OrchestratorDbConfig) {
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

  async findActiveByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const result = await this.pool.query<ApiKeyRecord>(
      `
      SELECT key_id, key_hash, key_prefix, label, created_at, last_used_at, is_active
      FROM ${this.schema}.api_keys
      WHERE key_hash = $1
        AND is_active = true
      LIMIT 1
      `,
      [keyHash]
    );
    return result.rows[0] ?? null;
  }

  async touchLastUsed(keyId: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE ${this.schema}.api_keys
      SET last_used_at = NOW()
      WHERE key_id = $1
      `,
      [keyId]
    );
  }

  async insertApiKey(keyHash: string, keyPrefix: string, label?: string): Promise<ApiKeyRecord> {
    const result = await this.pool.query<ApiKeyRecord>(
      `
      INSERT INTO ${this.schema}.api_keys (key_hash, key_prefix, label)
      VALUES ($1, $2, $3)
      RETURNING key_id, key_hash, key_prefix, label, created_at, last_used_at, is_active
      `,
      [keyHash, keyPrefix, label ?? null]
    );
    return result.rows[0];
  }

  async ensureApiKey(keyHash: string, keyPrefix: string, label?: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO ${this.schema}.api_keys (key_hash, key_prefix, label)
      VALUES ($1, $2, $3)
      ON CONFLICT (key_hash) DO NOTHING
      `,
      [keyHash, keyPrefix, label ?? null]
    );
  }

  async listApiKeys(): Promise<Array<Omit<ApiKeyRecord, "key_hash">>> {
    const result = await this.pool.query<Omit<ApiKeyRecord, "key_hash">>(
      `
      SELECT key_id, key_prefix, label, created_at, last_used_at, is_active
      FROM ${this.schema}.api_keys
      ORDER BY created_at DESC
      `
    );
    return result.rows;
  }

  async deactivateApiKey(keyId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
      UPDATE ${this.schema}.api_keys
      SET is_active = false
      WHERE key_id = $1
      `,
      [keyId]
    );
    return (result.rowCount ?? 0) > 0;
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
      if (applied.has(version)) continue;

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
