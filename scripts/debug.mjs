#!/usr/bin/env node
import {
  formatAuditTrail,
  formatDebugTrace,
  formatErrors,
  formatReviewQueue
} from "./debug-lib.mjs";

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function getJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${url}`);
  }
  return response.json();
}

async function run() {
  const command = process.argv[2];
  const id = getArg("--id");

  const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? "http://localhost:3000";
  const auditServiceUrl = process.env.AUDIT_SERVICE_URL ?? "http://localhost:3003";
  const errorBusUrl = process.env.ERROR_BUS_URL ?? "http://localhost:3004";

  if (command === "trace") {
    if (!id) throw new Error("--id is required for trace");
    const payload = await getJson(`${auditServiceUrl}/events/${id}`);
    console.log(formatAuditTrail(payload));
    return;
  }

  if (command === "replay") {
    if (!id) throw new Error("--id is required for replay");
    const payload = await getJson(`${orchestratorUrl}/conversions/${id}/replay`, { method: "POST" });
    console.log(formatDebugTrace(payload));
    return;
  }

  if (command === "errors") {
    if (!id) throw new Error("--id is required for errors");
    const payload = await getJson(`${errorBusUrl}/errors/${id}`);
    console.log(formatErrors(payload));
    return;
  }

  if (command === "review-queue") {
    const payload = await getJson(`${errorBusUrl}/review-queue`);
    console.log(formatReviewQueue(payload));
    return;
  }

  console.error("Usage: node scripts/debug.mjs <trace|replay|errors|review-queue> [--id <ingestion_id>]");
  process.exit(1);
}

run().catch((error) => {
  console.error(`ht-debug failed: ${error.message}`);
  process.exit(1);
});
