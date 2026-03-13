export type ServiceHealthStatus = "healthy" | "degraded" | "unhealthy";

export interface ServiceHealthResponse {
  service: string;
  version: string;
  status: ServiceHealthStatus;
}

export type SourceFormat =
  | "HL7V2"
  | "FHIR_R4"
  | "CDA"
  | "CSV"
  | "PDF"
  | "DICOM"
  | "PLAIN_TEXT"
  | "CUSTOM";

export type TargetFormat =
  | "OMOP_CDM_V5_4"
  | "FHIR_R4"
  | "SNOMED_CT_RECORD"
  | "LOINC_LAB_RESULT"
  | "OPENEHR_ARCHETYPE"
  | "CUSTOM_FLAT_JSON";

export type ConversionStatus = "SUCCESS" | "PARTIAL_SUCCESS" | "FAILURE";

export interface AgentMetadata {
  agent_id: string;
  agent_version: string;
  supported_source_formats: SourceFormat[];
  supported_input_versions: string[];
  capabilities: string[];
  confidence_profile: Record<string, number>;
  danger_ruleset_version: string;
}

export interface SourceHint {
  source_format_candidate: SourceFormat;
  content_type?: string;
  sender_profile_format?: SourceFormat;
}

export interface SupportDecision {
  supported: boolean;
  score: number;
  evidence: string[];
}

export interface RawPayload {
  content: string;
  encoding?: string;
  transport_channel?: string;
}

export interface RoutingCheckResult {
  status: "PASS" | "FAIL";
  confidence: number;
  reason?: string;
  evidence: string[];
}

export interface ProcessingPolicy {
  allow_partial_success: boolean;
  halt_on_dangerous_mapping: boolean;
  min_confidence_thresholds: Record<string, number>;
}

export interface ContextSnapshot {
  terminology_release_id: string;
  mapping_model_versions: Record<string, string>;
  orchestrator_version: string;
}

export interface ConversionRequest {
  request_id: string;
  trace_id: string;
  tenant_id: string;
  received_at: string;
  source_channel: string;
  raw_payload: RawPayload;
  detected_source_format: SourceFormat;
  detection_confidence: number;
  detection_evidence: string[];
  requested_target_format: TargetFormat;
  processing_policy: ProcessingPolicy;
  context_snapshot: ContextSnapshot;
  phi_handling_status: "PASS" | "PASS_WITH_FLAGS" | "FAIL";
}

export interface MappingFlag {
  code:
    | "LOW_CONFIDENCE"
    | "UNMAPPABLE"
    | "LLM_ARBITRATED"
    | "DANGEROUS_RULE_HIT"
    | "PHI_POSITION_UNUSUAL";
  detail: string;
}

export interface FieldMapping {
  source_path: string;
  source_value_hash: string;
  target_path: string;
  target_value_hash: string;
  code_system?: "SNOMED_CT" | "LOINC" | "ICD10" | "RXNORM" | "OMOP";
  code?: string;
  display?: string;
  mapping_tier: "RULE" | "EMBED" | "LLM";
  confidence_score: number;
  threshold: number;
  threshold_passed: boolean;
  flags: MappingFlag[];
}

export interface AgentError {
  code: string;
  message: string;
  severity: "P0" | "P1" | "P2" | "P3";
  recoverability: "RETRYABLE" | "NON_RETRYABLE";
  diagnostic_payload: Record<string, unknown>;
}

export interface AgentWarning {
  code: string;
  message: string;
  diagnostic_payload?: Record<string, unknown>;
}

export interface ConversionMetrics {
  parse_ms: number;
  map_ms: number;
  validate_ms: number;
  serialize_ms: number;
  retries: number;
}

export interface ConversionResult {
  status: ConversionStatus;
  routing_self_check: RoutingCheckResult;
  canonical_record?: Record<string, unknown>;
  target_payload?: Record<string, unknown> | string;
  field_mappings: FieldMapping[];
  errors: AgentError[];
  warnings: AgentWarning[];
  metrics: ConversionMetrics;
  audit_refs: string[];
}

export interface SpecialistAgent {
  getMetadata(): AgentMetadata;
  supportsSource(inputHint: SourceHint): SupportDecision;
  selfCheckRouting(payload: RawPayload): RoutingCheckResult;
  convert(request: ConversionRequest): Promise<ConversionResult>;
  health(): Promise<ServiceHealthResponse>;
}

export interface DetectionCandidate {
  format: SourceFormat;
  score: number;
}

export interface DetectionResult {
  decision:
    | "ROUTE"
    | "FORMAT_AMBIGUOUS"
    | "FORMAT_LOW_CONFIDENCE"
    | "FORMAT_UNKNOWN"
    | "DETECTION_TIMEOUT";
  top_candidate: {
    format: SourceFormat;
    score: number;
    score_components: Record<string, number>;
  };
  all_candidates: DetectionCandidate[];
  tie_breaking_applied: boolean;
  tie_breaking_rule: string | null;
  human_resolved: boolean;
  human_resolver_id: string | null;
  detection_duration_ms: number;
  stage_reached: 1 | 2 | 3;
}

export interface OrchestratorResponseEnvelope {
  ingestion_id: string;
  trace_id: string;
  status: ConversionStatus;
  chosen_agent: {
    agent_id: string;
    agent_version: string;
  };
  target_format: TargetFormat;
  detection: DetectionResult;
  output: ConversionResult;
  flags_summary: string[];
  error_summary: string[];
  audit_trace_id: string;
}
