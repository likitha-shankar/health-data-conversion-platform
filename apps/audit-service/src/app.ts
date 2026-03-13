import express from "express";
import cors from "cors";
import type { ServiceHealthResponse } from "@platform/contracts";
import type { AuditEvent, StoredPayload } from "./db.js";

export interface AuditStore {
  ping(): Promise<void>;
  insert(event: AuditEvent): Promise<void>;
  storePayload(payload: StoredPayload): Promise<void>;
  getPayloadByIngestionId(ingestionId: string): Promise<StoredPayload | null>;
  getByIngestionId(ingestionId: string): Promise<AuditEvent[]>;
}

export function createAuditApp(repository: AuditStore, serviceVersion = process.env.SERVICE_VERSION ?? "1.0.0") {
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
  app.use(express.json({ limit: "5mb" }));

  const service = "audit-service";
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
      await repository.ping();
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

  app.post("/payloads", async (req, res) => {
    const payload = req.body as StoredPayload;
    const required = ["payload_id", "ingestion_id", "raw_payload", "content_type"] as const;

    for (const field of required) {
      if (!payload?.[field]) {
        res.status(400).json({ error: "INVALID_PAYLOAD", message: `${field} is required` });
        return;
      }
    }

    await repository.storePayload(payload);
    res.status(201).json({ status: "stored", payload_id: payload.payload_id });
  });

  app.get("/payloads/:ingestion_id", async (req, res) => {
    const payload = await repository.getPayloadByIngestionId(req.params.ingestion_id);
    if (!payload) {
      res.status(404).json({ error: "PAYLOAD_NOT_FOUND", ingestion_id: req.params.ingestion_id });
      return;
    }

    res.json(payload);
  });

  app.post("/events", async (req, res) => {
    const event = req.body as AuditEvent;
    const required = [
      "audit_event_id",
      "ingestion_id",
      "trace_id",
      "agent_id",
      "agent_version",
      "source_format",
      "target_format",
      "transformation_step",
      "status_transition"
    ] as const;

    for (const field of required) {
      if (!event?.[field]) {
        res.status(400).json({ error: "INVALID_AUDIT_EVENT", message: `${field} is required` });
        return;
      }
    }

    await repository.insert(event);
    res.status(201).json({ status: "accepted", audit_event_id: event.audit_event_id });
  });

  app.get("/events/:ingestion_id", async (req, res) => {
    const events = await repository.getByIngestionId(req.params.ingestion_id);
    res.json({ ingestion_id: req.params.ingestion_id, events });
  });

  return app;
}
