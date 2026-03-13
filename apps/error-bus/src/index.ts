import { createErrorBusApp } from "./app.js";
import { getErrorBusConfig } from "./config.js";
import { ErrorRepository } from "./db.js";

const config = getErrorBusConfig();
const repository = new ErrorRepository({
  databaseUrl: config.databaseUrl,
  schema: config.dbSchema
});

await repository.init();

const app = createErrorBusApp(repository, config.serviceVersion);
app.listen(config.port, () => {
  console.log(`error-bus listening on ${config.port}`);
});
