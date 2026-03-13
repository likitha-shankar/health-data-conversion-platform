import express from "express";
import cors from "cors";
import { serializeByTargetFormat, type FlatJsonMappingConfig } from "@platform/serializers";
import { validateApiKey } from "./auth.js";
import type { OrchestratorRepository } from "./db.js";
import { createAdminRouter } from "./routes/admin.js";
import type {
  AgentError,
  ConversionRequest,
  ConversionResult,
  DetectionResult,
  OrchestratorResponseEnvelope,
  ServiceHealthResponse,
  SourceFormat,
  TargetFormat
} from "@platform/contracts";

interface ConvertApiRequest {
  tenant_id?: string;
  source_channel?: string;
  requested_target_format?: string;
  flat_json_mapping?: FlatJsonMappingConfig;
  raw_payload: {
    content: string;
    encoding?: string;
    transport_channel?: string;
  };
}

interface OrchestratorConfig {
  serviceVersion: string;
  repository: OrchestratorRepository;
  adminSecret: string;
  hl7AgentUrl: string;
  terminologyServiceUrl?: string;
  auditServiceUrl: string;
  errorBusUrl: string;
  dashboardUrl?: string;
  terminologyReleaseId: string;
  hl7AgentVersion: string;
  enableReplay?: boolean;
}

interface ErrorBusPayload {
  error_code: string;
  error_category: string;
  layer: string;
  severity: string;
  is_retryable: boolean;
  requires_human_review: boolean;
  ingestion_id: string;
  trace_id: string;
  source_system_id?: string;
  source_format: string;
  target_format: string;
  timestamp: string;
  layer_context: string;
}

interface DebugDecision {
  decision_type: string;
  field: string;
  source_path: string;
  source_value: unknown;
  output_value: unknown;
  method_used: string;
}

interface DebugTraceStep {
  step_number: number;
  layer_name: string;
  service: { name: string; version: string };
  input_snapshot: unknown;
  output_snapshot: unknown;
  decisions: DebugDecision[];
  warnings: string[];
  duration_ms: number;
}

interface DebugTrace {
  ingestion_id: string;
  trace_id: string;
  steps: DebugTraceStep[];
}

interface AuditEventRecord {
  audit_event_id: string;
  ingestion_id: string;
  trace_id: string;
  agent_id: string;
  agent_version: string;
  source_format: string;
  target_format: string;
  transformation_step: string;
  status_transition: string;
  raw_payload_ref?: string | null;
  context_json?: string | null;
  created_at: string;
}

function createIds() {
  return {
    ingestion_id: crypto.randomUUID(),
    trace_id: crypto.randomUUID()
  };
}

function normalizeTargetFormat(input?: string): TargetFormat {
  const value = (input ?? "FHIR_R4").trim();
  const upper = value.toUpperCase();

  if (upper === "FHIR_R4") return "FHIR_R4";
  if (upper === "CUSTOM_FLAT_JSON") return "CUSTOM_FLAT_JSON";
  if (upper === "OMOP_CDM_V5_4") return "OMOP_CDM_V5_4";
  if (upper === "SNOMED_CT_RECORD") return "SNOMED_CT_RECORD";
  if (upper === "LOINC_LAB_RESULT") return "LOINC_LAB_RESULT";
  if (upper === "OPENEHR_ARCHETYPE") return "OPENEHR_ARCHETYPE";
  if (value.toLowerCase() === "fhir_r4") return "FHIR_R4";
  if (value.toLowerCase() === "omop") return "OMOP_CDM_V5_4";
  if (value.toLowerCase() === "omop_cdm_v5.4") return "OMOP_CDM_V5_4";

  return "FHIR_R4";
}

function detectFormatStub(_raw: string): DetectionResult {
  return {
    decision: "ROUTE",
    top_candidate: {
      format: "HL7V2",
      score: 1.0,
      score_components: {
        stub_detection: 1.0
      }
    },
    all_candidates: [{ format: "HL7V2", score: 1.0 }],
    tie_breaking_applied: false,
    tie_breaking_rule: null,
    human_resolved: false,
    human_resolver_id: null,
    detection_duration_ms: 1,
    stage_reached: 3
  };
}

function resolveAgentUrl(sourceFormat: SourceFormat, config: OrchestratorConfig): string | null {
  if (sourceFormat === "HL7V2") {
    return config.hl7AgentUrl;
  }
  return null;
}

function classifyErrorCategory(errorCode: string): string {
  if (errorCode.startsWith("FORMAT_") || errorCode.includes("MISROUTE")) return "ROUTING";
  if (errorCode.includes("SERIALIZATION")) return "SERIALIZATION";
  if (errorCode.includes("DATATYPE") || errorCode.includes("MAPPING")) return "MAPPING";
  if (errorCode.includes("UNAVAILABLE") || errorCode.includes("DISPATCH")) return "SYSTEM";
  return "GENERAL";
}

async function postJson(url: string, payload: unknown): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${url}`);
  }
  return (await response.json()) as T;
}

async function checkDependency(url: string, path = "/health/ready"): Promise<{ ok: boolean; detail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${url}${path}`, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, detail: `status_${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "unknown" };
  } finally {
    clearTimeout(timer);
  }
}

async function emitErrorsToBus(
  errors: AgentError[],
  ingestionId: string,
  traceId: string,
  sourceFormat: string,
  targetFormat: string,
  sourceSystemId: string | undefined,
  config: OrchestratorConfig
): Promise<void> {
  await Promise.all(
    errors.map((error) => {
      const payload: ErrorBusPayload = {
        error_code: error.code,
        error_category: classifyErrorCategory(error.code),
        layer: error.code === "OUTPUT_SERIALIZATION_FAILED" ? "serializer" : "agent",
        severity: error.severity,
        is_retryable: error.recoverability === "RETRYABLE",
        requires_human_review: error.severity === "P1" || error.severity === "P2",
        ingestion_id: ingestionId,
        trace_id: traceId,
        source_system_id: sourceSystemId,
        source_format: sourceFormat,
        target_format: targetFormat,
        timestamp: new Date().toISOString(),
        layer_context: JSON.stringify(error.diagnostic_payload ?? {})
      };
      return postJson(`${config.errorBusUrl}/errors`, payload).catch(() => undefined);
    })
  );
}

function parseContextJson(value?: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function buildParseSnapshot(canonicalRecord: Record<string, unknown>) {
  const provenance = (canonicalRecord.provenance ?? {}) as Record<string, unknown>;
  const patient = (canonicalRecord.patient ?? {}) as Record<string, unknown>;
  return {
    provenance: {
      sending_application: provenance.sending_application,
      sending_facility: provenance.sending_facility,
      message_type: provenance.message_type,
      source_message_id: provenance.source_message_id,
      hl7_version: provenance.hl7_version
    },
    patient_anchor: {
      source_identifiers: patient.source_identifiers,
      family_name: patient.family_name,
      given_names: patient.given_names
    }
  };
}

function buildMapDecisions(conversionResult: ConversionResult): DebugDecision[] {
  const mappingDecisions = conversionResult.field_mappings.map((mapping) => ({
    decision_type: "field_mapping",
    field: mapping.target_path,
    source_path: mapping.source_path,
    source_value: mapping.source_value_hash,
    output_value: mapping.target_value_hash,
    method_used: `${mapping.mapping_tier}:confidence=${mapping.confidence_score}`
  }));

  const confidenceMap = ((conversionResult.canonical_record?.field_confidence_map ?? {}) as Record<string, number>) || {};
  const terminologyDecisions = Object.entries(confidenceMap).map(([path, confidence]) => ({
    decision_type: "terminology_confidence",
    field: path,
    source_path: path,
    source_value: null,
    output_value: confidence,
    method_used: "TERMINOLOGY_RULE_ENGINE"
  }));

  const candidateMap =
    ((conversionResult.canonical_record?.terminology_candidates ?? {}) as Record<string, unknown[]>) || {};
  const candidateDecisions = Object.entries(candidateMap).map(([path, candidates]) => ({
    decision_type: "terminology_candidates",
    field: path,
    source_path: path,
    source_value: null,
    output_value: candidates,
    method_used: "TERMINOLOGY_EMBED_TOP3"
  }));

  return [...mappingDecisions, ...terminologyDecisions, ...candidateDecisions];
}

function buildDebugTrace(
  ingestionId: string,
  traceId: string,
  rawPayload: string,
  detection: DetectionResult,
  conversionResult: ConversionResult,
  orchestratorVersion: string,
  agentVersion: string
): DebugTrace {
  const canonical = (conversionResult.canonical_record ?? {}) as Record<string, unknown>;
  const parseSnapshot = buildParseSnapshot(canonical);
  const mapDecisions = buildMapDecisions(conversionResult);

  const steps: DebugTraceStep[] = [
    {
      step_number: 1,
      layer_name: "ingest",
      service: { name: "orchestrator", version: orchestratorVersion },
      input_snapshot: { raw_payload_length: rawPayload.length },
      output_snapshot: { ingestion_id: ingestionId, trace_id: traceId },
      decisions: [
        {
          decision_type: "ingest_received",
          field: "raw_payload",
          source_path: "request.raw_payload",
          source_value: rawPayload.slice(0, 120),
          output_value: "accepted",
          method_used: "API_POST"
        }
      ],
      warnings: [],
      duration_ms: 1
    },
    {
      step_number: 2,
      layer_name: "format_detection",
      service: { name: "orchestrator", version: orchestratorVersion },
      input_snapshot: { raw_payload_head: rawPayload.slice(0, 120) },
      output_snapshot: detection,
      decisions: [
        {
          decision_type: "format_route",
          field: "detected_source_format",
          source_path: "raw_payload",
          source_value: rawPayload.slice(0, 30),
          output_value: detection.top_candidate.format,
          method_used: "DETECTION_STUB"
        }
      ],
      warnings: [],
      duration_ms: detection.detection_duration_ms
    },
    {
      step_number: 3,
      layer_name: "parse",
      service: { name: "hl7v2-agent", version: agentVersion },
      input_snapshot: { raw_payload: rawPayload },
      output_snapshot: parseSnapshot,
      decisions: [
        {
          decision_type: "parse_provenance",
          field: "provenance.message_type",
          source_path: "MSH-9",
          source_value: rawPayload,
          output_value: (parseSnapshot.provenance as Record<string, unknown>).message_type,
          method_used: "HL7_SEGMENT_PARSER"
        }
      ],
      warnings: conversionResult.warnings
        .filter((warning) => warning.code.includes("TIMESTAMP") || warning.code.includes("DATATYPE"))
        .map((warning) => warning.code),
      duration_ms: conversionResult.metrics.parse_ms
    },
    {
      step_number: 4,
      layer_name: "map",
      service: { name: "hl7v2-agent", version: agentVersion },
      input_snapshot: parseSnapshot,
      output_snapshot: canonical,
      decisions: mapDecisions,
      warnings: conversionResult.warnings
        .filter((warning) => warning.code.includes("MAPPING") || warning.code.includes("OBX"))
        .map((warning) => warning.code),
      duration_ms: conversionResult.metrics.map_ms
    },
    {
      step_number: 5,
      layer_name: "serialize",
      service: { name: "orchestrator", version: orchestratorVersion },
      input_snapshot: canonical,
      output_snapshot: conversionResult.target_payload,
      decisions: [
        {
          decision_type: "serializer_selection",
          field: "target_payload",
          source_path: "requested_target_format",
          source_value: null,
          output_value: conversionResult.target_payload,
          method_used: "SERIALIZER_DISPATCH"
        }
      ],
      warnings: conversionResult.warnings
        .filter((warning) => warning.code.includes("OUTPUT"))
        .map((warning) => warning.code),
      duration_ms: conversionResult.metrics.serialize_ms
    }
  ];

  return {
    ingestion_id: ingestionId,
    trace_id: traceId,
    steps
  };
}

async function executePipeline(
  config: OrchestratorConfig,
  input: {
    ingestionId: string;
    traceId: string;
    tenantId: string;
    sourceChannel: string;
    rawPayload: ConvertApiRequest["raw_payload"];
    requestedTargetFormat: TargetFormat;
    terminologyReleaseId: string;
    flatJsonMapping?: FlatJsonMappingConfig;
    agentVersionOverride?: string;
  }
): Promise<{ detection: DetectionResult; conversionRequest: ConversionRequest; agentResponse: ConversionResult }> {
  const detection = detectFormatStub(input.rawPayload.content);
  const agentUrl = resolveAgentUrl(detection.top_candidate.format, config);

  if (!agentUrl) {
    throw new Error("AGENT_UNAVAILABLE");
  }

  const conversionRequest: ConversionRequest = {
    request_id: input.ingestionId,
    trace_id: input.traceId,
    tenant_id: input.tenantId,
    received_at: new Date().toISOString(),
    source_channel: input.sourceChannel,
    raw_payload: input.rawPayload,
    detected_source_format: detection.top_candidate.format,
    detection_confidence: detection.top_candidate.score,
    detection_evidence: Object.keys(detection.top_candidate.score_components),
    requested_target_format: input.requestedTargetFormat,
    processing_policy: {
      allow_partial_success: true,
      halt_on_dangerous_mapping: true,
      min_confidence_thresholds: {
        diagnosis: 0.95,
        medication: 0.97,
        labs: 0.93
      }
    },
    context_snapshot: {
      terminology_release_id: input.terminologyReleaseId,
      mapping_model_versions: {
        rules_engine: "1.0.0",
        embedding_model: "1.0.0",
        arbitration_llm: "1.0.0"
      },
      orchestrator_version: config.serviceVersion
    },
    phi_handling_status: "PASS"
  };

  const response = await fetch(`${agentUrl}/convert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(conversionRequest)
  });

  if (!response.ok) {
    throw new Error(`AGENT_DISPATCH_FAILED:${response.status}`);
  }

  const agentResponse = (await response.json()) as ConversionResult;

  if (agentResponse.canonical_record) {
    const serialization = serializeByTargetFormat(
      input.requestedTargetFormat,
      agentResponse.canonical_record,
      input.flatJsonMapping
    );

    if (serialization.payload) {
      agentResponse.target_payload = serialization.payload;
    }

    if (serialization.warnings.length > 0) {
      agentResponse.warnings.push(...serialization.warnings);
    }

    if (serialization.errors.length > 0) {
      agentResponse.errors.push(...serialization.errors);
      agentResponse.status = "FAILURE";
    }
  }

  return { detection, conversionRequest, agentResponse };
}

function toEnvelope(
  ingestionId: string,
  traceId: string,
  requestedTargetFormat: TargetFormat,
  detection: DetectionResult,
  agentResponse: ConversionResult,
  hl7AgentVersion: string
): OrchestratorResponseEnvelope {
  return {
    ingestion_id: ingestionId,
    trace_id: traceId,
    status: agentResponse.status,
    chosen_agent: {
      agent_id: "hl7v2-agent",
      agent_version: hl7AgentVersion
    },
    target_format: requestedTargetFormat,
    detection,
    output: agentResponse,
    flags_summary: [
      ...agentResponse.field_mappings.flatMap((mapping) => mapping.flags.map((flag) => flag.code)),
      ...agentResponse.warnings.map((warning) => warning.code)
    ],
    error_summary: agentResponse.errors.map((error) => error.code),
    audit_trace_id: traceId
  };
}

export function createOrchestratorApp(config: OrchestratorConfig) {
  const app = express();
  const allowedOrigins = (process.env.CORS_ORIGINS ??
    "http://localhost:3005,http://127.0.0.1:3005,http://dashboard:3005")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("CORS origin not allowed"));
      }
    })
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(express.text({ type: "text/plain", limit: "2mb" }));
  app.use(
    "/admin",
    createAdminRouter({
      repository: config.repository,
      adminSecret: config.adminSecret
    })
  );

  const requireApiKey = validateApiKey(config.repository);

  app.get("/health", (_req, res) => {
    const payload: ServiceHealthResponse = {
      service: "orchestrator",
      version: config.serviceVersion,
      status: "healthy"
    };
    res.json(payload);
  });

  app.get("/health/ready", async (_req, res) => {
    const dependencies = {
      hl7_agent: await checkDependency(config.hl7AgentUrl),
      terminology_service: await checkDependency(
        config.terminologyServiceUrl ?? process.env.TERMINOLOGY_SERVICE_URL ?? "http://terminology-service:3002"
      ),
      audit_service: await checkDependency(config.auditServiceUrl),
      error_bus: await checkDependency(config.errorBusUrl),
      dashboard: await checkDependency(
        config.dashboardUrl ?? process.env.DASHBOARD_URL ?? "http://dashboard:3005",
        "/"
      )
    };

    const failed = Object.entries(dependencies).filter(([, value]) => !value.ok);
    if (failed.length > 0) {
      res.status(503).json({
        service: "orchestrator",
        status: "not_ready",
        dependencies
      });
      return;
    }

    res.json({
      service: "orchestrator",
      status: "ready",
      dependencies
    });
  });

  app.post("/convert", requireApiKey, async (req, res) => {
    const body = req.body as ConvertApiRequest | string;
    const queryTargetFormat =
      typeof req.query.requested_target_format === "string" ? req.query.requested_target_format : undefined;
    const requestedTargetFormat = normalizeTargetFormat(
      typeof body === "string" ? queryTargetFormat : (body?.requested_target_format ?? queryTargetFormat)
    );

    const rawContent = typeof body === "string" ? body : body?.raw_payload?.content;
    if (!rawContent) {
      res.status(400).json({ error: "INVALID_REQUEST", message: "raw_payload.content is required" });
      return;
    }
    const { ingestion_id, trace_id } = createIds();
    const sourceChannel = typeof body === "string" ? "mllp-listener" : (body.source_channel ?? "api");
    const tenantId = typeof body === "string" ? "mllp" : (body.tenant_id ?? "default_tenant");
    const flatJsonMapping = typeof body === "string" ? undefined : body.flat_json_mapping;

    const payloadId = crypto.randomUUID();
    const rawPayloadBase64 = Buffer.from(rawContent, "utf-8").toString("base64");
    await postJson(`${config.auditServiceUrl}/payloads`, {
      payload_id: payloadId,
      ingestion_id,
      raw_payload: rawPayloadBase64,
      content_type: "application/hl7-v2",
      stored_at: new Date().toISOString()
    }).catch(() => undefined);

    await postJson(`${config.auditServiceUrl}/events`, {
      audit_event_id: crypto.randomUUID(),
      ingestion_id,
      trace_id,
      agent_id: "orchestrator",
      agent_version: config.serviceVersion,
      source_format: "UNKNOWN",
      target_format: requestedTargetFormat,
      transformation_step: "ingest",
      status_transition: "INGEST_RECEIVED",
      raw_payload_ref: payloadId,
      context_json: JSON.stringify({
        requested_target_format: requestedTargetFormat,
        source_channel: sourceChannel,
        terminology_release_id: config.terminologyReleaseId
      }),
      created_at: new Date().toISOString()
    }).catch(() => undefined);

    try {
      const execution = await executePipeline(config, {
        ingestionId: ingestion_id,
        traceId: trace_id,
        tenantId,
        sourceChannel,
        rawPayload: {
          content: rawContent
        },
        requestedTargetFormat,
        terminologyReleaseId: config.terminologyReleaseId,
        flatJsonMapping
      });

      const sourceSystemId =
        (execution.agentResponse.canonical_record?.provenance as Record<string, unknown> | undefined)?.source_system_id?.toString() ??
        undefined;

      if (execution.agentResponse.errors.length > 0) {
        await emitErrorsToBus(
          execution.agentResponse.errors,
          ingestion_id,
          trace_id,
          execution.detection.top_candidate.format,
          requestedTargetFormat,
          sourceSystemId,
          config
        );
      }

      await postJson(`${config.auditServiceUrl}/events`, {
        audit_event_id: crypto.randomUUID(),
        ingestion_id,
        trace_id,
        agent_id: "orchestrator",
        agent_version: config.serviceVersion,
        source_format: execution.detection.top_candidate.format,
        target_format: requestedTargetFormat,
        transformation_step: "finalize",
        status_transition:
          execution.agentResponse.status === "FAILURE" ? "CONVERSION_FAILED" : "CONVERSION_COMPLETED",
        context_json: JSON.stringify({ terminology_release_id: config.terminologyReleaseId }),
        created_at: new Date().toISOString()
      }).catch(() => undefined);

      res.json(
        toEnvelope(
          ingestion_id,
          trace_id,
          requestedTargetFormat,
          execution.detection,
          execution.agentResponse,
          config.hl7AgentVersion
        )
      );
    } catch (error) {
      const code = error instanceof Error && error.message.startsWith("AGENT_UNAVAILABLE")
        ? "AGENT_UNAVAILABLE"
        : "AGENT_DISPATCH_FAILED";

      await postJson(`${config.errorBusUrl}/errors`, {
        error_code: code,
        error_category: "SYSTEM",
        layer: "orchestrator",
        severity: "P1",
        is_retryable: true,
        requires_human_review: false,
        ingestion_id,
        trace_id,
        source_format: "HL7V2",
        target_format: requestedTargetFormat,
        timestamp: new Date().toISOString(),
        layer_context: JSON.stringify({ detail: error instanceof Error ? error.message : "unknown" })
      }).catch(() => undefined);

      await postJson(`${config.auditServiceUrl}/events`, {
        audit_event_id: crypto.randomUUID(),
        ingestion_id,
        trace_id,
        agent_id: "orchestrator",
        agent_version: config.serviceVersion,
        source_format: "HL7V2",
        target_format: requestedTargetFormat,
        transformation_step: "finalize",
        status_transition: "CONVERSION_FAILED",
        created_at: new Date().toISOString()
      }).catch(() => undefined);

      res.status(503).json({ ingestion_id, trace_id, status: "FAILURE", error: code });
    }
  });

  app.post("/conversions/:ingestion_id/replay", requireApiKey, async (req, res) => {
    if (config.enableReplay === false) {
      res.status(404).json({ error: "REPLAY_DISABLED" });
      return;
    }

    const ingestionParam = req.params.ingestion_id;
    const ingestionId = Array.isArray(ingestionParam) ? ingestionParam[0] : ingestionParam;

    let eventsResponse: { events: AuditEventRecord[] };
    let payloadResponse: { raw_payload: string; content_type: string };

    try {
      eventsResponse = await fetchJson<{ events: AuditEventRecord[] }>(
        `${config.auditServiceUrl}/events/${ingestionId}`
      );
      payloadResponse = await fetchJson<{ raw_payload: string; content_type: string }>(
        `${config.auditServiceUrl}/payloads/${ingestionId}`
      );
    } catch (error) {
      res.status(404).json({
        error: "REPLAY_SOURCE_NOT_FOUND",
        ingestion_id: ingestionId,
        detail: error instanceof Error ? error.message : "unknown"
      });
      return;
    }

    const ingestEvent = eventsResponse.events.find((event) => event.status_transition === "INGEST_RECEIVED");
    const parseEvent = eventsResponse.events.find((event) => event.transformation_step === "parse");
    const context = parseContextJson(ingestEvent?.context_json ?? null);

    const traceId = ingestEvent?.trace_id ?? crypto.randomUUID();
    const requestedTargetFormat = normalizeTargetFormat(
      String(context.requested_target_format ?? ingestEvent?.target_format ?? "FHIR_R4")
    );
    const sourceChannel = String(context.source_channel ?? "replay");
    const terminologyReleaseId = String(context.terminology_release_id ?? config.terminologyReleaseId);
    const rawPayload = Buffer.from(payloadResponse.raw_payload, "base64").toString("utf-8");

    try {
      const execution = await executePipeline(config, {
        ingestionId,
        traceId,
        tenantId: "replay_tenant",
        sourceChannel,
        rawPayload: {
          content: rawPayload,
          transport_channel: sourceChannel
        },
        requestedTargetFormat,
        terminologyReleaseId
      });

      const envelope = toEnvelope(
        ingestionId,
        traceId,
        requestedTargetFormat,
        execution.detection,
        execution.agentResponse,
        parseEvent?.agent_version ?? config.hl7AgentVersion
      );

      const debugTrace = buildDebugTrace(
        ingestionId,
        traceId,
        rawPayload,
        execution.detection,
        execution.agentResponse,
        config.serviceVersion,
        parseEvent?.agent_version ?? config.hl7AgentVersion
      );

      res.json({
        replay_of_ingestion_id: ingestionId,
        conversion: envelope,
        debug_trace: debugTrace
      });
    } catch (error) {
      res.status(500).json({
        error: "REPLAY_FAILED",
        ingestion_id: ingestionId,
        detail: error instanceof Error ? error.message : "unknown"
      });
    }
  });

  return app;
}
