import type { Metadata } from "next";
import Link from "next/link";
import { PartnershipContactForm } from "@/components/PartnershipContactForm";

export const metadata: Metadata = {
  title: "About | Workplace Match",
  description: "Workplace Match helps people and companies find each other through real capability, pay alignment, location fit, and mutual interest."
};

export default function AboutPage() {
  return (
    <>
      <section className="border-b border-gray-200 bg-white px-4 py-16 text-center">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-zinc-950 sm:text-5xl">
            Work should match people better.
          </h1>
          <p className="mt-6 text-lg leading-8 text-zinc-600">
            Workplace Match helps people and companies find each other through real capability, pay alignment, location fit, and mutual interest — not resume keyword games.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 py-14">
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">For People</p>
            <p className="mt-3 text-sm leading-7 text-zinc-700">
              You are more than a resume. Create a profile around what you can actually do, what you&apos;re looking for, where you want to work, and what pay makes sense for your life. Then see opportunities that fit you — not just jobs that happen to be posted.
            </p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">For Employers</p>
            <p className="mt-3 text-sm leading-7 text-zinc-700">
              Stop waiting for the right person to apply. Workplace Match helps employers see people with relevant capability, realistic location fit, and aligned expectations before wasting time sorting through disconnected applications.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-14">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">Early Access</p>
          <p className="mt-3 text-sm leading-7 text-zinc-700">
            Workplace Match is currently in early build and validation, testing with real users before broader launch. Currently by invite only.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-14">
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">Connect</p>
          <h2 className="mt-2 text-2xl font-bold text-zinc-950">About the Founder</h2>
          <p className="mt-3 text-sm leading-7 text-zinc-700">
            Built by Joel DeToy — 20-year Army veteran, 15 years Special Forces, now building the hiring platform he wished existed.
          </p>

          <div className="mt-6 border-t border-gray-200 pt-6">
            <h3 className="text-sm font-bold text-zinc-900">Partnership &amp; Investor Inquiries</h3>
            <p className="mt-1 text-sm text-zinc-500">
              Interested in partnering or investing? Send us a message.
            </p>
            <PartnershipContactForm />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 pb-16 text-center">
        <Link
          href="/join"
          className="inline-flex items-center justify-center rounded-md bg-red-900 px-8 py-3 text-base font-semibold text-white transition hover:bg-red-950"
        >
          Log In / Sign Up
        </Link>
      </section>
    </>
  );
}
