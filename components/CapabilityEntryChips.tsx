"use client";

import { isCapabilityEntriesSafe } from "../lib/employerTextGuard";
import type { CapabilityEntry } from "../lib/capabilityPipeline";

// The employer-facing replacement for showing raw capability_tags ("topSkills")
// chips directly. Provenance: capability_tags is EVIDENCE - a free-text input
// the candidate types on their own profile form, never scanned, never meant to
// reach an employer unprocessed. capability_entries is what the AI actually
// derived from that evidence (plus any uploaded documents), and it is the
// PUBLIC-layer artifact this platform is supposed to show - each entry already
// carries a verification confidence tag (VERIFIED = backed by an uploaded
// document, USER_PROVIDED = self-reported) rather than a visibility gate, per
// the provenance rule this shipped with. Both count fully toward capability;
// the tag is shown, not hidden, because the distinction is the product.
//
// Whole-block gate via isCapabilityEntriesSafe, not per-entry filtering -
// matches that function's own contract (see employerTextGuard.ts): one
// disqualifying entry makes the whole set unsafe to show, not just that entry.
export function CapabilityEntryChips({ entries }: { entries?: CapabilityEntry[] }) {
  if (!entries || entries.length === 0 || !isCapabilityEntriesSafe(entries)) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map((entry) => {
        const isVerified = entry.verificationStatus === "VERIFIED";
        return (
          <span
            key={entry.name}
            title={isVerified ? "Backed by an uploaded document" : "Self-reported by the candidate"}
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
              isVerified ? "bg-red-900 text-white" : "bg-red-100 text-red-800"
            }`}
          >
            {isVerified ? (
              <>
                <span aria-hidden="true">&#10003; </span>
                <span className="sr-only">Verified: </span>
              </>
            ) : null}
            {entry.name}
          </span>
        );
      })}
    </div>
  );
}
