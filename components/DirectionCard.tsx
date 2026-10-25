"use client";

import { useState } from "react";
import { OTHER_ROLE_FAMILY_ID, ROLE_FAMILIES } from "../lib/roleFamilies";
import {
  HOW_I_WANT_TO_WORK_MAX,
  MAX_ROLE_FAMILIES,
  MAX_TITLES,
  OTHER_FAMILY_MAX,
  TITLE_MAX,
  roleFamilyLabels,
  type CandidateDirection,
  type DirectionScope,
  type WorkSetting
} from "../lib/candidateDirection";

// "Where I'm heading" - the candidate's direction, at the top of their profile.
// Saved through /api/applicant/direction, which also starts a summary-only
// rebuild when it changed, so the employer summary's THRIVES IN / GROWING INTO
// follow it.

const WORK_SETTING_OPTIONS: Array<{ value: WorkSetting; label: string }> = [
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
  { value: "onsite", label: "Onsite" },
  { value: "open", label: "Open" }
];

type RebuildOutcome =
  | { status: "started" | "queued"; kind: string }
  | { status: "limited"; kind: string; limit: number }
  | { status: "skipped"; kind: string; reason: string }
  | null;

function savedMessage(changed: boolean, rebuild: RebuildOutcome): string {
  if (!changed || !rebuild) return "Saved.";
  switch (rebuild.status) {
    case "started":
      return "Saved. Your employer summary is being rewritten for your new direction and will update in a few minutes.";
    case "queued":
      return "Saved. Your profile is already being rebuilt; your employer summary will update for your new direction right after.";
    case "limited":
      return `Saved. You've reached today's limit of ${rebuild.limit} summary updates, so your employer summary will reflect this on the next rebuild.`;
    default:
      return "Saved. Your employer summary will reflect this once your capability profile finishes building.";
  }
}

function settingLabel(value: WorkSetting) {
  return WORK_SETTING_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

export function DirectionCard({ initialDirection }: { initialDirection: CandidateDirection | null }) {
  const [saved, setSaved] = useState<CandidateDirection | null>(initialDirection);
  const [isEditing, setIsEditing] = useState(false);
  const [families, setFamilies] = useState<string[]>(initialDirection?.roleFamilies ?? []);
  const [otherFamily, setOtherFamily] = useState(initialDirection?.otherFamily ?? "");
  const [scope, setScope] = useState<DirectionScope>(initialDirection?.scope ?? "open_related");
  const [titles, setTitles] = useState<string[]>(initialDirection?.titles?.length ? initialDirection.titles : [""]);
  const [workSetting, setWorkSetting] = useState<WorkSetting>(initialDirection?.workSetting ?? "open");
  const [howIWantToWork, setHowIWantToWork] = useState(initialDirection?.howIWantToWork ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  function resetDraft(from: CandidateDirection | null) {
    setFamilies(from?.roleFamilies ?? []);
    setOtherFamily(from?.otherFamily ?? "");
    setScope(from?.scope ?? "open_related");
    setTitles(from?.titles?.length ? from.titles : [""]);
    setWorkSetting(from?.workSetting ?? "open");
    setHowIWantToWork(from?.howIWantToWork ?? "");
  }

  function toggleFamily(id: string) {
    setError("");
    setFamilies((current) => {
      if (current.includes(id)) return current.filter((f) => f !== id);
      if (current.length >= MAX_ROLE_FAMILIES) {
        setError(`Choose up to ${MAX_ROLE_FAMILIES} role families.`);
        return current;
      }
      return [...current, id];
    });
  }

  async function save() {
    setIsSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/applicant/direction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          direction: {
            roleFamilies: families,
            otherFamily,
            scope,
            titles: scope === "only_these" ? titles.map((t) => t.trim()).filter(Boolean) : [],
            workSetting,
            howIWantToWork
          }
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(typeof result.error === "string" ? result.error : "Could not save. Please try again.");
        return;
      }
      setSaved(result.direction as CandidateDirection);
      resetDraft(result.direction as CandidateDirection);
      setIsEditing(false);
      setMessage(savedMessage(Boolean(result.changed), result.rebuild as RebuildOutcome));
    } catch (err) {
      console.error("[DirectionCard] save failed", err);
      setError("Could not save. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }

  const label = "text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500";

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-zinc-950">Where I&apos;m heading</h2>
          <p className="mt-1 text-sm text-zinc-600">The kinds of work you want next. Your employer summary is written around this.</p>
        </div>
        {!isEditing ? (
          <button
            type="button"
            onClick={() => { resetDraft(saved); setIsEditing(true); setMessage(""); setError(""); }}
            className="rounded-md border border-gray-300 bg-gray-50 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-white"
          >
            {saved ? "Edit" : "Set direction"}
          </button>
        ) : null}
      </div>

      {message && !isEditing ? <p className="mt-3 text-sm font-semibold text-green-700">{message}</p> : null}

      {!isEditing ? (
        saved ? (
          <dl className="mt-4 space-y-3">
            <div>
              <dt className={label}>Role families</dt>
              <dd className="mt-1 flex flex-wrap gap-1.5">
                {roleFamilyLabels(saved).map((family) => (
                  <span key={family} className="rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-semibold text-red-900">{family}</span>
                ))}
              </dd>
            </div>
            <div>
              <dt className={label}>Open to</dt>
              <dd className="mt-1 text-sm text-zinc-800">
                {saved.scope === "only_these" ? `Only these roles: ${(saved.titles ?? []).join(", ")}` : "Related roles in these families"}
              </dd>
            </div>
            <div>
              <dt className={label}>Work setting</dt>
              <dd className="mt-1 text-sm text-zinc-800">{settingLabel(saved.workSetting)}</dd>
            </div>
            {saved.howIWantToWork ? (
              <div>
                <dt className={label}>How I want to work</dt>
                <dd className="mt-1 text-sm text-zinc-800">{saved.howIWantToWork}</dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="mt-4 text-sm text-zinc-600">Not set yet. Choose the kinds of work you want so employers see you for where you&apos;re going.</p>
        )
      ) : (
        <div className="mt-5 space-y-5">
          <fieldset>
            <legend className="label">Role families <span className="font-normal text-zinc-500">(up to {MAX_ROLE_FAMILIES})</span></legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {[...ROLE_FAMILIES, { id: OTHER_ROLE_FAMILY_ID, label: "Other" }].map((family) => {
                const selected = families.includes(family.id);
                return (
                  <button
                    key={family.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => toggleFamily(family.id)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                      selected ? "border-red-900 bg-red-900 text-white" : "border-gray-300 bg-white text-zinc-700 hover:border-zinc-400"
                    }`}
                  >
                    {family.label}
                  </button>
                );
              })}
            </div>
            {families.includes(OTHER_ROLE_FAMILY_ID) ? (
              <input
                aria-label="Other role family"
                value={otherFamily}
                maxLength={OTHER_FAMILY_MAX}
                onChange={(event) => setOtherFamily(event.target.value)}
                placeholder="Describe the kind of work"
                className="field mt-3"
              />
            ) : null}
          </fieldset>

          <fieldset>
            <legend className="label">Open to</legend>
            <div className="mt-2 inline-flex rounded-md border border-gray-300 p-0.5">
              {([
                { value: "open_related", label: "Open to related roles" },
                { value: "only_these", label: "Only these roles" }
              ] as Array<{ value: DirectionScope; label: string }>).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={scope === option.value}
                  onClick={() => setScope(option.value)}
                  className={`rounded px-3 py-1.5 text-xs font-semibold transition ${scope === option.value ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-gray-50"}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {scope === "only_these" ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-zinc-600">Role titles (up to {MAX_TITLES}). These appear in your employer summary.</p>
                {titles.map((title, index) => (
                  <input
                    key={index}
                    aria-label={`Role title ${index + 1}`}
                    value={title}
                    maxLength={TITLE_MAX}
                    onChange={(event) => setTitles((current) => current.map((t, i) => (i === index ? event.target.value : t)))}
                    placeholder="e.g. Director of Operations"
                    className="field"
                  />
                ))}
                {titles.length < MAX_TITLES ? (
                  <button type="button" onClick={() => setTitles((current) => [...current, ""])} className="text-xs font-semibold text-red-800 hover:underline">
                    Add another title
                  </button>
                ) : null}
              </div>
            ) : null}
          </fieldset>

          <fieldset>
            <legend className="label">Work setting</legend>
            <div className="mt-2 inline-flex rounded-md border border-gray-300 p-0.5">
              {WORK_SETTING_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={workSetting === option.value}
                  onClick={() => setWorkSetting(option.value)}
                  className={`rounded px-3 py-1.5 text-xs font-semibold transition ${workSetting === option.value ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-gray-50"}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

          <div>
            <label htmlFor="howIWantToWork" className="label">How I want to work</label>
            <input
              id="howIWantToWork"
              value={howIWantToWork}
              maxLength={HOW_I_WANT_TO_WORK_MAX}
              onChange={(event) => setHowIWantToWork(event.target.value)}
              placeholder="e.g. Real responsibility, minimal oversight, built on relationships"
              className="field mt-2"
            />
            <p className="mt-1 text-right text-xs text-zinc-500">{howIWantToWork.length}/{HOW_I_WANT_TO_WORK_MAX}</p>
          </div>

          {error ? <p className="text-sm text-red-700">{error}</p> : null}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={isSaving}
              className="rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950 disabled:opacity-60"
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => { resetDraft(saved); setIsEditing(false); setError(""); }}
              disabled={isSaving}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
