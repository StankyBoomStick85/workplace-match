"use client";

import dynamic from "next/dynamic";

const CandidateJobsMap = dynamic(
  () => import("@/components/CandidateJobsMap").then((module) => module.CandidateJobsMap),
  {
    ssr: false,
    loading: () => (
      <div className="fixed inset-0 z-40 flex h-screen w-screen items-center justify-center bg-[#eef3ef]">
        <p className="text-sm text-zinc-600">Loading jobs map...</p>
      </div>
    )
  }
);

export default function JobsPage() {
  return <CandidateJobsMap />;
}
