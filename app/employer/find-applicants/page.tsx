"use client";

import dynamic from "next/dynamic";

const EmployerFindApplicants = dynamic(
  () => import("@/components/EmployerFindApplicants").then((module) => module.EmployerFindApplicants),
  {
    ssr: false,
    loading: () => (
      <div className="fixed inset-0 z-40 flex h-screen w-screen items-center justify-center bg-[#eef3ef]">
        <p className="text-sm text-zinc-600">Loading map...</p>
      </div>
    )
  }
);

export default function EmployerFindApplicantsPage() {
  return <EmployerFindApplicants />;
}
