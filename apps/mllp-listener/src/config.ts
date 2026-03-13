export interface MllpListenerConfig {
  mllpPort: number;
  orchestratorUrl: string;
  mllpApiKey: string;
  defaultTargetFormat: string;
}

export function getMllpConfig(env: NodeJS.ProcessEnv = process.env): MllpListenerConfig {
  return {
    mllpPort: Number(env.MLLP_PORT ?? 2575),
    orchestratorUrl: env.ORCHESTRATOR_URL ?? "http://localhost:3000",
    mllpApiKey: env.MLLP_API_KEY ?? "",
    defaultTargetFormat: env.MLLP_DEFAULT_TARGET_FORMAT ?? "fhir_r4"
  };
}
