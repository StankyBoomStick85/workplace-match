import Link from "next/link";
import { login, signUp } from "@/app/actions/auth";
import type { UserRole } from "@/lib/types";

type AuthFormProps = {
  mode: "login" | "signup";
  role: UserRole;
  error?: string;
};

export function AuthForm({ mode, role, error }: AuthFormProps) {
  const isSignup = mode === "signup";
  const action = isSignup ? signUp : login;
  const otherMode = isSignup ? "login" : "signup";

  return (
    <section className="mx-auto max-w-md px-4 py-14">
      <div className="rounded-lg border border-line bg-white p-6 shadow-soft">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-clay">
          {role}
        </p>
        <h1 className="mt-2 text-3xl font-bold">
          {isSignup ? "Create your account" : "Welcome back"}
        </h1>
        <form action={action} className="mt-6 space-y-4">
          <input type="hidden" name="role" value={role} />
          <div className="space-y-2">
            <label htmlFor="email" className="label">
              Email
            </label>
            <input id="email" name="email" type="email" required className="field" />
          </div>
          <div className="space-y-2">
            <label htmlFor="password" className="label">
              Password
            </label>
            <input id="password" name="password" type="password" required className="field" />
          </div>
          {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}
          <button type="submit" className="btn-primary w-full">
            {isSignup ? "Sign up" : "Log in"}
          </button>
        </form>
        <p className="mt-5 text-sm text-ink/65">
          {isSignup ? "Already have an account?" : "Need an account?"}{" "}
          <Link href={`/${role}/${otherMode}`} className="font-semibold text-moss">
            {isSignup ? "Log in" : "Sign up"}
          </Link>
        </p>
      </div>
    </section>
  );
}
