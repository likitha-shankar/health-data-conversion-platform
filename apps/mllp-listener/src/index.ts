import { getMllpConfig } from "./config.js";
import { OrchestratorForwarder } from "./forwarder.js";
import { generateAck, MllpServer } from "./mllp.js";

const config = getMllpConfig();
const forwarder = new OrchestratorForwarder({
  orchestratorUrl: config.orchestratorUrl,
  apiKey: config.mllpApiKey,
  defaultTargetFormat: config.defaultTargetFormat
});

const server = new MllpServer({
  port: config.mllpPort,
  onConnection(remoteAddress) {
    console.log(`mllp-listener connection from ${remoteAddress}`);
  },
  async onMessage(message) {
    const mshSegment = message.split("\r")[0] ?? "MSH|^~\\&|||||||||||2.5";
    const result = await forwarder.forward(message);
    if (result.ok) {
      return generateAck(mshSegment, "AA");
    }
    return generateAck(mshSegment, "AE", result.errorCode);
  }
});

await server.start();
console.log(`mllp-listener listening on ${config.mllpPort}`);
