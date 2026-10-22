"use client";

import { useState } from "react";
import { parseEmployerSummary } from "../lib/capabilityPipeline";

// Renders an employer_summary value - the only capability content an
// employer sees. Three stored shapes keep rendering:
//   v2 (current): HEADLINE / PROVEN_AT / THRIVES_IN / GROWING_INTO / GAP -
//      headline prominent, small section labels, bold lead phrases, built to
//      scan in about ten seconds.
//   v1: BEST_FIT / STRENGTHS / GROWTH / GAP (2026-09 to 2026-10).
//   legacy: a plain paragraph (parseEmployerSummary returns null).
// Existing rows are not migrated; they change shape when regenerated.
//
// collapsible: true is for a list of candidates an employer is scanning (the
// headline and THRIVES IN stay visible, the rest is behind a toggle). false is
// for a single summary on its own (the candidate's own profile page).
export function EmployerSummaryContent({ text, collapsible = true }: { text: string; collapsible?: boolean }) {
  const [isExpanded, setIsExpanded] = useState(!collapsible);
  const parsed = parseEmployerSummary(text);

  const toggle = (label: string) =>
    collapsible ? (
      <button
        type="button"
        onClick={() => setIsExpanded((current) => !current)}
        className="mt-2 text-xs font-semibold text-red-800 transition hover:underline"
      >
        {isExpanded ? "Show less" : label}
      </button>
    ) : null;

  if (!parsed) {
    return (
      <div>
        <p className={`text-sm leading-6 text-zinc-700 whitespace-pre-wrap ${isExpanded ? "" : "line-clamp-2"}`}>{text}</p>
        {toggle("Show more")}
      </div>
    );
  }

  if (parsed.format === "v1") {
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
        {toggle("Show full capability summary")}
      </div>
    );
  }

  const label = "text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500";
  return (
    <div>
      <p className="text-base font-semibold leading-snug text-zinc-950">{parsed.headline}</p>
      <div className="mt-2">
        <p className={label}>Thrives in</p>
        <p className="text-sm leading-6 text-zinc-800">{parsed.thrivesIn}</p>
      </div>
      {isExpanded ? (
        <div className="mt-2 space-y-2">
          <div>
            <p className={label}>Proven at</p>
            <ul className="mt-0.5 space-y-1 text-sm leading-5 text-zinc-700">
              {parsed.provenAt.map((item, index) => (
                <li key={index} className="flex gap-1.5">
                  <span aria-hidden="true" className="text-zinc-400">&bull;</span>
                  <span>
                    {item.lead ? <span className="font-semibold text-zinc-950">{item.lead}</span> : null}
                    {item.lead ? " " : null}
                    {item.proof}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {parsed.growingInto ? (
            <div>
              <p className={label}>Growing into</p>
              <p className="text-sm leading-6 text-zinc-800">{parsed.growingInto}</p>
            </div>
          ) : null}
          {parsed.gap ? (
            <div>
              <p className={label}>Gap</p>
              <p className="text-sm leading-6 text-zinc-800">{parsed.gap}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {toggle("Show full summary")}
    </div>
  );
}
