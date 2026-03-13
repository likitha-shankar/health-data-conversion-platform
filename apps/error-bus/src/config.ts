export interface ErrorBusConfig {
  port: number;
  serviceVersion: string;
  databaseUrl: string;
  dbSchema: string;
}

export function getErrorBusConfig(env: NodeJS.ProcessEnv = process.env): ErrorBusConfig {
  return {
    port: Number(env.PORT ?? 3004),
    serviceVersion: env.SERVICE_VERSION ?? "1.0.0",
    databaseUrl: env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/health_platform",
    dbSchema: env.ERROR_DB_SCHEMA ?? "error_bus"
  };
}
