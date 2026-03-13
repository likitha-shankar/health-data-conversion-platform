export interface TerminologyServiceConfig {
  port: number;
  serviceVersion: string;
  releaseId: string;
  enableTier2Embedding: boolean;
  databaseUrl: string;
  dbSchema: string;
  athenaVocabDir: string;
  athenaDownloadUrl?: string;
  autoLoadOnStart: boolean;
  indexMaxRows: number;
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() !== "false";
}

export function getTerminologyServiceConfig(env: NodeJS.ProcessEnv = process.env): TerminologyServiceConfig {
  return {
    port: Number(env.PORT ?? 3002),
    serviceVersion: env.SERVICE_VERSION ?? "1.0.0",
    releaseId: env.TERMINOLOGY_RELEASE_ID ?? "terminology-v1.0.0",
    enableTier2Embedding: toBoolean(env.ENABLE_TIER2_EMBEDDING, true),
    databaseUrl: env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/health_platform",
    dbSchema: env.TERMINOLOGY_DB_SCHEMA ?? "terminology",
    athenaVocabDir: env.ATHENA_VOCAB_DIR ?? "/app/data/athena",
    athenaDownloadUrl: env.ATHENA_DOWNLOAD_URL,
    autoLoadOnStart: toBoolean(env.TERMINOLOGY_AUTOLOAD_ON_START, false),
    indexMaxRows: Number(env.TERMINOLOGY_INDEX_MAX_ROWS ?? 250000)
  };
}
