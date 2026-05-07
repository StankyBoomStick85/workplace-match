"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { NotificationBell } from "./NotificationBell";

type Role = "candidate" | "employer";

type NavItem = {
  href: string;
  label: string;
  avatarUrl?: string;
};

export function Header() {
  const pathname = usePathname();
  const [activeRole, setActiveRole] = useState<Role | null>(null);
  const [activeEmail, setActiveEmail] = useState("");
  const [navItems, setNavItems] = useState<NavItem[]>(getLoggedOutNav());

  useEffect(() => {
    let isMounted = true;

    refreshSessionNav();
    const { data: listener } = supabase.auth.onAuthStateChange(() => {
      refreshSessionNav();
    });

    return () => {
      isMounted = false;
      listener.subscription.unsubscribe();
    };

    async function refreshSessionNav() {
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        if (!isMounted) return;
        setActiveRole(null);
        setActiveEmail("");
        setNavItems(getLoggedOutNav());
        return;
      }

      const response = await fetch("/api/user/me");
      const userRecord = await response.json();
      const role = userRecord?.role === "candidate" || userRecord?.role === "employer" ? userRecord.role : null;
      const label = role ? await getRoleLabel(role, user.id) : "";

      if (!isMounted) return;
      setActiveRole(role);
      setActiveEmail(role ? user.email ?? "" : "");
      setNavItems(role ? getRoleAwareNav(role, label) : getLoggedOutNav());
    }
  }, [pathname]);

  async function signOut() {
    await supabase.auth.signOut();
    setActiveRole(null);
    setActiveEmail("");
    setNavItems(getLoggedOutNav());
    window.location.href = "/";
  }

  return (
    <header className="sticky top-0 z-[1000] border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-5 px-4 py-3.5">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-3"
          aria-label="Workplace Match home"
        >
          <Image
            src="/wp-icon.png"
            alt=""
            width={44}
            height={42}
            priority
            className="h-10 w-auto object-contain"
          />
          <span className="whitespace-nowrap text-2xl tracking-normal">
            <span className="font-bold text-red-700">Workplace</span>{" "}
            <span className="font-bold text-zinc-900">Match</span>
          </span>
        </Link>
        <nav className="flex flex-wrap items-center justify-end gap-6 text-base">
          {navItems.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              label={item.label}
              avatarUrl={item.avatarUrl}
              isActive={isActivePath(pathname, item.href)}
            />
          ))}
          {activeRole ? (
            <>
              {activeEmail ? <NotificationBell recipientEmail={activeEmail} /> : null}
              <button
                type="button"
                onClick={signOut}
                className="border-b-2 border-transparent px-1.5 py-2 font-bold text-zinc-950 transition-colors duration-150 hover:text-red-700"
              >
                Sign out
              </button>
            </>
          ) : null}
        </nav>
      </div>
    </header>
  );
}

function getRoleAwareNav(role: Role, label: string): NavItem[] {
  if (role === "employer") {
    return [
      { href: "/employer/dashboard", label: label || "Dashboard" },
      { href: "/employer/find-applicants", label: "Find applicants" },
      { href: "/employer/matches", label: "My Matches" },
      { href: "/account/settings?role=employer", label: "Account" }
    ];
  }

  return [
    { href: "/candidate/dashboard", label: label || "Profile" },
    { href: "/jobs", label: "See jobs" },
    { href: "/candidate/matches", label: "My Matches" },
    { href: "/account/settings?role=candidate", label: "Account" }
  ];
}

function getLoggedOutNav(): NavItem[] {
  return [{ href: "/login", label: "Log in" }];
}

async function getRoleLabel(role: Role, userId: string) {
  if (role === "candidate") {
    const { data } = await supabase
      .from("candidate_profiles")
      .select("display_name")
      .eq("user_id", userId)
      .maybeSingle();
    return data?.display_name?.trim() || "Profile";
  }

  const { data } = await supabase
    .from("employer_profiles")
    .select("company_name")
    .eq("user_id", userId)
    .maybeSingle();
  return data?.company_name?.trim() || "Dashboard";
}

function NavLink({
  href,
  label,
  avatarUrl,
  isActive
}: {
  href: string;
  label: string;
  avatarUrl?: string;
  isActive: boolean;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-2 border-b-2 px-1.5 py-2 font-bold transition-colors duration-150 hover:text-red-700 ${
        isActive ? "border-red-700 text-red-700" : "border-transparent text-zinc-950"
      }`}
    >
      {avatarUrl !== undefined ? (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-100 text-zinc-500">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="currentColor"
            >
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4Z" />
              <path d="M4.75 20c.75-3.16 3.57-5.5 7.25-5.5s6.5 2.34 7.25 5.5H4.75Z" />
            </svg>
          )}
        </span>
      ) : null}
      {label}
    </Link>
  );
}

function isActivePath(pathname: string, href: string) {
  const routePath = href.split(/[?#]/)[0];
  return pathname === routePath || pathname.startsWith(`${routePath}/`);
}
