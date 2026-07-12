// Maps a source document to a civilian-friendly display label for the "Verified Skills"
// provenance UI. Phase 2 (generate-capability-finalize) only has each document's label and
// contentType available (sourceDocType is Step 1/Step 2 evidence-extraction metadata that
// isn't persisted past pending_evidence_groups), so matching is done primarily against the
// document's label text. sourceDocType is accepted too, for callers that do have it.
export type DocLabelInput = {
  label: string;
  sourceDocType?: string;
  contentType?: string;
};

function extractYear(text: string): string | null {
  const match = text.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : null;
}

export function getCivilianDocLabel(doc: DocLabelInput): string {
  const label = (doc.label ?? "").trim();
  const type = (doc.sourceDocType ?? "").toLowerCase();
  const haystack = `${label.toLowerCase()} ${type}`;
  const year = extractYear(label) ?? extractYear(type);

  const matches = (pattern: RegExp) => pattern.test(haystack);

  if (matches(/\bncoer\b/) || matches(/\boer\b/) || matches(/performance evaluation/)) {
    return year ? `Annual Performance Evaluation, ${year}` : "Annual Performance Evaluation";
  }

  if (matches(/\bdd\s?-?214\b/) || matches(/military service record/)) {
    return "Military Service Record";
  }

  if (matches(/certificat/)) {
    return year ? `${label}, Certified ${year}` : label;
  }

  if (matches(/transcript/)) {
    return "Academic Transcript";
  }

  if (matches(/diploma/)) {
    // Light-touch parse for labels like "Bachelor of Science - State University"
    // or "Associate Degree, Community College". Falls back to the raw label.
    const delimMatch = label.match(/^(.+?)\s*[-–,]\s*(.+)$/);
    if (delimMatch) {
      return `${delimMatch[1].trim()}, ${delimMatch[2].trim()}`;
    }
    return label || "Academic Credential";
  }

  if (matches(/award/) || matches(/commendation/) || matches(/\border\b/)) {
    return year ? `Official Commendation, ${year}` : "Official Commendation";
  }

  return label || "Supporting Document";
}
