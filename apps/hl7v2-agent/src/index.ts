import express from "express";
import cors from "cors";
import { Hl7V2MockAgent } from "./agent.js";
import { getHl7AgentConfig } from "./config.js";
import type { ConversionRequest } from "@platform/contracts";

async function checkDependency(url: string): Promise<{ ok: boolean; detail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${url}/health/ready`, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, detail: `status_${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "unknown" };
  } finally {
    clearTimeout(timer);
  }
}

const config = getHl7AgentConfig();
const app = express();
const allowedOrigins = (process.env.CORS_ORIGINS ??
  "http://localhost:3005,http://127.0.0.1:3005,http://dashboard:3005")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("CORS origin not allowed"));
    }
  })
);
app.use(express.json({ limit: "2mb" }));

const agent = new Hl7V2MockAgent();

app.get("/health", async (_req, res) => {
  res.json(await agent.health());
});

app.get("/health/ready", async (_req, res) => {
  const deps = {
    terminology_service: await checkDependency(config.terminologyServiceUrl),
    audit_service: await checkDependency(config.auditServiceUrl)
  };

  const failed = Object.entries(deps).filter(([, value]) => !value.ok);
  if (failed.length > 0) {
    res.status(503).json({
      service: "hl7v2-agent",
      status: "not_ready",
      dependencies: deps
    });
    return;
  }

  res.json({
    service: "hl7v2-agent",
    status: "ready",
    dependencies: deps
  });
});

app.get("/metadata", (_req, res) => {
  res.json(agent.getMetadata());
});

app.post("/convert", async (req, res) => {
  const request = req.body as ConversionRequest;
  const result = await agent.convert(request);
  res.json(result);
});

app.listen(config.port, () => {
  console.log(`hl7v2-agent listening on ${config.port}`);
});
