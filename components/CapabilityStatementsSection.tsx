"use client";

import { useState } from "react";

// Tier 1 capability statements on the candidate's OWN profile page (Phase 1).
// Statement as a heading, proof lines as bullets, niche skills in a collapsed
// list. No verification badges - how strong the evidence is lives in the proof
// wording itself. Renders nothing when there is nothing to show. Employer
// views do not use this component.

type ProofLine = { text: string };
type CoreStatement = { statement: string; proof: ProofLine[] };
type NicheCapability = { statement: string; applicability?: string[]; proof: ProofLine[] };

function asStatements<T extends { statement: string; proof: ProofLine[] }>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (s): s is T => !!s && typeof s.statement === "string" && s.statement.trim() !== "" && Array.isArray(s.proof)
  );
}

export function CapabilityStatementsSection({ statements, niche }: { statements: unknown; niche: unknown }) {
  const core = asStatements<CoreStatement>(statements);
  const specialized = asStatements<NicheCapability>(niche);
  const [nicheOpen, setNicheOpen] = useState(false);

  if (core.length === 0 && specialized.length === 0) return null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-zinc-900">Capability Statements</h3>
      <p className="mt-0.5 text-xs text-zinc-500">What you can do, and the numbers that back it up.</p>

      {core.length > 0 ? (
        <ol className="mt-3 space-y-4">
          {core.map((s, i) => (
            <li key={i} className="rounded-md border border-gray-200 bg-white p-4">
              <p className="font-semibold leading-6 text-zinc-900">{s.statement}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-zinc-700">
                {s.proof.map((p, j) => (
                  <li key={j}>{p.text}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      ) : null}

      {specialized.length > 0 ? (
        <div className="mt-4 rounded-md border border-gray-200">
          <button
            type="button"
            onClick={() => setNicheOpen((v) => !v)}
            aria-expanded={nicheOpen}
            className="flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-gray-50"
          >
            <span className="text-sm font-semibold text-zinc-900">
              Specialized skills <span className="font-normal text-zinc-500">({specialized.length})</span>
            </span>
            <svg
              className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform ${nicheOpen ? "rotate-180" : ""}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {nicheOpen ? (
            <ul className="space-y-4 border-t border-gray-200 px-4 py-4">
              {specialized.map((s, i) => (
                <li key={i}>
                  <p className="text-sm font-semibold leading-6 text-zinc-900">{s.statement}</p>
                  {s.applicability && s.applicability.length > 0 ? (
                    <p className="mt-1 flex flex-wrap gap-1.5">
                      {s.applicability.map((tag, j) => (
                        <span key={j} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-zinc-600">
                          {tag}
                        </span>
                      ))}
                    </p>
                  ) : null}
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-zinc-700">
                    {s.proof.map((p, j) => (
                      <li key={j}>{p.text}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
