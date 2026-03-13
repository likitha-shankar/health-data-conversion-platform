const orchestratorUrl = process.env.ORCHESTRATOR_URL ?? "http://localhost:3000";
const auditServiceUrl = process.env.AUDIT_SERVICE_URL ?? "http://localhost:3003";
const adminSecret = process.env.ADMIN_SECRET ?? "dev-admin-secret";
let cachedApiKey = null;

const basePayload = {
  tenant_id: "smoke-tenant",
  source_channel: "smoke-test",
  raw_payload: {
    content:
      "MSH|^~\\&|LAB|HOSP|EHR|HOSP|202603111200||ORU^R01|MSG00001|P|2.5\\rPID|1||12345^^^HOSP^MR||DOE^JANE||19800101|F\\rOBX|1|NM|718-7^Hemoglobin^LN||13.2|g/dL|||N|||F"
  }
};

async function postConvert(requestedTargetFormat) {
  const apiKey = await getApiKey();
  const response = await fetch(`${orchestratorUrl}/convert`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      ...basePayload,
      requested_target_format: requestedTargetFormat
    })
  });

  if (!response.ok) {
    console.error(`Smoke test failed (${requestedTargetFormat}) with status`, response.status);
    process.exit(1);
  }

  const body = await response.json();
  if (!body.ingestion_id || !body.trace_id) {
    console.error(`Smoke test failed (${requestedTargetFormat}): ingestion_id/trace_id missing`);
    process.exit(1);
  }

  const eventsResponse = await fetch(`${auditServiceUrl}/events/${body.ingestion_id}`);
  if (!eventsResponse.ok) {
    console.error("Smoke test failed: unable to query audit events", eventsResponse.status);
    process.exit(1);
  }

  const eventsBody = await eventsResponse.json();
  if (!Array.isArray(eventsBody.events) || eventsBody.events.length < 2) {
    console.error("Smoke test failed: expected at least two audit events for ingestion");
    process.exit(1);
  }

  return body;
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
    body: JSON.stringify({ label: "smoke-test" })
  });

  if (!response.ok) {
    console.error("Smoke test failed: unable to create API key", response.status);
    process.exit(1);
  }

  const payload = await response.json();
  return payload.raw_key;
}

const fhirBody = await postConvert("fhir_r4");
if (fhirBody?.output?.target_payload?.resourceType !== "Bundle") {
  console.error("Smoke test failed: expected FHIR Bundle target_payload");
  process.exit(1);
}

const omopBody = await postConvert("omop");
const omopPayload = omopBody?.output?.target_payload;
if (!omopPayload || !Array.isArray(omopPayload.PERSON) || omopPayload.PERSON.length < 1) {
  console.error("Smoke test failed: expected OMOP PERSON table with at least one row");
  process.exit(1);
}
if (!Array.isArray(omopPayload.MEASUREMENT) || omopPayload.MEASUREMENT.length < 1) {
  console.error("Smoke test failed: expected OMOP MEASUREMENT table with at least one row");
  process.exit(1);
}

console.log("Smoke test passed", {
  fhir_ingestion_id: fhirBody.ingestion_id,
  omop_ingestion_id: omopBody.ingestion_id,
  status_fhir: fhirBody.status,
  status_omop: omopBody.status
});
