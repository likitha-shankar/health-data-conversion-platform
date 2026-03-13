import { createOrchestratorApp } from "./app.js";
import { hashKey } from "./auth.js";
import { getOrchestratorEnvConfig } from "./config.js";
import { OrchestratorRepository } from "./db.js";

const config = getOrchestratorEnvConfig();
const repository = new OrchestratorRepository({
  databaseUrl: config.databaseUrl,
  schema: config.dbSchema
});
await repository.init();
if (process.env.MLLP_API_KEY) {
  await repository.ensureApiKey(hashKey(process.env.MLLP_API_KEY), process.env.MLLP_API_KEY.slice(0, 8), "mllp-listener");
}

const app = createOrchestratorApp({
  serviceVersion: config.serviceVersion,
  repository,
  adminSecret: config.adminSecret,
  hl7AgentUrl: config.hl7AgentUrl,
  terminologyServiceUrl: config.terminologyServiceUrl,
  auditServiceUrl: config.auditServiceUrl,
  errorBusUrl: config.errorBusUrl,
  dashboardUrl: config.dashboardUrl,
  terminologyReleaseId: config.terminologyReleaseId,
  hl7AgentVersion: config.hl7AgentVersion,
  enableReplay: config.enableReplay
});

app.listen(config.port, () => {
  console.log(`orchestrator listening on ${config.port}`);
});
