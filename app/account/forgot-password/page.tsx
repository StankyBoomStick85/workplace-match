import Link from "next/link";

export default function ForgotPasswordPage() {
  return (
    <section className="mx-auto max-w-md px-4 py-14">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">
          Password reset
        </p>
        <h1 className="mt-2 text-3xl font-bold text-zinc-950">Forgot password?</h1>
        <p className="mt-4 text-sm leading-6 text-zinc-600">
          Password reset will be connected when authentication is upgraded.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/candidate/login"
            className="inline-flex items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
          >
            Back to login
          </Link>
          <Link
            href="/employer/login"
            className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
          >
            Employer login
          </Link>
        </div>
      </div>
    </section>
  );
}
