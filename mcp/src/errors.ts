export class MijiaFlowError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MijiaFlowError";
  }
}

export function asMijiaFlowError(error: unknown, fallbackCode = "INTERNAL_ERROR"): MijiaFlowError {
  if (error instanceof MijiaFlowError) {
    return error;
  }
  const message = error instanceof Error ? error.message : "Unexpected MijiaFlow error";
  return new MijiaFlowError(message, fallbackCode);
}
