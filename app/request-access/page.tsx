import type { Metadata } from "next";
import Link from "next/link";
import { RequestAccessForm } from "@/components/RequestAccessForm";

export const metadata: Metadata = {
  title: "Request Access | Workplace Match",
  description: "Workplace Match is currently in beta and available by invite only. Request access to get started."
};

export default function RequestAccessPage() {
  return (
    <section className="mx-auto max-w-2xl px-4 py-16">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft sm:p-10">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">Request Access</p>
        <h1 className="mt-2 text-3xl font-bold text-zinc-950">Get Started with Workplace Match</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          Workplace Match is currently in beta and available by invite only. Tell us a bit about who you are and why you&apos;d like access, and we&apos;ll review your request.
        </p>

        <RequestAccessForm />

        <p className="mt-6 border-t border-gray-200 pt-4 text-sm text-zinc-600">
          Already have an access code?{" "}
          <Link href="/join" className="font-semibold text-red-800">
            Enter it here
          </Link>
        </p>
      </div>
    </section>
  );
}
