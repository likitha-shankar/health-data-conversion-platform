import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorApp } from "./app.js";
import type { OrchestratorRepository } from "./db.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockReplayFetch() {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/events/ing-1") && (!init || init.method === undefined)) {
      return {
        ok: true,
        async json() {
          return {
            events: [
              {
                audit_event_id: "evt-1",
                ingestion_id: "ing-1",
                trace_id: "trace-1",
                agent_id: "orchestrator",
                agent_version: "1.0.0",
                source_format: "UNKNOWN",
                target_format: "FHIR_R4",
                transformation_step: "ingest",
                status_transition: "INGEST_RECEIVED",
                context_json: JSON.stringify({
                  requested_target_format: "FHIR_R4",
                  source_channel: "api",
                  terminology_release_id: "terminology_2026_03"
                }),
                created_at: "2026-03-12T00:00:00.000Z"
              },
              {
                audit_event_id: "evt-2",
                ingestion_id: "ing-1",
                trace_id: "trace-1",
                agent_id: "hl7v2-agent",
                agent_version: "1.2.3",
                source_format: "HL7V2",
                target_format: "FHIR_R4",
                transformation_step: "parse",
                status_transition: "PARSE_COMPLETED",
                created_at: "2026-03-12T00:00:01.000Z"
              }
            ]
          };
        }
      } as Response;
    }

    if (url.includes("/payloads/ing-1") && (!init || init.method === undefined)) {
      return {
        ok: true,
        async json() {
          return {
            payload_id: "pl-1",
            ingestion_id: "ing-1",
            raw_payload: Buffer.from(
              "MSH|^~\\&|LAB|HOSP|EHR|HOSP|202603111200||ORU^R01|MSG00001|P|2.5\\rPID|1||12345^^^HOSP^MR||DOE^JANE||19800101|F\\rOBX|1|NM|718-7^Hemoglobin^LN||13.2|g/dL|||N|||F"
            ).toString("base64"),
            content_type: "application/hl7-v2"
          };
        }
      } as Response;
    }

    if (url.includes("/convert") && init?.method === "POST") {
      return {
        ok: true,
        async json() {
          return {
            status: "SUCCESS",
            routing_self_check: {
              status: "PASS",
              confidence: 1,
              evidence: ["msh_at_start"]
            },
            canonical_record: {
              cim_record_id: "cim-1",
              provenance: {
                source_system_id: "HOSP",
                sending_application: "LAB",
                sending_facility: "HOSP",
                message_type: "ORU^R01",
                source_message_id: "MSG00001",
                hl7_version: "2.5"
              },
              patient: {
                source_identifiers: [{ value: "12345" }],
                family_name: "DOE",
                given_names: ["JANE"]
              },
              observations: [
                {
                  loinc_code: { code: "718-7", display: "Hemoglobin", system: "LOINC" },
                  value_quantity: { value: 13.2, unit: "g/dL" }
                }
              ],
              field_confidence_map: {
                "$.observations[0].loinc_code.code": 1
              }
            },
            target_payload: {},
            field_mappings: [
              {
                source_path: "OBX[1].3",
                source_value_hash: "sha256:abc",
                target_path: "$.observations[0].loinc_code.code",
                target_value_hash: "sha256:def",
                mapping_tier: "RULE",
                confidence_score: 1,
                threshold: 0.93,
                threshold_passed: true,
                flags: []
              }
            ],
            errors: [],
            warnings: [],
            metrics: {
              parse_ms: 3,
              map_ms: 5,
              validate_ms: 1,
              serialize_ms: 2,
              retries: 0
            },
            audit_refs: []
          };
        }
      } as Response;
    }

    return {
      ok: true,
      async json() {
        return {};
      }
    } as Response;
  });

  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("orchestrator replay endpoint", () => {
  it("retrieves payload and returns debug trace with expected step count", async () => {
    mockReplayFetch();
    const mockRepository = {
      async findActiveByHash() {
        return {
          key_id: "key-1",
          key_hash: "hash",
          key_prefix: "qmemo_ab",
          label: "test",
          created_at: new Date().toISOString(),
          last_used_at: null,
          is_active: true
        };
      },
      async touchLastUsed() {},
      async listApiKeys() {
        return [];
      },
      async deactivateApiKey() {
        return true;
      },
      async insertApiKey() {
        throw new Error("not needed");
      }
    } as unknown as OrchestratorRepository;

    const app = createOrchestratorApp({
      serviceVersion: "1.0.0",
      repository: mockRepository,
      adminSecret: "test-admin",
      hl7AgentUrl: "http://hl7v2-agent:3001",
      auditServiceUrl: "http://audit-service:3003",
      errorBusUrl: "http://error-bus:3004",
      terminologyReleaseId: "terminology_2026_03",
      hl7AgentVersion: "1.0.0"
    });

    const response = await request(app)
      .post("/conversions/ing-1/replay")
      .set("authorization", "Bearer qmemo_test_key");
    expect(response.status).toBe(200);
    expect(response.body.debug_trace.steps).toHaveLength(5);
  });

  it("contains parse/map snapshots and terminology decision", async () => {
    mockReplayFetch();
    const mockRepository = {
      async findActiveByHash() {
        return {
          key_id: "key-1",
          key_hash: "hash",
          key_prefix: "qmemo_ab",
          label: "test",
          created_at: new Date().toISOString(),
          last_used_at: null,
          is_active: true
        };
      },
      async touchLastUsed() {},
      async listApiKeys() {
        return [];
      },
      async deactivateApiKey() {
        return true;
      },
      async insertApiKey() {
        throw new Error("not needed");
      }
    } as unknown as OrchestratorRepository;

    const app = createOrchestratorApp({
      serviceVersion: "1.0.0",
      repository: mockRepository,
      adminSecret: "test-admin",
      hl7AgentUrl: "http://hl7v2-agent:3001",
      auditServiceUrl: "http://audit-service:3003",
      errorBusUrl: "http://error-bus:3004",
      terminologyReleaseId: "terminology_2026_03",
      hl7AgentVersion: "1.0.0"
    });

    const response = await request(app)
      .post("/conversions/ing-1/replay")
      .set("authorization", "Bearer qmemo_test_key");
    const parseStep = response.body.debug_trace.steps.find((s: any) => s.layer_name === "parse");
    const mapStep = response.body.debug_trace.steps.find((s: any) => s.layer_name === "map");

    expect(parseStep.input_snapshot.raw_payload).toContain("MSH|");
    expect(parseStep.output_snapshot.provenance.message_type).toBe("ORU^R01");
    expect(mapStep.output_snapshot.field_confidence_map["$.observations[0].loinc_code.code"]).toBe(1);

    const terminologyDecision = mapStep.decisions.find(
      (d: any) => d.decision_type === "terminology_confidence"
    );
    expect(terminologyDecision).toBeDefined();
    expect(terminologyDecision.field).toBe("$.observations[0].loinc_code.code");
  });
});
