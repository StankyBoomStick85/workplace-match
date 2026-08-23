"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type AuthState = "checking" | "loggedOut";

export function LandingPageActions() {
  const router = useRouter();
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
        router.replace("/applicant/profile");
      } else if (userRecord?.role === "employer") {
        router.replace("/employer/dashboard");
      } else if (userRecord?.role === "pending") {
        router.replace("/onboarding");
      } else {
        setAuthState("loggedOut");
        return;
      }
      setAuthState("checking");
    }

    checkAuth();
    return () => {
      isMounted = false;
    };
  }, [router]);

  // Reserve the button row's footprint while checking, so the page doesn't jump
  // once auth state resolves.
  if (authState === "checking") {
    return <div className="mt-10 h-[52px]" aria-hidden="true" />;
  }

  return (
    <div className="mt-10 flex flex-col items-center gap-4">
      <div className="flex flex-col gap-3 sm:flex-row">
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
      <p className="text-base text-zinc-700">
        Already approved?{" "}
        <Link
          href="/login"
          className="font-semibold text-red-800 underline underline-offset-2 transition hover:text-red-900"
        >
          Log in or create your account here
        </Link>
      </p>
    </div>
  );
}
