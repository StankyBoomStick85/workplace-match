"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { NotificationBell } from "./NotificationBell";

type Role = "candidate" | "employer";

type NavItem = {
  href: string;
  label: string;
  avatarUrl?: string;
};

const candidateAccountKey = "workplace_match_candidate";
const candidateProfileKey = "workplace_match_candidate_profile";
const employerAccountKey = "workplace_match_employer";
const employerAccountsKey = "workplace_match_employer_accounts";
const employerCompanyProfileKey = "workplace_match_employer_company_profile";
const activeRoleKey = "workplace_match_active_role";
const activeEmailKey = "workplace_match_active_email";

export function Header() {
  const pathname = usePathname();
  const [activeRole, setActiveRole] = useState<Role | null>(null);
  const [activeEmail, setActiveEmail] = useState("");
  const [navItems, setNavItems] = useState<NavItem[]>(getLoggedOutNav());

  useEffect(() => {
    const role = getCurrentRole(pathname);
    setActiveRole(role);
    setActiveEmail(role ? localStorage.getItem(activeEmailKey) ?? "" : "");
    setNavItems(role ? getRoleAwareNav(role) : getLoggedOutNav());
  }, [pathname]);

  function signOut() {
    localStorage.removeItem(activeRoleKey);
    localStorage.removeItem(activeEmailKey);
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

function getRoleAwareNav(role: Role): NavItem[] {
  if (role === "employer") {
    return [
      { href: "/employer/dashboard", label: getEmployerLabel() },
      { href: "/employer/find-applicants", label: "Find applicants" },
      { href: "/employer/matches", label: "My Matches" },
      { href: "/account/settings?role=employer", label: "Account" }
    ];
  }

  return [
    { href: "/candidate/dashboard", label: getCandidateLabel(), avatarUrl: getCandidateProfilePicture() },
    { href: "/jobs", label: "See jobs" },
    { href: "/candidate/matches", label: "My Matches" },
    { href: "/account/settings?role=candidate", label: "Account" }
  ];
}

function getLoggedOutNav(): NavItem[] {
  return [{ href: "/login", label: "Log in" }];
}

function getCurrentRole(pathname: string): Role | null {
  const activeRole = localStorage.getItem(activeRoleKey);
  if (activeRole === "candidate" || activeRole === "employer") {
    return activeRole;
  }

  return null;
}

function getCandidateLabel() {
  const savedProfile = localStorage.getItem(candidateProfileKey);
  if (!savedProfile) {
    return "Profile";
  }

  try {
    const profile = JSON.parse(savedProfile) as { fullName?: string };
    return profile.fullName?.trim() || "Profile";
  } catch {
    return "Profile";
  }
}

function getCandidateProfilePicture() {
  const savedProfile = localStorage.getItem(candidateProfileKey);
  const savedAccount = localStorage.getItem(candidateAccountKey);

  const profilePicture = getStoredProfilePicture(savedProfile);
  if (profilePicture) {
    return profilePicture;
  }

  return getStoredProfilePicture(savedAccount);
}

function getStoredProfilePicture(value: string | null) {
  if (!value) {
    return "";
  }

  try {
    const parsed = JSON.parse(value) as { profilePictureDataUrl?: string };
    return parsed.profilePictureDataUrl?.trim() ?? "";
  } catch {
    return "";
  }
}

function getEmployerLabel() {
  const savedEmployer = localStorage.getItem(employerAccountKey);
  const activeEmail = localStorage.getItem(activeEmailKey);
  const activeEmployer = getActiveEmployerAccount(savedEmployer, activeEmail);
  const savedCompanyProfile = localStorage.getItem(employerCompanyProfileKey);
  const companyProfileLabel = getStoredCompanyNameForEmployer(savedCompanyProfile, activeEmployer?.email ?? activeEmail);

  if (companyProfileLabel) {
    return companyProfileLabel;
  }

  return activeEmployer?.companyName?.trim() || "Dashboard";
}

function getStoredCompanyNameForEmployer(value: string | null, employerEmail?: string | null) {
  if (!value || !employerEmail) {
    return "";
  }

  try {
    const parsed = JSON.parse(value) as { employerEmail?: string; companyName?: string };
    return parsed.employerEmail?.trim().toLowerCase() === employerEmail.trim().toLowerCase()
      ? parsed.companyName?.trim() ?? ""
      : "";
  } catch {
    return "";
  }
}

function getActiveEmployerAccount(savedEmployer: string | null, activeEmail: string | null) {
  const legacyAccount = parseEmployerAccount(savedEmployer);
  const accounts = parseEmployerAccounts(localStorage.getItem(employerAccountsKey));
  const normalizedActiveEmail = activeEmail?.trim().toLowerCase() ?? "";

  if (normalizedActiveEmail) {
    return (
      accounts.find((account) => account.email.trim().toLowerCase() === normalizedActiveEmail) ??
      (legacyAccount?.email.trim().toLowerCase() === normalizedActiveEmail ? legacyAccount : null)
    );
  }

  return legacyAccount;
}

function parseEmployerAccounts(value: string | null) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as Array<{ email?: string; companyName?: string }> | { email?: string; companyName?: string };
    return Array.isArray(parsed) ? parsed.filter(isEmployerAccount) : isEmployerAccount(parsed) ? [parsed] : [];
  } catch {
    return [];
  }
}

function parseEmployerAccount(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as { email?: string; companyName?: string };
    return isEmployerAccount(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isEmployerAccount(value: unknown): value is { email: string; companyName?: string } {
  return Boolean(value && typeof value === "object" && typeof (value as { email?: unknown }).email === "string");
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
