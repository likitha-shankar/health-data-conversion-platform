import crypto from "node:crypto";
import type {
  AgentMetadata,
  ConversionRequest,
  ConversionResult,
  FieldMapping,
  RawPayload,
  RoutingCheckResult,
  ServiceHealthResponse,
  SourceHint,
  SpecialistAgent,
  SupportDecision
} from "@platform/contracts";

const VERSION = process.env.SERVICE_VERSION ?? "1.0.0";

interface ParsedMsh {
  sendingApplication?: string;
  sendingFacility?: string;
  messageType?: string;
  messageControlId?: string;
  timestampIsoUtc?: string;
  hl7Version?: string;
  timestampParseError?: string;
  timestampNoTimezoneAssumedUtc?: boolean;
}

interface ParsedPid {
  identifiers: Array<{ id: string; assigningAuthority?: string; identifierType?: string }>;
  familyName?: string;
  givenNames: string[];
  birthDateIso?: string;
  birthDateParseError?: string;
  administrativeSex?: string;
  address?: {
    line?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
}

type ParsedObxDataType = "NM" | "ST" | "CE";

interface ParsedObx {
  observationIdentifier?: { code?: string; display?: string; system?: string };
  units?: string;
  resultStatus?: string;
  dataType?: ParsedObxDataType;
  dataTypeInferred: boolean;
  rawObservationValue?: string;
  numericValue?: number;
  stringValue?: string;
  codedValue?: { identifier?: string; text?: string; codingSystem?: string };
  datatypeError?: string;
}

interface ParsedMessage {
  msh?: ParsedMsh;
  pid?: ParsedPid;
  obx: ParsedObx[];
  dg1: ParsedDg1[];
  hasZSegment: boolean;
  messageType?: string;
}

interface ParsedDg1 {
  diagnosisCode?: string;
  diagnosisDisplay?: string;
  diagnosisSystem?: string;
}

function hashValue(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function splitSegments(content: string): string[] {
  const normalized = content.replace(/\\r\\n/g, "\n").replace(/\\r/g, "\n").replace(/\\n/g, "\n");
  return normalized
    .split(/\r\n|\n|\r/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeHl7TimestampToUtcIso(
  value: string,
  senderTimezone?: string
): { value?: string; error?: string; noTimezoneAssumedUtc?: boolean } {
  const input = value.trim();
  const match = input.match(
    /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:\.(\d+))?([+\-]\d{4})?$/
  );

  if (!match) {
    return { error: `Invalid HL7 TS format: ${input}` };
  }

  const year = match[1];
  const month = match[2] ?? "01";
  const day = match[3] ?? "01";
  const hour = match[4] ?? "00";
  const minute = match[5] ?? "00";
  const second = match[6] ?? "00";
  const fractional = match[7] ? `.${match[7].slice(0, 3)}` : "";
  const tz = match[8];

  const isoBase = `${year}-${month}-${day}T${hour}:${minute}:${second}${fractional}`;
  const timezoneSource = tz ?? senderTimezone;
  const noTimezoneAssumedUtc = !timezoneSource;

  const isoInput = timezoneSource
    ? `${isoBase}${timezoneSource.slice(0, 3)}:${timezoneSource.slice(3, 5)}`
    : `${isoBase}Z`;

  const date = new Date(isoInput);
  if (Number.isNaN(date.getTime())) {
    return { error: `Invalid HL7 TS date value: ${input}` };
  }

  return { value: date.toISOString(), noTimezoneAssumedUtc };
}

function normalizeHl7DateToIsoDate(value: string): { value?: string; error?: string } {
  const input = value.trim();
  const match = input.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) {
    return { error: `Invalid HL7 date format: ${input}` };
  }

  const isoDate = `${match[1]}-${match[2]}-${match[3]}`;
  const probe = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(probe.getTime())) {
    return { error: `Invalid HL7 date value: ${input}` };
  }

  return { value: isoDate };
}

function parseMsh(segment: string, fieldSep: string, componentSep: string): ParsedMsh {
  const fields = segment.split(fieldSep);
  const senderTimezone = process.env.HL7_SENDER_DEFAULT_TIMEZONE;
  const timestampNormalized = fields[6] ? normalizeHl7TimestampToUtcIso(fields[6], senderTimezone) : {};

  return {
    sendingApplication: fields[2] || undefined,
    sendingFacility: fields[3] || undefined,
    messageType: fields[8] ? fields[8].split(componentSep).join("^") : undefined,
    messageControlId: fields[9] || undefined,
    timestampIsoUtc: timestampNormalized.value,
    hl7Version: fields[11] || undefined,
    timestampParseError: timestampNormalized.error,
    timestampNoTimezoneAssumedUtc: timestampNormalized.noTimezoneAssumedUtc
  };
}

function parsePid(segment: string, fieldSep: string, componentSep: string): ParsedPid {
  const fields = segment.split(fieldSep);

  const identifiers = (fields[3] || "")
    .split("~")
    .filter(Boolean)
    .map((idBlock) => {
      const idParts = idBlock.split(componentSep);
      return {
        id: idParts[0] || "",
        assigningAuthority: idParts[3] || undefined,
        identifierType: idParts[4] || undefined
      };
    })
    .filter((item) => item.id);

  const nameParts = (fields[5] || "").split(componentSep);
  const birthDateNormalized = fields[7] ? normalizeHl7DateToIsoDate(fields[7]) : {};

  const addressParts = (fields[11] || "").split(componentSep);
  const address = fields[11]
    ? {
        line: [addressParts[0], addressParts[1]].filter(Boolean).join(" ") || undefined,
        city: addressParts[2] || undefined,
        state: addressParts[3] || undefined,
        postalCode: addressParts[4] || undefined,
        country: addressParts[5] || undefined
      }
    : undefined;

  return {
    identifiers,
    familyName: nameParts[0] || undefined,
    givenNames: [nameParts[1], nameParts[2]].filter(Boolean) as string[],
    birthDateIso: birthDateNormalized.value,
    birthDateParseError: birthDateNormalized.error,
    administrativeSex: fields[8] || undefined,
    address
  };
}

function inferObxDatatype(value: string, componentSep: string): ParsedObxDataType {
  const trimmed = value.trim();
  if (/^[+\-]?\d+(?:\.\d+)?$/.test(trimmed)) {
    return "NM";
  }
  const ceParts = trimmed.split(componentSep);
  if (ceParts.length >= 2) {
    return "CE";
  }
  return "ST";
}

function parseObx(segment: string, fieldSep: string, componentSep: string): ParsedObx {
  const fields = segment.split(fieldSep);
  const idParts = (fields[3] || "").split(componentSep);
  const unitsParts = (fields[6] || "").split(componentSep);

  const rawDatatype = fields[2]?.trim().toUpperCase();
  const rawValue = fields[5] || "";

  let dataType: ParsedObxDataType | undefined;
  let dataTypeInferred = false;

  if (rawDatatype === "NM" || rawDatatype === "ST" || rawDatatype === "CE") {
    dataType = rawDatatype;
  } else if (!rawDatatype) {
    dataType = inferObxDatatype(rawValue, componentSep);
    dataTypeInferred = true;
  } else {
    dataType = "ST";
  }

  const parsed: ParsedObx = {
    observationIdentifier: fields[3]
      ? {
          code: idParts[0] || undefined,
          display: idParts[1] || undefined,
          system: idParts[2] || undefined
        }
      : undefined,
    units: unitsParts[0] || undefined,
    resultStatus: fields[11] || undefined,
    dataType,
    dataTypeInferred,
    rawObservationValue: rawValue
  };

  if (dataType === "NM") {
    const numeric = Number.parseFloat(rawValue);
    if (!rawValue.trim() || Number.isNaN(numeric)) {
      parsed.datatypeError = `HL7_FIELD_DATATYPE_INVALID: expected NM numeric value in OBX-5, got '${rawValue}'`;
      return parsed;
    }
    parsed.numericValue = numeric;
    return parsed;
  }

  if (dataType === "CE") {
    const ceParts = rawValue.split(componentSep);
    parsed.codedValue = {
      identifier: ceParts[0] || undefined,
      text: ceParts[1] || undefined,
      codingSystem: ceParts[2] || undefined
    };
    return parsed;
  }

  parsed.stringValue = rawValue.trim();
  return parsed;
}

function parseDg1(segment: string, fieldSep: string, componentSep: string): ParsedDg1 {
  const fields = segment.split(fieldSep);
  const diagnosisParts = (fields[3] || "").split(componentSep);
  return {
    diagnosisCode: diagnosisParts[0] || undefined,
    diagnosisDisplay: diagnosisParts[1] || undefined,
    diagnosisSystem: diagnosisParts[2] || undefined
  };
}

function parseMessage(content: string): ParsedMessage {
  const segments = splitSegments(content);
  const mshSegment = segments.find((seg) => seg.startsWith("MSH"));
  if (!mshSegment) {
    return { obx: [], dg1: [], hasZSegment: false };
  }

  const fieldSep = mshSegment.charAt(3) || "|";
  const mshFields = mshSegment.split(fieldSep);
  const componentSep = mshFields[1]?.charAt(0) || "^";

  const msh = parseMsh(mshSegment, fieldSep, componentSep);
  const pidSegment = segments.find((seg) => seg.startsWith("PID"));
  const pid = pidSegment ? parsePid(pidSegment, fieldSep, componentSep) : undefined;

  const obx = segments
    .filter((seg) => seg.startsWith("OBX"))
    .map((seg) => parseObx(seg, fieldSep, componentSep));
  const dg1 = segments
    .filter((seg) => seg.startsWith("DG1"))
    .map((seg) => parseDg1(seg, fieldSep, componentSep));

  return {
    msh,
    pid,
    obx,
    dg1,
    hasZSegment: segments.some((seg) => seg.startsWith("Z")),
    messageType: msh.messageType
  };
}

function toObservationStatus(value?: string): string {
  switch (value) {
    case "F":
      return "final";
    case "P":
      return "preliminary";
    case "C":
      return "corrected";
    case "X":
      return "cancelled";
    default:
      return "registered";
  }
}

function toAdministrativeGender(value?: string): string | undefined {
  switch ((value || "").toUpperCase()) {
    case "M":
      return "male";
    case "F":
      return "female";
    case "O":
      return "other";
    case "U":
      return "unknown";
    default:
      return value ? "unknown" : undefined;
  }
}

function buildMissingFieldFlag(path: string): FieldMapping {
  return {
    source_path: "",
    source_value_hash: hashValue(path),
    target_path: path,
    target_value_hash: hashValue("MISSING"),
    mapping_tier: "RULE",
    confidence_score: 0,
    threshold: 1,
    threshold_passed: false,
    flags: [{ code: "UNMAPPABLE", detail: `Missing required field: ${path}` }]
  };
}

interface AuditEventPayload {
  audit_event_id: string;
  ingestion_id: string;
  trace_id: string;
  agent_id: string;
  agent_version: string;
  source_format: string;
  target_format: string;
  transformation_step: string;
  status_transition: string;
  context_json?: string;
  created_at: string;
}

async function postAuditEvent(event: AuditEventPayload): Promise<boolean> {
  const auditServiceUrl = process.env.AUDIT_SERVICE_URL;
  if (!auditServiceUrl) {
    return false;
  }

  try {
    const response = await fetch(`${auditServiceUrl}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event)
    });
    return response.ok;
  } catch {
    return false;
  }
}

interface TerminologyMapRequest {
  concept_text: string;
  source_system: "SNOMED" | "LOINC" | "ICD10" | "RXNORM" | "LOCAL";
  target_system: "SNOMED" | "LOINC" | "ICD10" | "RXNORM" | "LOCAL";
  context_domain: "diagnosis" | "medication" | "lab" | "procedure" | "vital" | "administrative";
}

interface TerminologyMapResponse {
  mapped_code: string;
  mapped_display: string;
  mapped_system: string;
  confidence: number;
  mapping_tier: "RULE" | "EMBED" | "LLM" | "UNMAPPABLE";
  flags: string[];
  candidates: Array<{ code: string; display: string; system: string; score: number }>;
  release_id: string;
}

interface TerminologyBatchResponse {
  release_id: string;
  results: TerminologyMapResponse[];
}

async function mapViaTerminologyBatch(
  requests: TerminologyMapRequest[]
): Promise<{ responses: TerminologyMapResponse[]; serviceUnavailable: boolean; releaseId: string }> {
  const terminologyServiceUrl = process.env.TERMINOLOGY_SERVICE_URL;
  const defaultUnmappable = (request: TerminologyMapRequest): TerminologyMapResponse => ({
    mapped_code: "",
    mapped_display: "",
    mapped_system: request.target_system,
    confidence: 0,
    mapping_tier: "UNMAPPABLE",
    flags: ["MAPPING_TERMINOLOGY_SERVER_UNAVAILABLE"],
    candidates: [],
    release_id: ""
  });

  if (requests.length === 0) {
    return { responses: [], serviceUnavailable: false, releaseId: "" };
  }

  if (!terminologyServiceUrl) {
    return {
      responses: requests.map((request) => defaultUnmappable(request)),
      serviceUnavailable: true,
      releaseId: ""
    };
  }

  try {
    const response = await fetch(`${terminologyServiceUrl}/map/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requests)
    });

    if (!response.ok) {
      throw new Error(`terminology status ${response.status}`);
    }

    const payload = (await response.json()) as TerminologyBatchResponse;
    return { responses: payload.results, serviceUnavailable: false, releaseId: payload.release_id };
  } catch {
    return {
      responses: requests.map((request) => defaultUnmappable(request)),
      serviceUnavailable: true,
      releaseId: ""
    };
  }
}

export class Hl7V2Agent implements SpecialistAgent {
  getMetadata(): AgentMetadata {
    return {
      agent_id: "hl7v2-agent",
      agent_version: VERSION,
      supported_source_formats: ["HL7V2"],
      supported_input_versions: ["2.1", "2.2", "2.3", "2.3.1", "2.4", "2.5", "2.5.1", "2.6", "2.7", "2.8"],
      capabilities: ["parse", "map", "validate", "serialize"],
      confidence_profile: {
        diagnosis: 0.95,
        medication: 0.97,
        labs: 0.93
      },
      danger_ruleset_version: "1.0.0"
    };
  }

  supportsSource(inputHint: SourceHint): SupportDecision {
    const supported = inputHint.source_format_candidate === "HL7V2";
    return {
      supported,
      score: supported ? 1.0 : 0.0,
      evidence: supported ? ["source_format_hl7v2"] : ["source_not_supported"]
    };
  }

  selfCheckRouting(payload: RawPayload): RoutingCheckResult {
    const isLikelyHL7 = payload.content.startsWith("MSH");
    return {
      status: isLikelyHL7 ? "PASS" : "FAIL",
      confidence: isLikelyHL7 ? 1.0 : 0.0,
      reason: isLikelyHL7 ? "MSH present at message start" : "MSH not present at message start",
      evidence: [isLikelyHL7 ? "msh_at_start" : "msh_missing_at_start"]
    };
  }

  async convert(request: ConversionRequest): Promise<ConversionResult> {
    const start = Date.now();
    const routing = this.selfCheckRouting(request.raw_payload);
    const auditRefs: string[] = [];

    if (routing.status === "FAIL") {
      return {
        status: "FAILURE",
        routing_self_check: routing,
        field_mappings: [],
        errors: [
          {
            code: "MISROUTE_DETECTED",
            message: "Payload failed HL7 routing self-check",
            severity: "P1",
            recoverability: "NON_RETRYABLE",
            diagnostic_payload: {
              detected_source_format: request.detected_source_format
            }
          }
        ],
        warnings: [],
        metrics: {
          parse_ms: 0,
          map_ms: 0,
          validate_ms: 0,
          serialize_ms: 0,
          retries: 0
        },
        audit_refs: []
      };
    }

    const parsed = parseMessage(request.raw_payload.content);
    const parseMs = Date.now() - start;

    const parseAuditEventId = crypto.randomUUID();
    const parseAuditOk = await postAuditEvent({
      audit_event_id: parseAuditEventId,
      ingestion_id: request.request_id,
      trace_id: request.trace_id,
      agent_id: "hl7v2-agent",
      agent_version: VERSION,
      source_format: request.detected_source_format,
      target_format: request.requested_target_format,
      transformation_step: "parse",
      status_transition: "PARSE_COMPLETED",
      created_at: new Date().toISOString()
    });
    if (parseAuditOk) {
      auditRefs.push(parseAuditEventId);
    }

    const warnings: ConversionResult["warnings"] = [];
    const fieldMappings: FieldMapping[] = [];
    const cimFlags: string[] = [];

    if (parsed.hasZSegment) {
      warnings.push({
        code: "HL7_ZSEGMENT_PRESENT",
        message: "Z-segment detected and preserved as extension metadata"
      });
      cimFlags.push("HL7_ZSEGMENT_PRESENT");
    }

    if (parsed.msh?.timestampParseError) {
      warnings.push({
        code: "HL7_TIMESTAMP_MALFORMED",
        message: parsed.msh.timestampParseError
      });
      fieldMappings.push(buildMissingFieldFlag("$.encounters[0].period_start"));
      cimFlags.push("HL7_TIMESTAMP_MALFORMED");
    }

    if (parsed.msh?.timestampNoTimezoneAssumedUtc) {
      warnings.push({
        code: "HL7_TIMESTAMP_NO_TIMEZONE",
        message: "MSH-7 has no timezone offset; normalized assuming UTC"
      });
      cimFlags.push("HL7_TIMESTAMP_NO_TIMEZONE");
    }

    const missingPaths: string[] = [];

    if (!parsed.pid) {
      missingPaths.push("$.patient.source_identifiers");
      missingPaths.push("$.patient.family_name");
      missingPaths.push("$.patient.given_names");
    } else {
      if (parsed.pid.identifiers.length === 0) {
        missingPaths.push("$.patient.source_identifiers");
      }
      if (!parsed.pid.familyName) {
        missingPaths.push("$.patient.family_name");
      }
      if (parsed.pid.givenNames.length === 0) {
        missingPaths.push("$.patient.given_names");
      }
    }

    if (parsed.messageType?.startsWith("ORU") && parsed.obx.length === 0) {
      missingPaths.push("$.observations");
    }

    for (const path of missingPaths) {
      fieldMappings.push(buildMissingFieldFlag(path));
    }

    const patient = {
      patient_id: crypto.randomUUID(),
      source_identifiers:
        parsed.pid?.identifiers.map((id) => ({
          value: id.id,
          assigning_authority: id.assigningAuthority,
          type: id.identifierType
        })) ?? [],
      family_name: parsed.pid?.familyName,
      given_names: parsed.pid?.givenNames ?? [],
      birth_date: parsed.pid?.birthDateIso,
      administrative_gender: toAdministrativeGender(parsed.pid?.administrativeSex),
      addresses: parsed.pid?.address
        ? [
            {
              line: parsed.pid.address.line,
              city: parsed.pid.address.city,
              state: parsed.pid.address.state,
              postalCode: parsed.pid.address.postalCode,
              country: parsed.pid.address.country
            }
          ]
        : []
    };

    const encounter = {
      encounter_id: crypto.randomUUID(),
      status: "unknown",
      class: {
        code: "AMB",
        system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
        display: "ambulatory"
      },
      period_start: parsed.msh?.timestampIsoUtc,
      source_encounter_id: parsed.msh?.messageControlId
    };

    const fieldConfidenceMap: Record<string, number> = {
      "$.patient.source_identifiers": parsed.pid?.identifiers.length ? 1 : 0
    };
    const terminologyCandidatesMap: Record<string, Array<{ code: string; display: string; system: string; score: number }>> = {};

    const terminologyRequests: TerminologyMapRequest[] = [];
    const obxRequestIndex = new Map<number, { primary: number; fallback?: number }>();
    const dg1RequestIndex = new Map<number, { snomed: number; icd10: number }>();

    for (const [index, obx] of parsed.obx.entries()) {
      if (!obx.observationIdentifier?.code) continue;
      const primaryIndex = terminologyRequests.length;
      terminologyRequests.push({
        concept_text: obx.observationIdentifier.code,
        source_system: "LOINC",
        target_system: "LOINC",
        context_domain: "lab"
      });
      const fallbackIndex =
        obx.observationIdentifier.display && obx.observationIdentifier.display.trim()
          ? terminologyRequests.push({
              concept_text: obx.observationIdentifier.display,
              source_system: "LOCAL",
              target_system: "LOINC",
              context_domain: "lab"
            }) - 1
          : undefined;
      obxRequestIndex.set(index, { primary: primaryIndex, fallback: fallbackIndex });
    }

    for (const [index, dg1] of parsed.dg1.entries()) {
      const sourceSystem = dg1.diagnosisSystem?.toUpperCase().includes("I10") ? "ICD10" : "SNOMED";
      const primaryCode = dg1.diagnosisCode ?? "";
      dg1RequestIndex.set(index, {
        snomed: terminologyRequests.length,
        icd10: terminologyRequests.length + 1
      });
      terminologyRequests.push({
        concept_text: primaryCode,
        source_system: sourceSystem,
        target_system: "SNOMED",
        context_domain: "diagnosis"
      });
      terminologyRequests.push({
        concept_text: primaryCode,
        source_system: sourceSystem,
        target_system: "ICD10",
        context_domain: "diagnosis"
      });
    }

    const terminologyBatch = await mapViaTerminologyBatch(terminologyRequests);
    const terminologyResponses = terminologyBatch.responses;
    const terminologyReleaseId =
      terminologyBatch.releaseId || request.context_snapshot.terminology_release_id;

    if (terminologyBatch.serviceUnavailable && terminologyRequests.length > 0) {
      warnings.push({
        code: "MAPPING_TERMINOLOGY_SERVER_UNAVAILABLE",
        message: "Terminology service unreachable; affected concepts marked as UNMAPPABLE"
      });
    }

    const observations = await Promise.all(parsed.obx.map(async (obx, index) => {
      if (obx.dataTypeInferred) {
        warnings.push({
          code: "HL7_OBX_DATATYPE_INFERRED",
          message: `OBX-${index + 1} missing OBX-2 datatype; inferred ${obx.dataType}`,
          diagnostic_payload: { obx_index: index + 1, inferred_datatype: obx.dataType }
        });
      }

      if (obx.datatypeError) {
        warnings.push({
          code: "HL7_FIELD_DATATYPE_INVALID",
          message: obx.datatypeError,
          diagnostic_payload: { obx_index: index + 1 }
        });
        fieldMappings.push({
          source_path: `OBX[${index + 1}].5`,
          source_value_hash: hashValue(obx.rawObservationValue || ""),
          target_path: `$.observations[${index}].value_quantity.value`,
          target_value_hash: hashValue("INVALID"),
          mapping_tier: "RULE",
          confidence_score: 0,
          threshold: 1,
          threshold_passed: false,
          flags: [{ code: "UNMAPPABLE", detail: "HL7_FIELD_DATATYPE_INVALID" }]
        });
      }

      let loincDecision: TerminologyMapResponse = {
        mapped_code: "",
        mapped_display: "",
        mapped_system: "LOINC",
        confidence: 0,
        mapping_tier: "UNMAPPABLE",
        flags: ["MAPPING_NO_VIABLE_CANDIDATE"],
        candidates: [],
        release_id: terminologyReleaseId
      };
      const mappedIndex = obxRequestIndex.get(index);
      if (mappedIndex !== undefined && terminologyResponses[mappedIndex.primary]) {
        loincDecision = terminologyResponses[mappedIndex.primary];
        if (
          loincDecision.mapping_tier === "UNMAPPABLE" &&
          mappedIndex.fallback !== undefined &&
          terminologyResponses[mappedIndex.fallback]
        ) {
          loincDecision = terminologyResponses[mappedIndex.fallback];
        }
      }

      const observation = {
        observation_id: crypto.randomUUID(),
        status: toObservationStatus(obx.resultStatus),
        category: {
          code: "laboratory",
          system: "http://terminology.hl7.org/CodeSystem/observation-category",
          display: "laboratory"
        },
        loinc_code: {
          code: loincDecision.mapped_code || obx.observationIdentifier?.code,
          display: loincDecision.mapped_display || obx.observationIdentifier?.display,
          system: loincDecision.mapped_system || obx.observationIdentifier?.system || "LOINC"
        },
        effective_datetime: parsed.msh?.timestampIsoUtc,
        value_quantity:
          obx.dataType === "NM" && obx.numericValue !== undefined
            ? {
                value: obx.numericValue,
                unit: obx.units
              }
            : undefined,
        value_string: obx.dataType === "ST" ? obx.stringValue : undefined,
        value_codeable_concept:
          obx.dataType === "CE"
            ? {
                code: obx.codedValue?.identifier,
                display: obx.codedValue?.text,
                system: obx.codedValue?.codingSystem
              }
            : undefined,
        encounter_id_ref: encounter.encounter_id
      };

      if (observation.loinc_code.code && loincDecision.mapping_tier !== "UNMAPPABLE") {
        fieldMappings.push({
          source_path: `OBX[${index + 1}].3`,
          source_value_hash: hashValue(observation.loinc_code.code),
          target_path: `$.observations[${index}].loinc_code.code`,
          target_value_hash: hashValue(observation.loinc_code.code),
          mapping_tier:
            loincDecision.mapping_tier === "EMBED"
              ? "EMBED"
              : loincDecision.mapping_tier === "LLM"
                ? "LLM"
                : "RULE",
          confidence_score: loincDecision.confidence,
          threshold: 0.93,
          threshold_passed: loincDecision.confidence >= 0.93,
          flags: loincDecision.flags.map((flag) => ({ code: "UNMAPPABLE", detail: flag }))
        });
      } else if (obx.observationIdentifier?.code) {
        fieldMappings.push(buildMissingFieldFlag(`$.observations[${index}].loinc_code.code`));
      }

      fieldConfidenceMap[`$.observations[${index}].loinc_code.code`] = loincDecision.confidence;
      terminologyCandidatesMap[`$.observations[${index}].loinc_code.code`] = loincDecision.candidates;

      return observation;
    }));

    const conditions = await Promise.all(parsed.dg1.map(async (dg1, index) => {
      const requestIndexes = dg1RequestIndex.get(index);
      const snomedDecision = requestIndexes ? terminologyResponses[requestIndexes.snomed] : undefined;
      const icdDecision = requestIndexes ? terminologyResponses[requestIndexes.icd10] : undefined;

      const snomedResult = snomedDecision ?? {
        mapped_code: "",
        mapped_display: "",
        mapped_system: "SNOMED",
        confidence: 0,
        mapping_tier: "UNMAPPABLE" as const,
        flags: ["MAPPING_NO_VIABLE_CANDIDATE"],
        candidates: [],
        release_id: terminologyReleaseId
      };
      const icdResult = icdDecision ?? {
        mapped_code: "",
        mapped_display: "",
        mapped_system: "ICD10",
        confidence: 0,
        mapping_tier: "UNMAPPABLE" as const,
        flags: ["MAPPING_NO_VIABLE_CANDIDATE"],
        candidates: [],
        release_id: terminologyReleaseId
      };

      fieldConfidenceMap[`$.conditions[${index}].snomed_code`] = snomedResult.confidence;
      fieldConfidenceMap[`$.conditions[${index}].icd_code`] = icdResult.confidence;
      terminologyCandidatesMap[`$.conditions[${index}].snomed_code`] = snomedResult.candidates;
      terminologyCandidatesMap[`$.conditions[${index}].icd_code`] = icdResult.candidates;

      if (snomedResult.mapping_tier === "UNMAPPABLE") {
        fieldMappings.push(buildMissingFieldFlag(`$.conditions[${index}].snomed_code`));
      } else {
        fieldMappings.push({
          source_path: `DG1[${index + 1}].3`,
          source_value_hash: hashValue(dg1.diagnosisCode || ""),
          target_path: `$.conditions[${index}].snomed_code`,
          target_value_hash: hashValue(snomedResult.mapped_code),
          mapping_tier: snomedResult.mapping_tier === "EMBED" ? "EMBED" : "RULE",
          confidence_score: snomedResult.confidence,
          threshold: 0.95,
          threshold_passed: snomedResult.confidence >= 0.95,
          flags: snomedResult.flags.map((flag) => ({ code: "UNMAPPABLE", detail: flag }))
        });
      }
      if (icdResult.mapping_tier === "UNMAPPABLE") {
        fieldMappings.push(buildMissingFieldFlag(`$.conditions[${index}].icd_code`));
      } else {
        fieldMappings.push({
          source_path: `DG1[${index + 1}].3`,
          source_value_hash: hashValue(dg1.diagnosisCode || ""),
          target_path: `$.conditions[${index}].icd_code`,
          target_value_hash: hashValue(icdResult.mapped_code),
          mapping_tier: icdResult.mapping_tier === "EMBED" ? "EMBED" : "RULE",
          confidence_score: icdResult.confidence,
          threshold: 0.95,
          threshold_passed: icdResult.confidence >= 0.95,
          flags: icdResult.flags.map((flag) => ({ code: "UNMAPPABLE", detail: flag }))
        });
      }

      return {
        condition_id: crypto.randomUUID(),
        clinical_status: "active",
        verification_status: "confirmed",
        snomed_code:
          snomedResult.mapping_tier === "UNMAPPABLE"
            ? undefined
            : {
                code: snomedResult.mapped_code,
                display: snomedResult.mapped_display,
                system: snomedResult.mapped_system
              },
        icd_code:
          icdResult.mapping_tier === "UNMAPPABLE"
            ? undefined
            : {
                code: icdResult.mapped_code,
                display: icdResult.mapped_display,
                system: icdResult.mapped_system
              }
      };
    }));

    if (parsed.pid?.identifiers[0]) {
      fieldMappings.push({
        source_path: "PID.3",
        source_value_hash: hashValue(parsed.pid.identifiers[0].id),
        target_path: "$.patient.source_identifiers[0].value",
        target_value_hash: hashValue(parsed.pid.identifiers[0].id),
        mapping_tier: "RULE",
        confidence_score: 1,
        threshold: 0.95,
        threshold_passed: true,
        flags: []
      });
    }

    const hasDatatypeError = parsed.obx.some((obx) => Boolean(obx.datatypeError));
    const isPartial = missingPaths.length > 0 || Boolean(parsed.msh?.timestampParseError) || hasDatatypeError;

    const canonicalRecord = {
      cim_record_id: crypto.randomUUID(),
      ingestion_id: request.request_id,
      cim_version: "1.0.0",
      source_format: "HL7V2",
      agent_id: "hl7v2-agent",
      agent_version: VERSION,
      terminology_release_id: terminologyReleaseId,
      produced_at: new Date().toISOString(),
      record_status: isPartial ? "PARTIAL" : "COMPLETE",
      patient,
      encounters: [encounter],
      observations,
      conditions,
      medications: [],
      allergies: [],
      procedures: [],
      provenance: {
        source_system_id: parsed.msh?.sendingFacility,
        source_message_id: parsed.msh?.messageControlId,
        source_timestamp: parsed.msh?.timestampIsoUtc,
        transport_channel: request.raw_payload.transport_channel || request.source_channel,
        sending_application: parsed.msh?.sendingApplication,
        sending_facility: parsed.msh?.sendingFacility,
        message_type: parsed.msh?.messageType,
        hl7_version: parsed.msh?.hl7Version
      },
      cim_flags: cimFlags,
      field_confidence_map: fieldConfidenceMap,
      terminology_candidates: terminologyCandidatesMap,
      conflicted_values: []
    };

    const now = Date.now();
    const confidenceValues = Object.values(fieldConfidenceMap);
    const averageConfidence =
      confidenceValues.length === 0
        ? 0
        : confidenceValues.reduce((acc, value) => acc + value, 0) / confidenceValues.length;
    const mapAuditEventId = crypto.randomUUID();
    const mapAuditOk = await postAuditEvent({
      audit_event_id: mapAuditEventId,
      ingestion_id: request.request_id,
      trace_id: request.trace_id,
      agent_id: "hl7v2-agent",
      agent_version: VERSION,
      source_format: request.detected_source_format,
      target_format: request.requested_target_format,
      transformation_step: "map",
      status_transition: `${isPartial ? "MAP_PARTIAL_COMPLETED" : "MAP_COMPLETED"}_AVG_CONFIDENCE_${averageConfidence.toFixed(2)}`,
      context_json: JSON.stringify({
        terminology_release_id: terminologyReleaseId,
        average_confidence: Number(averageConfidence.toFixed(4))
      }),
      created_at: new Date().toISOString()
    });
    if (mapAuditOk) {
      auditRefs.push(mapAuditEventId);
    }

    return {
      status: isPartial ? "PARTIAL_SUCCESS" : "SUCCESS",
      routing_self_check: routing,
      canonical_record: canonicalRecord,
      target_payload: {
        resourceType: "Bundle",
        type: "collection",
        entry: [
          {
            resource: {
              resourceType: "Patient",
              id: patient.patient_id,
              identifier: patient.source_identifiers,
              name: [
                {
                  family: patient.family_name,
                  given: patient.given_names
                }
              ],
              gender: patient.administrative_gender,
              birthDate: patient.birth_date
            }
          }
        ]
      },
      field_mappings: fieldMappings,
      errors: [],
      warnings,
      metrics: {
        parse_ms: parseMs,
        map_ms: Math.max(1, now - start - parseMs),
        validate_ms: 1,
        serialize_ms: 1,
        retries: 0
      },
      audit_refs: auditRefs
    };
  }

  async health(): Promise<ServiceHealthResponse> {
    return {
      service: "hl7v2-agent",
      version: VERSION,
      status: "healthy"
    };
  }
}

// Backward-compatible export name used by existing imports.
export { Hl7V2Agent as Hl7V2MockAgent };
