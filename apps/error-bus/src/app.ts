import express from "express";
import cors from "cors";
import type { ServiceHealthResponse } from "@platform/contracts";
import type { ErrorRecord } from "./db.js";

export interface ErrorStore {
  ping(): Promise<void>;
  insert(error: ErrorRecord): Promise<void>;
  resolveById(id: number, resolutionAction: "approved" | "rejected"): Promise<boolean>;
  getByIngestionId(ingestionId: string): Promise<ErrorRecord[]>;
  getByErrorCode(errorCode: string): Promise<ErrorRecord[]>;
  getReviewQueue(): Promise<ErrorRecord[]>;
}

export function createErrorBusApp(repository: ErrorStore, serviceVersion = process.env.SERVICE_VERSION ?? "1.0.0") {
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
  app.use(express.json({ limit: "1mb" }));

  const service = "error-bus";
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

  app.post("/errors", async (req, res) => {
    const payload = req.body as ErrorRecord;
    const required = [
      "error_code",
      "error_category",
      "layer",
      "severity",
      "is_retryable",
      "requires_human_review",
      "ingestion_id",
      "trace_id",
      "source_format",
      "target_format",
      "timestamp",
      "layer_context"
    ] as const;

    for (const field of required) {
      if (payload?.[field] === undefined || payload?.[field] === null || payload?.[field] === "") {
        res.status(400).json({ error: "INVALID_ERROR_PAYLOAD", message: `${field} is required` });
        return;
      }
    }

    await repository.insert(payload);
    res.status(201).json({ status: "accepted", error_code: payload.error_code });
  });

  app.get("/errors/:ingestion_id", async (req, res) => {
    const errors = await repository.getByIngestionId(req.params.ingestion_id);
    res.json({ ingestion_id: req.params.ingestion_id, errors });
  });

  app.get("/errors", async (req, res) => {
    const errorCode = String(req.query.error_code ?? "");
    if (!errorCode) {
      res.status(400).json({ error: "INVALID_QUERY", message: "error_code query parameter is required" });
      return;
    }

    const errors = await repository.getByErrorCode(errorCode);
    res.json({ error_code: errorCode, errors });
  });

  app.get("/review-queue", async (_req, res) => {
    const queue = await repository.getReviewQueue();
    res.json({ review_queue: queue });
  });

  app.patch("/errors/:error_id/resolve", async (req, res) => {
    const errorId = Number(req.params.error_id);
    const resolutionAction = req.body?.resolution_action as "approved" | "rejected" | undefined;
    if (!Number.isInteger(errorId) || errorId <= 0) {
      res.status(400).json({ error: "INVALID_ERROR_ID" });
      return;
    }
    if (resolutionAction !== "approved" && resolutionAction !== "rejected") {
      res.status(400).json({ error: "INVALID_RESOLUTION_ACTION" });
      return;
    }

    const resolved = await repository.resolveById(errorId, resolutionAction);
    if (!resolved) {
      res.status(404).json({ error: "ERROR_NOT_FOUND", error_id: errorId });
      return;
    }

    res.json({ status: "resolved", error_id: errorId, resolution_action: resolutionAction });
  });

  return app;
}
