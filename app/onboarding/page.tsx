"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type OnboardingRole = "candidate" | "employer";

export default function OnboardingPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [isSaving, setIsSaving] = useState<OnboardingRole | null>(null);

  async function chooseRole(role: OnboardingRole) {
    setError("");
    setIsSaving(role);

    const saveResponse = await fetch("/api/user/set-role", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role })
    });

    if (!saveResponse.ok) {
      setError("Unable to save your account type. Please try again.");
      setIsSaving(null);
      return;
    }

    router.push(role === "candidate" ? "/applicant/onboarding" : "/employer/dashboard");
  }

  return (
    <section className="mx-auto flex min-h-[520px] max-w-3xl items-center px-4 py-14">
      <div className="w-full rounded-lg border border-gray-200 bg-white p-6 text-center shadow-soft">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">
          Workplace Match
        </p>
        <h1 className="mt-2 text-3xl font-bold text-zinc-950">
          What brings you to Workplace Match?
        </h1>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => chooseRole("candidate")}
            disabled={isSaving !== null}
            className="inline-flex items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isSaving === "candidate" ? "Saving..." : "I'm looking for work"}
          </button>
          <button
            type="button"
            onClick={() => chooseRole("employer")}
            disabled={isSaving !== null}
            className="inline-flex items-center justify-center rounded-md border border-zinc-800 bg-white px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isSaving === "employer" ? "Saving..." : "I'm hiring"}
          </button>
        </div>
        {error ? <p className="mt-5 text-sm font-medium text-red-700">{error}</p> : null}
      </div>
    </section>
  );
}
