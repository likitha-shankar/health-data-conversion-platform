## Contributing

### Run the stack locally

Use the local quickstart steps in `README.md`.

### Run tests

```bash
npm run test
```

### Add a new agent

Implement the agent contract in `packages/contracts` and provide these required methods:

- `getMetadata`
- `supportsSource`
- `convert`

Register the new agent with the orchestrator after it conforms to the contract.

### Report a bug

Open a GitHub issue and include:

- `ingestion_id` (if available)
- Sanitized HL7 payload (no real PHI)
- Clear reproduction steps
- Expected behavior and actual behavior

### Clinical review requirement

Issues labeled `clinical-review-needed` require validation by someone with a clinical informatics background before merging.
