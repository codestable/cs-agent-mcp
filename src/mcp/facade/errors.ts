import type { FacadeErrorShape } from "./types.js";

export class FacadeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "FacadeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toJSON(): FacadeErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function normalizeFacadeError(error: unknown): FacadeErrorShape {
  if (error instanceof FacadeError) {
    return error.toJSON();
  }
  return {
    code: "RUNTIME_FAILURE",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
