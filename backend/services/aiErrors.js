/**
 * Mediblix Desktop — Shared AI error taxonomy
 *
 * Every AI failure is expressed as an AIError carrying a stable machine code,
 * an HTTP status for the API layer, and a message that is safe to show a user.
 * Controllers never invent ad-hoc strings, and the provider router can decide
 * whether a fallback makes sense from the code alone.
 */

export const AI_ERROR = {
  // Request / input problems (client's fault, 4xx)
  INPUT_REQUIRED: { code: "AI_INPUT_REQUIRED", statusCode: 400 },
  INPUT_INVALID: { code: "AI_INPUT_INVALID", statusCode: 400 },
  INPUT_TOO_LARGE: { code: "AI_INPUT_TOO_LARGE", statusCode: 413 },
  INPUT_UNSUPPORTED: { code: "AI_INPUT_UNSUPPORTED", statusCode: 415 },

  // No usable provider (server-side availability, 503)
  UNAVAILABLE: { code: "AI_UNAVAILABLE", statusCode: 503 },
  OFFLINE_UNSUPPORTED: { code: "AI_OFFLINE_UNSUPPORTED", statusCode: 503 },
  LOCAL_UNAVAILABLE: { code: "AI_LOCAL_UNAVAILABLE", statusCode: 503 },
  LOCAL_MODEL_MISSING: { code: "AI_LOCAL_MODEL_MISSING", statusCode: 503 },
  LOCAL_DISABLED: { code: "AI_LOCAL_DISABLED", statusCode: 503 },
  PDF_SUPPORT_MISSING: { code: "AI_PDF_SUPPORT_MISSING", statusCode: 503 },

  // Provider-side problems
  TIMEOUT: { code: "AI_TIMEOUT", statusCode: 504 },
  INVALID_OUTPUT: { code: "AI_INVALID_OUTPUT", statusCode: 422 },
  EMPTY_OUTPUT: { code: "AI_EMPTY_OUTPUT", statusCode: 422 },

  // Gemini specific
  GEMINI_NOT_CONFIGURED: { code: "AI_GEMINI_NOT_CONFIGURED", statusCode: 503 },
  GEMINI_AUTH: { code: "AI_GEMINI_AUTH", statusCode: 503 },
  GEMINI_QUOTA: { code: "AI_GEMINI_QUOTA", statusCode: 429 },
  GEMINI_UNAVAILABLE: { code: "AI_GEMINI_UNAVAILABLE", statusCode: 503 },
  GEMINI_EMPTY: { code: "AI_GEMINI_EMPTY", statusCode: 502 },

  // Connectivity
  OFFLINE: { code: "AI_OFFLINE", statusCode: 503 },

  INTERNAL: { code: "AI_INTERNAL_ERROR", statusCode: 500 },
};

export class AIError extends Error {
  constructor(spec, message, options = {}) {
    super(message);
    this.name = "AIError";
    this.code = spec.code;
    this.statusCode = options.statusCode || spec.statusCode || 500;
    this.provider = options.provider || null;
    this.retryable = Boolean(options.retryable);
    this.details = options.details || null;
    if (options.cause) this.cause = options.cause;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      provider: this.provider,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isAIError(error) {
  return error instanceof AIError;
}

/**
 * Normalises any thrown value into an AIError so controllers have one shape.
 */
export function toAIError(error, fallback = AI_ERROR.INTERNAL) {
  if (isAIError(error)) return error;

  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return new AIError(AI_ERROR.TIMEOUT, "The AI request timed out. Please try again.", {
      cause: error,
    });
  }

  const code = error?.cause?.code || error?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNRESET") {
    return new AIError(AI_ERROR.UNAVAILABLE, "The AI service could not be reached.", {
      cause: error,
      details: { networkCode: code },
    });
  }

  return new AIError(fallback, error?.message || "The AI request failed.", { cause: error });
}

export default { AI_ERROR, AIError, isAIError, toAIError };
