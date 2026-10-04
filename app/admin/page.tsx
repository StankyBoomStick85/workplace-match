"use client";

import { useEffect } from "react";

// Admin access comes only from a signed-in session (see lib/serverRoles.ts);
// the dashboard itself checks it and explains when access is denied, so this
// index just forwards there. There is no separate admin login page.
export default function AdminIndexPage() {
  useEffect(() => {
    window.location.href = "/admin/dashboard";
  }, []);

  return (
    <section className="mx-auto max-w-7xl px-4 py-8">
      <p className="text-sm text-zinc-600">Opening admin...</p>
    </section>
  );
}
