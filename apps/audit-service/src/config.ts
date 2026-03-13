export interface AuditServiceConfig {
  port: number;
  serviceVersion: string;
  databaseUrl: string;
  dbSchema: string;
}

export function getAuditServiceConfig(env: NodeJS.ProcessEnv = process.env): AuditServiceConfig {
  return {
    port: Number(env.PORT ?? 3003),
    serviceVersion: env.SERVICE_VERSION ?? "1.0.0",
    databaseUrl: env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/health_platform",
    dbSchema: env.AUDIT_DB_SCHEMA ?? "audit"
  };
}
