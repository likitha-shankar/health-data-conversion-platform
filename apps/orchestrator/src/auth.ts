import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { OrchestratorRepository } from "./db.js";

declare global {
  namespace Express {
    interface Request {
      auth_key_id?: string;
    }
  }
}

export function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

export function generateApiKey(): { raw_key: string; key_hash: string; key_prefix: string } {
  const token = crypto.randomBytes(32).toString("hex");
  const rawKey = `qmemo_${token}`;
  return {
    raw_key: rawKey,
    key_hash: hashKey(rawKey),
    key_prefix: rawKey.slice(0, 8)
  };
}

export async function createApiKey(
  repository: OrchestratorRepository,
  label?: string
): Promise<{ key_id: string; key_prefix: string; raw_key: string }> {
  const generated = generateApiKey();
  const inserted = await repository.insertApiKey(generated.key_hash, generated.key_prefix, label);

  // Raw API keys are only visible once at creation time.
  console.log(`orchestrator api key created: ${generated.raw_key}`);
  return {
    key_id: inserted.key_id,
    key_prefix: inserted.key_prefix,
    raw_key: generated.raw_key
  };
}

export function validateApiKey(repository: OrchestratorRepository): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.header("authorization") ?? "";
    const bearerPrefix = "Bearer ";
    if (!authorization.startsWith(bearerPrefix)) {
      res.status(401).json({ error: "INVALID_API_KEY" });
      return;
    }

    const rawKey = authorization.slice(bearerPrefix.length).trim();
    if (!rawKey) {
      res.status(401).json({ error: "INVALID_API_KEY" });
      return;
    }

    try {
      const keyHash = hashKey(rawKey);
      const record = await repository.findActiveByHash(keyHash);
      if (!record || !record.is_active) {
        res.status(401).json({ error: "INVALID_API_KEY" });
        return;
      }

      await repository.touchLastUsed(record.key_id);
      req.auth_key_id = record.key_id;
      next();
    } catch {
      res.status(401).json({ error: "INVALID_API_KEY" });
    }
  };
}
