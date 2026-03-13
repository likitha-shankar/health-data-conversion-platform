import crypto from "node:crypto";
import type { AgentError, AgentWarning, TargetFormat } from "@platform/contracts";
import { fhirR4BundleSchema } from "./fhir-r4-bundle.schema.js";

export interface FlatJsonMappingConfig {
  field_mappings: Record<string, string>;
}

export interface SerializerResult {
  payload?: Record<string, unknown>;
  warnings: AgentWarning[];
  errors: AgentError[];
}

interface OmopPersonRow {
  person_id: number;
  gender_concept_id: number;
  year_of_birth: number | null;
  month_of_birth: number | null;
  day_of_birth: number | null;
  birth_datetime: string | null;
  race_concept_id: number;
  ethnicity_concept_id: number;
}

interface OmopVisitOccurrenceRow {
  visit_occurrence_id: number;
  person_id: number;
  visit_concept_id: number;
  visit_start_date: string | null;
  visit_start_datetime: string | null;
  visit_end_date: string | null;
  visit_end_datetime: string | null;
  visit_type_concept_id: number;
  care_site_id: number | null;
}

interface OmopMeasurementRow {
  measurement_id: number;
  person_id: number;
  measurement_concept_id: number;
  measurement_date: string | null;
  measurement_datetime: string | null;
  measurement_type_concept_id: number;
  operator_concept_id: number | null;
  value_as_number: number | null;
  value_as_concept_id: number;
  unit_concept_id: number;
  range_low: number | null;
  range_high: number | null;
}

interface OmopConditionOccurrenceRow {
  condition_occurrence_id: number;
  person_id: number;
  condition_concept_id: number;
  condition_start_date: string | null;
  condition_start_datetime: string | null;
  condition_end_date: string | null;
  condition_type_concept_id: number;
  condition_status_concept_id: number;
}

const LOINC_TO_OMOP_CONCEPT_ID: Record<string, number> = {
  "2345-7": 3004501,
  "4548-4": 3004410,
  "2160-0": 3016723,
  "2951-2": 3019550,
  "2823-3": 3023103,
  "718-7": 3000963,
  "6690-2": 3000905,
  "3016-3": 3020455,
  "6301-6": 3022217,
  "6598-7": 3027018
};

const SNOMED_TO_OMOP_CONCEPT_ID: Record<string, number> = {
  "44054006": 201826,
  "38341003": 316866,
  "195967001": 317009,
  "84114007": 316139,
  "13645005": 255573,
  "35489007": 443732,
  "197480006": 432584,
  "49436004": 313217,
  "709044004": 4030518,
  "40930008": 319067
};

const UCUM_TO_OMOP_UNIT_CONCEPT_ID: Record<string, number> = {
  "mg/dL": 8840,
  "mmol/L": 8753,
  "g/dL": 8713,
  "10*3/uL": 8848,
  "%": 8554,
  "mIU/L": 8876,
  "u[IU]/mL": 8876
};

function toArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function normalizePath(path: string): string {
  return path.replace(/^\$\./, "");
}

function getByPath(root: Record<string, unknown>, rawPath: string): unknown {
  const path = normalizePath(rawPath);
  if (!path) {
    return root;
  }

  const tokens = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);

  let current: unknown = root;
  for (const token of tokens) {
    if (typeof current !== "object" || current === null || !(token in (current as Record<string, unknown>))) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[token];
  }

  return current;
}

function validateFhirBundleAgainstSchema(bundle: Record<string, unknown>): { valid: boolean; failingPath: string } {
  if (bundle.resourceType !== fhirR4BundleSchema.properties.resourceType.const) {
    return { valid: false, failingPath: "$.resourceType" };
  }
  if (bundle.type !== fhirR4BundleSchema.properties.type.const) {
    return { valid: false, failingPath: "$.type" };
  }

  const entries = bundle.entry;
  if (!Array.isArray(entries)) {
    return { valid: false, failingPath: "$.entry" };
  }

  for (let i = 0; i < entries.length; i += 1) {
    const entry = asRecord(entries[i]);
    const resource = asRecord(entry.resource);

    if (!entry.resource) {
      return { valid: false, failingPath: `$.entry[${i}].resource` };
    }

    if (typeof resource.resourceType !== "string") {
      return { valid: false, failingPath: `$.entry[${i}].resource.resourceType` };
    }

    const allowed = fhirR4BundleSchema.properties.entry.items.properties.resource.properties.resourceType.enum;
    if (!allowed.includes(resource.resourceType as (typeof allowed)[number])) {
      return { valid: false, failingPath: `$.entry[${i}].resource.resourceType` };
    }

    if (typeof resource.id !== "string" || resource.id.length === 0) {
      return { valid: false, failingPath: `$.entry[${i}].resource.id` };
    }

    const meta = asRecord(resource.meta);
    if (typeof meta.source !== "string" || meta.source.length === 0) {
      return { valid: false, failingPath: `$.entry[${i}].resource.meta.source` };
    }
  }

  return { valid: true, failingPath: "" };
}

function stablePositiveInt(input: string): number {
  const hash = crypto.createHash("sha256").update(input).digest("hex");
  const first32 = Number.parseInt(hash.slice(0, 8), 16);
  return (first32 % 2_147_483_647) || 1;
}

function parseDateParts(value: string | undefined): {
  year: number | null;
  month: number | null;
  day: number | null;
  date: string | null;
  datetime: string | null;
} {
  if (!value) {
    return { year: null, month: null, day: null, date: null, datetime: null };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
    return {
      year,
      month,
      day,
      date: value,
      datetime: `${value}T00:00:00.000Z`
    };
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return { year: null, month: null, day: null, date: null, datetime: null };
  }

  const iso = parsed.toISOString();
  const date = iso.slice(0, 10);
  return {
    year: parsed.getUTCFullYear(),
    month: parsed.getUTCMonth() + 1,
    day: parsed.getUTCDate(),
    date,
    datetime: iso
  };
}

function genderToOmopConceptId(value: unknown): number {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "male") return 8507;
  if (normalized === "female") return 8532;
  return 0;
}

function visitClassToConceptId(value: unknown): number {
  const normalized = String(value ?? "").toUpperCase();
  if (normalized === "IMP") return 9201;
  if (normalized === "AMB") return 9202;
  if (normalized === "EMER") return 9203;
  return 0;
}

function conditionAssertionToStatusConceptId(value: unknown): number {
  const normalized = String(value ?? "").toUpperCase();
  if (normalized === "ASSERTED") return 32893;
  if (normalized === "HISTORICAL") return 4230359;
  return 0;
}

function conditionAssertionToTypeConceptId(value: unknown): number {
  const normalized = String(value ?? "").toUpperCase();
  if (normalized === "ASSERTED") return 32817;
  if (normalized === "HISTORICAL") return 32020;
  return 32020;
}

function normalizeUnit(raw: unknown): string {
  return String(raw ?? "").trim();
}

function serializePatient(cim: Record<string, unknown>, sourceSystemId: string): Record<string, unknown> {
  const patient = asRecord(cim.patient);
  const identifiers = toArray<Record<string, unknown>>(patient.source_identifiers).map((id) => ({
    value: id.value,
    assigner: id.assigning_authority ? { display: id.assigning_authority } : undefined,
    type: id.type ? { text: id.type } : undefined
  }));

  const name = {
    family: patient.family_name,
    given: toArray<string>(patient.given_names)
  };

  const address = toArray<Record<string, unknown>>(patient.addresses).map((addr) => ({
    line: addr.line ? [addr.line] : undefined,
    city: addr.city,
    state: addr.state,
    postalCode: addr.postalCode,
    country: addr.country
  }));

  return {
    resourceType: "Patient",
    id: String(patient.patient_id ?? "patient-unknown"),
    meta: { source: sourceSystemId },
    identifier: identifiers,
    name: [name],
    gender: patient.administrative_gender,
    birthDate: patient.birth_date,
    address
  };
}

function serializeEncounter(
  encounterInput: Record<string, unknown>,
  sourceSystemId: string,
  patientId: string
): Record<string, unknown> {
  return {
    resourceType: "Encounter",
    id: String(encounterInput.encounter_id ?? crypto.randomUUID()),
    meta: { source: sourceSystemId },
    status: encounterInput.status ?? "unknown",
    class: asRecord(encounterInput.class),
    subject: { reference: `Patient/${patientId}` },
    period: {
      start: encounterInput.period_start,
      end: encounterInput.period_end
    }
  };
}

function serializeObservation(
  observationInput: Record<string, unknown>,
  sourceSystemId: string,
  patientId: string,
  encounterId?: string
): Record<string, unknown> {
  const observation: Record<string, unknown> = {
    resourceType: "Observation",
    id: String(observationInput.observation_id ?? crypto.randomUUID()),
    meta: { source: sourceSystemId },
    status: observationInput.status ?? "registered",
    category: [{ coding: [asRecord(observationInput.category)] }],
    code: { coding: [asRecord(observationInput.loinc_code)] },
    subject: { reference: `Patient/${patientId}` },
    effectiveDateTime: observationInput.effective_datetime
  };

  if (observationInput.value_quantity) {
    const quantity = asRecord(observationInput.value_quantity);
    observation.valueQuantity = {
      value: quantity.value,
      unit: quantity.unit
    };
  } else if (observationInput.value_string) {
    observation.valueString = observationInput.value_string;
  } else if (observationInput.value_codeable_concept) {
    observation.valueCodeableConcept = {
      coding: [asRecord(observationInput.value_codeable_concept)]
    };
  }

  if (encounterId) {
    observation.encounter = { reference: `Encounter/${encounterId}` };
  }

  return observation;
}

function serializeCondition(
  conditionInput: Record<string, unknown>,
  sourceSystemId: string,
  patientId: string
): Record<string, unknown> {
  return {
    resourceType: "Condition",
    id: String(conditionInput.condition_id ?? crypto.randomUUID()),
    meta: { source: sourceSystemId },
    clinicalStatus: {
      text: conditionInput.clinical_status
    },
    verificationStatus: {
      text: conditionInput.verification_status
    },
    code: {
      coding: [asRecord(conditionInput.snomed_code)]
    },
    subject: {
      reference: `Patient/${patientId}`
    },
    onsetDateTime: conditionInput.onset_datetime
  };
}

export function serializeToFhirR4(cimRecord: Record<string, unknown>): SerializerResult {
  const warnings: AgentWarning[] = [];
  const errors: AgentError[] = [];

  const provenance = asRecord(cimRecord.provenance);
  const sourceSystemId = String(provenance.source_system_id ?? "unknown-source");

  const patient = serializePatient(cimRecord, sourceSystemId);
  const patientId = String(patient.id);

  const encounterResources = toArray<Record<string, unknown>>(cimRecord.encounters).map((encounter) =>
    serializeEncounter(encounter, sourceSystemId, patientId)
  );

  const encounterIds = new Set(encounterResources.map((enc) => String(enc.id)));

  const observationResources = toArray<Record<string, unknown>>(cimRecord.observations).map((obs) => {
    const encounterRef = String(obs.encounter_id_ref ?? "");
    const encounterId = encounterIds.has(encounterRef) ? encounterRef : undefined;
    return serializeObservation(obs, sourceSystemId, patientId, encounterId);
  });

  const conditionResources = toArray<Record<string, unknown>>(cimRecord.conditions).map((condition) =>
    serializeCondition(condition, sourceSystemId, patientId)
  );

  const bundle = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: patient },
      ...encounterResources.map((resource) => ({ resource })),
      ...observationResources.map((resource) => ({ resource })),
      ...conditionResources.map((resource) => ({ resource }))
    ]
  };

  const validation = validateFhirBundleAgainstSchema(bundle);
  if (!validation.valid) {
    errors.push({
      code: "OUTPUT_SERIALIZATION_FAILED",
      message: "FHIR R4 bundle schema validation failed",
      severity: "P2",
      recoverability: "NON_RETRYABLE",
      diagnostic_payload: {
        failing_path: validation.failingPath
      }
    });

    return { warnings, errors };
  }

  return { payload: bundle, warnings, errors };
}

export function serializeToOmop(cimRecord: Record<string, unknown>): SerializerResult {
  const warnings: AgentWarning[] = [];
  const errors: AgentError[] = [];

  const patient = asRecord(cimRecord.patient);
  const patientId = String(patient.patient_id ?? "").trim();
  if (!patientId) {
    errors.push({
      code: "OUTPUT_OMOP_NO_PERSON_ID",
      message: "OMOP serialization requires cim.patient.patient_id",
      severity: "P1",
      recoverability: "NON_RETRYABLE",
      diagnostic_payload: {
        path: "$.patient.patient_id"
      }
    });
    return { warnings, errors };
  }

  const personId = stablePositiveInt(patientId);
  const birth = parseDateParts(String(patient.birth_date ?? ""));

  const personRows: OmopPersonRow[] = [
    {
      person_id: personId,
      gender_concept_id: genderToOmopConceptId(patient.administrative_gender),
      year_of_birth: birth.year,
      month_of_birth: birth.month,
      day_of_birth: birth.day,
      birth_datetime: birth.datetime,
      race_concept_id: 0,
      ethnicity_concept_id: 0
    }
  ];

  const visitRows: OmopVisitOccurrenceRow[] = toArray<Record<string, unknown>>(cimRecord.encounters).map(
    (encounter, index) => {
      const classValue = asRecord(encounter.class).code ?? encounter.class;
      const start = parseDateParts(String(encounter.period_start ?? ""));
      const end = parseDateParts(String(encounter.period_end ?? encounter.period_start ?? ""));
      const visitOccurrenceId = stablePositiveInt(`${patientId}:visit:${encounter.encounter_id ?? index}`);

      return {
        visit_occurrence_id: visitOccurrenceId,
        person_id: personId,
        visit_concept_id: visitClassToConceptId(classValue),
        visit_start_date: start.date,
        visit_start_datetime: start.datetime,
        visit_end_date: end.date,
        visit_end_datetime: end.datetime,
        visit_type_concept_id: 32035,
        care_site_id: null
      };
    }
  );

  const measurementRows: OmopMeasurementRow[] = [];
  for (const [index, observation] of toArray<Record<string, unknown>>(cimRecord.observations).entries()) {
    const category = String(asRecord(observation.category).code ?? "").toLowerCase();
    if (category !== "laboratory" && category !== "vital-signs") {
      continue;
    }

    const loincCode = String(asRecord(observation.loinc_code).code ?? "").trim();
    const measurementConceptId = LOINC_TO_OMOP_CONCEPT_ID[loincCode] ?? 0;
    if (measurementConceptId === 0) {
      warnings.push({
        code: "OMOP_CONCEPT_UNMAPPED",
        message: "Measurement concept is unmapped to OMOP",
        diagnostic_payload: {
          table: "MEASUREMENT",
          source_code: loincCode,
          path: `$.observations[${index}].loinc_code.code`
        }
      });
    }

    const effective = parseDateParts(String(observation.effective_datetime ?? ""));
    const valueQuantity = asRecord(observation.value_quantity);
    const referenceRange = asRecord(observation.reference_range);
    const unit = normalizeUnit(valueQuantity.unit);

    measurementRows.push({
      measurement_id: stablePositiveInt(`${patientId}:measurement:${observation.observation_id ?? index}`),
      person_id: personId,
      measurement_concept_id: measurementConceptId,
      measurement_date: effective.date,
      measurement_datetime: effective.datetime,
      measurement_type_concept_id: 32856,
      operator_concept_id: null,
      value_as_number:
        typeof valueQuantity.value === "number"
          ? valueQuantity.value
          : Number.isFinite(Number(valueQuantity.value))
            ? Number(valueQuantity.value)
            : null,
      value_as_concept_id: 0,
      unit_concept_id: UCUM_TO_OMOP_UNIT_CONCEPT_ID[unit] ?? 0,
      range_low:
        typeof referenceRange.low === "number"
          ? referenceRange.low
          : Number.isFinite(Number(referenceRange.low))
            ? Number(referenceRange.low)
            : null,
      range_high:
        typeof referenceRange.high === "number"
          ? referenceRange.high
          : Number.isFinite(Number(referenceRange.high))
            ? Number(referenceRange.high)
            : null
    });
  }

  const conditionRows: OmopConditionOccurrenceRow[] = [];
  for (const [index, condition] of toArray<Record<string, unknown>>(cimRecord.conditions).entries()) {
    const assertionClass = String(condition.assertion_class ?? "").toUpperCase();
    if (assertionClass !== "ASSERTED" && assertionClass !== "HISTORICAL") {
      continue;
    }

    const snomedCode = String(asRecord(condition.snomed_code).code ?? "").trim();
    const conditionConceptId = SNOMED_TO_OMOP_CONCEPT_ID[snomedCode] ?? 0;
    if (conditionConceptId === 0) {
      warnings.push({
        code: "OMOP_CONCEPT_UNMAPPED",
        message: "Condition concept is unmapped to OMOP",
        diagnostic_payload: {
          table: "CONDITION_OCCURRENCE",
          source_code: snomedCode,
          path: `$.conditions[${index}].snomed_code.code`
        }
      });
    }

    const start = parseDateParts(String(condition.onset_datetime ?? condition.condition_start_datetime ?? ""));
    const end = parseDateParts(String(condition.condition_end_datetime ?? ""));

    conditionRows.push({
      condition_occurrence_id: stablePositiveInt(`${patientId}:condition:${condition.condition_id ?? index}`),
      person_id: personId,
      condition_concept_id: conditionConceptId,
      condition_start_date: start.date,
      condition_start_datetime: start.datetime,
      condition_end_date: end.date,
      condition_type_concept_id: conditionAssertionToTypeConceptId(assertionClass),
      condition_status_concept_id: conditionAssertionToStatusConceptId(assertionClass)
    });
  }

  return {
    payload: {
      PERSON: personRows,
      VISIT_OCCURRENCE: visitRows,
      MEASUREMENT: measurementRows,
      CONDITION_OCCURRENCE: conditionRows
    },
    warnings,
    errors
  };
}

export function serializeToFlatJson(
  cimRecord: Record<string, unknown>,
  config: FlatJsonMappingConfig
): SerializerResult {
  const payload: Record<string, unknown> = {};
  const warnings: AgentWarning[] = [];

  for (const [targetKey, cimPath] of Object.entries(config.field_mappings)) {
    const value = getByPath(cimRecord, cimPath);
    if (value === undefined) {
      warnings.push({
        code: "OUTPUT_UNDEFINED_MAPPING_PATH",
        message: `CIM path not found and omitted: ${cimPath}`,
        diagnostic_payload: {
          target_key: targetKey,
          cim_path: cimPath
        }
      });
      continue;
    }

    payload[targetKey] = value;
  }

  return { payload, warnings, errors: [] };
}

export function serializeByTargetFormat(
  targetFormat: TargetFormat,
  cimRecord: Record<string, unknown>,
  flatJsonMapping?: FlatJsonMappingConfig
): SerializerResult {
  if (targetFormat === "FHIR_R4") {
    return serializeToFhirR4(cimRecord);
  }

  if (targetFormat === "OMOP_CDM_V5_4") {
    return serializeToOmop(cimRecord);
  }

  if (targetFormat === "CUSTOM_FLAT_JSON") {
    return serializeToFlatJson(cimRecord, flatJsonMapping ?? { field_mappings: {} });
  }

  return {
    warnings: [],
    errors: [
      {
        code: "OUTPUT_SERIALIZATION_FAILED",
        message: `No serializer implemented for target format: ${targetFormat}`,
        severity: "P2",
        recoverability: "NON_RETRYABLE",
        diagnostic_payload: {
          target_format: targetFormat
        }
      }
    ]
  };
}
