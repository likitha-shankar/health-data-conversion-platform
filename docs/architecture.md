## Architecture

- **orchestrator**: Routes requests, detects format, dispatches to agents, and serializes output.
- **hl7v2-agent**: Parses HL7 v2 ORU R01 messages, maps to CIM, and calls terminology service.
- **terminology-service**: Athena-backed OMOP vocabulary service with Tier 1 direct lookup and Tier 2 TF-IDF embedding.
- **audit-service**: Append-only PostgreSQL event log for traceability and replay.
- **error-bus**: Error routing and human review queue.
- **dashboard**: React SPA for conversion, review queue, and audit trace.
