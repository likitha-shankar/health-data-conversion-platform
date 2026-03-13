import { describe, expect, it } from "vitest";
import { serializeToFhirR4, serializeToFlatJson, serializeToOmop } from "./index.js";

function makeCimRecord() {
  return {
    cim_record_id: "cim-1",
    provenance: {
      source_system_id: "epic_prod_east"
    },
    patient: {
      patient_id: "pat-1",
      source_identifiers: [{ value: "12345", assigning_authority: "HOSP", type: "MR" }],
      family_name: "DOE",
      given_names: ["JANE"],
      birth_date: "1980-01-01",
      administrative_gender: "female",
      addresses: [{ line: "123 MAIN ST", city: "BOSTON", state: "MA", postalCode: "02110", country: "US" }]
    },
    encounters: [
      {
        encounter_id: "enc-1",
        status: "finished",
        class: { code: "AMB", system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", display: "ambulatory" },
        period_start: "2026-03-11T09:00:00.000Z"
      }
    ],
    observations: [
      {
        observation_id: "obs-1",
        status: "final",
        category: { code: "laboratory", system: "http://terminology.hl7.org/CodeSystem/observation-category" },
        loinc_code: { code: "718-7", display: "Hemoglobin", system: "http://loinc.org" },
        effective_datetime: "2026-03-11T09:00:00.000Z",
        value_quantity: { value: 13.2, unit: "g/dL" },
        encounter_id_ref: "enc-1"
      },
      {
        observation_id: "obs-2",
        status: "final",
        category: { code: "vital-signs", system: "http://terminology.hl7.org/CodeSystem/observation-category" },
        loinc_code: { code: "2345-7", display: "Glucose", system: "http://loinc.org" },
        effective_datetime: "2026-03-11T09:00:00.000Z",
        value_quantity: { value: 99, unit: "mg/dL" },
        encounter_id_ref: "enc-1"
      }
    ],
    conditions: [
      {
        condition_id: "cond-1",
        assertion_class: "ASSERTED",
        clinical_status: "active",
        verification_status: "confirmed",
        snomed_code: { code: "44054006", display: "Diabetes mellitus type 2", system: "http://snomed.info/sct" },
        onset_datetime: "2025-10-01T00:00:00.000Z"
      }
    ]
  };
}

describe("FHIR R4 serializer", () => {
  it("serializes CIM with patient and two observations to valid FHIR R4 bundle", () => {
    const result = serializeToFhirR4(makeCimRecord());
    expect(result.errors).toHaveLength(0);
    expect(result.payload?.resourceType).toBe("Bundle");
    expect((result.payload as any).entry.length).toBeGreaterThanOrEqual(4);

    const resources = (result.payload as any).entry.map((e: any) => e.resource);
    const patient = resources.find((r: any) => r.resourceType === "Patient");
    const observations = resources.filter((r: any) => r.resourceType === "Observation");

    expect(patient.meta.source).toBe("epic_prod_east");
    expect(observations).toHaveLength(2);
    expect(observations[0].valueQuantity).toBeDefined();
  });

  it("serializes CIM with missing optional fields without errors", () => {
    const cim = makeCimRecord();
    delete (cim.patient as any).addresses;
    delete (cim.encounters[0] as any).period_end;
    const result = serializeToFhirR4(cim);

    expect(result.errors).toHaveLength(0);
    expect(result.payload?.resourceType).toBe("Bundle");
  });
});

describe("OMOP serializer", () => {
  it("serializes patient and observations to PERSON and MEASUREMENT rows", () => {
    const result = serializeToOmop(makeCimRecord());
    expect(result.errors).toHaveLength(0);

    const payload = result.payload as any;
    expect(payload.PERSON).toHaveLength(1);
    expect(payload.MEASUREMENT).toHaveLength(2);
    expect(payload.VISIT_OCCURRENCE).toHaveLength(1);
  });

  it("maps all gender values to OMOP concept ids", () => {
    const genders = ["male", "female", "other", "unknown"];
    const conceptIds = genders.map((gender) => {
      const cim = makeCimRecord();
      (cim.patient as any).administrative_gender = gender;
      return (serializeToOmop(cim).payload as any).PERSON[0].gender_concept_id;
    });

    expect(conceptIds).toEqual([8507, 8532, 0, 0]);
  });

  it("maps known and unknown LOINC to measurement_concept_id and flags unknown", () => {
    const cim = makeCimRecord();
    (cim.observations[0] as any).loinc_code.code = "UNKNOWN-LOINC";

    const result = serializeToOmop(cim);
    const rows = (result.payload as any).MEASUREMENT;

    expect(rows[0].measurement_concept_id).toBe(0);
    expect(rows[1].measurement_concept_id).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.code === "OMOP_CONCEPT_UNMAPPED")).toBe(true);
  });

  it("maps known and unknown SNOMED to condition_concept_id and flags unknown", () => {
    const cim = makeCimRecord();
    (cim.conditions[0] as any).snomed_code.code = "UNKNOWN-SNOMED";

    const result = serializeToOmop(cim);
    const rows = (result.payload as any).CONDITION_OCCURRENCE;

    expect(rows[0].condition_concept_id).toBe(0);
    expect(result.warnings.some((w) => w.code === "OMOP_CONCEPT_UNMAPPED")).toBe(true);
  });

  it("returns OUTPUT_OMOP_NO_PERSON_ID error when patient_id is missing", () => {
    const cim = makeCimRecord();
    delete (cim.patient as any).patient_id;

    const result = serializeToOmop(cim);
    expect(result.payload).toBeUndefined();
    expect(result.errors.some((e) => e.code === "OUTPUT_OMOP_NO_PERSON_ID")).toBe(true);
  });

  it("maps assertion_class to condition_status_concept_id correctly", () => {
    const cim = makeCimRecord();
    cim.conditions = [
      {
        condition_id: "cond-a",
        assertion_class: "ASSERTED",
        snomed_code: { code: "44054006" },
        onset_datetime: "2025-10-01T00:00:00.000Z"
      } as any,
      {
        condition_id: "cond-h",
        assertion_class: "HISTORICAL",
        snomed_code: { code: "709044004" },
        onset_datetime: "2024-01-01T00:00:00.000Z"
      } as any
    ];

    const rows = (serializeToOmop(cim).payload as any).CONDITION_OCCURRENCE;
    expect(rows[0].condition_status_concept_id).toBe(32893);
    expect(rows[1].condition_status_concept_id).toBe(4230359);
  });
});

describe("Flat JSON serializer", () => {
  it("maps specified CIM paths correctly", () => {
    const result = serializeToFlatJson(makeCimRecord(), {
      field_mappings: {
        patient_id: "$.patient.patient_id",
        first_given_name: "$.patient.given_names[0]",
        first_observation_code: "$.observations[0].loinc_code.code"
      }
    });

    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.payload).toEqual({
      patient_id: "pat-1",
      first_given_name: "JANE",
      first_observation_code: "718-7"
    });
  });

  it("emits warning for undefined CIM path and omits field", () => {
    const result = serializeToFlatJson(makeCimRecord(), {
      field_mappings: {
        patient_id: "$.patient.patient_id",
        unknown_field: "$.patient.nonexistent.path"
      }
    });

    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((w) => w.code === "OUTPUT_UNDEFINED_MAPPING_PATH")).toBe(true);
    expect(result.payload).toEqual({
      patient_id: "pat-1"
    });
  });
});
