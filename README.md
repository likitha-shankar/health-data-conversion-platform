An open-source, AI-assisted health data conversion platform. Convert HL7 v2 messages to FHIR R4 and OMOP CDM automatically, with confidence-scored terminology mapping and a full audit trail.

![CI](https://github.com/your-org/health-data-conversion-platform/actions/workflows/ci.yml/badge.svg)

## Demo

```bash
curl -s -X POST http://localhost:3000/convert \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{
    "requested_target_format": "fhir_r4",
    "raw_payload": {
      "content_type": "text/hl7-v2",
      "content": "MSH|^~\\&|LABAPP|HOSP|EHR|FAC|202603151200||ORU^R01|MSG-001|P|2.5\rPID|1||12345^^^HOSP^MR||DOE^JANE||19800101|F\rOBX|1|NM|718-7^Hemoglobin^LN||13.2|g/dL|||N|||F"
    }
  }'
```

Expected response shape:

```json
{
  "ingestion_id": "uuid",
  "trace_id": "uuid",
  "status": "SUCCESS",
  "target_format": "FHIR_R4",
  "output": {
    "status": "SUCCESS",
    "target_payload": {
      "resourceType": "Bundle",
      "type": "collection",
      "entry": []
    }
  }
}
```

## What it does

- Parses HL7 v2 ORU R01 messages into a canonical internal model.
- Maps clinical concepts using Athena-backed OMOP vocabularies with confidence scoring.
- Produces multiple outputs from the same input, including FHIR R4 and OMOP CDM.

## Run locally in 5 minutes

1. Prerequisites: Docker, Node 20.
2. Clone the repo.
3. Copy `.env.example` to `.env`.
4. Add Athena vocabulary CSV files to `data/athena/`.
5. Run `docker compose up --build`.
6. Run `npm run demo`.
7. Open `http://localhost:3005`.

## Tech stack

- Node.js
- TypeScript
- PostgreSQL
- React
- Vite
- Tailwind
- Docker

## How it works

1. HL7 in.
2. Terminology mapping.
3. FHIR or OMOP out.

## Architecture

See `docs/architecture.md`.

## Contributing

See `CONTRIBUTING.md`.

## License

MIT (see `LICENSE`).
