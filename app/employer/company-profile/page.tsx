"use client";

import { useEffect } from "react";
import { supabase } from "@/lib/supabase";

export default function EmployerCompanyProfileRedirectPage() {
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      window.location.href = user ? `/employer/company/${user.id}` : "/employer/login";
    });
  }, []);

  return (
    <section className="mx-auto max-w-3xl px-4 py-14">
      <p className="text-sm text-zinc-600">Redirecting…</p>
    </section>
  );
}
