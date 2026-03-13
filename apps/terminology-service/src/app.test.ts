import request from "supertest";
import { describe, expect, it } from "vitest";
import { createTerminologyApp } from "./app.js";
import type { MapRequest, MapResponse, TerminologyEngine } from "./engine.js";

class FakeEngine {
  getReleaseId() {
    return "terminology-test";
  }

  async ping() {
    return;
  }

  async getStats() {
    return {
      LOINC: 11,
      SNOMED: 10,
      ICD10CM: 10,
      RxNorm: 10
    };
  }

  async mapConcept(request: MapRequest): Promise<MapResponse> {
    if (request.concept_text === "718-7" && request.source_system === "LOINC" && request.target_system === "LOINC") {
      return {
        mapped_code: "718-7",
        mapped_display: "Hemoglobin [Mass/volume] in Blood",
        mapped_system: "LOINC",
        confidence: 1,
        mapping_tier: "RULE",
        flags: [],
        candidates: [],
        release_id: this.getReleaseId()
      };
    }

    if (request.concept_text.toLowerCase().includes("diabetes")) {
      return {
        mapped_code: "E11.9",
        mapped_display: "Type 2 diabetes mellitus",
        mapped_system: "ICD10",
        confidence: 0.96,
        mapping_tier: "EMBED",
        flags: [],
        candidates: [
          { code: "E11.9", display: "Type 2 diabetes mellitus", system: "ICD10", score: 0.96 },
          { code: "I10", display: "Hypertension", system: "ICD10", score: 0.52 },
          { code: "J45.909", display: "Asthma", system: "ICD10", score: 0.41 }
        ],
        release_id: this.getReleaseId()
      };
    }

    return {
      mapped_code: "",
      mapped_display: "",
      mapped_system: request.target_system,
      confidence: 0,
      mapping_tier: "UNMAPPABLE",
      flags: ["MAPPING_NO_VIABLE_CANDIDATE"],
      candidates: [],
      release_id: this.getReleaseId()
    };
  }

  async mapBatch(requests: MapRequest[]): Promise<MapResponse[]> {
    const output: MapResponse[] = [];
    for (const request of requests) {
      output.push(await this.mapConcept(request));
    }
    return output;
  }

  async lookupByCodeAndSystem(code: string, system: string) {
    if (code === "44054006" && system === "SNOMED") {
      return [
        {
          source_system: "SNOMED",
          source_code: "44054006",
          source_display: "Type 2 diabetes mellitus",
          target_system: "ICD10",
          target_code: "E11.9",
          target_display: "Type 2 diabetes mellitus",
          context_domain: "diagnosis",
          unit: null
        }
      ];
    }
    return [];
  }
}

describe("terminology-service", () => {
  const app = createTerminologyApp(new FakeEngine() as unknown as TerminologyEngine, "1.0.0");

  it("Tier 1 lookup returns code and confidence", async () => {
    const response = await request(app).post("/map").send({
      concept_text: "718-7",
      source_system: "LOINC",
      target_system: "LOINC",
      context_domain: "lab"
    });

    expect(response.status).toBe(200);
    expect(response.body.mapped_code).toBe("718-7");
    expect(response.body.mapping_tier).toBe("RULE");
    expect(response.body.confidence).toBe(1);
  });

  it("Tier 2 lookup returns candidates", async () => {
    const response = await request(app).post("/map").send({
      concept_text: "type 2 diabetes",
      source_system: "LOCAL",
      target_system: "ICD10",
      context_domain: "diagnosis"
    });

    expect(response.status).toBe(200);
    expect(response.body.mapping_tier).toBe("EMBED");
    expect(response.body.candidates).toHaveLength(3);
  });

  it("batch endpoint returns matching count", async () => {
    const response = await request(app)
      .post("/map/batch")
      .send([
        {
          concept_text: "718-7",
          source_system: "LOINC",
          target_system: "LOINC",
          context_domain: "lab"
        },
        {
          concept_text: "type 2 diabetes",
          source_system: "LOCAL",
          target_system: "ICD10",
          context_domain: "diagnosis"
        }
      ]);

    expect(response.status).toBe(200);
    expect(response.body.results).toHaveLength(2);
  });

  it("lookup endpoint returns mappings", async () => {
    const response = await request(app).get("/terminology/lookup").query({
      code: "44054006",
      system: "SNOMED"
    });

    expect(response.status).toBe(200);
    expect(response.body.mappings.length).toBeGreaterThan(0);
  });

  it("stats endpoint returns vocabulary counts", async () => {
    const response = await request(app).get("/terminology/stats");
    expect(response.status).toBe(200);
    expect(response.body.counts_by_vocabulary.LOINC).toBe(11);
  });
});
