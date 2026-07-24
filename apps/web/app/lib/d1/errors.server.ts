/**
 * Classify D1 / SQLite failures for callers.
 * Domain "no row updated" results are NOT thrown as success — they stay as domain results.
 *
 * Stage L4.3b: distinguish schema / binding-proxy failures from opaque "unknown"
 * without logging secrets or raw SQL payloads.
 */

export type D1ErrorClass =
  | "constraint"
  | "check"
  | "busy"
  | "retryable"
  | "fatal"
  | "schema"
  | "unknown";

/** Coarse stage for dual-write / shadow diagnostics (no secrets). */
export type D1FailureStage =
  | "binding"
  | "prepare"
  | "bind"
  | "run"
  | "timeout"
  | "unknown";

export class D1RepositoryError extends Error {
  readonly classification: D1ErrorClass;
  readonly retryable: boolean;
  readonly failureStage: D1FailureStage;
  readonly cause?: unknown;

  constructor(
    message: string,
    classification: D1ErrorClass,
    options?: {
      cause?: unknown;
      retryable?: boolean;
      failureStage?: D1FailureStage;
    },
  ) {
    super(message);
    this.name = "D1RepositoryError";
    this.classification = classification;
    this.cause = options?.cause;
    this.failureStage = options?.failureStage ?? inferFailureStage(message);
    this.retryable =
      options?.retryable ??
      (classification === "busy" || classification === "retryable");
  }
}

export function inferFailureStage(message: string): D1FailureStage {
  const lower = message.toLowerCase();
  if (lower.includes("binding") && lower.includes("missing")) return "binding";
  if (
    lower.includes("d1_dual_write_timeout") ||
    lower.includes("d1_shadow_timeout") ||
    lower.includes("d1_primary_timeout") ||
    lower.includes("d1_only_timeout")
  ) {
    return "timeout";
  }
  if (lower.includes("timeout")) return "timeout";
  // D1_ERROR / SQLITE often surface at statement execution (.run / .first)
  if (
    lower.includes("no such table") ||
    lower.includes("sqlite_error") ||
    lower.includes("d1_error") ||
    lower.includes("syntax error")
  ) {
    return "run";
  }
  if (lower.includes("prepare")) return "prepare";
  if (lower.includes("bind")) return "bind";
  return "unknown";
}

export function safeErrorName(error: unknown): string {
  if (error instanceof Error && error.name) return error.name.slice(0, 64);
  return typeof error;
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
      failureStage: "run",
    });
  }

  if (lower.includes("check constraint") || lower.includes("check constraint failed")) {
    return new D1RepositoryError(message, "check", {
      cause: error,
      retryable: false,
      failureStage: "run",
    });
  }

  if (
    lower.includes("no such table") ||
    lower.includes("no such column") ||
    (lower.includes("sqlite_error") && lower.includes("no such"))
  ) {
    return new D1RepositoryError(message, "schema", {
      cause: error,
      retryable: false,
      failureStage: "run",
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
      failureStage: "run",
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
      failureStage: inferFailureStage(message),
    });
  }

  if (lower.includes("d1_error") || lower.includes("sqlite_error")) {
    return new D1RepositoryError(message, "fatal", {
      cause: error,
      retryable: false,
      failureStage: "run",
    });
  }

  return new D1RepositoryError(message, "unknown", {
    cause: error,
    retryable: false,
    failureStage: inferFailureStage(message),
  });
}

/** Never treat thrown DB errors as domain success. */
export function isRetryableD1Error(error: unknown): boolean {
  return classifyD1Error(error).retryable;
}
