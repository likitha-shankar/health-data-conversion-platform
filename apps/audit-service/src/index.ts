import { createAuditApp } from "./app.js";
import { getAuditServiceConfig } from "./config.js";
import { AuditRepository } from "./db.js";

const config = getAuditServiceConfig();
const repository = new AuditRepository({
  databaseUrl: config.databaseUrl,
  schema: config.dbSchema
});

await repository.init();

const app = createAuditApp(repository, config.serviceVersion);
app.listen(config.port, () => {
  console.log(`audit-service listening on ${config.port}`);
});
