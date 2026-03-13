import express from "express";
import cors from "cors";
import type { ServiceHealthResponse } from "@platform/contracts";
import type { MapRequest, TerminologyEngine } from "./engine.js";
import type { TerminologySystem } from "./rules.js";

export function createTerminologyApp(engine: TerminologyEngine, serviceVersion = process.env.SERVICE_VERSION ?? "1.0.0") {
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

  const service = "terminology-service";
  const version = serviceVersion;

  app.get("/health", (_req, res) => {
    const payload: ServiceHealthResponse = {
      service,
      version,
      status: "healthy"
    };
    res.json(payload);
  });

  app.get("/health/ready", async (_req, res) => {
    try {
      await engine.ping();
      res.json({ service, version, status: "ready" });
    } catch (error) {
      res.status(503).json({
        service,
        version,
        status: "not_ready",
        detail: error instanceof Error ? error.message : "unknown"
      });
    }
  });

  app.get("/terminology/stats", async (_req, res) => {
    const counts = await engine.getStats();
    res.json({ release_id: engine.getReleaseId(), counts_by_vocabulary: counts });
  });

  app.post("/map", async (req, res) => {
    const body = req.body as MapRequest;
    const required = ["concept_text", "source_system", "target_system", "context_domain"] as const;

    for (const field of required) {
      if (!body?.[field]) {
        res.status(400).json({ error: "INVALID_MAPPING_REQUEST", message: `${field} is required` });
        return;
      }
    }

    const response = await engine.mapConcept(body);
    res.json(response);
  });

  app.post("/map/batch", async (req, res) => {
    const requests = req.body as MapRequest[];
    if (!Array.isArray(requests)) {
      res.status(400).json({ error: "INVALID_BATCH_REQUEST", message: "body must be an array" });
      return;
    }
    if (requests.length === 0 || requests.length > 50) {
      res.status(400).json({ error: "INVALID_BATCH_SIZE", message: "batch size must be 1..50" });
      return;
    }

    const required = ["concept_text", "source_system", "target_system", "context_domain"] as const;
    for (const [index, request] of requests.entries()) {
      for (const field of required) {
        if (!request?.[field]) {
          res.status(400).json({
            error: "INVALID_BATCH_REQUEST",
            message: `request[${index}].${field} is required`
          });
          return;
        }
      }
    }

    const results = await engine.mapBatch(requests);
    res.json({ release_id: engine.getReleaseId(), results });
  });

  app.get("/terminology/lookup", async (req, res) => {
    const code = String(req.query.code ?? "");
    const system = String(req.query.system ?? "") as TerminologySystem;

    if (!code || !system) {
      res.status(400).json({ error: "INVALID_LOOKUP_REQUEST", message: "code and system are required" });
      return;
    }

    const mappings = await engine.lookupByCodeAndSystem(code, system);
    res.json({
      release_id: engine.getReleaseId(),
      code,
      system,
      mappings
    });
  });

  return app;
}
