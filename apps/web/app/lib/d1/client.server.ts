/**
 * D1 access helpers (Stage L1).
 * Repositories accept D1Database explicitly — not wired into production routes yet.
 */

export const D1_MIGRATION_VERSION = "l1-v1";

export function requireTtiDb(env: { TTI_DB?: D1Database }): D1Database {
  if (!env.TTI_DB) {
    throw new D1ConfigError("TTI_DB binding is not configured");
  }
  return env.TTI_DB;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export class D1ConfigError extends Error {
  readonly kind = "config" as const;
  constructor(message: string) {
    super(message);
    this.name = "D1ConfigError";
  }
}
