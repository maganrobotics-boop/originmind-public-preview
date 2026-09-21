/** Shared, closed diagnostic vocabulary. Never serialize raw exceptions or bodies. */
const PHASES = new Set([
  'request_claim', 'config_read', 'provider_selection', 'endpoint_validation',
  'key_decryption', 'model_configuration', 'budget', 'model_request',
  'tool_execution', 'unknown',
]);
const CODES = new Set([
  'TASK_INTERNAL_ERROR', 'TASK_MODEL_CONFIG', 'TASK_MODEL_HTTP',
  'TASK_MODEL_TRANSPORT', 'TASK_MODEL_PROTOCOL', 'TASK_MODEL_RESPONSE_LIMIT',
  'TASK_BUDGET_EXHAUSTED', 'TASK_BUDGET_UNAVAILABLE',
  'TASK_INVALID_INPUT', 'TASK_TOOL_TIMEOUT', 'TASK_TOOL_CONTEXT_LIMIT',
  'TASK_TOOL_ARGUMENTS', 'TASK_TOOL_NOT_ALLOWED', 'TASK_TOOL_ORDER',
  'TASK_TOOL_LIMIT', 'TASK_NO_ARTIFACT', 'TASK_ARTIFACT_INVALID',
  'TASK_SOURCE_REQUIRED', 'TASK_SOURCE_RANGE', 'TASK_TABLE_INVALID',
  'TASK_TABLE_LIMIT', 'TASK_TABLE_NON_NUMERIC', 'TASK_TABLE_COLUMN_MISSING',
]);

/** Also used on the receiving side: ignore additions and reject unknown labels. */
export function sanitizeTaskDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.version !== 1 || !PHASES.has(value.phase) || !CODES.has(value.code)) return null;
  const result = { version: 1, phase: value.phase, code: value.code };
  // This is the observed upstream status, NOT the bridge's compatibility 503.
  if (value.code === 'TASK_MODEL_HTTP' && Number.isInteger(value.upstreamStatus) &&
      value.upstreamStatus >= 300 && value.upstreamStatus <= 599) result.upstreamStatus = value.upstreamStatus;
  return result;
}

export function taskFailureDiagnostic(error, phase) {
  return sanitizeTaskDiagnostic({
    version: 1,
    phase: PHASES.has(phase) ? phase : 'unknown',
    code: CODES.has(error?.message) ? error.message : 'TASK_INTERNAL_ERROR',
    upstreamStatus: error?.upstreamStatus,
  });
}
