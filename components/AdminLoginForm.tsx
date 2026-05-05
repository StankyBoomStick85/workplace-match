"use client";

import { useState, type FormEvent } from "react";
import { adminSessionKey } from "../lib/adminAuth";

const adminEmail = "admin@workplacematch.local";
const adminPassword = "workplace-admin";

export function AdminLoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const emailMatches = email.trim().toLowerCase() === adminEmail;
    const passwordMatches = password === adminPassword;

    if (!emailMatches || !passwordMatches) {
      setError("Invalid admin credentials");
      return;
    }

    localStorage.setItem(adminSessionKey, "true");
    window.location.href = "/admin/dashboard";
  }

  return (
    <section className="mx-auto max-w-md px-4 py-14">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <p className="text-sm font-bold uppercase tracking-[0.16em] text-red-800">Admin</p>
        <h1 className="mt-2 text-3xl font-bold text-zinc-950">Admin login</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          Sign in with the local MVP admin account to review beta testing data.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div className="space-y-2">
            <label htmlFor="adminEmail" className="label">
              Email
            </label>
            <input
              id="adminEmail"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              className="field"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="adminPassword" className="label">
              Password
            </label>
            <input
              id="adminPassword"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              className="field"
            />
          </div>
          {error ? <p className="text-sm font-semibold text-red-700">{error}</p> : null}
          <button
            type="submit"
            className="inline-flex w-full items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
          >
            Log in
          </button>
        </form>
      </div>
    </section>
  );
}
