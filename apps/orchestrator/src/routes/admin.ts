import express from "express";
import { createApiKey } from "../auth.js";
import type { OrchestratorRepository } from "../db.js";

interface AdminRouteOptions {
  repository: OrchestratorRepository;
  adminSecret: string;
}

export function createAdminRouter(options: AdminRouteOptions) {
  const router = express.Router();

  router.use((req, res, next) => {
    const provided = req.header("x-admin-secret");
    if (!provided || provided !== options.adminSecret) {
      res.status(403).json({ error: "FORBIDDEN" });
      return;
    }
    next();
  });

  router.post("/keys", async (req, res) => {
    const label = typeof req.body?.label === "string" ? req.body.label : undefined;
    const created = await createApiKey(options.repository, label);
    res.status(201).json({
      key_prefix: created.key_prefix,
      raw_key: created.raw_key,
      message: "Store this key securely — it will not be shown again"
    });
  });

  router.get("/keys", async (_req, res) => {
    const keys = await options.repository.listApiKeys();
    res.json({ keys });
  });

  router.delete("/keys/:key_id", async (req, res) => {
    const deactivated = await options.repository.deactivateApiKey(req.params.key_id);
    if (!deactivated) {
      res.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    res.json({ status: "deactivated" });
  });

  return router;
}
