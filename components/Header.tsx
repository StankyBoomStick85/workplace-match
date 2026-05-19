"use client";

import Image from "next/image";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { NotificationBell } from "./NotificationBell";
import { SettingsModal } from "./SettingsModal";

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
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

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
      const { label, avatarUrl } = role ? await getRoleLabel(role, user.id) : { label: "", avatarUrl: "" };

      if (!isMounted) return;
      setActiveRole(role);
      setActiveEmail(role ? user.email ?? "" : "");
      setNavItems(role ? getRoleAwareNav(role, label, avatarUrl) : getLoggedOutNav());
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
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-5 px-4 py-2 sm:py-3.5">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 sm:gap-3"
          aria-label="Workplace Match home"
        >
          <Image
            src="/wp-icon.svg"
            alt=""
            width={44}
            height={42}
            priority
            className="h-7 w-auto object-contain sm:h-10"
          />
          <span className="whitespace-nowrap text-base tracking-normal sm:text-2xl">
            <span className="font-bold text-red-700">Workplace</span>{" "}
            <span className="font-bold text-zinc-900">Match</span>
          </span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden md:flex flex-wrap items-center justify-end gap-3 text-sm sm:gap-6 sm:text-base">
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
              {activeRole === "candidate" ? <SettingsModal /> : null}
              <button
                type="button"
                onClick={signOut}
                className="border-b-2 border-transparent px-1 py-1 font-bold text-zinc-950 transition-colors duration-150 hover:text-red-700 sm:px-1.5 sm:py-2"
              >
                Sign out
              </button>
            </>
          ) : null}
        </nav>

        {/* Hamburger button — mobile only */}
        <button
          type="button"
          onClick={() => setMenuOpen((prev) => !prev)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md text-zinc-950 transition hover:bg-gray-100 md:hidden"
        >
          {menuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>

      {/* Mobile dropdown */}
      {menuOpen ? (
        <div className="absolute left-0 right-0 top-full border-b border-gray-200 bg-white shadow-lg md:hidden">
          <div className="mx-auto max-w-6xl divide-y divide-gray-100 px-4">
            {navItems.map((item) => (
              <MobileNavLink
                key={item.href}
                href={item.href}
                label={item.label}
                avatarUrl={item.avatarUrl}
                isActive={isActivePath(pathname, item.href)}
                onClick={() => setMenuOpen(false)}
              />
            ))}
            {activeRole ? (
              <div className="flex items-center gap-2 py-3">
                {activeEmail ? <NotificationBell recipientEmail={activeEmail} /> : null}
                {activeRole === "candidate" ? <SettingsModal /> : null}
                <button
                  type="button"
                  onClick={() => { setMenuOpen(false); signOut(); }}
                  className="ml-auto font-bold text-zinc-950 transition-colors hover:text-red-700"
                >
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </header>
  );
}

function getRoleAwareNav(role: Role, label: string, avatarUrl = ""): NavItem[] {
  if (role === "employer") {
    return [
      { href: "/employer/dashboard", label: label || "Dashboard" },
      { href: "/employer/find-applicants", label: "Find applicants" },
      { href: "/employer/matches", label: "Dashboard" },
      { href: "/account/settings?role=employer", label: "Account" }
    ];
  }

  return [
    { href: "/applicant/profile", label: label || "Profile", avatarUrl },
    { href: "/applicant/my-jobs", label: "My Jobs" },
    { href: "/applicant/job-map", label: "Job Map" }
  ];
}

function getLoggedOutNav(): NavItem[] {
  return [{ href: "/login", label: "Log in" }];
}

async function getRoleLabel(role: Role, userId: string): Promise<{ label: string; avatarUrl: string }> {
  if (role === "candidate") {
    const response = await fetch(`/api/mvp/read?resource=header-label&role=candidate&userId=${encodeURIComponent(userId)}`);
    const { data } = await response.json();
    return {
      label: data?.display_name?.trim() || "Profile",
      avatarUrl: data?.profile_picture_url ?? ""
    };
  }

  const response = await fetch(`/api/mvp/read?resource=header-label&role=employer&userId=${encodeURIComponent(userId)}`);
  const { data } = await response.json();
  return { label: data?.company_name?.trim() || "Dashboard", avatarUrl: "" };
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
      className={`inline-flex items-center gap-2 border-b-2 px-1 py-1 font-bold transition-colors duration-150 hover:text-red-700 sm:px-1.5 sm:py-2 ${
        isActive ? "border-red-700 text-red-700" : "border-transparent text-zinc-950"
      }`}
    >
      {avatarUrl !== undefined ? (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-100 text-zinc-500">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-xs font-semibold leading-none">{nameInitials(label)}</span>
          )}
        </span>
      ) : null}
      {label}
    </Link>
  );
}

function MobileNavLink({
  href,
  label,
  avatarUrl,
  isActive,
  onClick
}: {
  href: string;
  label: string;
  avatarUrl?: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`flex items-center gap-3 py-3.5 font-bold transition-colors hover:text-red-700 ${
        isActive ? "text-red-700" : "text-zinc-950"
      }`}
    >
      {avatarUrl !== undefined ? (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-100 text-zinc-500">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-xs font-semibold leading-none">{nameInitials(label)}</span>
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

function nameInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
