"use client";

import { useEffect } from "react";
import { hasAdminSession } from "../../lib/adminAuth";

export default function AdminIndexPage() {
  useEffect(() => {
    window.location.href = hasAdminSession() ? "/admin/dashboard" : "/admin/login";
  }, []);

  return (
    <section className="mx-auto max-w-7xl px-4 py-8">
      <p className="text-sm text-zinc-600">Opening admin...</p>
    </section>
  );
}
