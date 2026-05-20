import { MapPin, Scale, Sparkles } from "lucide-react";
import Link from "next/link";

const features = [
  {
    icon: Sparkles,
    title: "Capability first",
    body: "Applicants show practical skills and work readiness."
  },
  {
    icon: MapPin,
    title: "Location fit",
    body: "Matches account for where the work is and where people can be."
  },
  {
    icon: Scale,
    title: "Pay alignment",
    body: "Pay expectations are visible before time is wasted."
  }
];

export default function LandingPage() {
  return (
    <>
      <section className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-3xl flex-col items-center px-4 py-16 text-center md:py-24">
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-zinc-950 sm:text-5xl md:text-6xl">
            Capability-first hiring.
          </h1>

          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {["Verified Skills", "Mutual Interest", "Real Alignment"].map((label) => (
              <span
                key={label}
                className="rounded-full border border-zinc-200 bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-700"
              >
                {label}
              </span>
            ))}
          </div>

          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/applicant/signup"
              className="inline-flex items-center justify-center rounded-md bg-red-900 px-7 py-3 text-base font-semibold text-white transition hover:bg-red-950"
            >
              I&rsquo;m Looking for Work
            </Link>
            <Link
              href="/employer/signup"
              className="inline-flex items-center justify-center rounded-md border border-zinc-800 bg-white px-7 py-3 text-base font-semibold text-zinc-950 transition hover:bg-zinc-50"
            >
              I&rsquo;m Hiring
            </Link>
          </div>
        </div>
      </section>

      <section
        className="bg-center bg-repeat"
        style={{
          backgroundImage: "url('/salary-map-background.svg')",
          backgroundSize: "960px auto"
        }}
      >
        <div className="bg-white/60">
          <div className="mx-auto grid max-w-6xl gap-4 px-4 py-10 md:grid-cols-3">
            {features.map((feature) => {
              const Icon = feature.icon;
              return (
                <article key={feature.title} className="rounded-lg border border-gray-200 bg-white p-5">
                  <Icon className="mb-4 text-red-800" size={24} />
                  <h2 className="text-lg font-bold text-zinc-950">{feature.title}</h2>
                  <p className="mt-2 text-sm leading-6 text-zinc-600">{feature.body}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>
    </>
  );
}
