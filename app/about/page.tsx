import type { Metadata } from "next";
import Link from "next/link";
import { PartnershipContactForm } from "@/components/PartnershipContactForm";
import { LearnMoreAccordions } from "@/components/LearnMoreAccordions";

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
            Workplace Match helps people and companies find each other through real capability, pay alignment, location fit, and mutual interest, not resume keyword games.
          </p>
          <p className="mt-4 text-base leading-7 text-zinc-500">
            Workplace Match is for blue collar workers, for executives, for management, for veterans, and for everyone in between. It is for every employer who needs the right people and cannot find them through a keyword search.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 py-14">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">Early Access</p>
          <p className="mt-3 text-sm leading-7 text-zinc-700">
            Workplace Match is currently in early build and validation, testing with real users before broader launch. Currently by invite only.
          </p>
          <Link
            href="/request-access"
            className="mt-4 inline-flex items-center justify-center rounded-md bg-red-900 px-8 py-3 text-base font-semibold text-white transition hover:bg-red-950"
          >
            Request Access
          </Link>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-14">
        <LearnMoreAccordions />
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-14">
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">Connect</p>
          <div className="mt-4">
            <h3 className="text-sm font-bold text-zinc-900">Partnership &amp; Investor Inquiries</h3>
            <p className="mt-1 text-sm text-zinc-500">
              Interested in partnering or investing? Send us a message.
            </p>
            <PartnershipContactForm />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-16">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">Early Access</p>
          <p className="mt-3 text-sm leading-7 text-zinc-700">
            Workplace Match is currently in early build and validation, testing with real users before broader launch. Currently by invite only.
          </p>
          <Link
            href="/request-access"
            className="mt-4 inline-flex items-center justify-center rounded-md bg-red-900 px-8 py-3 text-base font-semibold text-white transition hover:bg-red-950"
          >
            Request Access
          </Link>
        </div>
      </section>
    </>
  );
}
