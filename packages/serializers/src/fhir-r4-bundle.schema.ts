export const fhirR4BundleSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["resourceType", "type", "entry"],
  properties: {
    resourceType: { const: "Bundle" },
    type: { const: "collection" },
    entry: {
      type: "array",
      items: {
        type: "object",
        required: ["resource"],
        properties: {
          resource: {
            type: "object",
            required: ["resourceType", "id", "meta"],
            properties: {
              resourceType: {
                type: "string",
                enum: ["Patient", "Encounter", "Observation", "Condition"]
              },
              id: { type: "string", minLength: 1 },
              meta: {
                type: "object",
                required: ["source"],
                properties: {
                  source: { type: "string", minLength: 1 }
                },
                additionalProperties: true
              }
            },
            additionalProperties: true
          }
        },
        additionalProperties: true
      }
    }
  },
  additionalProperties: true
} as const;
