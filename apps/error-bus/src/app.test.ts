import request from "supertest";
import { describe, expect, it } from "vitest";
import { createErrorBusApp, type ErrorStore } from "./app.js";
import type { ErrorRecord } from "./db.js";

class InMemoryErrorStore implements ErrorStore {
  private readonly errors: ErrorRecord[] = [];

  async ping(): Promise<void> {
    return;
  }

  async insert(error: ErrorRecord): Promise<void> {
    this.errors.push({ ...error, id: this.errors.length + 1, resolution_action: error.resolution_action ?? null });
  }

  async resolveById(id: number, resolutionAction: "approved" | "rejected"): Promise<boolean> {
    const row = this.errors.find((item) => item.id === id);
    if (!row) return false;
    row.resolved_at = new Date().toISOString();
    row.resolution_action = resolutionAction;
    return true;
  }

  async getByIngestionId(ingestionId: string): Promise<ErrorRecord[]> {
    return this.errors.filter((row) => row.ingestion_id === ingestionId);
  }

  async getByErrorCode(errorCode: string): Promise<ErrorRecord[]> {
    return this.errors.filter((row) => row.error_code === errorCode);
  }

  async getReviewQueue(): Promise<ErrorRecord[]> {
    return this.errors.filter((row) => row.requires_human_review && !row.resolved_at);
  }
}

describe("error-bus", () => {
  it("stores errors and surfaces unresolved human-review items", async () => {
    const app = createErrorBusApp(new InMemoryErrorStore(), "1.0.0");

    await request(app).post("/errors").send({
      error_code: "LOW_CONFIDENCE_NO_FALLBACK",
      error_category: "MAPPING",
      layer: "terminology",
      severity: "P2",
      is_retryable: false,
      requires_human_review: true,
      ingestion_id: "ing-1",
      trace_id: "trace-1",
      source_system_id: "epic",
      source_format: "HL7V2",
      target_format: "FHIR_R4",
      timestamp: "2026-03-12T00:00:00.000Z",
      layer_context: JSON.stringify({ concept: "test" }),
      resolved_at: null
    });

    const reviewQueue = await request(app).get("/review-queue");
    expect(reviewQueue.status).toBe(200);
    expect(reviewQueue.body.review_queue).toHaveLength(1);
  });

  it("review queue excludes resolved errors", async () => {
    const app = createErrorBusApp(new InMemoryErrorStore(), "1.0.0");

    await request(app).post("/errors").send({
      error_code: "FORMAT_AMBIGUOUS",
      error_category: "ROUTING",
      layer: "orchestrator",
      severity: "P2",
      is_retryable: false,
      requires_human_review: true,
      ingestion_id: "ing-2",
      trace_id: "trace-2",
      source_system_id: "epic",
      source_format: "HL7V2",
      target_format: "FHIR_R4",
      timestamp: "2026-03-12T00:00:00.000Z",
      layer_context: JSON.stringify({ candidates: ["HL7V2", "PLAIN_TEXT"] }),
      resolved_at: "2026-03-12T00:10:00.000Z"
    });

    const reviewQueue = await request(app).get("/review-queue");
    expect(reviewQueue.status).toBe(200);
    expect(reviewQueue.body.review_queue).toHaveLength(0);
  });
});
