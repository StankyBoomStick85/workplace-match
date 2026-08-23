"use client";

import dynamic from "next/dynamic";

const MyMatches = dynamic(() => import("@/components/MyMatches").then((mod) => mod.MyMatches), { ssr: false });

export default function EmployerMatchesPage() {
  return <MyMatches role="employer" />;
}
