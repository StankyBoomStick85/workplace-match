import { ArrowRight, BriefcaseBusiness, MapPin, Scale, Sparkles } from "lucide-react";
import Link from "next/link";

const features = [
  {
    icon: Sparkles,
    title: "Capability first",
    body: "Candidates show practical skills and work readiness."
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
        <div className="mx-auto grid min-h-[560px] max-w-6xl items-center gap-10 px-4 py-14 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <p className="mb-4 text-sm font-semibold uppercase tracking-[0.18em] text-red-800">
              Capability-based matching
            </p>
            <h1 className="max-w-3xl text-5xl font-bold leading-tight tracking-normal text-zinc-950 md:text-6xl">
              Show capability, not narratives.
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-zinc-700">
              Workplace Match connects candidates and employers using practical
              signals: capability, location, pay, and fit.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/candidate/signup"
                className="inline-flex items-center justify-center gap-2 rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
              >
                I&rsquo;m looking for work <ArrowRight size={17} />
              </Link>
              <Link
                href="/employer/signup"
                className="inline-flex items-center justify-center rounded-md border border-zinc-800 bg-white px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-50"
              >
                I&rsquo;m hiring
              </Link>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-gray-50 p-5 shadow-soft">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-white text-red-800">
                <BriefcaseBusiness size={22} />
              </div>
              <div>
                <p className="text-sm font-semibold text-zinc-950">Example match</p>
                <p className="text-sm text-zinc-600">Operations associate</p>
              </div>
            </div>
            <div className="space-y-3 text-sm">
              {[
                ["Location", "Austin, TX"],
                ["Capability", "Scheduling, inventory, customer service"],
                ["Pay range", "$22-$28/hr"],
                ["Fit score", "86%"]
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-center justify-between gap-4 rounded-md border border-gray-200 bg-white px-3 py-3"
                >
                  <span className="text-zinc-600">{label}</span>
                  <span className="text-right font-semibold text-zinc-950">{value}</span>
                </div>
              ))}
            </div>
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
