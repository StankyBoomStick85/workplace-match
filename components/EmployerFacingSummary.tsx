"use client";

import { useEffect } from "react";
import { logError } from "../lib/logError";
import { scanEmployerFacingText, formatViolations } from "../lib/employerTextGuard";
import { EmployerSummaryContent } from "./EmployerSummaryContent";

// The single way an employer-facing view shows a candidate's capability: the
// employer summary, at every stage (browsing, pending interest, mutual match).
// It is identity-blind by design; this component re-checks it at render time
// anyway, because a stored row can predate a guard fix (fixing generation does
// not fix content already in the database). A flagged summary is never shown,
// and the violation is logged once per mount.
export function EmployerFacingSummary({
  candidateId,
  text,
  route,
  collapsible = true
}: {
  candidateId: string;
  text?: string | null;
  route: string;
  // false shows the summary fully expanded (e.g. an opened mutual match).
  collapsible?: boolean;
}) {
  const summary = text ?? "";
  const violations = summary ? scanEmployerFacingText(summary) : [];
  const isSafe = summary !== "" && violations.length === 0;

  useEffect(() => {
    if (!summary || violations.length === 0) return;
    console.error(`[${route}] employer_summary failed identity guard at render time`, { candidateId, violations });
    logError({
      route,
      errorMessage: `Stored employer_summary failed identity guard: ${formatViolations(violations)}`,
      errorType: "privacy_violation",
      severity: "high",
      userId: candidateId,
      metadata: { violations }
    });
    // violations is derived from summary; re-run only when the text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateId, summary, route]);

  return isSafe ? (
    <EmployerSummaryContent text={summary} collapsible={collapsible} />
  ) : (
    <p className="text-xs text-zinc-500">Capability summary unavailable - pending review.</p>
  );
}
