export interface Hl7AgentConfig {
  port: number;
  terminologyServiceUrl: string;
  auditServiceUrl: string;
}

export function getHl7AgentConfig(env: NodeJS.ProcessEnv = process.env): Hl7AgentConfig {
  return {
    port: Number(env.PORT ?? 3001),
    terminologyServiceUrl: env.TERMINOLOGY_SERVICE_URL ?? "http://terminology-service:3002",
    auditServiceUrl: env.AUDIT_SERVICE_URL ?? "http://audit-service:3003"
  };
}
