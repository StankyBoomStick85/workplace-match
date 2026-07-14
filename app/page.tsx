import Image from "next/image";
import Link from "next/link";

export default function LandingPage() {
  return (
    <section className="mx-auto flex min-h-[70vh] max-w-2xl flex-col items-center justify-center px-4 py-16 text-center">
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

      <div className="mt-10 flex flex-col gap-3 sm:flex-row">
        <Link
          href="/join"
          className="inline-flex items-center justify-center rounded-md bg-red-900 px-8 py-3 text-base font-semibold text-white transition hover:bg-red-950"
        >
          Log In / Sign Up
        </Link>
        <Link
          href="/about"
          className="inline-flex items-center justify-center rounded-md border border-zinc-800 bg-white px-8 py-3 text-base font-semibold text-zinc-950 transition hover:bg-zinc-50"
        >
          Learn More
        </Link>
      </div>
    </section>
  );
}
