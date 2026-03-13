export type TerminologySystem = "SNOMED" | "LOINC" | "ICD10" | "RXNORM" | "LOCAL";
export type ContextDomain =
  | "diagnosis"
  | "medication"
  | "lab"
  | "procedure"
  | "vital"
  | "administrative";

export const DOMAIN_THRESHOLDS: Record<ContextDomain, number> = {
  diagnosis: 0.95,
  medication: 0.97,
  lab: 0.93,
  procedure: 0.94,
  vital: 0.93,
  administrative: 1.0
};

export const SYSTEM_TO_VOCABULARY: Record<Exclude<TerminologySystem, "LOCAL">, string> = {
  SNOMED: "SNOMED",
  LOINC: "LOINC",
  ICD10: "ICD10CM",
  RXNORM: "RxNorm"
};

export const VOCABULARY_TO_SYSTEM: Record<string, Exclude<TerminologySystem, "LOCAL">> = {
  SNOMED: "SNOMED",
  LOINC: "LOINC",
  ICD10CM: "ICD10",
  RxNorm: "RXNORM"
};
