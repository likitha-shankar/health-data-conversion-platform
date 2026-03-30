# Health Data Conversion Platform

An open-source, AI-assisted platform for converting HL7 v2 clinical messages 
to FHIR R4 and OMOP CDM — with confidence-scored terminology mapping and a 
full audit trail on every conversion.

Built to address the real interoperability gap hospitals face when migrating 
between EHR systems or feeding clinical data into research pipelines.

---

## What it solves

Legacy healthcare systems speak HL7 v2. Modern EHRs, research platforms, 
and analytics pipelines expect FHIR R4 or OMOP CDM. Manually mapping between 
these formats is error-prone, unaudited, and doesn't scale. This platform 
automates that conversion with terminology confidence scoring so you know 
exactly how reliable each mapping is.

---

## How it works

1. Send a raw HL7 v2 message to the `/convert` endpoint
2. The parser extracts clinical observations into a canonical internal model
3. Athena-backed OMOP vocabulary lookup maps each clinical concept with a confidence score
4. The platform produces FHIR R4 Bundle JSON and/or OMOP CDM output
5. Every request gets a unique `ingestion_id` and `trace_id` for full audit traceability

---

## Quick demo
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

Response:
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

---

## Tech stack

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat-square&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-43853D?style=flat-square&logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=flat-square&logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind-38B2AC?style=flat-square&logo=tailwind-css&logoColor=white)
![Railway](https://img.shields.io/badge/Railway-0B0D0E?style=flat-square&logo=railway&logoColor=white)

---

## Run locally

Prerequisites: Docker, Node 20
```bash
git clone https://github.com/likitha-shankar/health-data-conversion-platform
cd health-data-conversion-platform
cp .env.example .env
# Add Athena vocabulary CSV files to data/athena/
docker compose up --build
npm run demo
# Open http://localhost:3005
```

---

## Architecture

See [`docs/architecture.md`](./docs/architecture.md) for the full system design 
including the parsing pipeline, terminology mapping layer, and output serializers.

---

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). PRs welcome — especially for 
additional HL7 message types beyond ORU R01, new target formats, and 
expanded OMOP vocabulary coverage.

---

## License

MIT
