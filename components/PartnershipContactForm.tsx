"use client";

import { useState } from "react";

export function PartnershipContactForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [organization, setOrganization] = useState("");
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");

  async function handleSubmit() {
    if (!name.trim() || !email.trim() || !message.trim()) return;
    setStatus("sending");
    try {
      const res = await fetch("/api/partnership-contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, organization, message })
      });
      if (res.ok) {
        setStatus("success");
        setName("");
        setEmail("");
        setOrganization("");
        setMessage("");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="mt-6 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="partnership-name" className="label">Name</label>
          <input
            id="partnership-name"
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); if (status !== "idle") setStatus("idle"); }}
            className="field"
          />
        </div>
        <div>
          <label htmlFor="partnership-email" className="label">Email</label>
          <input
            id="partnership-email"
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); if (status !== "idle") setStatus("idle"); }}
            className="field"
          />
        </div>
      </div>
      <div>
        <label htmlFor="partnership-org" className="label">Organization (optional)</label>
        <input
          id="partnership-org"
          type="text"
          value={organization}
          onChange={(e) => { setOrganization(e.target.value); if (status !== "idle") setStatus("idle"); }}
          className="field"
        />
      </div>
      <div>
        <label htmlFor="partnership-message" className="label">Message</label>
        <textarea
          id="partnership-message"
          value={message}
          onChange={(e) => { setMessage(e.target.value); if (status !== "idle") setStatus("idle"); }}
          placeholder="Tell us about the partnership or investment opportunity."
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
        {status === "sending" ? "Sending…" : "Send Message"}
      </button>
      {status === "success" ? (
        <p className="text-sm font-semibold text-green-700">Message sent. We&apos;ll be in touch.</p>
      ) : null}
      {status === "error" ? (
        <p className="text-sm font-semibold text-red-700">Something went wrong. Please try again.</p>
      ) : null}
    </div>
  );
}
