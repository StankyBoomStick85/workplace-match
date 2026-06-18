"use client";

import { useState, useEffect, type FormEvent } from "react";
import { supabase } from "../lib/supabase";

const PROFILE_PICTURE_BUCKET = "profile-pictures";
const DOCUMENTS_BUCKET = "candidate-documents";
const MAX_DOC_BYTES = 5 * 1024 * 1024; // 5 MB

type DocumentMeta = {
  id: string;
  label: string;
  filename: string;
  path: string;
  contentType: string;
  uploadedAt: string;
  extractedText?: string;
  extractionStatus?: "pending" | "complete" | "failed";
};

type AlternatePath = {
  roleTitle: string;
  explanation: string;
  entryPoint: string;
  gap: string;
};

type ApplicantProfile = {
  candidateEmail?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  profilePictureDataUrl?: string;
  profilePictureUrl?: string;
  fullName: string;
  zipCode: string;
  desiredJobType: string;
  workPreference: string;
  capabilitySummary: string;
  topSkills: string[];
  experienceLevel: string;
  educationLevel: string;
  updatedAt: string;
  capabilityProfile?: string;
  recommendedPosition?: string;
  entryPoint?: string;
  futurePositions?: string;
  employerSummary?: string;
  summaryPriority?: string;
  isApproved?: boolean;
  correctionNotes?: string;
};

function splitSkills(value: string) {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

type AccordionEntry = { title: string; content: string; tag?: "VERIFIED" | "USER_PROVIDED" };

function parseAccordionItems(text: string): AccordionEntry[] {
  return text
    .split(/\n(?=\*\*)/)
    .flatMap((part) => {
      const match = part.match(/^\*\*(.+?)\*\*\s*(\[VERIFIED\]|\[USER_PROVIDED\])?\s*[:\s]*([\s\S]*)$/);
      if (!match) return [];
      const title = match[1].trim();
      const tagRaw = match[2] as string | undefined;
      const content = match[3].trim();
      const tag: AccordionEntry["tag"] = tagRaw === "[VERIFIED]" ? "VERIFIED" : tagRaw === "[USER_PROVIDED]" ? "USER_PROVIDED" : undefined;
      return title && content ? [{ title, content, tag }] : [];
    });
}

function AccordionItem({ title, content, tag }: { title: string; content: string; tag?: "VERIFIED" | "USER_PROVIDED" }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="rounded-md border border-gray-200">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-gray-50"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-zinc-900">{title}</span>
          {tag === "VERIFIED" && (
            <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800">Verified</span>
          )}
          {tag === "USER_PROVIDED" && (
            <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-zinc-600">Self-Reported</span>
          )}
        </span>
        <svg
          className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {isOpen && (
        <div className="border-t border-gray-200 px-4 py-3 text-sm leading-7 text-zinc-700 whitespace-pre-wrap">
          {content}
        </div>
      )}
    </div>
  );
}

function AccordionSection({ title, text }: { title: string; text: string }) {
  const items = parseAccordionItems(text);
  if (items.length === 0) {
    return (
      <div>
        <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
        <div className="mt-2 rounded-md border border-gray-200 bg-gray-50 p-4 text-sm leading-7 text-zinc-700 whitespace-pre-wrap">
          {text}
        </div>
      </div>
    );
  }
  return (
    <div>
      <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
      <div className="mt-2 space-y-1">
        {items.map((item, i) => (
          <AccordionItem key={i} title={item.title} content={item.content} tag={item.tag} />
        ))}
      </div>
    </div>
  );
}

function RecommendedPositionCard({ content }: { content: string }) {
  const match = content.match(/^\*\*(.+?)\*\*[:\s]*([\s\S]*)$/);
  const title = match ? match[1].trim() : "";
  const body = match ? match[2].trim() : content;
  return (
    <div>
      <h3 className="text-sm font-semibold text-zinc-900">Recommended Position</h3>
      <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-4">
        {title && <p className="font-bold text-red-900">{title}</p>}
        <p className={`text-sm leading-7 text-zinc-700 whitespace-pre-wrap${title ? " mt-2" : ""}`}>{body}</p>
      </div>
    </div>
  );
}

function EntryPointCard({ content }: { content: string }) {
  const match = content.match(/^\*\*(.+?)\*\*[:\s]*([\s\S]*)$/);
  const title = match ? match[1].trim() : "";
  const body = match ? match[2].trim() : content;
  return (
    <div>
      <h3 className="text-sm font-semibold text-zinc-900">Entry Point Role</h3>
      <p className="mt-0.5 text-xs text-zinc-500">Where to start</p>
      <div className="mt-2 rounded-md border border-blue-200 bg-blue-50 p-4">
        {title && <p className="font-bold text-blue-900">{title}</p>}
        <p className={`text-sm leading-7 text-zinc-700 whitespace-pre-wrap${title ? " mt-2" : ""}`}>{body}</p>
      </div>
    </div>
  );
}

function GeneratedSection({ title, content }: { title: string; content: string }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
      <div className="mt-2 rounded-md border border-gray-200 bg-gray-50 p-4 text-sm leading-7 text-zinc-700 whitespace-pre-wrap">
        {content}
      </div>
    </div>
  );
}

type ProfileRow = Record<string, unknown> | null;

type Props = {
  userEmail: string;
  initialProfile: ProfileRow;
};

function mapProfileRow(userEmail: string, row: NonNullable<ProfileRow>): ApplicantProfile {
  console.log("[mapProfileRow] AI fields from raw row:", {
    capability_summary: row.capability_summary,
    recommended_position: row.recommended_position,
    entry_point: row.entry_point,
    future_positions: row.future_positions,
    employer_summary: row.employer_summary,
  });
  return {
    candidateEmail: userEmail,
    profilePictureUrl: (row.profile_picture_url as string) ?? "",
    fullName: (row.display_name as string) ?? "",
    zipCode: (row.zip_code as string) ?? "",
    desiredJobType: Array.isArray(row.job_types) ? ((row.job_types[0] as string) ?? "") : "",
    workPreference: (row.work_preference as string) ?? "open",
    capabilitySummary: (row.summary as string) ?? "",
    topSkills: Array.isArray(row.capability_tags) ? (row.capability_tags as string[]) : [],
    experienceLevel: (row.experience_level as string) ?? "",
    educationLevel: (row.education_level as string) ?? "",
    updatedAt: (row.created_at as string) ?? "",
    capabilityProfile: (row.capability_summary as string) ?? "",
    recommendedPosition: (row.recommended_position as string) ?? "",
    entryPoint: (row.entry_point as string) ?? "",
    futurePositions: (row.future_positions as string) ?? "",
    employerSummary: (row.employer_summary as string) ?? "",
    summaryPriority: (row.summary_priority as string) ?? "",
    isApproved: (row.is_approved as boolean) ?? false,
    correctionNotes: (row.correction_notes as string) ?? "",
  };
}

export function ApplicantProfileForm({ userEmail, initialProfile }: Props) {
  const mappedInitial = initialProfile ? mapProfileRow(userEmail, initialProfile) : null;
  const [profile, setProfile] = useState<ApplicantProfile | null>(mappedInitial);
  const [isEditing, setIsEditing] = useState(false);
  const [profilePictureDataUrl, setProfilePictureDataUrl] = useState(mappedInitial?.profilePictureUrl ?? "");
  const [pendingPictureFile, setPendingPictureFile] = useState<File | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [funMessage, setFunMessage] = useState("Jitterbugging...");

  useEffect(() => {
    if (!isGenerating) {
      setFunMessage("Jitterbugging...");
      return;
    }
    const messages = [
      "Jitterbugging...",
      "Combobulating...",
      "Wrangling...",
      "Herding cats...",
      "Noodling on it...",
      "Percolating...",
      "Marinating...",
      "Untangling...",
      "Ruminating...",
      "Doing the thing...",
      "Crunching...",
      "Finagling...",
      "Discombobulating...",
      "Twiddling the knobs...",
      "Nearly there...",
    ];
    let idx = 0;
    const interval = setInterval(() => {
      idx = (idx + 1) % messages.length;
      setFunMessage(messages[idx]);
    }, 4000);
    return () => clearInterval(interval);
  }, [isGenerating]);
  const [generateError, setGenerateError] = useState("");
  const [activePathTab, setActivePathTab] = useState<"primary" | "alternate">(
    (mappedInitial?.summaryPriority as "primary" | "alternate") || "primary"
  );
  const [alternatePaths, setAlternatePaths] = useState<AlternatePath[] | null>(null);
  const [isGeneratingAlternate, setIsGeneratingAlternate] = useState(false);
  const [alternatePathsError, setAlternatePathsError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [isApproved, setIsApproved] = useState(mappedInitial?.isApproved ?? false);
  const [isApproving, setIsApproving] = useState(false);
  const [isCorrectionModalOpen, setIsCorrectionModalOpen] = useState(false);
  const [correctionMessage, setCorrectionMessage] = useState("");
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState("");

  const rawDocMeta = initialProfile
    ? (Array.isArray((initialProfile as Record<string, unknown>).document_metadata)
        ? ((initialProfile as Record<string, unknown>).document_metadata as DocumentMeta[])
        : [])
    : [];
  const [documentMeta, setDocumentMeta] = useState<DocumentMeta[]>(rawDocMeta);
  const [newDocLabel, setNewDocLabel] = useState("");
  const [newDocFile, setNewDocFile] = useState<File | null>(null);
  const [isUploadingDoc, setIsUploadingDoc] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [docError, setDocError] = useState("");

  function handleProfilePictureChange(file: File | null) {
    if (!file) return;
    setPendingPictureFile(file);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setProfilePictureDataUrl(reader.result);
    };
    reader.readAsDataURL(file);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Capture before any await — event.currentTarget becomes null after async gaps
    const form = event.currentTarget;
    setSaveError("");
    setSaveSuccess(false);
    setIsSaving(true);

    try {
      let savedPictureUrl = profile?.profilePictureUrl ?? "";

      if (pendingPictureFile) {
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
          console.error("[handleSubmit] getUser failed", userError);
          setSaveError("Session expired. Please sign in again.");
          return;
        }
        console.log("[handleSubmit] uploading to", PROFILE_PICTURE_BUCKET, `${user.id}/avatar`);
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from(PROFILE_PICTURE_BUCKET)
          .upload(`${user.id}/avatar`, pendingPictureFile, {
            upsert: true,
            contentType: pendingPictureFile.type,
          });
        if (uploadError) {
          console.error("[handleSubmit] storage upload failed", uploadError);
          setSaveError(`Picture upload failed: ${uploadError.message}`);
          return;
        }
        const { data: { publicUrl } } = supabase.storage
          .from(PROFILE_PICTURE_BUCKET)
          .getPublicUrl(uploadData.path);
        console.log("[handleSubmit] upload succeeded, publicUrl:", publicUrl);
        savedPictureUrl = publicUrl;
      } else if (!profilePictureDataUrl && profile?.profilePictureUrl) {
        savedPictureUrl = "";
      }

      const formData = new FormData(form);
      const nextProfile: ApplicantProfile = {
        candidateEmail: profile?.candidateEmail ?? "",
        streetAddress: profile?.streetAddress ?? "",
        city: profile?.city ?? "",
        state: profile?.state ?? "",
        profilePictureUrl: savedPictureUrl,
        fullName: String(formData.get("fullName") ?? "").trim(),
        zipCode: profile?.zipCode ?? "",
        desiredJobType: String(formData.get("desiredJobType") ?? "").trim(),
        workPreference: String(formData.get("workPreference") ?? "open"),
        capabilitySummary: String(formData.get("capabilitySummary") ?? "").trim(),
        topSkills: splitSkills(String(formData.get("topSkills") ?? "")),
        experienceLevel: String(formData.get("experienceLevel") ?? ""),
        educationLevel: String(formData.get("educationLevel") ?? ""),
        updatedAt: new Date().toISOString(),
        capabilityProfile: profile?.capabilityProfile ?? "",
        recommendedPosition: profile?.recommendedPosition ?? "",
        entryPoint: profile?.entryPoint ?? "",
        futurePositions: profile?.futurePositions ?? "",
        employerSummary: profile?.employerSummary ?? "",
        summaryPriority: profile?.summaryPriority ?? "",
      };

      const response = await fetch("/api/mvp/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resource: "candidate-profile",
          data: {
            fullName: nextProfile.fullName,
            zipCode: nextProfile.zipCode,
            jobType: nextProfile.desiredJobType,
            workSetting: nextProfile.workPreference,
            capabilitySummary: nextProfile.capabilitySummary,
            topSkills: nextProfile.topSkills,
            experienceLevel: nextProfile.experienceLevel,
            educationLevel: nextProfile.educationLevel,
            profilePictureUrl: savedPictureUrl,
          },
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.error("[handleSubmit] write route returned error", result);
        setSaveError(result.error ?? "Unable to save profile. Please try again.");
        return;
      }

      setPendingPictureFile(null);
      setProfilePictureDataUrl(savedPictureUrl);
      setProfile(nextProfile);
      setIsEditing(false);
      setSaveSuccess(true);
    } catch (err) {
      console.error("[handleSubmit] unexpected error", err);
      setSaveError("An unexpected error occurred. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleAddDocument() {
    if (!newDocLabel.trim()) { setDocError("Please enter a label for this document."); return; }
    if (!newDocFile) { setDocError("Please select a file to upload."); return; }
    if (newDocFile.size > MAX_DOC_BYTES) { setDocError("File must be 5 MB or smaller."); return; }

    const contentTypeForExtraction = newDocFile.type;
    setDocError("");
    setIsUploadingDoc(true);
    let pathForExtraction = "";

    try {
      const { data: { user }, error: userErr } = await supabase.auth.getUser();
      if (userErr || !user) { setDocError("Session expired. Please sign in again."); return; }

      const docId = crypto.randomUUID();
      const storagePath = `${user.id}/docs/${docId}`;
      const { error: uploadErr } = await supabase.storage
        .from(DOCUMENTS_BUCKET)
        .upload(storagePath, newDocFile, { contentType: newDocFile.type });
      if (uploadErr) {
        console.error("[handleAddDocument] upload failed", uploadErr);
        setDocError(`Upload failed: ${uploadErr.message}`);
        return;
      }

      const newMeta: DocumentMeta = {
        id: docId,
        label: newDocLabel.trim(),
        filename: newDocFile.name,
        path: storagePath,
        contentType: newDocFile.type,
        uploadedAt: new Date().toISOString(),
        extractionStatus: "pending",
        extractedText: "",
      };
      const updatedMeta = [...documentMeta, newMeta];

      const res = await fetch("/api/mvp/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "candidate-profile", data: { documentMetadata: updatedMeta } }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error("[handleAddDocument] write failed", body);
        setDocError(body.error ?? "Failed to save document record.");
        return;
      }

      setDocumentMeta(updatedMeta);
      setNewDocLabel("");
      setNewDocFile(null);
      const fileInput = document.getElementById("docFileInput") as HTMLInputElement | null;
      if (fileInput) fileInput.value = "";
      pathForExtraction = storagePath;

      // Trigger server-side text extraction
      fetch("/api/applicant/process-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: storagePath, docId }),
      }).catch((err) => console.error("[handleAddDocument] process-document trigger failed", err));
    } catch (err) {
      console.error("[handleAddDocument] unexpected error", err);
      setDocError("An unexpected error occurred.");
    } finally {
      setIsUploadingDoc(false);
    }

    if (!pathForExtraction) return;

    // Capability fields only — never touches name, zip, email, phone, or address
    setIsExtracting(true);
    try {
      const extractRes = await fetch("/api/applicant/extract-resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: pathForExtraction, contentType: contentTypeForExtraction }),
      });
      const extractResult = await extractRes.json().catch(() => ({}));
      if (extractRes.ok && extractResult.extracted) {
        const ex = extractResult.extracted as Record<string, string | null>;
        setProfile((prev) =>
          prev
            ? {
                ...prev,
                ...(ex.capabilitySummary ? { capabilitySummary: ex.capabilitySummary } : {}),
                ...(ex.topSkills ? { topSkills: splitSkills(ex.topSkills) } : {}),
                ...(ex.experienceLevel ? { experienceLevel: ex.experienceLevel } : {}),
                updatedAt: new Date().toISOString(),
              }
            : prev
        );
      }
    } catch (err) {
      console.error("[handleAddDocument] extraction failed, skipping pre-fill", err);
    } finally {
      setIsExtracting(false);
    }
  }

  async function handleDeleteDocument(doc: DocumentMeta) {
    setDocError("");
    try {
      const { error: removeErr } = await supabase.storage
        .from(DOCUMENTS_BUCKET)
        .remove([doc.path]);
      if (removeErr) console.error("[handleDeleteDocument] storage remove failed", removeErr);

      const updatedMeta = documentMeta.filter((d) => d.id !== doc.id);
      const res = await fetch("/api/mvp/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource: "candidate-profile", data: { documentMetadata: updatedMeta } }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error("[handleDeleteDocument] write failed", body);
        setDocError(body.error ?? "Failed to update document list.");
        return;
      }
      setDocumentMeta(updatedMeta);
    } catch (err) {
      console.error("[handleDeleteDocument] unexpected error", err);
      setDocError("An unexpected error occurred.");
    }
  }

  async function handleGenerate() {
    setIsGenerating(true);
    setGenerateError("");

    try {
      const response = await fetch("/api/applicant/generate-capability", { method: "POST" });
      const result = await response.json();

      if (!response.ok) {
        setGenerateError(result.error ?? "Generation failed. Please try again.");
        return;
      }

      setProfile((prev) => {
        const base = prev ?? ({
          candidateEmail: userEmail,
          profilePictureUrl: "",
          fullName: "",
          zipCode: "",
          desiredJobType: "",
          workPreference: "open",
          capabilitySummary: "",
          topSkills: [],
          experienceLevel: "",
          educationLevel: "",
          updatedAt: new Date().toISOString(),
          summaryPriority: "",
          isApproved: false,
          correctionNotes: "",
        } as ApplicantProfile);
        return {
          ...base,
          capabilityProfile: result.capabilitySummary ?? "",
          recommendedPosition: result.recommendedPosition ?? "",
          entryPoint: result.entryPoint ?? "",
          futurePositions: result.futurePositions ?? "",
          employerSummary: result.employerSummary ?? "",
          isApproved: false,
        };
      });
      setIsApproved(false);
    } catch {
      setGenerateError("An unexpected error occurred. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleShowAlternatePaths() {
    if (alternatePaths !== null) return;
    setIsGeneratingAlternate(true);
    setAlternatePathsError("");
    try {
      const res = await fetch("/api/applicant/generate-alternate-paths", { method: "POST" });
      const result = await res.json();
      if (!res.ok) {
        setAlternatePathsError(result.error ?? "Failed to generate alternate paths.");
        return;
      }
      setAlternatePaths(result.alternatePaths);
    } catch {
      setAlternatePathsError("An unexpected error occurred.");
    } finally {
      setIsGeneratingAlternate(false);
    }
  }

  async function handleSetPriority(priority: "primary" | "alternate") {
    setProfile((prev) => prev ? { ...prev, summaryPriority: priority } : prev);
    await fetch("/api/mvp/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: "candidate-profile", data: { summaryPriority: priority } }),
    });
  }

  async function handleApprove() {
    setIsApproving(true);
    await fetch("/api/mvp/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: "candidate-profile", data: { isApproved: true } }),
    });
    setIsApproved(true);
    setProfile((prev) => prev ? { ...prev, isApproved: true } : prev);
    setIsApproving(false);
  }

  async function handleRegenerate() {
    if (!correctionMessage.trim()) return;
    setIsRegenerating(true);
    setRegenerateError("");
    try {
      const res = await fetch("/api/applicant/correct-capability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ correctionMessage }),
      });
      const rawText = await res.text();
      console.log("[handleRegenerate] status:", res.status, "body:", rawText);
      if (!res.ok) {
        let message = "Regeneration failed.";
        try { message = JSON.parse(rawText)?.error ?? message; } catch { /* non-JSON body */ }
        setRegenerateError(message);
        return;
      }
      const result = JSON.parse(rawText);
      setProfile((prev) => prev ? {
        ...prev,
        capabilityProfile: result.capabilitySummary ?? "",
        recommendedPosition: result.recommendedPosition ?? "",
        entryPoint: result.entryPoint ?? "",
        futurePositions: result.futurePositions ?? "",
        employerSummary: result.employerSummary ?? "",
        isApproved: false,
      } : prev);
      setIsApproved(false);
      setIsCorrectionModalOpen(false);
      setCorrectionMessage("");
    } catch (err) {
      console.error("[handleRegenerate] threw:", err);
      setRegenerateError("An unexpected error occurred.");
    } finally {
      setIsRegenerating(false);
    }
  }

  useEffect(() => {
    if (!isCorrectionModalOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") { setIsCorrectionModalOpen(false); setCorrectionMessage(""); setRegenerateError(""); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isCorrectionModalOpen]);

  // Client-side fallback: if SSR didn't deliver AI-generated fields (initialProfile was null
  // or the server query failed silently), fetch fresh from the API on mount.
  useEffect(() => {
    const ssrHasAI = Boolean(
      mappedInitial?.capabilityProfile ||
      mappedInitial?.recommendedPosition ||
      mappedInitial?.entryPoint ||
      mappedInitial?.futurePositions ||
      mappedInitial?.employerSummary
    );
    if (ssrHasAI) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/mvp/read?resource=candidate-profile");
        if (!res.ok || cancelled) return;
        const { data } = await res.json();
        if (!data || cancelled) return;
        const mapped = mapProfileRow(userEmail, data);
        setProfile(mapped);
        setIsApproved(mapped.isApproved ?? false);
      } catch {
        // non-fatal: component falls back to whatever initialProfile provided
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const hasGeneratedContent = Boolean(
    profile?.capabilityProfile || profile?.recommendedPosition || profile?.entryPoint || profile?.futurePositions || profile?.employerSummary
  );

  return (
    <>
      {isEditing ? (
        <div className="fixed top-0 left-0 z-[1001] w-full flex items-center justify-end gap-2 border-b border-gray-200 bg-white/95 px-6 py-5 shadow-sm backdrop-blur-sm">
          <button
            type="button"
            onClick={() => { setIsEditing(false); setSaveError(""); }}
            disabled={isSaving}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-gray-50 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="applicant-profile-form"
            disabled={isSaving}
            className="inline-flex items-center gap-2 justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950 disabled:opacity-60"
          >
            {isSaving ? (
              <>
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Saving…
              </>
            ) : "Save"}
          </button>
        </div>
      ) : null}
      <section className={`mx-auto max-w-3xl space-y-6 px-4${isEditing ? " pt-20 pb-14" : " py-14"}`}>
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-zinc-950">{profile?.fullName || "Your profile"}</h1>
            <div className="mt-4">
              <ProfileAvatar src={profile?.profilePictureUrl} name={profile?.fullName ?? ""} size="lg" />
            </div>
          </div>
          <div className="flex gap-2">
            {!isEditing ? (
              <button
                type="button"
                onClick={() => { setIsEditing(true); setSaveSuccess(false); }}
                className="rounded-md border border-gray-300 bg-gray-50 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-white"
              >
                Edit
              </button>
            ) : null}
          </div>
        </div>

        {saveSuccess && !isEditing ? (
          <p className="mt-3 text-sm font-semibold text-green-700">Profile saved.</p>
        ) : null}

        {isEditing ? (
          <form
            id="applicant-profile-form"
            key={profile?.updatedAt ?? "new"}
            onSubmit={handleSubmit}
            className="mt-6 grid gap-4 md:grid-cols-2"
          >
            <div className="space-y-2 md:col-span-2">
              <label htmlFor="fullName" className="label">Full name</label>
              <input id="fullName" name="fullName" required defaultValue={profile?.fullName ?? ""} className="field" />
            </div>

            <div className="space-y-3 md:col-span-2">
              <label htmlFor="profilePicture" className="label">Profile picture</label>
              <div className="flex flex-wrap items-center gap-4 rounded-md border border-gray-200 bg-gray-50 p-4">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-gray-200 bg-white text-2xl">
                  {profilePictureDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={profilePictureDataUrl} alt="Profile preview" className="h-full w-full object-cover" />
                  ) : (
                    <span aria-hidden="true">🙂</span>
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <input
                    id="profilePicture"
                    type="file"
                    accept="image/*"
                    onChange={(event) => handleProfilePictureChange(event.target.files?.[0] ?? null)}
                    className="block w-full text-sm text-zinc-700 file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-semibold file:text-zinc-900 hover:file:bg-zinc-50"
                  />
                  {profilePictureDataUrl ? (
                    <button
                      type="button"
                      onClick={() => { setProfilePictureDataUrl(""); setPendingPictureFile(null); }}
                      className="text-sm font-semibold text-zinc-600 transition hover:text-red-800"
                    >
                      Remove picture
                    </button>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="desiredJobType" className="label">Desired job type</label>
              <input id="desiredJobType" name="desiredJobType" placeholder="Operations, customer support, warehouse" defaultValue={profile?.desiredJobType ?? ""} className="field" />
            </div>

            <div className="space-y-2">
              <label htmlFor="workPreference" className="label">Work preference</label>
              <select id="workPreference" name="workPreference" required defaultValue={profile?.workPreference ?? "open"} className="field">
                <option value="onsite">Onsite</option>
                <option value="hybrid">Hybrid</option>
                <option value="remote">Remote</option>
                <option value="open">Open</option>
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="experienceLevel" className="label">Experience level</label>
              <select id="experienceLevel" name="experienceLevel" defaultValue={profile?.experienceLevel ?? ""} className="field">
                <option value="">Select level</option>
                <option>Entry level</option>
                <option>Some experience</option>
                <option>Experienced</option>
                <option>Lead or senior</option>
              </select>
            </div>

            <div className="space-y-2 md:col-span-2">
              <label htmlFor="capabilitySummary" className="label">Short capability summary</label>
              <textarea id="capabilitySummary" name="capabilitySummary" required rows={4} defaultValue={profile?.capabilitySummary ?? ""} className="field" placeholder="Briefly describe what you do well." />
            </div>

            <div className="space-y-2">
              <label htmlFor="topSkills" className="label">Top skills</label>
              <input id="topSkills" name="topSkills" required defaultValue={profile?.topSkills.join(", ") ?? ""} className="field" placeholder="Scheduling, inventory, customer service" />
            </div>

            <div className="space-y-2">
              <label htmlFor="educationLevel" className="label">Education level</label>
              <select id="educationLevel" name="educationLevel" defaultValue={profile?.educationLevel ?? ""} className="field">
                <option value="">Select level</option>
                <option>High school or GED</option>
                <option>Some college</option>
                <option>Associate degree</option>
                <option>Bachelor's degree</option>
                <option>Master's degree</option>
                <option>Doctorate / PhD</option>
                <option>Trade or technical program</option>
                <option>Other</option>
              </select>
            </div>

            {saveError ? (
              <p className="md:col-span-2 text-sm text-red-700">{saveError}</p>
            ) : null}
          </form>
        ) : (
          <div className="mt-6">
            {profile ? (
              <dl className="grid gap-4 md:grid-cols-2">
                <ViewField label="Full name" value={profile.fullName} />
                <ViewField label="Desired job type" value={profile.desiredJobType} />
                <ViewField label="Work preference" value={profile.workPreference} />
                <ViewField label="Experience level" value={profile.experienceLevel} />
                <div className="space-y-1 md:col-span-2">
                  <dt className="label">Short capability summary</dt>
                  <dd className="text-sm leading-6 text-zinc-700 whitespace-pre-wrap">{profile.capabilitySummary || "—"}</dd>
                </div>
                <ViewField label="Top skills" value={profile.topSkills.join(", ")} />
                {profile.educationLevel ? <ViewField label="Education level" value={profile.educationLevel} /> : null}
              </dl>
            ) : (
              <p className="text-sm text-zinc-600">No profile information saved yet. Click Edit to get started.</p>
            )}
          </div>
        )}
      </div>

      {/* Upload Your Story — edit mode only */}
      {isEditing ? <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <h2 className="text-2xl font-bold text-zinc-950">Upload Your Story</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          Add resumes, transcripts, certifications, performance reviews, NCOERs, OERs, or awards. The AI Capability Engine reads these as primary source material to generate a more accurate profile. Accepted formats: PDF, JPG, PNG, DOC, DOCX (5 MB max each).
        </p>

        {/* Document list */}
        {documentMeta.length > 0 ? (
          <ul className="mt-5 divide-y divide-gray-100 rounded-md border border-gray-200">
            {documentMeta.map((doc) => (
              <li key={doc.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-zinc-900">{doc.label}</p>
                  <p className="truncate text-xs text-zinc-500">{doc.filename}</p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDeleteDocument(doc)}
                  className="shrink-0 text-xs font-semibold text-zinc-500 transition hover:text-red-700"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-5 text-sm text-zinc-500">No documents uploaded yet.</p>
        )}

        {/* Add document form */}
        <div className="mt-5 rounded-md border border-dashed border-gray-300 bg-gray-50 p-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Add a document</p>
          <div className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="docLabel" className="label">Document label</label>
              <input
                id="docLabel"
                type="text"
                placeholder="e.g. NCOER 2023, Resume, AWS Certification"
                value={newDocLabel}
                onChange={(e) => setNewDocLabel(e.target.value)}
                disabled={isUploadingDoc}
                className="field"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="docFileInput" className="label">File</label>
              <input
                id="docFileInput"
                type="file"
                accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                setNewDocFile(file);
                if (file && !newDocLabel.trim()) {
                  setNewDocLabel(file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "));
                }
              }}
                disabled={isUploadingDoc}
                className="block w-full text-sm text-zinc-700 file:mr-3 file:rounded-md file:border file:border-zinc-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-semibold file:text-zinc-900 hover:file:bg-zinc-50"
              />
            </div>
            {docError ? <p className="text-sm text-red-700">{docError}</p> : null}
            <button
              type="button"
              onClick={handleAddDocument}
              disabled={isUploadingDoc || isExtracting || !newDocLabel.trim() || !newDocFile}
              className="inline-flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-700 disabled:opacity-50"
            >
              {isUploadingDoc ? (
                <>
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Uploading…
                </>
              ) : "Upload Document"}
            </button>
            {isExtracting ? (
              <div className="flex items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
                <svg className="h-4 w-4 shrink-0 animate-spin text-amber-700" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <p className="text-sm font-semibold text-amber-800">Reading document and pre-filling capability fields…</p>
              </div>
            ) : null}
          </div>
        </div>
      </div> : null}

      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">AI-Powered</p>
        <h2 className="mt-2 text-2xl font-bold text-zinc-950">Verified Skills</h2>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          Generate a full capability translation of your background—including concrete operational skills, the best role to target now, future position recommendations, and a plain-language employer summary. Save your profile first, then generate.
        </p>

        <div className="mt-5">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={isGenerating}
            className="inline-flex items-center gap-2 rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950 disabled:opacity-60"
          >
            {isGenerating ? (
              <>
                 <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                   <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                   <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                 </svg>
                 {funMessage}
              </>
            ) : (
              "Generate My Capability Profile"
            )}
          </button>
        </div>

        {generateError ? <p className="mt-3 text-sm text-red-700">{generateError}</p> : null}

        <div className="mt-6">
          {hasGeneratedContent ? (
            <>
            <div className="space-y-6">
              {profile?.recommendedPosition ? <RecommendedPositionCard content={profile.recommendedPosition} /> : null}
              {profile?.entryPoint ? <EntryPointCard content={profile.entryPoint} /> : null}
              {profile?.futurePositions ? <AccordionSection title="Future Position Recommendations" text={profile.futurePositions} /> : null}
              {profile?.employerSummary ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="inline-flex rounded-md border border-gray-200 bg-gray-100 p-1">
                      <button
                        type="button"
                        onClick={() => setActivePathTab("primary")}
                        className={`rounded px-3 py-1.5 text-sm font-semibold transition ${activePathTab === "primary" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-700"}`}
                      >
                        Primary Path
                      </button>
                      <button
                        type="button"
                        onClick={() => { setActivePathTab("alternate"); handleShowAlternatePaths(); }}
                        className={`rounded px-3 py-1.5 text-sm font-semibold transition ${activePathTab === "alternate" ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-700"}`}
                      >
                        Alternate Paths
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleSetPriority(activePathTab)}
                      disabled={profile?.summaryPriority === activePathTab}
                      className={`text-xs font-semibold transition ${profile?.summaryPriority === activePathTab ? "cursor-default text-green-700" : "text-zinc-400 hover:text-zinc-700"}`}
                    >
                      {profile?.summaryPriority === activePathTab ? "Employer Priority" : "Set as Priority"}
                    </button>
                  </div>

                  {activePathTab === "primary" ? (
                    <GeneratedSection title="Employer-Facing Summary" content={profile.employerSummary} />
                  ) : (
                    <div>
                      {isGeneratingAlternate ? (
                        <div className="flex items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
                          <svg className="h-4 w-4 shrink-0 animate-spin text-amber-700" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          <p className="text-sm font-semibold text-amber-800">Finding alternate career paths…</p>
                        </div>
                      ) : alternatePathsError ? (
                        <p className="text-sm text-red-700">{alternatePathsError}</p>
                      ) : alternatePaths && alternatePaths.length > 0 ? (
                        <div className="space-y-4">
                          {alternatePaths.map((path, i) => (
                            <div key={i} className="rounded-md border border-gray-200 bg-gray-50 p-4">
                              <p className="font-semibold text-zinc-900">{path.roleTitle}</p>
                              <p className="mt-2 text-sm leading-6 text-zinc-700">{path.explanation}</p>
                              <p className="mt-3 text-xs text-zinc-500">
                                <span className="font-semibold">Entry point:</span> {path.entryPoint}
                              </p>
                              {path.gap ? (
                                <p className="mt-1 text-xs text-zinc-500">
                                  <span className="font-semibold">Gap to close:</span> {path.gap}
                                </p>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              ) : null}
              {profile?.capabilityProfile ? <AccordionSection title="Verified Skills" text={profile.capabilityProfile} /> : null}
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-gray-200 pt-5">
              {isApproved ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-sm font-semibold text-green-800">
                  <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  Approved — Visible to Employers
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleApprove}
                    disabled={isApproving}
                    className="inline-flex items-center gap-2 rounded-md bg-green-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-green-800 disabled:opacity-60"
                  >
                    {isApproving ? "Approving…" : "Approve"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsCorrectionModalOpen(true)}
                    className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-gray-50"
                  >
                    Edit / Correct
                  </button>
                  <p className="text-xs text-zinc-500">Approve to make this profile visible to employers.</p>
                </>
              )}
            </div>
            </>
          ) : (
            <div className="rounded-md border border-gray-200 bg-gray-50 p-6 text-center">
              <p className="text-sm font-semibold text-zinc-700">No capability profile generated yet.</p>
              <p className="mt-1 text-sm text-zinc-500">
                Save your profile above, then click &ldquo;Generate My Capability Profile&rdquo; to get your full capability translation, recommended position, future role roadmap, and employer-facing summary.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>

    {isCorrectionModalOpen ? (
      <div
        className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/50 p-4"
        onClick={() => { setIsCorrectionModalOpen(false); setCorrectionMessage(""); setRegenerateError(""); }}
      >
        <div
          className="w-full max-w-lg rounded-xl bg-white p-6 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-zinc-950">Correct Your Profile</h2>
            <button
              type="button"
              onClick={() => { setIsCorrectionModalOpen(false); setCorrectionMessage(""); setRegenerateError(""); }}
              className="rounded-md p-1 text-zinc-400 transition hover:text-zinc-700"
              aria-label="Close"
            >
              <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
          <p className="mt-2 text-sm text-zinc-600">
            Describe what the AI got wrong. It will regenerate the full profile with your correction applied.
          </p>
          <textarea
            className="mt-4 w-full rounded-md border border-gray-300 bg-white p-3 text-sm leading-6 text-zinc-900 shadow-sm outline-none focus:border-zinc-400 focus:ring-1 focus:ring-zinc-300"
            rows={5}
            placeholder="Tell the AI what to correct — wrong dates, incorrect certifications, missing info, etc."
            value={correctionMessage}
            onChange={(e) => setCorrectionMessage(e.target.value)}
            disabled={isRegenerating}
          />
          {regenerateError ? <p className="mt-2 text-sm text-red-700">{regenerateError}</p> : null}
          <div className="mt-4 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => { setIsCorrectionModalOpen(false); setCorrectionMessage(""); setRegenerateError(""); }}
              disabled={isRegenerating}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-gray-50 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleRegenerate}
              disabled={isRegenerating || !correctionMessage.trim()}
              className="inline-flex items-center gap-2 rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950 disabled:opacity-60"
            >
              {isRegenerating ? (
                <>
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Regenerating…
                </>
              ) : "Regenerate"}
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}

function ViewField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="label">{label}</dt>
      <dd className="text-sm text-zinc-900">{value || "—"}</dd>
    </div>
  );
}

function ProfileAvatar({ src, name, size }: { src?: string; name: string; size: "sm" | "lg" }) {
  const sizeClass = size === "lg" ? "h-28 w-28 text-4xl" : "h-7 w-7 text-sm";
  return (
    <div className={`${sizeClass} flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-gray-200 bg-gray-100`}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name} className="h-full w-full object-cover" />
      ) : (
        <span aria-hidden="true">🙂</span>
      )}
    </div>
  );
}
