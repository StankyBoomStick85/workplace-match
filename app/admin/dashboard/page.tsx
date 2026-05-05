"use client";

import dynamic from "next/dynamic";

const AdminDashboard = dynamic(
  () => import("../../../components/AdminDashboard").then((module) => module.AdminDashboard),
  {
    ssr: false,
    loading: () => (
      <section className="mx-auto max-w-7xl px-4 py-8">
        <p className="text-sm text-zinc-600">Loading admin dashboard...</p>
      </section>
    )
  }
);

export default function AdminDashboardPage() {
  return <AdminDashboard />;
}
