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

function splitSkills(value: string) {
  return value
    .split(",")
    .map((skill) => skill.trim())
    .filter(Boolean);
}

export function CandidateProfileForm() {
  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [profilePictureDataUrl, setProfilePictureDataUrl] = useState("");
  const [isReady, setIsReady] = useState(false);
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

      const profileResponse = await fetch(`/api/mvp/read?resource=candidate-profile&userId=${encodeURIComponent(user.id)}`);
      const { data } = await profileResponse.json();
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

    await supabase.from("candidate_profiles").upsert(
      {
        user_id: user.id,
        display_name: nextProfile.fullName,
        zip_code: nextProfile.zipCode,
        job_types: nextProfile.desiredJobType ? [nextProfile.desiredJobType] : [],
        work_preference: nextProfile.workPreference,
        capability_tags: nextProfile.topSkills,
        experience_level: nextProfile.experienceLevel,
        summary: nextProfile.capabilitySummary,
        visibility: "private"
      },
      { onConflict: "user_id" }
    );

    window.location.href = "/candidate/dashboard";
  }

  if (!isReady) {
    return (
      <section className="mx-auto max-w-3xl px-4 py-14">
        <p className="text-sm text-zinc-600">Loading profile...</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-3xl px-4 py-14">
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

          <div className="md:col-span-2">
            <button
              type="submit"
              className="inline-flex items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
            >
              {isEditing ? "Update profile" : "Save profile"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
