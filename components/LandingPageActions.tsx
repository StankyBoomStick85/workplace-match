"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type AuthState = "checking" | "loggedOut" | "candidate" | "employer" | "pending";

export function LandingPageActions() {
  const [authState, setAuthState] = useState<AuthState>("checking");

  useEffect(() => {
    let isMounted = true;

    async function checkAuth() {
      const {
        data: { user }
      } = await supabase.auth.getUser();

      if (!user) {
        if (isMounted) setAuthState("loggedOut");
        return;
      }

      const response = await fetch("/api/user/me");
      const userRecord = await response.json();
      if (!isMounted) return;

      if (userRecord?.role === "candidate") {
        setAuthState("candidate");
      } else if (userRecord?.role === "employer") {
        setAuthState("employer");
      } else if (userRecord?.role === "pending") {
        setAuthState("pending");
      } else {
        setAuthState("loggedOut");
      }
    }

    checkAuth();
    return () => {
      isMounted = false;
    };
  }, []);

  // Reserve the button row's footprint while checking, so the page doesn't jump
  // once auth state resolves.
  if (authState === "checking") {
    return <div className="mt-10 h-[52px]" aria-hidden="true" />;
  }

  if (authState === "loggedOut") {
    return (
      <div className="mt-10 flex flex-col gap-3 sm:flex-row">
        <Link
          href="/request-access"
          className="inline-flex items-center justify-center rounded-md bg-red-900 px-8 py-3 text-base font-semibold text-white shadow-soft transition hover:bg-red-950"
        >
          Request Access
        </Link>
        <Link
          href="/about"
          className="inline-flex items-center justify-center rounded-md border border-zinc-800 bg-white px-8 py-3 text-base font-semibold text-zinc-950 transition hover:bg-zinc-50"
        >
          Learn More
        </Link>
      </div>
    );
  }

  const profileHref =
    authState === "candidate" ? "/applicant/profile" : authState === "employer" ? "/employer/dashboard" : "/onboarding";
  const profileLabel = authState === "pending" ? "Continue Setup" : "Back to My Profile";

  return (
    <div className="mt-10 flex flex-col gap-3 sm:flex-row">
      <Link
        href={profileHref}
        className="inline-flex items-center justify-center rounded-md bg-red-900 px-8 py-3 text-base font-semibold text-white shadow-soft transition hover:bg-red-950"
      >
        {profileLabel}
      </Link>
      <Link
        href="/about"
        className="inline-flex items-center justify-center rounded-md border border-zinc-800 bg-white px-8 py-3 text-base font-semibold text-zinc-950 transition hover:bg-zinc-50"
      >
        Learn More
      </Link>
    </div>
  );
}
