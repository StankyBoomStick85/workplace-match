"use client";

import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";

type CandidateProfile = {
  candidateEmail?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  profilePictureDataUrl?: string;
  fullName: string;
  zipCode: string;
  desiredJobType: string;
  workPreference: string;
  capabilitySummary: string;
  topSkills: string[];
  experienceLevel: string;
  educationLevel: string;
  updatedAt: string;
};

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-gray-200 ${className}`} />;
}

function ProfilePageSkeleton() {
  return (
    <section className="mx-auto max-w-3xl space-y-6 px-4 py-14">
      {/* Profile form card */}
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <SkeletonBlock className="h-3 w-14" />
        <SkeletonBlock className="mt-3 h-8 w-52" />
        <SkeletonBlock className="mt-3 h-4 w-full max-w-sm" />

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <SkeletonBlock className="h-3 w-16" />
            <SkeletonBlock className="h-10 w-full" />
          </div>
          <div className="space-y-2 md:col-span-2">
            <SkeletonBlock className="h-3 w-24" />
            <SkeletonBlock className="h-24 w-full" />
          </div>
          <div className="space-y-2">
            <SkeletonBlock className="h-3 w-24" />
            <SkeletonBlock className="h-10 w-full" />
          </div>
          <div className="space-y-2">
            <SkeletonBlock className="h-3 w-24" />
            <SkeletonBlock className="h-10 w-full" />
          </div>
          <div className="space-y-2">
            <SkeletonBlock className="h-3 w-24" />
            <SkeletonBlock className="h-10 w-full" />
          </div>
          <div className="space-y-2 md:col-span-2">
            <SkeletonBlock className="h-3 w-36" />
            <SkeletonBlock className="h-24 w-full" />
          </div>
          <div className="space-y-2">
            <SkeletonBlock className="h-3 w-20" />
            <SkeletonBlock className="h-10 w-full" />
          </div>
          <div className="space-y-2">
            <SkeletonBlock className="h-3 w-24" />
            <SkeletonBlock className="h-10 w-full" />
          </div>
          <div className="md:col-span-2">
            <SkeletonBlock className="h-10 w-36" />
          </div>
        </div>
      </div>

      {/* AI Capability card */}
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <SkeletonBlock className="h-3 w-20" />
        <SkeletonBlock className="mt-3 h-8 w-48" />
        <SkeletonBlock className="mt-3 h-4 w-full max-w-lg" />
        <SkeletonBlock className="mt-1 h-4 w-3/4 max-w-md" />
        <SkeletonBlock className="mt-5 h-10 w-56" />
        <SkeletonBlock className="mt-6 h-28 w-full" />
      </div>
    </section>
  );
}

function splitSkills(value: string) {
  return value
    .split(",")
    .map((skill) => skill.trim())
    .filter(Boolean);
}

function parseAccordionItems(text: string): Array<{ title: string; content: string }> {
  return text
    .split(/\n(?=\*\*)/)
    .flatMap((part) => {
      const match = part.match(/^\*\*(.+?)\*\*[:\s]*([\s\S]*)$/);
      if (!match) return [];
      const title = match[1].trim();
      const content = match[2].trim();
      return title && content ? [{ title, content }] : [];
    });
}

function AccordionItem({ title, content }: { title: string; content: string }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="rounded-md border border-gray-200">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-gray-50"
      >
        <span className="text-sm font-semibold text-zinc-900">{title}</span>
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
          <AccordionItem key={i} title={item.title} content={item.content} />
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

export function CandidateProfileForm() {
  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [profilePictureDataUrl, setProfilePictureDataUrl] = useState("");
  const [isReady, setIsReady] = useState(false);

  // AI-generated capability fields
  const [capabilityProfile, setCapabilityProfile] = useState("");
  const [recommendedPosition, setRecommendedPosition] = useState("");
  const [futurePositions, setFuturePositions] = useState("");
  const [employerSummary, setEmployerSummary] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");

  const [saveError, setSaveError] = useState("");
  const isEditing = Boolean(profile);

  useEffect(() => {
    loadProfile();

    async function loadProfile() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        window.location.href = "/candidate/login";
        return;
      }

      const userResponse = await fetch("/api/user/me");
      const userRecord = await userResponse.json();
      if (userRecord?.role !== "candidate") {
        window.location.href = "/candidate/login";
        return;
      }

      const { data } = await supabase
        .from("candidate_profiles")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      if (data) {
        setProfile({
          candidateEmail: user.email ?? "",
          fullName: data.display_name ?? "",
          zipCode: data.zip_code ?? "",
          desiredJobType: Array.isArray(data.job_types) ? data.job_types[0] ?? "" : "",
          workPreference: data.work_preference ?? "open",
          capabilitySummary: data.summary ?? "",
          topSkills: data.capability_tags ?? [],
          experienceLevel: data.experience_level ?? "",
          educationLevel: "",
          updatedAt: data.created_at ?? ""
        });
        setCapabilityProfile(data.capability_summary ?? "");
        setRecommendedPosition(data.recommended_position ?? "");
        setFuturePositions(data.future_positions ?? "");
        setEmployerSummary(data.employer_summary ?? "");
      }

      setIsReady(true);
    }
  }, []);

  function handleProfilePictureChange(file: File | null) {
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setProfilePictureDataUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveError("");

    const formData = new FormData(event.currentTarget);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      window.location.href = "/candidate/login";
      return;
    }

    const nextProfile: CandidateProfile = {
      candidateEmail: user.email ?? "",
      streetAddress: profile?.streetAddress ?? "",
      city: profile?.city ?? "",
      state: profile?.state ?? "",
      profilePictureDataUrl,
      fullName: String(formData.get("fullName") ?? "").trim(),
      zipCode: profile?.zipCode ?? "",
      desiredJobType: String(formData.get("desiredJobType") ?? "").trim(),
      workPreference: String(formData.get("workPreference") ?? "open"),
      capabilitySummary: String(formData.get("capabilitySummary") ?? "").trim(),
      topSkills: splitSkills(String(formData.get("topSkills") ?? "")),
      experienceLevel: String(formData.get("experienceLevel") ?? ""),
      educationLevel: String(formData.get("educationLevel") ?? ""),
      updatedAt: new Date().toISOString()
    };

    try {
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
            experienceLevel: nextProfile.experienceLevel
          }
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSaveError(result.error ?? "Unable to save profile. Please try again.");
        return;
      }
    } catch {
      setSaveError("An unexpected error occurred. Please try again.");
      return;
    }

    window.location.href = "/candidate/dashboard";
  }

  async function handleGenerate() {
    setIsGenerating(true);
    setGenerateError("");

    try {
      const response = await fetch("/api/candidate/generate-capability", { method: "POST" });
      const result = await response.json();

      if (!response.ok) {
        setGenerateError(result.error ?? "Generation failed. Please try again.");
        return;
      }

      setCapabilityProfile(result.capabilitySummary ?? "");
      setRecommendedPosition(result.recommendedPosition ?? "");
      setFuturePositions(result.futurePositions ?? "");
      setEmployerSummary(result.employerSummary ?? "");
    } catch {
      setGenerateError("An unexpected error occurred. Please try again.");
    } finally {
      setIsGenerating(false);
    }
  }

  if (!isReady) {
    return <ProfilePageSkeleton />;
  }

  const hasGeneratedContent = Boolean(capabilityProfile || recommendedPosition || futurePositions || employerSummary);

  return (
    <section className="mx-auto max-w-3xl space-y-6 px-4 py-14">
      {/* Profile form */}
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">
          Profile
        </p>
        <h1 className="mt-2 text-3xl font-bold text-zinc-950">
          {isEditing ? "Edit your profile" : "Create your profile"}
        </h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          Add the basic signals employers need to understand capability and fit.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <label htmlFor="fullName" className="label">
              Full name
            </label>
            <input
              id="fullName"
              name="fullName"
              required
              defaultValue={profile?.fullName ?? ""}
              className="field"
            />
          </div>

          <div className="space-y-3 md:col-span-2">
            <label htmlFor="profilePicture" className="label">
              Profile picture
            </label>
            <div className="flex flex-wrap items-center gap-4 rounded-md border border-gray-200 bg-gray-50 p-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-gray-200 bg-white text-2xl">
                {profilePictureDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={profilePictureDataUrl}
                    alt="Profile preview"
                    className="h-full w-full object-cover"
                  />
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
                    onClick={() => setProfilePictureDataUrl("")}
                    className="text-sm font-semibold text-zinc-600 transition hover:text-red-800"
                  >
                    Remove picture
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="desiredJobType" className="label">
              Desired job type
            </label>
            <input
              id="desiredJobType"
              name="desiredJobType"
              required
              placeholder="Operations, customer support, warehouse"
              defaultValue={profile?.desiredJobType ?? ""}
              className="field"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="workPreference" className="label">
              Work preference
            </label>
            <select
              id="workPreference"
              name="workPreference"
              required
              defaultValue={profile?.workPreference ?? "open"}
              className="field"
            >
              <option value="onsite">Onsite</option>
              <option value="hybrid">Hybrid</option>
              <option value="remote">Remote</option>
              <option value="open">Open</option>
            </select>
          </div>

          <div className="space-y-2">
            <label htmlFor="experienceLevel" className="label">
              Experience level
            </label>
            <select
              id="experienceLevel"
              name="experienceLevel"
              required
              defaultValue={profile?.experienceLevel ?? ""}
              className="field"
            >
              <option value="" disabled>
                Select level
              </option>
              <option>Entry level</option>
              <option>Some experience</option>
              <option>Experienced</option>
              <option>Lead or senior</option>
            </select>
          </div>

          <div className="space-y-2 md:col-span-2">
            <label htmlFor="capabilitySummary" className="label">
              Short capability summary
            </label>
            <textarea
              id="capabilitySummary"
              name="capabilitySummary"
              required
              rows={4}
              defaultValue={profile?.capabilitySummary ?? ""}
              className="field"
              placeholder="Briefly describe what you do well."
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="topSkills" className="label">
              Top skills
            </label>
            <input
              id="topSkills"
              name="topSkills"
              required
              defaultValue={profile?.topSkills.join(", ") ?? ""}
              className="field"
              placeholder="Scheduling, inventory, customer service"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="educationLevel" className="label">
              Education level
            </label>
            <select
              id="educationLevel"
              name="educationLevel"
              required
              defaultValue={profile?.educationLevel ?? ""}
              className="field"
            >
              <option value="" disabled>
                Select level
              </option>
              <option>High school or GED</option>
              <option>Some college</option>
              <option>Associate degree</option>
              <option>Bachelor's degree</option>
              <option>Trade or technical program</option>
              <option>Other</option>
            </select>
          </div>

          <div className="md:col-span-2 space-y-3">
            <button
              type="submit"
              className="inline-flex items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
            >
              {isEditing ? "Update profile" : "Save profile"}
            </button>
            {saveError && (
              <p className="text-sm text-red-700">{saveError}</p>
            )}
          </div>
        </form>
      </div>

      {/* AI Capability Profile */}
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">
          AI-Powered
        </p>
        <h2 className="mt-2 text-2xl font-bold text-zinc-950">Capability Profile</h2>
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
                <svg
                  className="h-4 w-4 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Generating…
              </>
            ) : (
              "Generate My Capability Profile"
            )}
          </button>
        </div>

        {generateError && (
          <p className="mt-3 text-sm text-red-700">{generateError}</p>
        )}

        <div className="mt-6">
          {hasGeneratedContent ? (
            <div className="space-y-6">
              {capabilityProfile && (
                <AccordionSection title="Capability Profile" text={capabilityProfile} />
              )}
              {recommendedPosition && (
                <RecommendedPositionCard content={recommendedPosition} />
              )}
              {futurePositions && (
                <AccordionSection title="Future Position Recommendations" text={futurePositions} />
              )}
              {employerSummary && (
                <GeneratedSection title="Employer-Facing Summary" content={employerSummary} />
              )}
            </div>
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
  );
}
