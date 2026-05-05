import Link from "next/link";

export default function SetupNeededPage() {
  return (
    <section className="mx-auto max-w-2xl px-4 py-14">
      <div className="rounded-lg border border-line bg-white p-6 shadow-soft">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-clay">
          Setup needed
        </p>
        <h1 className="mt-2 text-3xl font-bold">Connect Supabase to save data</h1>
        <p className="mt-4 leading-7 text-ink/70">
          The local app is running. Add your Supabase URL and anon key to
          <code className="mx-1 rounded bg-cloud px-1 py-0.5">.env.local</code>,
          run the SQL in <code className="mx-1 rounded bg-cloud px-1 py-0.5">supabase/schema.sql</code>,
          then restart the dev server.
        </p>
        <Link href="/" className="btn-primary mt-6">
          Back home
        </Link>
      </div>
    </section>
  );
}
