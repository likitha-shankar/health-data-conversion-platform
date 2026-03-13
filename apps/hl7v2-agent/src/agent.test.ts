import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hl7V2Agent } from "./agent.js";
import type { ConversionRequest } from "@platform/contracts";

function makeRequest(content: string): ConversionRequest {
  return {
    request_id: "req-1",
    trace_id: "trace-1",
    tenant_id: "tenant-1",
    received_at: new Date().toISOString(),
    source_channel: "test",
    raw_payload: { content },
    detected_source_format: "HL7V2",
    detection_confidence: 1,
    detection_evidence: ["test"],
    requested_target_format: "FHIR_R4",
    processing_policy: {
      allow_partial_success: true,
      halt_on_dangerous_mapping: true,
      min_confidence_thresholds: { diagnosis: 0.95 }
    },
    context_snapshot: {
      terminology_release_id: "terminology-v1.0.0",
      mapping_model_versions: {},
      orchestrator_version: "1.0.0"
    },
    phi_handling_status: "PASS"
  };
}

beforeEach(() => {
  process.env.TERMINOLOGY_SERVICE_URL = "http://terminology.test";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/map/batch")) {
        const requests = JSON.parse(String(init?.body ?? "[]"));
        return {
          ok: true,
          async json() {
            return {
              release_id: "terminology-v1.0.0",
              results: requests.map((req: any) => ({
                mapped_code: req.concept_text || "",
                mapped_display: `Mapped ${req.concept_text}`,
                mapped_system: req.target_system,
                confidence: 1,
                mapping_tier: "RULE",
                flags: [],
                candidates: [],
                release_id: "terminology-v1.0.0"
              }))
            };
          }
        } as Response;
      }

      if (url.includes("/events")) {
        return { ok: true, async json() { return { status: "accepted" }; } } as Response;
      }

      throw new Error(`unexpected fetch url: ${url}`);
    })
  );
});

afterEach(() => {
  delete process.env.TERMINOLOGY_SERVICE_URL;
  vi.restoreAllMocks();
});

describe("Hl7V2Agent", () => {
  it("parses a valid ORU R01 message", async () => {
    const agent = new Hl7V2Agent();
    const msg = [
      "MSH|^~\\&|LABAPP|HOSP|EHR|FAC|202603110900||ORU^R01|MSG001|P|2.5",
      "PID|1||12345^^^HOSP^MR||DOE^JANE||19800101|F",
      "OBX|1|NM|718-7^Hemoglobin^LN||13.2|g/dL|||N|||F"
    ].join("\r");

    const result = await agent.convert(makeRequest(msg));
    expect(result.status).toBe("SUCCESS");
    expect(result.routing_self_check.status).toBe("PASS");
  });

  it("returns PARTIAL_SUCCESS when PID is missing", async () => {
    const agent = new Hl7V2Agent();
    const msg = [
      "MSH|^~\\&|LABAPP|HOSP|EHR|FAC|202603110900||ORU^R01|MSG001|P|2.5",
      "OBX|1|NM|718-7^Hemoglobin^LN||13.2|g/dL|||N|||F"
    ].join("\r");

    const result = await agent.convert(makeRequest(msg));
    expect(result.status).toBe("PARTIAL_SUCCESS");
    expect(result.field_mappings.some((m) => m.target_path === "$.patient.source_identifiers")).toBe(true);
  });

  it("fails selfCheckRouting for non-HL7 payload", () => {
    const agent = new Hl7V2Agent();
    const routing = agent.selfCheckRouting({ content: "{\"foo\":\"bar\"}" });
    expect(routing.status).toBe("FAIL");
  });

  it("uses batch terminology call and populates confidence for all observations", async () => {
    const fetchMock = vi.mocked(fetch);
    const agent = new Hl7V2Agent();
    const msg = [
      "MSH|^~\\&|LABAPP|HOSP|EHR|FAC|202603110900||ORU^R01|MSG001|P|2.5",
      "PID|1||12345^^^HOSP^MR||DOE^JANE||19800101|F",
      "OBX|1|NM|718-7^Hemoglobin^LN||13.2|g/dL|||N|||F",
      "OBX|2|NM|2345-7^Glucose^LN||99|mg/dL|||N|||F"
    ].join("\r");

    const result = await agent.convert(makeRequest(msg));
    const confidenceMap = (result.canonical_record as any).field_confidence_map;

    expect(confidenceMap["$.observations[0].loinc_code.code"]).toBe(1);
    expect(confidenceMap["$.observations[1].loinc_code.code"]).toBe(1);

    const batchCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/map/batch"));
    expect(batchCalls).toHaveLength(1);
  });

  it("adds terminology unavailable warning without failing whole record", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/map/batch")) {
          throw new Error("service unavailable");
        }
        if (url.includes("/events")) {
          return { ok: true, async json() { return {}; } } as Response;
        }
        throw new Error("unexpected fetch");
      })
    );

    const agent = new Hl7V2Agent();
    const msg = [
      "MSH|^~\\&|LABAPP|HOSP|EHR|FAC|202603110900||ORU^R01|MSG001|P|2.5",
      "PID|1||12345^^^HOSP^MR||DOE^JANE||19800101|F",
      "OBX|1|NM|718-7^Hemoglobin^LN||13.2|g/dL|||N|||F"
    ].join("\r");

    const result = await agent.convert(makeRequest(msg));
    expect(result.status).not.toBe("FAILURE");
    expect(result.warnings.some((w) => w.code === "MAPPING_TERMINOLOGY_SERVER_UNAVAILABLE")).toBe(true);
  });
});
