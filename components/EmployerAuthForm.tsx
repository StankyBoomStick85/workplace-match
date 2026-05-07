"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { logAdminEvent } from "../lib/adminEvents";
import { supabase } from "../lib/supabase";
import { AuthDivider, GoogleOAuthButton } from "./GoogleOAuthButton";

type EmployerAuthFormProps = {
  mode: "login" | "signup";
};

export function EmployerAuthForm({ mode }: EmployerAuthFormProps) {
  const isSignup = mode === "signup";
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  function updatePassword(value: string) {
    setPassword(value);
    if (isSignup && error === "Passwords do not match." && value === confirmPassword) {
      setError("");
    }
  }

  function updateConfirmPassword(value: string) {
    setConfirmPassword(value);
    if (isSignup && error === "Passwords do not match." && password === value) {
      setError("");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim().toLowerCase();

    if (!email || !password || (isSignup && !confirmPassword)) {
      setError("Enter an email and password.");
      return;
    }

    if (isSignup) {
      if (password !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }

      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { role: "employer" } }
      });

      if (signUpError || !data.user) {
        setError(signUpError?.message ?? "Unable to create employer account.");
        return;
      }

      await supabase.from("users").upsert({
        id: data.user.id,
        email,
        role: "employer"
      });
      if (!data.session) {
        const { error: sessionError } = await supabase.auth.signInWithPassword({ email, password });
        if (sessionError) {
          setError("Account created. Log in to continue.");
          return;
        }
      }
      logAdminEvent({
        type: "signup_created",
        userRole: "employer",
        employerId: data.user.id,
        dedupeKey: `signup_created:employer:${data.user.id}`
      });
      await sendWelcomeEmail(email, "employer");
      window.location.href = "/employer/dashboard";
      return;
    }

    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError || !data.user) {
      setError("Email or password does not match.");
      return;
    }

    const response = await fetch("/api/user/me");
    const userRecord = await response.json();

    if (userRecord?.role === "candidate") {
      window.location.href = "/candidate/dashboard";
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
          Employer
        </p>
        <h1 className="mt-2 text-3xl font-bold text-zinc-950">
          {isSignup ? "Create employer account" : "Employer login"}
        </h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          {isSignup
            ? "Create a temporary MVP account to access your employer dashboard."
            : "Log in to continue to your employer dashboard."}
        </p>

        <div className="mt-6 space-y-4">
          <GoogleOAuthButton role="employer" />
          <AuthDivider />
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div className="space-y-2">
            <label htmlFor="email" className="label">
              Work email
            </label>
            <input id="email" name="email" type="email" required className="field" />
          </div>
          {isSignup ? (
            <>
              <PasswordField
                id="password"
                name="password"
                label="Password"
                value={password}
                isVisible={showPassword}
                onChange={updatePassword}
                onToggle={() => setShowPassword((current) => !current)}
              />
              <PasswordField
                id="confirmPassword"
                name="confirmPassword"
                label="Confirm Password"
                value={confirmPassword}
                isVisible={showPassword}
                onChange={updateConfirmPassword}
              />
            </>
          ) : (
            <PasswordField
              id="password"
              name="password"
              label="Password"
              value={password}
              isVisible={showPassword}
              onChange={setPassword}
              onToggle={() => setShowPassword((current) => !current)}
            />
          )}
          {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}
          {!isSignup ? (
            <div className="text-right">
              <Link href="/account/forgot-password" className="text-sm font-semibold text-red-800">
                Forgot password?
              </Link>
            </div>
          ) : null}
          <button
            type="submit"
            className="inline-flex w-full items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
          >
            {isSignup ? "Create account" : "Log in"}
          </button>
        </form>

        <p className="mt-5 text-sm text-zinc-600">
          {isSignup ? "Already have an account?" : "Need an account?"}{" "}
          <Link
            href={isSignup ? "/employer/login" : "/employer/signup"}
            className="font-semibold text-red-800"
          >
            {isSignup ? "Log in" : "Create one"}
          </Link>
        </p>
      </div>
    </section>
  );
}

async function sendWelcomeEmail(email: string, role: "candidate" | "employer") {
  try {
    await fetch("/api/email/welcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role })
    });
  } catch {
    // Account creation should not fail if transactional email is temporarily unavailable.
  }
}

type PasswordFieldProps = {
  id: string;
  name: string;
  label: string;
  value: string;
  isVisible: boolean;
  onChange: (value: string) => void;
  onToggle?: () => void;
};

function PasswordField({
  id,
  name,
  label,
  value,
  isVisible,
  onChange,
  onToggle
}: PasswordFieldProps) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={name}
          type={isVisible ? "text" : "password"}
          required
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`field ${onToggle ? "pr-11" : ""}`}
        />
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-label={isVisible ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-2 flex items-center px-2 text-zinc-500 transition hover:text-zinc-900"
          >
            {isVisible ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6A3 3 0 0 0 12 15a3 3 0 0 0 2.4-4.8" />
      <path d="M9.9 4.3A10.5 10.5 0 0 1 12 4.1c6.5 0 10 7.9 10 7.9a17.8 17.8 0 0 1-3.1 4.2" />
      <path d="M6.6 6.6A17.6 17.6 0 0 0 2 12s3.5 7.9 10 7.9a10.7 10.7 0 0 0 4.2-.9" />
    </svg>
  );
}
