import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Tab = "conversion" | "review" | "trace" | "mllp";

interface ConversionResponse {
  ingestion_id: string;
  trace_id: string;
  status: string;
  output: {
    target_payload: unknown;
    warnings: Array<{ code: string; message: string }>;
    metrics?: { parse_ms?: number; map_ms?: number; validate_ms?: number; serialize_ms?: number };
  };
  flags_summary?: string[];
}

interface ReviewItem {
  id: number;
  ingestion_id: string;
  error_code: string;
  source_format: string;
  severity: string;
  timestamp: string;
  layer_context: string;
  resolution_action?: string | null;
}

function syntaxHighlightJson(value: unknown) {
  const json = JSON.stringify(value, null, 2)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"\s*:?)|(\btrue\b|\bfalse\b|null)|(-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = "text-cyan-300";
      if (/^".*":$/.test(match)) cls = "text-purple-300";
      else if (/true|false/.test(match)) cls = "text-amber-300";
      else if (/null/.test(match)) cls = "text-slate-400";
      else if (!Number.isNaN(Number(match))) cls = "text-emerald-300";
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

function App() {
  const orchestratorUrl = import.meta.env.VITE_ORCHESTRATOR_URL ?? "http://localhost:3000";
  const errorBusUrl = import.meta.env.VITE_ERROR_BUS_URL ?? "http://localhost:3004";
  const auditServiceUrl = import.meta.env.VITE_AUDIT_SERVICE_URL ?? "http://localhost:3003";
  const mllpHost = import.meta.env.VITE_MLLP_HOST ?? "localhost";
  const mllpPort = import.meta.env.VITE_MLLP_PORT ?? "2575";

  const [tab, setTab] = useState<Tab>("conversion");
  const [showSettings, setShowSettings] = useState(false);
  const [apiKey, setApiKey] = useState("");

  const [hl7, setHl7] = useState(
    "MSH|^~\\&|LABAPP|HOSP|EHR|FAC|202603151200||ORU^R01|MSG-DASH-001|P|2.5\rPID|1||12345^^^HOSP^MR||DOE^JANE||19800101|F\rOBX|1|NM|718-7^Hemoglobin^LN||13.2|g/dL|||N|||F"
  );
  const [target, setTarget] = useState("fhir_r4");
  const [loadingConvert, setLoadingConvert] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [conversion, setConversion] = useState<ConversionResponse | null>(null);
  const [roundtripMs, setRoundtripMs] = useState<number | null>(null);

  const [reviewQueue, setReviewQueue] = useState<ReviewItem[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [selectedReview, setSelectedReview] = useState<ReviewItem | null>(null);

  const [traceQuery, setTraceQuery] = useState("");
  const [events, setEvents] = useState<any[]>([]);
  const [traceLoading, setTraceLoading] = useState(false);
  const [replayData, setReplayData] = useState<any | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Record<number, boolean>>({});
  const [traceError, setTraceError] = useState<string | null>(null);

  function buildOrchestratorHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey.trim()) {
      headers.authorization = `Bearer ${apiKey.trim()}`;
    }
    return headers;
  }

  async function submitConvert() {
    setLoadingConvert(true);
    setConvertError(null);
    const started = performance.now();
    try {
      const response = await fetch(`${orchestratorUrl}/convert`, {
        method: "POST",
        headers: buildOrchestratorHeaders(),
        body: JSON.stringify({
          tenant_id: "dashboard",
          source_channel: "web-dashboard",
          requested_target_format: target,
          raw_payload: { content: hl7 }
        })
      });
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Invalid or missing API key");
        }
        throw new Error(`convert failed: ${response.status}`);
      }
      const payload = (await response.json()) as ConversionResponse;
      setConversion(payload);
      setRoundtripMs(Math.round(performance.now() - started));
      setTraceQuery(payload.ingestion_id);
    } catch (error) {
      setConvertError(error instanceof Error ? error.message : "unknown error");
    } finally {
      setLoadingConvert(false);
    }
  }

  async function loadReviewQueue() {
    setReviewLoading(true);
    try {
      const response = await fetch(`${errorBusUrl}/review-queue`);
      if (!response.ok) return;
      const payload = await response.json();
      setReviewQueue(payload.review_queue ?? []);
    } finally {
      setReviewLoading(false);
    }
  }

  async function resolveReview(item: ReviewItem, resolutionAction: "approved" | "rejected") {
    const response = await fetch(`${errorBusUrl}/errors/${item.id}/resolve`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolution_action: resolutionAction })
    });
    if (response.ok) {
      setSelectedReview(null);
      await loadReviewQueue();
    }
  }

  async function searchTrace() {
    if (!traceQuery.trim()) return;
    setTraceLoading(true);
    setReplayData(null);
    try {
      const response = await fetch(`${auditServiceUrl}/events/${traceQuery.trim()}`);
      if (!response.ok) throw new Error(`audit lookup failed: ${response.status}`);
      const payload = await response.json();
      setEvents(payload.events ?? []);
    } catch {
      setEvents([]);
    } finally {
      setTraceLoading(false);
    }
  }

  async function replayTrace() {
    if (!traceQuery.trim()) return;
    setTraceError(null);
    const response = await fetch(`${orchestratorUrl}/conversions/${traceQuery.trim()}/replay`, {
      method: "POST",
      headers: apiKey.trim() ? { authorization: `Bearer ${apiKey.trim()}` } : {}
    });
    if (!response.ok) {
      if (response.status === 401) {
        setTraceError("Invalid or missing API key");
      } else {
        setTraceError(`Replay failed: ${response.status}`);
      }
      return;
    }
    const payload = await response.json();
    setReplayData(payload.debug_trace);
  }

  useEffect(() => {
    loadReviewQueue();
    const timer = setInterval(loadReviewQueue, 30_000);
    return () => clearInterval(timer);
  }, []);

  const prettyPayload = useMemo(
    () => (conversion ? syntaxHighlightJson(conversion.output?.target_payload ?? {}) : ""),
    [conversion]
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Health Data Conversion Dashboard</h1>
            <p className="text-sm text-slate-400">Demo console for conversion, review queue, and trace replay</p>
          </div>
          <button
            className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm hover:bg-slate-800"
            onClick={() => setShowSettings((prev) => !prev)}
            title="Settings"
          >
            ⚙
          </button>
        </div>
        {showSettings && (
          <div className="mt-4 rounded border border-slate-800 bg-slate-900 p-3">
            <label className="mb-2 block text-sm text-slate-300">Orchestrator API key</label>
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              placeholder="qmemo_..."
            />
          </div>
        )}
      </header>

      <nav className="flex gap-2 border-b border-slate-800 px-6 py-3">
        {([
          ["conversion", "Live Conversion"],
          ["review", "Review Queue"],
          ["trace", "Audit Trace"],
          ["mllp", "MLLP Info"]
        ] as const).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`rounded px-3 py-2 text-sm ${tab === value ? "bg-cyan-600" : "bg-slate-800 hover:bg-slate-700"}`}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="p-6">
        {tab === "conversion" && (
          <section className="space-y-4">
            <div className="rounded border border-slate-800 bg-slate-900 p-4">
              <label className="mb-2 block text-sm text-slate-300">Raw HL7 message</label>
              <textarea
                value={hl7}
                onChange={(e) => setHl7(e.target.value)}
                className="h-44 w-full rounded border border-slate-700 bg-slate-950 p-3 font-mono text-xs"
              />
              <div className="mt-3 flex items-center gap-3">
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                >
                  <option value="fhir_r4">FHIR R4</option>
                  <option value="omop">OMOP CDM</option>
                </select>
                <button
                  onClick={submitConvert}
                  disabled={loadingConvert}
                  className="rounded bg-cyan-600 px-4 py-2 text-sm font-medium hover:bg-cyan-500 disabled:opacity-60"
                >
                  {loadingConvert ? "Converting..." : "Convert"}
                </button>
              </div>
            </div>

            {convertError && <div className="rounded border border-red-500 bg-red-950 p-3 text-red-200">{convertError}</div>}

            {conversion && (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded border border-slate-800 bg-slate-900 p-3">
                    <div className="text-xs text-slate-400">Ingestion ID</div>
                    <div className="font-mono text-sm">{conversion.ingestion_id}</div>
                  </div>
                  <div className="rounded border border-slate-800 bg-slate-900 p-3">
                    <div className="text-xs text-slate-400">Trace ID</div>
                    <div className="font-mono text-sm">{conversion.trace_id}</div>
                  </div>
                  <div className="rounded border border-slate-800 bg-slate-900 p-3">
                    <div className="text-xs text-slate-400">Processing time</div>
                    <div className="text-sm">{roundtripMs ?? "-"} ms</div>
                  </div>
                </div>

                <div className="rounded border border-slate-800 bg-slate-900 p-4">
                  <h3 className="mb-2 text-sm font-semibold text-slate-200">Target Payload</h3>
                  <pre
                    className="overflow-auto rounded bg-slate-950 p-3 text-xs"
                    dangerouslySetInnerHTML={{ __html: prettyPayload }}
                  />
                </div>

                <div className="rounded border border-slate-800 bg-slate-900 p-4">
                  <h3 className="mb-2 text-sm font-semibold text-slate-200">Flags & Warnings</h3>
                  <ul className="space-y-1 text-sm">
                    {(conversion.flags_summary ?? []).map((flag) => (
                      <li key={flag} className="text-amber-300">{flag}</li>
                    ))}
                    {(conversion.output?.warnings ?? []).map((warning) => (
                      <li key={warning.code} className="text-amber-300">
                        {warning.code}: {warning.message}
                      </li>
                    ))}
                    {(conversion.flags_summary?.length ?? 0) === 0 && (conversion.output?.warnings?.length ?? 0) === 0 && (
                      <li className="text-emerald-300">No flags or warnings</li>
                    )}
                  </ul>
                </div>
              </>
            )}
          </section>
        )}

        {tab === "review" && (
          <section className="relative">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Pending Review Queue</h2>
              <button onClick={loadReviewQueue} className="rounded bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700">
                {reviewLoading ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            <div className="overflow-hidden rounded border border-slate-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-900 text-slate-300">
                  <tr>
                    <th className="px-3 py-2">ingestion_id</th>
                    <th className="px-3 py-2">error_code</th>
                    <th className="px-3 py-2">source_format</th>
                    <th className="px-3 py-2">severity</th>
                    <th className="px-3 py-2">timestamp</th>
                    <th className="px-3 py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {reviewQueue.map((item) => (
                    <tr key={item.id} className="border-t border-slate-800 bg-slate-950">
                      <td className="px-3 py-2 font-mono">
                        <button
                          className="text-cyan-300 hover:underline"
                          onClick={() => {
                            setTraceQuery(item.ingestion_id);
                            setSelectedReview(item);
                          }}
                        >
                          {item.ingestion_id.slice(0, 12)}...
                        </button>
                      </td>
                      <td className="px-3 py-2">{item.error_code}</td>
                      <td className="px-3 py-2">{item.source_format}</td>
                      <td className="px-3 py-2">{item.severity}</td>
                      <td className="px-3 py-2">{new Date(item.timestamp).toLocaleString()}</td>
                      <td className="px-3 py-2">
                        <button className="rounded bg-cyan-600 px-3 py-1 text-xs" onClick={() => setSelectedReview(item)}>
                          Review
                        </button>
                      </td>
                    </tr>
                  ))}
                  {reviewQueue.length === 0 && (
                    <tr>
                      <td className="px-3 py-4 text-slate-400" colSpan={6}>
                        No pending review items.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {selectedReview && (
              <aside className="absolute right-0 top-0 h-full w-full max-w-xl overflow-auto border-l border-slate-700 bg-slate-900 p-4 shadow-2xl">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-lg font-semibold">Review item</h3>
                  <button onClick={() => setSelectedReview(null)} className="text-slate-400 hover:text-slate-200">Close</button>
                </div>
                <pre className="overflow-auto rounded bg-slate-950 p-3 text-xs">
                  {JSON.stringify(JSON.parse(selectedReview.layer_context || "{}"), null, 2)}
                </pre>
                <div className="mt-4 flex gap-2">
                  <button
                    className="rounded bg-emerald-600 px-3 py-2 text-sm"
                    onClick={() => resolveReview(selectedReview, "approved")}
                  >
                    Approve
                  </button>
                  <button
                    className="rounded bg-rose-600 px-3 py-2 text-sm"
                    onClick={() => resolveReview(selectedReview, "rejected")}
                  >
                    Reject
                  </button>
                </div>
              </aside>
            )}
          </section>
        )}

        {tab === "trace" && (
          <section className="space-y-4">
            <div className="flex gap-2">
              <input
                value={traceQuery}
                onChange={(e) => setTraceQuery(e.target.value)}
                className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2"
                placeholder="Enter ingestion_id"
              />
              <button onClick={searchTrace} className="rounded bg-cyan-600 px-4 py-2 text-sm">
                {traceLoading ? "Loading..." : "Search"}
              </button>
              <button onClick={replayTrace} className="rounded bg-slate-800 px-4 py-2 text-sm hover:bg-slate-700">
                Replay
              </button>
            </div>
            {traceError && <div className="rounded border border-rose-500 bg-rose-950 p-3 text-rose-200">{traceError}</div>}

            <div className="rounded border border-slate-800 bg-slate-900 p-4">
              <h3 className="mb-3 font-semibold">Audit Timeline</h3>
              <div className="space-y-3">
                {events.map((event, idx) => (
                  <div key={idx} className="border-l-2 border-cyan-500 pl-3">
                    <div className="text-sm font-medium">{event.agent_id}</div>
                    <div className="text-xs text-slate-300">
                      {event.transformation_step} - {event.status_transition}
                    </div>
                    <div className="text-xs text-slate-400">{new Date(event.created_at).toLocaleString()}</div>
                  </div>
                ))}
                {events.length === 0 && <div className="text-sm text-slate-400">No events loaded.</div>}
              </div>
            </div>

            {replayData && (
              <div className="rounded border border-slate-800 bg-slate-900 p-4">
                <h3 className="mb-3 font-semibold">Replay DebugTrace</h3>
                <div className="space-y-2">
                  {(replayData.steps ?? []).map((step: any) => (
                    <div key={step.step_number} className="rounded border border-slate-700">
                      <button
                        className="flex w-full items-center justify-between bg-slate-800 px-3 py-2 text-left text-sm"
                        onClick={() =>
                          setExpandedSteps((prev) => ({ ...prev, [step.step_number]: !prev[step.step_number] }))
                        }
                      >
                        <span>
                          Step {step.step_number}: {step.layer_name}
                        </span>
                        <span>{step.duration_ms} ms</span>
                      </button>
                      {expandedSteps[step.step_number] && (
                        <div className="overflow-auto p-3">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr className="text-slate-300">
                                <th className="pb-1">decision_type</th>
                                <th className="pb-1">field</th>
                                <th className="pb-1">method</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(step.decisions ?? []).map((decision: any, idx: number) => (
                                <tr key={idx} className="border-t border-slate-800">
                                  <td className="py-1">{decision.decision_type}</td>
                                  <td className="py-1">{decision.field}</td>
                                  <td className="py-1">{decision.method_used}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {tab === "mllp" && (
          <section className="space-y-4">
            <div className="rounded border border-slate-800 bg-slate-900 p-4">
              <h2 className="mb-2 text-lg font-semibold">MLLP Connection Details</h2>
              <p className="text-sm text-slate-300">Configure your EHR HL7 feed to send MLLP-framed messages to:</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="rounded border border-slate-700 bg-slate-950 p-3">
                  <div className="text-xs text-slate-400">Host</div>
                  <div className="font-mono text-sm">{mllpHost}</div>
                </div>
                <div className="rounded border border-slate-700 bg-slate-950 p-3">
                  <div className="text-xs text-slate-400">Port</div>
                  <div className="font-mono text-sm">{mllpPort}</div>
                </div>
              </div>
            </div>

            <div className="rounded border border-slate-800 bg-slate-900 p-4">
              <h3 className="mb-2 text-sm font-semibold">Example EHR feed configuration</h3>
              <textarea
                readOnly
                className="h-40 w-full rounded border border-slate-700 bg-slate-950 p-3 font-mono text-xs"
                value={`Connection Name: HL7 Outbound Feed\nProtocol: MLLP (TCP)\nHost: ${mllpHost}\nPort: ${mllpPort}\nEncoding: UTF-8\nMessage Type: ORU^R01\nACK Required: Yes (AA/AE)\nTransport Retry: Enabled`}
              />
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
