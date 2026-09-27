"use client";

import dynamic from "next/dynamic";

const ApplicantMyJobs = dynamic(() => import("@/components/ApplicantMyJobs").then((mod) => mod.ApplicantMyJobs), { ssr: false });

export default function ApplicantMyJobsPage() {
  return <ApplicantMyJobs />;
}
