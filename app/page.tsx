import Image from "next/image";
import Link from "next/link";
import { MapPin } from "lucide-react";

const matchPins: { label: string; position: string; visibility: string; opacity: string }[] = [
  { label: "94% Match", position: "left-[6%] top-[16%]", visibility: "hidden sm:flex", opacity: "opacity-60" },
  { label: "88% Match", position: "right-[7%] top-[24%]", visibility: "hidden md:flex", opacity: "opacity-40" },
  { label: "97% Match", position: "left-[9%] bottom-[18%]", visibility: "hidden md:flex", opacity: "opacity-45" },
  { label: "91% Match", position: "right-[5%] bottom-[14%]", visibility: "hidden sm:flex", opacity: "opacity-55" }
];

export default function LandingPage() {
  return (
    <section className="relative isolate flex min-h-[78vh] items-center justify-center overflow-hidden bg-gradient-to-b from-white to-cloud px-4 py-16">
      {/* Faded map-style background texture */}
      <div
        className="pointer-events-none absolute inset-0 bg-repeat opacity-[0.14]"
        style={{ backgroundImage: "url('/salary-map-background.svg')", backgroundSize: "1100px auto" }}
        aria-hidden="true"
      />

      {/* Scattered match-percentage pin callouts */}
      {matchPins.map((pin) => (
        <div
          key={pin.label}
          aria-hidden="true"
          className={`pointer-events-none absolute ${pin.position} ${pin.visibility} ${pin.opacity} items-center gap-1.5 rounded-full border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-800 shadow-soft`}
        >
          <MapPin size={14} className="text-red-700" />
          {pin.label}
        </div>
      ))}

      {/* Foreground content */}
      <div className="relative z-10 flex w-full max-w-2xl flex-col items-center rounded-2xl border border-gray-200 bg-white/80 px-8 py-12 text-center shadow-soft backdrop-blur-sm sm:px-14 sm:py-16">
        <div className="flex flex-col items-center gap-3">
          <Image
            src="/wp-icon.svg"
            alt="Workplace Match"
            width={64}
            height={61}
            priority
            className="h-14 w-auto object-contain sm:h-16"
          />
          <span className="whitespace-nowrap text-3xl sm:text-4xl">
            <span className="font-bold text-red-700">Workplace</span>{" "}
            <span className="font-bold text-zinc-900">Match</span>
          </span>
        </div>

        <p className="mt-5 max-w-md text-lg font-semibold leading-7 text-zinc-800 sm:text-xl">
          Finding the right person and the right job just got easier.
        </p>

        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/request-access"
            className="inline-flex items-center justify-center rounded-md bg-red-900 px-8 py-3 text-base font-semibold text-white shadow-soft transition hover:bg-red-950"
          >
            Request Access
          </Link>
          <Link
            href="/about"
            className="inline-flex items-center justify-center rounded-md border border-zinc-800 bg-white px-8 py-3 text-base font-semibold text-zinc-950 transition hover:bg-zinc-50"
          >
            Learn More
          </Link>
        </div>
      </div>
    </section>
  );
}
