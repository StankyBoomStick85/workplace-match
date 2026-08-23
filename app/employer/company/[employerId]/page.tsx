"use client";

import dynamic from "next/dynamic";

const EmployerCompanyProfile = dynamic(
  () => import("@/components/EmployerCompanyProfileForm").then((mod) => mod.EmployerCompanyProfile),
  { ssr: false }
);

export default function EmployerCompanyProfilePage({ params }: { params: { employerId: string } }) {
  return <EmployerCompanyProfile employerId={params.employerId} />;
}
