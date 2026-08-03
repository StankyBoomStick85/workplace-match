"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";
import { AuthDivider, GoogleOAuthButton } from "./GoogleOAuthButton";
import { PasswordVisibilityField } from "./PasswordVisibilityField";

export function UnifiedLoginForm() {
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim().toLowerCase();

    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError || !data.user) {
      setError("No account found with that email and password.");
      return;
    }

    const response = await fetch("/api/user/me");
    const userRecord = await response.json();

    if (userRecord?.role === "candidate") {
      window.location.href = "/applicant/profile";
      return;
    }

    if (userRecord?.role === "employer") {
      window.location.href = "/employer/dashboard";
      return;
    }

    window.location.href = "/onboarding";
  }

  return (
    <section className="mx-auto max-w-md px-4 py-14">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">
          Account
        </p>
        <h1 className="mt-2 text-3xl font-bold text-zinc-950">Log in</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          Log in with your email and password.
        </p>

        <div className="mt-6 space-y-4">
          <GoogleOAuthButton />
          <AuthDivider />
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div className="space-y-2">
            <label htmlFor="email" className="label">
              Email
            </label>
            <input id="email" name="email" type="email" required className="field" />
          </div>
          <div className="space-y-2">
            <label htmlFor="password" className="label">
              Password
            </label>
            <PasswordVisibilityField
              id="password"
              name="password"
              value={password}
              isVisible={showPassword}
              onChange={setPassword}
              onToggle={() => setShowPassword((current) => !current)}
              required
            />
          </div>
          {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}
          <div className="text-right">
            <Link href="/account/forgot-password" className="text-sm font-semibold text-red-800">
              Forgot password?
            </Link>
          </div>
          <button
            type="submit"
            className="inline-flex w-full items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
          >
            Log in
          </button>
        </form>

        <div className="mt-6 border-t border-gray-200 pt-6">
          <h2 className="text-base font-bold text-zinc-950">First time here?</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-600">
            If your access request was approved, use the email address you submitted to create your account and set your password.
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/applicant/signup"
              className="inline-flex items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
            >
              Create your profile
            </Link>
            <Link
              href="/employer/signup"
              className="inline-flex items-center justify-center rounded-md border border-zinc-800 bg-white px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-50"
            >
              Create an employer account
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
