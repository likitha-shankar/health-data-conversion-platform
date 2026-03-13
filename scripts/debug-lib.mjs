export function formatAuditTrail(payload) {
  const events = Array.isArray(payload.events) ? payload.events : [];
  const lines = [`Audit trail for ingestion_id=${payload.ingestion_id}`];
  for (const event of events) {
    lines.push(
      `[${event.created_at}] ${event.transformation_step} ${event.status_transition} ` +
        `agent=${event.agent_id}@${event.agent_version} source=${event.source_format} target=${event.target_format}`
    );
  }
  return lines.join("\n");
}

export function formatDebugTrace(payload) {
  const trace = payload.debug_trace;
  const lines = [`Replay trace for ingestion_id=${trace.ingestion_id} trace_id=${trace.trace_id}`];
  for (const step of trace.steps) {
    lines.push(
      `\nStep ${step.step_number}: ${step.layer_name} (${step.service.name}@${step.service.version}) duration=${step.duration_ms}ms`
    );
    lines.push(`  Input: ${JSON.stringify(step.input_snapshot)}`);
    lines.push(`  Output: ${JSON.stringify(step.output_snapshot)}`);
    lines.push("  Decisions:");
    for (const decision of step.decisions) {
      lines.push(
        `    - ${decision.decision_type} field=${decision.field} source_path=${decision.source_path} method=${decision.method_used}`
      );
      lines.push(`      source_value=${JSON.stringify(decision.source_value)} output_value=${JSON.stringify(decision.output_value)}`);
    }
    if (step.warnings.length > 0) {
      lines.push(`  Warnings: ${step.warnings.join(", ")}`);
    }
  }
  return lines.join("\n");
}

export function formatErrors(payload) {
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  const lines = [`Errors for ingestion_id=${payload.ingestion_id}`];
  for (const error of errors) {
    lines.push(
      `[${error.timestamp}] code=${error.error_code} severity=${error.severity} layer=${error.layer} retryable=${error.is_retryable}`
    );
    lines.push(`  context=${error.layer_context}`);
  }
  return lines.join("\n");
}

export function formatReviewQueue(payload) {
  const items = Array.isArray(payload.review_queue) ? payload.review_queue : [];
  const lines = ["Review queue items:"];
  for (const item of items) {
    lines.push(
      `- ingestion_id=${item.ingestion_id} code=${item.error_code} severity=${item.severity} source_system=${item.source_system_id}`
    );
    lines.push(`  source_values=${item.layer_context}`);
  }
  return lines.join("\n");
}
