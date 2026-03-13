export interface OrchestratorEnvConfig {
  port: number;
  serviceVersion: string;
  databaseUrl: string;
  dbSchema: string;
  adminSecret: string;
  hl7AgentUrl: string;
  terminologyServiceUrl: string;
  auditServiceUrl: string;
  errorBusUrl: string;
  dashboardUrl: string;
  terminologyReleaseId: string;
  hl7AgentVersion: string;
  enableReplay: boolean;
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() !== "false";
}

export function getOrchestratorEnvConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorEnvConfig {
  return {
    port: Number(env.PORT ?? 3000),
    serviceVersion: env.SERVICE_VERSION ?? "1.0.0",
    databaseUrl: env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/health_platform",
    dbSchema: env.ORCHESTRATOR_DB_SCHEMA ?? "orchestrator",
    adminSecret: env.ADMIN_SECRET ?? "dev-admin-secret",
    hl7AgentUrl: env.HL7_AGENT_URL ?? "http://hl7v2-agent:3001",
    terminologyServiceUrl: env.TERMINOLOGY_SERVICE_URL ?? "http://terminology-service:3002",
    auditServiceUrl: env.AUDIT_SERVICE_URL ?? "http://audit-service:3003",
    errorBusUrl: env.ERROR_BUS_URL ?? "http://error-bus:3004",
    dashboardUrl: env.DASHBOARD_URL ?? "http://dashboard:3005",
    terminologyReleaseId: env.TERMINOLOGY_RELEASE_ID ?? "terminology_2026_03",
    hl7AgentVersion: env.HL7_AGENT_VERSION ?? "1.0.0",
    enableReplay: toBoolean(env.ENABLE_REPLAY_ENDPOINT, true)
  };
}
