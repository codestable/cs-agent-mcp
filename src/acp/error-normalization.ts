import {
  AuthPolicyError,
  PermissionDeniedError,
  PermissionPromptUnavailableError,
} from "../errors.js";
import {
  EXIT_CODES,
  OUTPUT_ERROR_CODES,
  OUTPUT_ERROR_ORIGINS,
  type ExitCode,
  type OutputErrorAcpPayload,
  type OutputErrorCode,
  type OutputErrorOrigin,
} from "../types.js";
import {
  extractAcpError,
  formatUnknownErrorMessage,
  isAcpResourceNotFoundError,
} from "./error-shapes.js";

const AUTH_REQUIRED_ACP_CODES = new Set([-32000]);
const QUERY_CLOSED_BEFORE_RESPONSE_DETAIL = "query closed before response received";
const MAX_TURNS_EXCEEDED_DETAIL_CODE = "MAX_TURNS_EXCEEDED";
const MAX_TURNS_EXCEEDED_SUBTYPE = "error_max_turns";
const MAX_TURNS_EXCEEDED_MESSAGE_PATTERN =
  /reached maximum number of turns(?:\s*\(\s*(\d{1,5})\s*\))?/i;
const MAX_TURNS_EXCEEDED_FIELDS = ["message", "details", "subtype", "type", "errors"] as const;

type ErrorMeta = {
  outputCode?: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
};

export type NormalizedOutputError = {
  code: OutputErrorCode;
  message: string;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
};

export type NormalizeOutputErrorOptions = {
  defaultCode?: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isAuthRequiredMessage(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.toLowerCase();
  return [
    "auth required",
    "authentication required",
    "authorization required",
    "credential required",
    "credentials required",
    "token required",
    "login required",
  ].some((needle) => normalized.includes(needle));
}

function isAcpAuthRequiredPayload(acp: OutputErrorAcpPayload | undefined): boolean {
  if (!acp) {
    return false;
  }
  if (!AUTH_REQUIRED_ACP_CODES.has(acp.code)) {
    return false;
  }
  if (isAuthRequiredMessage(acp.message)) {
    return true;
  }

  const data = asRecord(acp.data);
  if (!data) {
    return false;
  }

  return hasAuthRequiredData(data);
}

function hasAuthRequiredData(data: Record<string, unknown>): boolean {
  return (
    data.authRequired === true || hasNonEmptyString(data.methodId) || hasNonEmptyArray(data.methods)
  );
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function isOutputErrorCode(value: unknown): value is OutputErrorCode {
  return typeof value === "string" && OUTPUT_ERROR_CODES.includes(value as OutputErrorCode);
}

function isOutputErrorOrigin(value: unknown): value is OutputErrorOrigin {
  return typeof value === "string" && OUTPUT_ERROR_ORIGINS.includes(value as OutputErrorOrigin);
}

function readOutputErrorMeta(error: unknown): ErrorMeta {
  const record = asRecord(error);
  if (!record) {
    return {};
  }

  const outputCode = isOutputErrorCode(record.outputCode) ? record.outputCode : undefined;
  const detailCode =
    typeof record.detailCode === "string" && record.detailCode.trim().length > 0
      ? record.detailCode
      : undefined;
  const origin = isOutputErrorOrigin(record.origin) ? record.origin : undefined;
  const retryable = typeof record.retryable === "boolean" ? record.retryable : undefined;

  const acp = extractAcpError(record.acp);
  return {
    outputCode,
    detailCode,
    origin,
    retryable,
    acp,
  };
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function isNoSessionLike(error: unknown): boolean {
  return error instanceof Error && error.name === "NoSessionError";
}

function isUsageLike(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "CommanderError" ||
    error.name === "InvalidArgumentError" ||
    asRecord(error)?.code === "commander.invalidArgument"
  );
}

function readKnownField(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function maxTurnsExceededText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  const messageMatch = MAX_TURNS_EXCEEDED_MESSAGE_PATTERN.exec(value);
  if (messageMatch) {
    const configuredTurns = messageMatch[1];
    return configuredTurns
      ? `Reached maximum number of turns (${configuredTurns})`
      : "Reached maximum number of turns";
  }
  return normalized.includes(MAX_TURNS_EXCEEDED_SUBTYPE)
    ? "Reached maximum number of turns"
    : undefined;
}

function findMaxTurnsExceededInKnownValue(value: unknown, depth = 0): string | undefined {
  const direct = maxTurnsExceededText(value);
  if (direct || depth > 4) {
    return direct;
  }
  if (Array.isArray(value)) {
    return findMaxTurnsExceededInEntries(value, depth);
  }
  const record = asRecord(value);
  return record ? findMaxTurnsExceededInRecord(record, depth) : undefined;
}

function findMaxTurnsExceededInEntries(entries: unknown[], depth: number): string | undefined {
  for (const entry of entries) {
    const hint = findMaxTurnsExceededInKnownValue(entry, depth + 1);
    if (hint) {
      return hint;
    }
  }
  return undefined;
}

function findMaxTurnsExceededInRecord(
  record: Record<string, unknown>,
  depth: number,
): string | undefined {
  for (const field of MAX_TURNS_EXCEEDED_FIELDS) {
    const hint = findMaxTurnsExceededInKnownValue(readKnownField(record, field), depth + 1);
    if (hint) {
      return hint;
    }
  }
  return undefined;
}

function findMaxTurnsExceededHint(
  error: unknown,
  acp: OutputErrorAcpPayload | undefined,
): string | undefined {
  const errorRecord = asRecord(error);
  const topLevelHint = errorRecord
    ? findMaxTurnsExceededInKnownValue({
        message: readKnownField(errorRecord, "message"),
        subtype: readKnownField(errorRecord, "subtype"),
        type: readKnownField(errorRecord, "type"),
        errors: readKnownField(errorRecord, "errors"),
      })
    : maxTurnsExceededText(error);
  if (topLevelHint || !acp) {
    return topLevelHint;
  }

  const data = asRecord(acp.data);
  return (
    maxTurnsExceededText(acp.message) ??
    (data
      ? findMaxTurnsExceededInKnownValue({
          details: readKnownField(data, "details"),
          subtype: readKnownField(data, "subtype"),
          type: readKnownField(data, "type"),
          errors: readKnownField(data, "errors"),
        })
      : undefined)
  );
}

function hasCompleteExplicitSemantics(
  meta: ErrorMeta,
  options: NormalizeOutputErrorOptions,
): boolean {
  return (
    (meta.detailCode ?? options.detailCode) !== undefined &&
    (meta.retryable ?? options.retryable) !== undefined
  );
}

function resolveNormalizedErrorMessage(error: unknown, maxTurnsExceededHint: string | undefined) {
  return maxTurnsExceededHint
    ? formatMaxTurnsExceededMessage(maxTurnsExceededHint)
    : formatErrorMessage(error);
}

function resolveNormalizedRetryable(
  meta: ErrorMeta,
  options: NormalizeOutputErrorOptions,
  maxTurnsExceeded: boolean,
): boolean | undefined {
  if (maxTurnsExceeded) {
    return false;
  }
  if (meta.retryable !== undefined) {
    return meta.retryable;
  }
  if (options.retryable !== undefined) {
    return options.retryable;
  }
  return undefined;
}

function formatMaxTurnsExceededMessage(hint: string): string {
  return (
    "The agent reached its configured sessionOptions.maxTurns before completing the task " +
    `(${hint}). Create a new agent with a higher value or omit it.`
  );
}

export function formatErrorMessage(error: unknown): string {
  return formatUnknownErrorMessage(error);
}

export { extractAcpError, isAcpResourceNotFoundError };

export function isAcpQueryClosedBeforeResponseError(error: unknown): boolean {
  const acp = extractAcpError(error);
  if (!acp || acp.code !== -32603) {
    return false;
  }

  const data = asRecord(acp.data);
  const details = data?.details;
  if (typeof details !== "string") {
    return false;
  }

  return details.toLowerCase().includes(QUERY_CLOSED_BEFORE_RESPONSE_DETAIL);
}

function mapErrorCode(error: unknown): OutputErrorCode | undefined {
  if (error instanceof PermissionPromptUnavailableError) {
    return "PERMISSION_PROMPT_UNAVAILABLE";
  }
  if (error instanceof PermissionDeniedError) {
    return "PERMISSION_DENIED";
  }
  if (isTimeoutLike(error)) {
    return "TIMEOUT";
  }
  if (isNoSessionLike(error) || isAcpResourceNotFoundError(error)) {
    return "NO_SESSION";
  }
  if (isUsageLike(error)) {
    return "USAGE";
  }
  return undefined;
}

export function normalizeOutputError(
  error: unknown,
  options: NormalizeOutputErrorOptions = {},
): NormalizedOutputError {
  const meta = readOutputErrorMeta(error);
  const code = resolveOutputErrorCode(error, options, meta);
  const acp = options.acp ?? meta.acp ?? extractAcpError(error);
  const maxTurnsExceededHint =
    code === "RUNTIME" && !hasCompleteExplicitSemantics(meta, options)
      ? findMaxTurnsExceededHint(error, acp)
      : undefined;
  return {
    code,
    message: resolveNormalizedErrorMessage(error, maxTurnsExceededHint),
    detailCode: resolveDetailCode(error, acp, options, meta, Boolean(maxTurnsExceededHint)),
    origin: meta.origin ?? options.origin,
    retryable: resolveNormalizedRetryable(meta, options, Boolean(maxTurnsExceededHint)),
    acp,
  };
}

function resolveOutputErrorCode(
  error: unknown,
  options: NormalizeOutputErrorOptions,
  meta: ErrorMeta,
): OutputErrorCode {
  const code = meta.outputCode ?? mapErrorCode(error) ?? options.defaultCode ?? "RUNTIME";
  if (code === "RUNTIME" && isAcpResourceNotFoundError(error)) {
    return "NO_SESSION";
  }
  return code;
}

function resolveDetailCode(
  error: unknown,
  acp: OutputErrorAcpPayload | undefined,
  options: NormalizeOutputErrorOptions,
  meta: ErrorMeta,
  maxTurnsExceeded: boolean,
): string | undefined {
  return (
    (maxTurnsExceeded ? MAX_TURNS_EXCEEDED_DETAIL_CODE : undefined) ??
    meta.detailCode ??
    options.detailCode ??
    (error instanceof AuthPolicyError || isAcpAuthRequiredPayload(acp)
      ? "AUTH_REQUIRED"
      : undefined)
  );
}

/**
 * Returns true when an error from `client.prompt()` looks transient and
 * can reasonably be retried (e.g. model-API 400/500, network hiccups that
 * surface as ACP internal errors).
 *
 * Errors that are definitively non-recoverable (auth, missing session,
 * invalid params, timeout, permission) return false.
 */
export function isRetryablePromptError(error: unknown): boolean {
  const normalized = normalizeOutputError(error);
  if (
    normalized.code !== "RUNTIME" ||
    normalized.detailCode === "AUTH_REQUIRED" ||
    isNonRetryablePromptError(error)
  ) {
    return false;
  }

  if (normalized.retryable !== undefined) {
    return normalized.retryable;
  }

  const acp = normalized.acp;
  if (!acp) {
    // Non-ACP errors (e.g. process crash) are not retried at the prompt level.
    return false;
  }

  if (isPermanentPromptAcpError(acp)) {
    return false;
  }

  // ACP internal errors (-32603) typically wrap model-API failures → retryable.
  // Parse errors (-32700) can also be transient.
  return acp.code === -32603 || acp.code === -32700;
}

function isNonRetryablePromptError(error: unknown): boolean {
  return (
    error instanceof PermissionDeniedError ||
    error instanceof PermissionPromptUnavailableError ||
    isTimeoutLike(error) ||
    isNoSessionLike(error) ||
    isUsageLike(error)
  );
}

function isPermanentPromptAcpError(acp: OutputErrorAcpPayload): boolean {
  return (
    acp.code === -32001 ||
    acp.code === -32002 ||
    acp.code === -32601 ||
    acp.code === -32602 ||
    isAcpAuthRequiredPayload(acp)
  );
}

export function exitCodeForOutputErrorCode(code: OutputErrorCode): ExitCode {
  switch (code) {
    case "USAGE":
      return EXIT_CODES.USAGE;
    case "TIMEOUT":
      return EXIT_CODES.TIMEOUT;
    case "NO_SESSION":
      return EXIT_CODES.NO_SESSION;
    case "PERMISSION_DENIED":
    case "PERMISSION_PROMPT_UNAVAILABLE":
      return EXIT_CODES.PERMISSION_DENIED;
    case "RUNTIME":
    default:
      return EXIT_CODES.ERROR;
  }
}
