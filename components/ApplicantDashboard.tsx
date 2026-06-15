"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";
import {
  getAllJobs,
  getCurrentMvpUser,
  getMutualMatches,
  type MvpJobListing,
  type MvpMatch
} from "../lib/supabaseMvpData";

const DOCUMENTS_BUCKET = "candidate-documents";
const MAX_DOC_BYTES = 5 * 1024 * 1024;

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

type ApplicantProfileState = {
  fullName: string;
  zipCode: string;
  city: string;
  state: string;
  searchRadius: string;
  desiredPayMin: string;
  payType: string;
  jobType: string;
  shiftPreference: string;
  workSetting: string;
  capabilitySummary: string;
  topSkills: string;
  experienceLevel: string;
  educationLevel: string;
  industriesOfInterest: string;
  availableStartDate: string;
  willingToRelocate: string;
  phone: string;
};

const emptyProfile: ApplicantProfileState = {
  fullName: "",
  zipCode: "",
  city: "",
  state: "",
  searchRadius: "",
  desiredPayMin: "",
  payType: "hourly",
  jobType: "",
  shiftPreference: "",
  workSetting: "",
  capabilitySummary: "",
  topSkills: "",
  experienceLevel: "",
  educationLevel: "",
  industriesOfInterest: "",
  availableStartDate: "",
  willingToRelocate: "",
  phone: ""
};

export function ApplicantDashboard({ redirectOnSave }: { redirectOnSave?: string }) {
  const [profile, setProfile] = useState<ApplicantProfileState>(emptyProfile);
  const [draftProfile, setDraftProfile] = useState<ApplicantProfileState>(emptyProfile);
  const [matchedJobs, setMatchedJobs] = useState<Array<{ job: MvpJobListing; match: MvpMatch }>>([]);
  const [isReady, setIsReady] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const isEditingRef = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [driveTimeDisplay, setDriveTimeDisplay] = useState<string | null>(null);
  const [documentMeta, setDocumentMeta] = useState<DocumentMeta[]>([]);
  const [newDocLabel, setNewDocLabel] = useState("");
  const [newDocFile, setNewDocFile] = useState<File | null>(null);
  const [isUploadingDoc, setIsUploadingDoc] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [docError, setDocError] = useState("");

  useEffect(() => {
    loadProfile();

    async function loadProfile() {
      const user = await getCurrentMvpUser("candidate");
      if (!user) {
        window.location.href = "/applicant/login";
        return;
      }

      const [profileResponse, jobs, matches] = await Promise.all([
        fetch(`/api/mvp/read?resource=candidate-profile&userId=${encodeURIComponent(user.id)}`),
        getAllJobs(),
        getMutualMatches()
      ]);
      const { data } = await profileResponse.json();
      const nextProfile = mapProfileData(data);
      setProfile(nextProfile);
      if (!isEditingRef.current) {
        setDraftProfile(nextProfile);
      }
      if (Array.isArray(data?.document_metadata)) {
        setDocumentMeta(data.document_metadata as DocumentMeta[]);
      }
      setMatchedJobs(
        matches
          .filter((match) => match.candidateId === user.id)
          .map((match) => ({ match, job: jobs.find((job) => job.id === match.jobId) }))
          .filter((record): record is { job: MvpJobListing; match: MvpMatch } => Boolean(record.job))
      );
      setIsReady(true);
    }
  }, []);

  useEffect(() => {
    const zip = isEditing ? draftProfile.zipCode : profile.zipCode;
    const radius = isEditing ? draftProfile.searchRadius : profile.searchRadius;

    if (!zip || !radius || Number(radius) <= 0) {
      setDriveTimeDisplay(null);
      return;
    }

    const timer = setTimeout(async () => {
      const result = await fetchDriveTime(zip, Number(radius));
      setDriveTimeDisplay(result);
    }, 800);

    return () => clearTimeout(timer);
  }, [profile.zipCode, profile.searchRadius, draftProfile.zipCode, draftProfile.searchRadius, isEditing]);

  async function handleAddDocument() {
    if (!newDocLabel.trim()) { setDocError("Please enter a label for this document."); return; }
    if (!newDocFile) { setDocError("Please select a file to upload."); return; }
    if (newDocFile.size > MAX_DOC_BYTES) { setDocError("File must be 5 MB or smaller."); return; }

    setDocError("");
    setIsUploadingDoc(true);
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
      const fileInput = document.getElementById("onboardingDocFileInput") as HTMLInputElement | null;
      if (fileInput) fileInput.value = "";

      // Trigger server-side text extraction
      fetch("/api/applicant/process-document", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: storagePath, docId }),
      }).catch((err) => console.error("[handleAddDocument] process-document trigger failed", err));

      // Attempt AI extraction to pre-fill the profile form
      const uploadedContentType = newDocFile.type;
      setIsUploadingDoc(false);
      setIsExtracting(true);
      try {
        const extractRes = await fetch("/api/applicant/extract-resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: storagePath, contentType: uploadedContentType }),
        });
        const extractResult = await extractRes.json().catch(() => ({}));

        if (extractRes.ok && extractResult.extracted) {
          const ex = extractResult.extracted as Record<string, string | null>;
          const merged: Partial<ApplicantProfileState> = {};
          if (ex.fullName) merged.fullName = ex.fullName;
          if (ex.zipCode) merged.zipCode = ex.zipCode;
          if (ex.city) merged.city = ex.city;
          if (ex.state) merged.state = ex.state;
          if (ex.capabilitySummary) merged.capabilitySummary = ex.capabilitySummary;
          if (ex.topSkills) merged.topSkills = ex.topSkills;
          if (ex.experienceLevel) merged.experienceLevel = ex.experienceLevel;
          if (ex.educationLevel) merged.educationLevel = ex.educationLevel;
          if (ex.industriesOfInterest) merged.industriesOfInterest = ex.industriesOfInterest;
          if (ex.phoneNumber) merged.phone = ex.phoneNumber as string;

          const mergedProfile = { ...draftProfile, ...merged };
          setDraftProfile(mergedProfile);
          setMessage("");
          setError("");
          window.dispatchEvent(new CustomEvent("workplace-match-extraction-complete", {
            detail: { message: "Please verify your account information and profile details are correct" }
          }));
          await performSave(mergedProfile);
        }
      } catch (err) {
        console.error("[extract-resume] extraction failed, skipping pre-fill", err);
        // Upload already succeeded — extraction failure is non-blocking
      } finally {
        setIsExtracting(false);
      }
      return; // already cleared isUploadingDoc above
    } catch (err) {
      console.error("[handleAddDocument] unexpected error", err);
      setDocError("An unexpected error occurred.");
    } finally {
      setIsUploadingDoc(false);
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

  async function performSave(data: ApplicantProfileState) {
    const response = await fetch("/api/mvp/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: "candidate-profile",
        data: {
          ...data,
          topSkills: splitTags(data.topSkills)
        }
      })
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      setError(typeof payload.error === "string" ? payload.error : "Unable to save profile.");
      return;
    }

    if (redirectOnSave) {
      window.location.href = redirectOnSave;
      return;
    }

    setProfile(data);
    isEditingRef.current = false;
    setIsEditing(false);
    setMessage("Profile saved.");
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    await performSave(draftProfile);
  }

  function startEditing() {
    isEditingRef.current = true;
    setDraftProfile(profile);
    setMessage("");
    setError("");
    setIsEditing(true);
  }

  function updateDraft(field: keyof ApplicantProfileState, value: string) {
    setDraftProfile((current) => ({ ...current, [field]: value }));
  }

  if (!isReady) {
    return (
      <section className="mx-auto max-w-5xl px-4 py-12">
        <p className="text-sm text-zinc-600">Loading profile...</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <form onSubmit={saveProfile}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="mt-2 text-3xl font-bold text-zinc-950">Welcome</h1>
              <p className="mt-2 text-3xl font-bold text-zinc-950">{profile.fullName || "Applicant"}</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link href="/applicant/job-map" className="rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950">
                Job Map
              </Link>
              {isEditing ? (
                <button key="save" type="submit" className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-gray-50">
                  Save
                </button>
              ) : (
                <button key="edit" type="button" onClick={startEditing} className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-gray-50">
                  Edit Profile
                </button>
              )}
            </div>
          </div>

          {/* Upload Your Story */}
          <div className="mt-6 rounded-lg border-2 border-dashed border-red-200 bg-red-50 p-6">
            <h2 className="text-xl font-bold text-zinc-950">Upload your resume to pre-fill your profile</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-600">Drop one document and see jobs you qualify for instantly. The more you upload, the more accurate your matches become.</p>

            {documentMeta.length > 0 ? (
              <ul className="mt-4 divide-y divide-red-100 rounded-md border border-red-200 bg-white">
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
            ) : null}

            {isExtracting ? (
              <div className="mt-4 flex items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
                <svg className="h-4 w-4 shrink-0 animate-spin text-amber-700" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <p className="text-sm font-semibold text-amber-800">Reading your resume…</p>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <label htmlFor="onboardingDocLabel" className="label">Document label</label>
                    <input
                      id="onboardingDocLabel"
                      type="text"
                      placeholder="e.g. Resume, NCOER 2023, AWS Certification"
                      value={newDocLabel}
                      onChange={(e) => setNewDocLabel(e.target.value)}
                      disabled={isUploadingDoc}
                      className="field"
                    />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <label htmlFor="onboardingDocFileInput" className="label">File (PDF, DOC, DOCX, JPG, PNG — 5 MB max)</label>
                    <input
                      id="onboardingDocFileInput"
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
                </div>
                {docError ? <p className="text-sm text-red-700">{docError}</p> : null}
                <button
                  type="button"
                  onClick={handleAddDocument}
                  disabled={isUploadingDoc || !newDocLabel.trim() || !newDocFile}
                  className="inline-flex items-center gap-2 rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950 disabled:opacity-50"
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
              </div>
            )}
          </div>

          {message ? <p className="mt-4 text-sm font-semibold text-green-700">{message}</p> : null}
          {error ? <p className="mt-4 text-sm font-semibold text-red-700">{error}</p> : null}

          {isEditing ? (
            <div className="mt-6 space-y-5">
              <ProfileSection title="Personal Info">
                <ProfileField label="Full name" id="fullName">
                  <input id="fullName" value={draftProfile.fullName} onChange={(event) => updateDraft("fullName", event.target.value)} readOnly={!isEditing} className="field" />
                </ProfileField>
                <ProfileField label="ZIP code" id="zipCode">
                  <input id="zipCode" value={draftProfile.zipCode} onChange={(event) => updateDraft("zipCode", event.target.value)} readOnly={!isEditing} className="field" />
                </ProfileField>
                <ProfileField label="Search radius (drive time from your location)" id="searchRadius">
                  <input id="searchRadius" type="number" min="0" value={draftProfile.searchRadius} onChange={(event) => updateDraft("searchRadius", event.target.value)} readOnly={!isEditing} className="field" />
                  {driveTimeDisplay && (
                    <p className="text-xs text-zinc-500">{driveTimeDisplay}</p>
                  )}
                </ProfileField>
              </ProfileSection>

              <ProfileSection title="Work Preferences">
                <ProfileField label="Desired pay minimum" id="desiredPayMin">
                  <input id="desiredPayMin" type="number" min="0" value={draftProfile.desiredPayMin} onChange={(event) => updateDraft("desiredPayMin", event.target.value)} readOnly={!isEditing} className="field" />
                </ProfileField>
                <ProfileField label="Pay type" id="payType">
                  <select id="payType" value={draftProfile.payType} onChange={(event) => updateDraft("payType", event.target.value)} disabled={!isEditing} className="field">
                    <option value="hourly">Hourly</option>
                    <option value="salary">Salary</option>
                  </select>
                </ProfileField>
                <ProfileField label="Job type" id="jobType">
                  <select id="jobType" value={draftProfile.jobType} onChange={(event) => updateDraft("jobType", event.target.value)} disabled={!isEditing} className="field">
                    <option value="">Select type</option>
                    <option value="full-time">Full-time</option>
                    <option value="part-time">Part-time</option>
                    <option value="contract">Contract</option>
                    <option value="temporary">Temporary</option>
                  </select>
                </ProfileField>
                <ProfileField label="Shift preference" id="shiftPreference">
                  <select id="shiftPreference" value={draftProfile.shiftPreference} onChange={(event) => updateDraft("shiftPreference", event.target.value)} disabled={!isEditing} className="field">
                    <option value="">Select shift</option>
                    <option value="days">Days</option>
                    <option value="nights">Nights</option>
                    <option value="swing">Swing</option>
                    <option value="weekends">Weekends</option>
                    <option value="flexible">Flexible</option>
                  </select>
                </ProfileField>
                <ProfileField label="Work setting" id="workSetting">
                  <select id="workSetting" value={draftProfile.workSetting} onChange={(event) => updateDraft("workSetting", event.target.value)} disabled={!isEditing} className="field">
                    <option value="">Select setting</option>
                    <option value="on-site">On-site</option>
                    <option value="hybrid">Hybrid</option>
                    <option value="remote">Remote</option>
                  </select>
                </ProfileField>
              </ProfileSection>

              <ProfileSection title="Capability Profile">
                <ProfileField label="Capability summary" id="capabilitySummary" fullWidth>
                  <textarea id="capabilitySummary" rows={4} value={draftProfile.capabilitySummary} onChange={(event) => updateDraft("capabilitySummary", event.target.value)} readOnly={!isEditing} className="field" />
                </ProfileField>
                <ProfileField label="Top skills" id="topSkills">
                  <input id="topSkills" value={draftProfile.topSkills} onChange={(event) => updateDraft("topSkills", event.target.value)} readOnly={!isEditing} className="field" />
                </ProfileField>
                <ProfileField label="Experience level" id="experienceLevel">
                  <select id="experienceLevel" value={draftProfile.experienceLevel} onChange={(event) => updateDraft("experienceLevel", event.target.value)} disabled={!isEditing} className="field">
                    <option value="">Select level</option>
                    <option value="entry">Entry</option>
                    <option value="skilled">Skilled</option>
                    <option value="lead">Lead</option>
                    <option value="lower management">Lower management</option>
                    <option value="management">Management</option>
                  </select>
                </ProfileField>
                <ProfileField label="Industries of interest" id="industriesOfInterest">
                  <input id="industriesOfInterest" value={draftProfile.industriesOfInterest} onChange={(event) => updateDraft("industriesOfInterest", event.target.value)} readOnly={!isEditing} className="field" />
                </ProfileField>
              </ProfileSection>

              <ProfileSection title="Additional">
                <ProfileField label="Available start date" id="availableStartDate">
                  <input id="availableStartDate" type="date" value={draftProfile.availableStartDate} onChange={(event) => updateDraft("availableStartDate", event.target.value)} readOnly={!isEditing} className="field" />
                </ProfileField>
                <ProfileField label="Willing to relocate" id="willingToRelocate">
                  <select id="willingToRelocate" value={draftProfile.willingToRelocate} onChange={(event) => updateDraft("willingToRelocate", event.target.value)} disabled={!isEditing} className="field">
                    <option value="">Select option</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                    <option value="maybe">Maybe</option>
                  </select>
                </ProfileField>
              </ProfileSection>
            </div>
          ) : (
            <>
              <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-5">
                <h2 className="text-lg font-bold text-zinc-950">Capability Snapshot</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-700">{profile.capabilitySummary || "No capability summary saved yet."}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {splitTags(profile.topSkills).map((skill) => (
                    <span key={skill} className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-700">
                      {skill}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <DashboardCard label="Full name" value={profile.fullName || "Not set"} />
                <DashboardCard label="ZIP code" value={profile.zipCode || "Not set"} />
                <DashboardCard label="Search radius" value={profile.searchRadius ? (driveTimeDisplay ?? `${profile.searchRadius} miles`) : "Not set"} />
                <DashboardCard label="Desired pay" value={formatPay(profile.desiredPayMin, profile.payType)} />
                <DashboardCard label="Job type" value={profile.jobType || "Not set"} />
                <DashboardCard label="Shift preference" value={profile.shiftPreference || "Not set"} />
                <DashboardCard label="Work setting" value={profile.workSetting || "Not set"} />
                <DashboardCard label="Experience Level" value={profile.experienceLevel || "Not set"} />
                <DashboardCard label="Industries of interest" value={profile.industriesOfInterest || "Not set"} />
                <DashboardCard label="Available start date" value={profile.availableStartDate || "Not set"} />
                <DashboardCard label="Willing to relocate" value={profile.willingToRelocate || "Not set"} />
              </div>
            </>
          )}
        </form>

        {matchedJobs.length === 0 && !isEditing ? (
          <p className="mt-6 text-sm text-zinc-600">
            Nothing here yet. Start exploring the Job Map and click interest on roles that fit.
          </p>
        ) : null}

        {matchedJobs.length > 0 && !isEditing ? (
          <div className="mt-6 space-y-4">
            <h2 className="text-lg font-bold text-zinc-950">Matched jobs</h2>
            {matchedJobs.map(({ job, match }) => (
              <article key={`${job.id}-${match.candidateId}`} className="rounded-lg border border-gray-200 bg-white p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-bold text-zinc-950">{job.title}</h3>
                    <p className="mt-1 text-sm text-zinc-600">{[job.locationCity, job.locationState, job.locationZip].filter(Boolean).join(", ")}</p>
                  </div>
                  <span className="rounded-full bg-red-900 px-3 py-1 text-xs font-bold text-white">{match.matchPercent}%</span>
                </div>
                <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
                  <DashboardCard label="Pay range" value={job.payRange || "Not listed"} />
                  <DashboardCard label="Job type" value={job.jobType || "Not listed"} />
                  <DashboardCard label="Schedule" value={job.schedule || "Not listed"} />
                </div>
                <p className="mt-4 text-sm leading-6 text-zinc-700">{job.description}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" className="rounded-md bg-green-700 px-3 py-2 text-sm font-semibold text-white">Reach Out</button>
                  <button type="button" className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700">Message</button>
                  <button type="button" className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700">Schedule Conversation</button>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

async function fetchDriveTime(zipCode: string, radiusMiles: number): Promise<string | null> {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  try {
    const geocodeRes = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(zipCode)}&key=${encodeURIComponent(apiKey)}`
    );
    const geocodeData = await geocodeRes.json();
    if (geocodeData.status !== "OK" || !geocodeData.results?.[0]) return null;

    const { lat, lng } = geocodeData.results[0].geometry.location as { lat: number; lng: number };
    const destLat = lat + radiusMiles / 69.0;

    const matrixRes = await fetch(
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${lat},${lng}&destinations=${destLat},${lng}&mode=driving&key=${encodeURIComponent(apiKey)}`
    );
    const matrixData = await matrixRes.json();
    if (matrixData.status !== "OK") return null;

    const element = matrixData.rows?.[0]?.elements?.[0] as { status: string; duration: { value: number }; distance: { value: number } } | undefined;
    if (!element || element.status !== "OK") return null;

    const durationMin = Math.round(element.duration.value / 60);
    const distanceMiles = Math.round(element.distance.value / 1609.34);

    return `~${durationMin} min drive (${distanceMiles} miles)`;
  } catch {
    return null;
  }
}

function mapProfileData(data: any): ApplicantProfileState {
  const extras = parseProfileExtras(data?.visibility);

  return {
    fullName: data?.display_name ?? "",
    zipCode: data?.zip_code ?? "",
    city: data?.city ?? "",
    state: data?.state ?? "",
    searchRadius: data?.search_radius ? String(data.search_radius) : "",
    desiredPayMin: data?.desired_pay_min ? String(data.desired_pay_min) : "",
    payType: data?.pay_type || "hourly",
    jobType: Array.isArray(data?.job_types) ? data.job_types[0] ?? "" : "",
    shiftPreference: Array.isArray(data?.shifts) ? data.shifts[0] ?? "" : "",
    workSetting: data?.work_preference ?? "",
    capabilitySummary: data?.summary ?? "",
    topSkills: Array.isArray(data?.capability_tags) ? data.capability_tags.join(", ") : "",
    experienceLevel: data?.experience_level ?? "",
    educationLevel: data?.education_level ?? "",
    industriesOfInterest: extras.industriesOfInterest,
    availableStartDate: extras.availableStartDate,
    willingToRelocate: extras.willingToRelocate,
    phone: data?.phone ?? ""
  };
}

function parseProfileExtras(value?: string) {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return {
      industriesOfInterest: typeof parsed.industriesOfInterest === "string" ? parsed.industriesOfInterest : "",
      availableStartDate: typeof parsed.availableStartDate === "string" ? parsed.availableStartDate : "",
      willingToRelocate: typeof parsed.willingToRelocate === "string" ? parsed.willingToRelocate : ""
    };
  } catch {
    return {
      industriesOfInterest: "",
      availableStartDate: "",
      willingToRelocate: ""
    };
  }
}

function splitTags(value: string) {
  return value.split(",").map((skill) => skill.trim()).filter(Boolean);
}

function formatPay(value: string, payType: string) {
  if (!value) return "Not set";
  return payType === "salary" ? `$${value}/year` : `$${value}/hr`;
}

function ProfileSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-5">
      <h2 className="text-lg font-bold text-zinc-950">{title}</h2>
      <div className="mt-4 grid gap-4 md:grid-cols-2">{children}</div>
    </div>
  );
}

function ProfileField({
  label,
  id,
  fullWidth = false,
  children
}: {
  label: string;
  id: string;
  fullWidth?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-2 ${fullWidth ? "md:col-span-2" : ""}`}>
      <label htmlFor={id} className="label">
        {label}
      </label>
      {children}
    </div>
  );
}

function DashboardCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</p>
      <p className="mt-1 font-semibold text-zinc-950">{value}</p>
    </div>
  );
}
