interface ForwarderConfig {
  orchestratorUrl: string;
  apiKey: string;
  defaultTargetFormat: string;
}

export interface ForwardResult {
  ok: boolean;
  ingestionId?: string;
  errorCode?: string;
}

export class OrchestratorForwarder {
  constructor(private readonly config: ForwarderConfig) {}

  async forward(message: string): Promise<ForwardResult> {
    try {
      const url = `${this.config.orchestratorUrl}/convert?requested_target_format=${encodeURIComponent(
        this.config.defaultTargetFormat
      )}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          authorization: `Bearer ${this.config.apiKey}`
        },
        body: message
      });

      if (!response.ok) {
        return { ok: false, errorCode: `ORCH_HTTP_${response.status}` };
      }

      const payload = (await response.json()) as { ingestion_id?: string };
      if (payload.ingestion_id) {
        console.log(`mllp-listener forwarded ingestion_id=${payload.ingestion_id}`);
      }
      return { ok: true, ingestionId: payload.ingestion_id };
    } catch {
      return { ok: false, errorCode: "ORCH_NETWORK_ERROR" };
    }
  }
}
