/** Optional deterministic outcome published by an extension for non-interactive callers. */
export const SESSION_OUTCOME_ENTRY = "session.outcome";
export interface SessionOutcome {
	exitCode: 0 | 1 | 130;
	summary: string;
}
