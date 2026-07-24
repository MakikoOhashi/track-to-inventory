/**
 * Stage L4.4b production canary gate criteria (definition only).
 *
 * L4.4a must not flip SESSION_D1_MODE to d1_primary.
 * Latency / fallback rate thresholds stay "proposed" until dual_write traffic
 * yields measured p50/p95 — do not lock soft numbers here.
 */

export type L44bGateCriterion = {
  id: string;
  description: string;
  /** hard = required before canary; proposed = measure then set */
  severity: "hard" | "proposed";
};

export const L44B_ROLLBACK_MODE = "dual_write" as const;

export const L44B_GATE_CRITERIA: L44bGateCriterion[] = [
  {
    id: "fingerprint_match",
    description: "Redis and D1 offline session semantic fingerprints match",
    severity: "hard",
  },
  {
    id: "d1_live_one",
    description: "D1 shopify_sessions live count = 1 for target shop; duplicates = 0",
    severity: "hard",
  },
  {
    id: "no_tombstone_conflict",
    description: "No equal-timestamp tombstone/live conflict on target session id",
    severity: "hard",
  },
  {
    id: "ledger_succeeded_two",
    description: "inventory_sync_ledger succeeded rows = 2 (L3 seed); no new mutations",
    severity: "hard",
  },
  {
    id: "auth_probe_fixed",
    description:
      "auth-context probe uses standard browser UA + Bearer JWT; short UA rejected",
    severity: "hard",
  },
  {
    id: "d1_read_latency",
    description:
      "Record D1 primary-path p50/p95/max under dual_write shadow traffic; set canary budget after measurement",
    severity: "proposed",
  },
  {
    id: "error_timeout_fallback_rate",
    description:
      "Record session_d1_* error/timeout/fallback rates; set canary ceilings after measurement",
    severity: "proposed",
  },
  {
    id: "rollback_dual_write",
    description: `Rollback target remains SESSION_D1_MODE=${L44B_ROLLBACK_MODE}`,
    severity: "hard",
  },
  {
    id: "redis_write_continues",
    description:
      "After d1_primary canary, Redis remains write primary and D1 dual-write continues",
    severity: "hard",
  },
  {
    id: "no_inventory_mutation",
    description: "Canary cutover must not mutate inventory or ledger",
    severity: "hard",
  },
];

/** Hard criteria ids that must pass before any L4.4b mode flip. */
export function l44bHardGateIds(): string[] {
  return L44B_GATE_CRITERIA.filter((c) => c.severity === "hard").map((c) => c.id);
}
