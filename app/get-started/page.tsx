import Link from "next/link";

export default function GetStartedPage() {
  return (
    <section className="mx-auto flex min-h-[520px] max-w-3xl items-center px-4 py-14">
      <div className="w-full rounded-lg border border-gray-200 bg-white p-6 text-center shadow-soft">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">
          Get started
        </p>
        <h1 className="mt-2 text-3xl font-bold text-zinc-950">
          How are you using Workplace Match?
        </h1>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            href="/candidate/signup"
            className="inline-flex items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
          >
            I&rsquo;m looking for work
          </Link>
          <Link
            href="/employer/signup"
            className="inline-flex items-center justify-center rounded-md border border-zinc-800 bg-white px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-50"
          >
            I&rsquo;m hiring
          </Link>
        </div>
      </div>
    </section>
  );
}
