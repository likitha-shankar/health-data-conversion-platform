import { describe, expect, it } from "vitest";
import { formatAuditTrail } from "../../../scripts/debug-lib.mjs";

describe("ht-debug trace formatting", () => {
  it("formats audit events chronologically in readable form", () => {
    const text = formatAuditTrail({
      ingestion_id: "ing-1",
      events: [
        {
          created_at: "2026-03-12T00:00:00.000Z",
          transformation_step: "ingest",
          status_transition: "INGEST_RECEIVED",
          agent_id: "orchestrator",
          agent_version: "1.0.0",
          source_format: "UNKNOWN",
          target_format: "FHIR_R4"
        },
        {
          created_at: "2026-03-12T00:00:01.000Z",
          transformation_step: "map",
          status_transition: "MAP_COMPLETED_AVG_CONFIDENCE_1.00",
          agent_id: "hl7v2-agent",
          agent_version: "1.2.3",
          source_format: "HL7V2",
          target_format: "FHIR_R4"
        }
      ]
    });

    expect(text).toContain("Audit trail for ingestion_id=ing-1");
    expect(text).toContain("ingest INGEST_RECEIVED agent=orchestrator@1.0.0");
    expect(text).toContain("map MAP_COMPLETED_AVG_CONFIDENCE_1.00 agent=hl7v2-agent@1.2.3");
  });
});
