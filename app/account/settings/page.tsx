"use client";

import dynamic from "next/dynamic";

const AccountSettings = dynamic(
  () => import("@/components/AccountSettings").then((mod) => mod.AccountSettings),
  { ssr: false }
);

export default function AccountSettingsPage() {
  return <AccountSettings />;
}
