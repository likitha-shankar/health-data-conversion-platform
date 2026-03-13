#!/usr/bin/env node

const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? "http://localhost:3000";
const dashboardUrl = process.env.DASHBOARD_URL ?? "http://localhost:3005";
const terminologyUrl = process.env.TERMINOLOGY_SERVICE_URL ?? "http://localhost:3002";
const adminSecret = process.env.ADMIN_SECRET ?? "dev-admin-secret";
let cachedApiKey = null;

function printSection(title) {
  console.log("\n" + "=".repeat(70));
  console.log(title);
  console.log("=".repeat(70));
}

function buildMessage(obxLine) {
  return [
    "MSH|^~\\&|LABAPP|HOSP|EHR|FAC|202603151200||ORU^R01|MSG-DEMO-001|P|2.5",
    "PID|1||12345^^^HOSP^MR||DOE^JANE||19800101|F",
    obxLine
  ].join("\r");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postConvert({ content, target }) {
  const apiKey = await getApiKey();
  const response = await fetch(`${orchestratorUrl}/convert`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      tenant_id: "demo-tenant",
      source_channel: "demo-script",
      requested_target_format: target,
      raw_payload: { content }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`convert failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function getApiKey() {
  if (!cachedApiKey) {
    cachedApiKey = await createApiKey();
  }
  return cachedApiKey;
}

async function createApiKey() {
  const response = await fetch(`${orchestratorUrl}/admin/keys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-secret": adminSecret
    },
    body: JSON.stringify({ label: "demo-script" })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`api key creation failed (${response.status}): ${text}`);
  }
  const payload = await response.json();
  return payload.raw_key;
}

async function postTerminologyMap(request) {
  const response = await fetch(`${terminologyUrl}/map`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`terminology map failed (${response.status}): ${text}`);
  }
  return response.json();
}

async function waitForTier2Ready(timeoutMs = 120000) {
  const started = Date.now();
  // LOCAL -> LOINC forces Tier2 path (Tier1 does not apply to LOCAL source).
  const probeRequest = {
    concept_text: "Acyclovir [Susceptibility]",
    source_system: "LOCAL",
    target_system: "LOINC",
    context_domain: "lab"
  };

  while (Date.now() - started < timeoutMs) {
    const result = await postTerminologyMap(probeRequest);
    if (!result.flags?.includes("MAPPING_TIER2_INDEX_NOT_READY")) {
      return result;
    }
    await sleep(2000);
  }

  throw new Error("Tier2 index did not become ready within timeout");
}

function getObservationCoding(payload) {
  const entries = payload?.output?.target_payload?.entry ?? [];
  const observation = entries
    .map((entry) => entry.resource)
    .find((resource) => resource?.resourceType === "Observation");
  return observation?.code?.coding?.[0];
}

async function run() {
  printSection("Scenario 1: Clean ORU with known LOINC -> FHIR R4");
  const scenario1 = await postConvert({
    target: "fhir_r4",
    content: buildMessage("OBX|1|NM|718-7^Hemoglobin^LN||13.2|g/dL|||N|||F")
  });

  const coding1 = getObservationCoding(scenario1);
  console.log(`Ingestion ID: ${scenario1.ingestion_id}`);
  console.log(`Status: ${scenario1.status}`);
  console.log(`FHIR Observation code: ${coding1?.code} (${coding1?.display})`);
  console.log(
    `Terminology confidence: ${
      scenario1.output?.canonical_record?.field_confidence_map?.["$.observations[0].loinc_code.code"]
    }`
  );

  printSection("Scenario 2: Unknown OBX code -> Tier 2 embedding + candidates");
  await waitForTier2Ready();
  const scenario2 = await postConvert({
    target: "fhir_r4",
    content: buildMessage("OBX|1|NM|ZZZ-ACY^Acyclovir [Susceptibility]^LN||13.2|g/dL|||N|||F")
  });

  const mapping = (scenario2.output?.field_mappings ?? []).find(
    (item) => item.target_path === "$.observations[0].loinc_code.code"
  );
  const candidates =
    scenario2.output?.canonical_record?.terminology_candidates?.["$.observations[0].loinc_code.code"] ?? [];

  console.log(`Ingestion ID: ${scenario2.ingestion_id}`);
  console.log(`Status: ${scenario2.status}`);
  console.log(`Mapping tier: ${mapping?.mapping_tier}`);
  console.log(`Confidence: ${mapping?.confidence_score}`);
  console.log("Top 3 candidates:");
  for (const candidate of candidates) {
    console.log(`  - ${candidate.code} | ${candidate.display} | score=${candidate.score}`);
  }
  if (mapping?.mapping_tier !== "EMBED" || candidates.length === 0) {
    throw new Error("Scenario 2 did not produce Tier2 EMBED mapping with candidates");
  }

  printSection("Scenario 3: Same message -> OMOP output");
  const scenario3 = await postConvert({
    target: "omop",
    content: buildMessage("OBX|1|NM|718-7^Hemoglobin^LN||13.2|g/dL|||N|||F")
  });

  const omop = scenario3.output?.target_payload ?? {};
  const person = Array.isArray(omop.PERSON) ? omop.PERSON[0] : null;
  const measurement = Array.isArray(omop.MEASUREMENT) ? omop.MEASUREMENT[0] : null;

  console.log(`Ingestion ID: ${scenario3.ingestion_id}`);
  console.log(`Status: ${scenario3.status}`);
  console.log(`PERSON row: ${JSON.stringify(person)}`);
  console.log(`MEASUREMENT row: ${JSON.stringify(measurement)}`);
  console.log(
    `Terminology confidence: ${
      scenario3.output?.canonical_record?.field_confidence_map?.["$.observations[0].loinc_code.code"]
    }`
  );

  printSection("Demo complete");
  console.log("The platform converted HL7 v2 into FHIR and OMOP with auditable terminology decisions.");
  console.log(`Dashboard URL: ${dashboardUrl}`);
}

run().catch((error) => {
  console.error(`Demo failed: ${error.message}`);
  process.exit(1);
});
