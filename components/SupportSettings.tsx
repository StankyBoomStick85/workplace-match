"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export function SupportSettings() {
  const [userName, setUserName] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [supportMessage, setSupportMessage] = useState("");
  const [supportStatus, setSupportStatus] = useState<"idle" | "sending" | "success" | "error">("idle");

  useEffect(() => {
    async function loadUser() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      setUserEmail(user.email ?? "");

      const meRes = await fetch("/api/user/me");
      const meData = await meRes.json();
      const role = meData?.role === "employer" ? "employer" : "candidate";
      const resource = role === "employer" ? "employer-profile" : "candidate-profile";

      const profileRes = await fetch(`/api/mvp/read?resource=${resource}&userId=${encodeURIComponent(user.id)}`);
      const { data } = await profileRes.json();
      const name = role === "employer" ? (data?.company_name ?? "") : (data?.display_name ?? "");
      setUserName(name);
    }
    loadUser();
  }, []);

  async function handleSubmit() {
    if (!supportMessage.trim()) return;
    setSupportStatus("sending");
    try {
      const res = await fetch("/api/contact-support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: supportMessage, userName, userEmail })
      });
      if (res.ok) {
        setSupportStatus("success");
        setSupportMessage("");
      } else {
        setSupportStatus("error");
      }
    } catch {
      setSupportStatus("error");
    }
  }

  return (
    <div className="px-6 py-6">
      <h3 className="text-sm font-bold text-zinc-900">Contact Support</h3>
      <p className="mt-1 text-sm text-zinc-500">
        Have a question, found a bug, or have an idea? Let us know.
      </p>
      <div className="mt-5 space-y-3">
        <textarea
          value={supportMessage}
          onChange={(e) => {
            setSupportMessage(e.target.value);
            if (supportStatus !== "idle") setSupportStatus("idle");
          }}
          placeholder="Have a question, found a bug, or have an idea? Let us know."
          rows={5}
          className="field w-full resize-none"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={supportStatus === "sending" || !supportMessage.trim()}
          className="rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950 disabled:opacity-50"
        >
          {supportStatus === "sending" ? "Sending…" : "Send Message"}
        </button>
        {supportStatus === "success" ? (
          <p className="text-sm font-semibold text-green-700">Message sent. We&apos;ll be in touch.</p>
        ) : null}
        {supportStatus === "error" ? (
          <p className="text-sm font-semibold text-red-700">Something went wrong. Please try again.</p>
        ) : null}
      </div>
    </div>
  );
}
