import request from "supertest";
import { describe, expect, it } from "vitest";
import { createAuditApp, type AuditStore } from "./app.js";
import type { AuditEvent, StoredPayload } from "./db.js";

class InMemoryAuditStore implements AuditStore {
  private readonly events: AuditEvent[] = [];
  private readonly payloads: StoredPayload[] = [];

  async ping(): Promise<void> {
    return;
  }

  async insert(event: AuditEvent): Promise<void> {
    this.events.push({
      ...event,
      raw_payload_ref: event.raw_payload_ref ?? null,
      context_json: event.context_json ?? null,
      created_at: event.created_at ?? new Date().toISOString()
    });
  }

  async storePayload(payload: StoredPayload): Promise<void> {
    this.payloads.push({
      ...payload,
      stored_at: payload.stored_at ?? new Date().toISOString()
    });
  }

  async getPayloadByIngestionId(ingestionId: string): Promise<StoredPayload | null> {
    const matches = this.payloads.filter((item) => item.ingestion_id === ingestionId);
    return matches[matches.length - 1] ?? null;
  }

  async getByIngestionId(ingestionId: string): Promise<AuditEvent[]> {
    return this.events
      .filter((event) => event.ingestion_id === ingestionId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }
}

describe("audit-service", () => {
  it("stores and retrieves events by ingestion_id", async () => {
    const app = createAuditApp(new InMemoryAuditStore(), "1.0.0");

    await request(app).post("/events").send({
      audit_event_id: "evt-1",
      ingestion_id: "ing-1",
      trace_id: "trace-1",
      agent_id: "orchestrator",
      agent_version: "1.0.0",
      source_format: "HL7V2",
      target_format: "FHIR_R4",
      transformation_step: "ingest",
      status_transition: "INGEST_RECEIVED",
      raw_payload_ref: "payload-1",
      created_at: "2026-03-12T00:00:00.000Z"
    });

    await request(app).post("/events").send({
      audit_event_id: "evt-2",
      ingestion_id: "ing-1",
      trace_id: "trace-1",
      agent_id: "hl7v2-agent",
      agent_version: "1.0.0",
      source_format: "HL7V2",
      target_format: "FHIR_R4",
      transformation_step: "parse",
      status_transition: "PARSE_COMPLETED",
      created_at: "2026-03-12T00:00:01.000Z"
    });

    const response = await request(app).get("/events/ing-1");
    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(2);
    expect(response.body.events[0].audit_event_id).toBe("evt-1");
    expect(response.body.events[1].audit_event_id).toBe("evt-2");
  });

  it("stores and retrieves raw payload by ingestion_id", async () => {
    const app = createAuditApp(new InMemoryAuditStore(), "1.0.0");

    await request(app).post("/payloads").send({
      payload_id: "pl-1",
      ingestion_id: "ing-2",
      raw_payload: "TVNIfF4+Li4u",
      content_type: "application/hl7-v2"
    });

    const response = await request(app).get("/payloads/ing-2");
    expect(response.status).toBe(200);
    expect(response.body.payload_id).toBe("pl-1");
    expect(response.body.raw_payload).toBe("TVNIfF4+Li4u");
  });
});
