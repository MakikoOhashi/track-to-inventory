/**
 * Classify D1 / SQLite failures for callers.
 * Domain "no row updated" results are NOT thrown as success — they stay as domain results.
 */

export type D1ErrorClass =
  | "constraint"
  | "check"
  | "busy"
  | "retryable"
  | "fatal"
  | "unknown";

export class D1RepositoryError extends Error {
  readonly classification: D1ErrorClass;
  readonly retryable: boolean;
  readonly cause?: unknown;

  constructor(
    message: string,
    classification: D1ErrorClass,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message);
    this.name = "D1RepositoryError";
    this.classification = classification;
    this.cause = options?.cause;
    this.retryable =
      options?.retryable ??
      (classification === "busy" || classification === "retryable");
  }
}

export function classifyD1Error(error: unknown): D1RepositoryError {
  if (error instanceof D1RepositoryError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    lower.includes("unique") ||
    lower.includes("constraint failed") ||
    lower.includes("primary key")
  ) {
    return new D1RepositoryError(message, "constraint", {
      cause: error,
      retryable: false,
    });
  }

  if (lower.includes("check constraint") || lower.includes("check constraint failed")) {
    return new D1RepositoryError(message, "check", {
      cause: error,
      retryable: false,
    });
  }

  if (
    lower.includes("database is locked") ||
    lower.includes("sqlite_busy") ||
    lower.includes("too many requests") ||
    lower.includes("429")
  ) {
    return new D1RepositoryError(message, "busy", {
      cause: error,
      retryable: true,
    });
  }

  if (
    lower.includes("network") ||
    lower.includes("timeout") ||
    lower.includes("temporar") ||
    lower.includes("503") ||
    lower.includes("502")
  ) {
    return new D1RepositoryError(message, "retryable", {
      cause: error,
      retryable: true,
    });
  }

  return new D1RepositoryError(message, "unknown", {
    cause: error,
    retryable: false,
  });
}

/** Never treat thrown DB errors as domain success. */
export function isRetryableD1Error(error: unknown): boolean {
  return classifyD1Error(error).retryable;
}
