"use client";

import { useState } from "react";
import { parseEmployerSummary } from "../lib/capabilityPipeline";

// Renders an employer_summary value. buildEmployerSummaryUserPrompt now asks
// for a structured "## BEST_FIT / ## STRENGTHS / ## GROWTH / ## GAP" format
// instead of a 200-300 word paragraph - this renders that structure as a
// scannable headline + bullet list, and falls back to a plain paragraph for
// any row generated before this change (parseEmployerSummary returns null for
// those - they have no "## BEST_FIT" heading at all). Existing rows are not
// migrated, so both shapes have to keep rendering correctly indefinitely
// unless a bulk regeneration happens later.
//
// collapsible: true is for a list of candidates an employer is scanning (the
// headline/fit sentence stays visible, strengths/growth/gap are behind a
// toggle). false is for a candidate reviewing their own generated profile -
// there's only one summary on that page, so there's nothing to keep short.
export function EmployerSummaryContent({ text, collapsible = true }: { text: string; collapsible?: boolean }) {
  const [isExpanded, setIsExpanded] = useState(!collapsible);
  const parsed = parseEmployerSummary(text);

  if (!parsed) {
    // Legacy paragraph - no section structure to collapse into, just clamp
    // the raw text the same way any other long block does.
    return (
      <div>
        <p className={`text-sm leading-6 text-zinc-700 whitespace-pre-wrap ${isExpanded ? "" : "line-clamp-2"}`}>
          {text}
        </p>
        {collapsible ? (
          <button
            type="button"
            onClick={() => setIsExpanded((current) => !current)}
            className="mt-1 text-xs font-semibold text-red-800 transition hover:underline"
          >
            {isExpanded ? "Show less" : "Show more"}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm font-semibold text-zinc-900">{parsed.bestFit}</p>
      {isExpanded ? (
        <div className="mt-2 space-y-2">
          <ul className="list-disc space-y-1 pl-4 text-sm leading-5 text-zinc-700">
            {parsed.strengths.map((strength, index) => (
              <li key={index}>{strength}</li>
            ))}
          </ul>
          <p className="text-sm leading-6 text-zinc-700">
            <span className="font-semibold text-zinc-900">Growth potential: </span>
            {parsed.growth}
          </p>
          {parsed.gap ? (
            <p className="text-sm leading-6 text-zinc-700">
              <span className="font-semibold text-zinc-900">Gap to close: </span>
              {parsed.gap}
            </p>
          ) : null}
        </div>
      ) : null}
      {collapsible ? (
        <button
          type="button"
          onClick={() => setIsExpanded((current) => !current)}
          className="mt-2 text-xs font-semibold text-red-800 transition hover:underline"
        >
          {isExpanded ? "Show less" : "Show full capability summary"}
        </button>
      ) : null}
    </div>
  );
}
