"use client";

import { useState } from "react";

export function RequestAccessForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");

  async function handleSubmit() {
    if (!name.trim() || !email.trim() || !message.trim()) return;
    setStatus("sending");
    try {
      const res = await fetch("/api/request-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, message })
      });
      if (res.ok) {
        setStatus("success");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div className="mt-6 rounded-md border border-green-200 bg-green-50 p-4 text-sm font-semibold text-green-800">
        Thanks — your request has been submitted. We&apos;ll be in touch with an access code if approved.
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-3">
      <div>
        <label htmlFor="request-name" className="label">Name</label>
        <input
          id="request-name"
          type="text"
          value={name}
          onChange={(e) => { setName(e.target.value); if (status !== "idle") setStatus("idle"); }}
          className="field"
        />
      </div>
      <div>
        <label htmlFor="request-email" className="label">Email</label>
        <input
          id="request-email"
          type="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); if (status !== "idle") setStatus("idle"); }}
          className="field"
        />
      </div>
      <div>
        <label htmlFor="request-message" className="label">Message</label>
        <textarea
          id="request-message"
          value={message}
          onChange={(e) => { setMessage(e.target.value); if (status !== "idle") setStatus("idle"); }}
          placeholder="Tell us who you are, what you're trying to do, or who referred you"
          rows={5}
          className="field resize-none"
        />
      </div>
      <button
        type="button"
        onClick={handleSubmit}
        disabled={status === "sending" || !name.trim() || !email.trim() || !message.trim()}
        className="inline-flex items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950 disabled:opacity-50"
      >
        {status === "sending" ? "Submitting…" : "Submit Request"}
      </button>
      {status === "error" ? (
        <p className="text-sm font-semibold text-red-700">Something went wrong. Please try again.</p>
      ) : null}
    </div>
  );
}
