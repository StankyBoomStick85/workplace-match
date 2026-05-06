"use client";

import { supabase } from "../lib/supabase";

const googleRedirectUrl = "https://workplace-match-gust.vercel.app/auth/callback";

export function GoogleOAuthButton({ role }: { role?: "candidate" | "employer" }) {
  async function signInWithGoogle() {
    if (role) {
      document.cookie = `workplace_match_oauth_role=${role}; path=/; max-age=600; SameSite=Lax`;
    } else {
      document.cookie = "workplace_match_oauth_role=; path=/; max-age=0; SameSite=Lax";
    }

    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: googleRedirectUrl
      }
    });
  }

  return (
    <button
      type="button"
      onClick={signInWithGoogle}
      className="inline-flex w-full items-center justify-center gap-3 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-gray-50"
    >
      <GoogleLogo />
      Continue with Google
    </button>
  );
}

export function AuthDivider() {
  return (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1 bg-gray-200" />
      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">or</span>
      <span className="h-px flex-1 bg-gray-200" />
    </div>
  );
}

function GoogleLogo() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24">
      <path
        fill="#4285F4"
        d="M21.6 12.23c0-.78-.07-1.53-.2-2.23H12v4.22h5.38a4.6 4.6 0 0 1-1.99 3.02v2.51h3.22c1.89-1.74 2.99-4.3 2.99-7.52Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.96-.9 6.61-2.43l-3.22-2.51c-.9.6-2.04.95-3.39.95-2.6 0-4.8-1.76-5.59-4.12H3.08v2.59A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.41 13.89A6.01 6.01 0 0 1 6.1 12c0-.66.11-1.29.31-1.89V7.52H3.08A10 10 0 0 0 2 12c0 1.61.39 3.13 1.08 4.48l3.33-2.59Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.99c1.47 0 2.78.5 3.82 1.49l2.86-2.86C16.95 3.01 14.69 2 12 2a10 10 0 0 0-8.92 5.52l3.33 2.59C7.2 7.75 9.4 5.99 12 5.99Z"
      />
    </svg>
  );
}
