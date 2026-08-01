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
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 py-14">
        <LearnMoreAccordions />
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
          <h2 className="mt-2 text-2xl font-bold text-zinc-950">Who built this</h2>
          <p className="mt-3 text-sm leading-7 text-zinc-700">
            I spent 20 years in the Army, 15 of them as a Green Beret. Real autonomy, real responsibility, decisions that mattered under pressure and could not be walked back.
          </p>
          <p className="mt-4 text-sm leading-7 text-zinc-700">
            Then I got out, and I felt what millions of people feel every time they look for work. You go from being trusted with consequential decisions to being an applicant, asking systems that cannot actually see you for permission to be considered. Nothing about my capability changed the day I took off the uniform. What changed was that nobody could see it anymore, because the only way to show it was a resume, and a resume is a sales document filtered by keyword before a human ever reads it.
          </p>
          <p className="mt-4 text-sm leading-7 text-zinc-700">
            I live in a small town. Families here are working jobs that start around $30,000 a year and struggling on it. Employers in the same town say they cannot find workers. Both of those things are true at once, and the gap between them is not talent. It is visibility. Workers with real skills have no way to prove them. Employers have no way to see past a keyword filter to the person who could actually do the job.
          </p>
          <p className="mt-4 text-sm leading-7 text-zinc-700">
            I built this because I wanted it to exist. I am not a traditional developer. I direct AI to build what I can see clearly, and what I can see clearly is a system where what you have actually done is visible without having to sell it, and where employers can see capability instead of guessing at it from job titles.
          </p>
          <p className="mt-4 text-sm leading-7 text-zinc-700">
            That is what this is. It is early, and it is being built in the open.
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
          href="/request-access"
          className="inline-flex items-center justify-center rounded-md bg-red-900 px-8 py-3 text-base font-semibold text-white transition hover:bg-red-950"
        >
          Request Access
        </Link>
      </section>
    </>
  );
}
