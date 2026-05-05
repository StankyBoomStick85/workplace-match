"use client";

import { useEffect, useState, type FormEvent } from "react";
import { getCityStateForZip, normalizeStateValue, normalizeZipCode } from "../lib/addressHelpers";
import { StateAbbreviationSelect } from "./StateAbbreviationSelect";

type EmployerAccount = {
  email: string;
  companyProfileComplete?: boolean;
};

type CompanyProfile = {
  employerEmail: string;
  companyName: string;
  industry: string;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
  companySize: string;
  description: string;
  website: string;
  updatedAt: string;
};

const employerAccountKey = "workplace_match_employer";
const activeRoleKey = "workplace_match_active_role";
const companyProfileKey = "workplace_match_employer_company_profile";

export function EmployerCompanyProfileForm() {
  const [account, setAccount] = useState<EmployerAccount | null>(null);
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [address, setAddress] = useState({
    streetAddress: "",
    city: "",
    state: "",
    zipCode: ""
  });

  useEffect(() => {
    const savedAccount = localStorage.getItem(employerAccountKey);
    const activeRole = localStorage.getItem(activeRoleKey);
    if (!savedAccount || activeRole !== "employer") {
      window.location.href = "/employer/login";
      return;
    }

    const parsedAccount = JSON.parse(savedAccount) as EmployerAccount;
    setAccount(parsedAccount);

    const savedProfile = localStorage.getItem(companyProfileKey);
    if (savedProfile) {
      const parsedProfile = JSON.parse(savedProfile) as CompanyProfile;
      if (parsedProfile.employerEmail === parsedAccount.email) {
        setProfile(parsedProfile);
        setAddress({
          streetAddress: parsedProfile.streetAddress ?? "",
          city: parsedProfile.city ?? "",
          state: parsedProfile.state ?? "",
          zipCode: parsedProfile.zipCode ?? ""
        });
      }
    }
  }, []);

  function updateAddressField(field: keyof typeof address, value: string) {
    setAddress((current) => {
      if (field === "state") {
        return { ...current, state: normalizeStateValue(value) };
      }

      if (field !== "zipCode") {
        return { ...current, [field]: value };
      }

      const normalizedZip = normalizeZipCode(value);
      const zipMatch = getCityStateForZip(normalizedZip);

      if (!zipMatch) {
        return { ...current, zipCode: normalizedZip };
      }

      return {
        ...current,
        zipCode: normalizedZip,
        city: zipMatch.city,
        state: zipMatch.state
      };
    });
  }

  function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!account) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const nextProfile: CompanyProfile = {
      employerEmail: account.email,
      companyName: String(formData.get("companyName") ?? "").trim(),
      industry: String(formData.get("industry") ?? "").trim(),
      streetAddress: address.streetAddress.trim(),
      city: address.city.trim(),
      state: address.state.trim().toUpperCase(),
      zipCode: address.zipCode.trim(),
      companySize: String(formData.get("companySize") ?? "").trim(),
      description: String(formData.get("description") ?? "").trim(),
      website: String(formData.get("website") ?? "").trim(),
      updatedAt: new Date().toISOString()
    };

    localStorage.setItem(companyProfileKey, JSON.stringify(nextProfile));
    const savedAccount = localStorage.getItem(employerAccountKey);
    if (savedAccount) {
      localStorage.setItem(
        employerAccountKey,
        JSON.stringify({ ...JSON.parse(savedAccount), companyProfileComplete: true })
      );
    }

    window.location.href = "/employer/dashboard";
  }

  if (!account) {
    return (
      <section className="mx-auto max-w-3xl px-4 py-14">
        <p className="text-sm text-zinc-600">Loading company profile...</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-3xl px-4 py-14">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">
          Company profile
        </p>
        <h1 className="mt-2 text-3xl font-bold text-zinc-950">
          {profile ? "Edit company profile" : "Create company profile"}
        </h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          Add basic company details for job listings and future matching.
        </p>

        <form onSubmit={saveProfile} className="mt-6 grid gap-4 md:grid-cols-2">
          <Field label="Company name" id="companyName">
            <input id="companyName" name="companyName" required defaultValue={profile?.companyName ?? ""} className="field" />
          </Field>
          <Field label="Industry" id="industry">
            <input id="industry" name="industry" required defaultValue={profile?.industry ?? ""} className="field" />
          </Field>
          <Field label="Street address" id="streetAddress" fullWidth>
            <input
              id="streetAddress"
              name="streetAddress"
              required
              value={address.streetAddress}
              onChange={(event) => updateAddressField("streetAddress", event.target.value)}
              className="field"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_4rem_7rem] md:col-span-2">
            <div className="space-y-2">
              <label htmlFor="city" className="label">
                City
              </label>
              <input
                id="city"
                name="city"
                required
                value={address.city}
                onChange={(event) => updateAddressField("city", event.target.value)}
                className="field"
              />
            </div>
            <div className="w-16 space-y-2">
              <label htmlFor="state" className="label">
                State
              </label>
              <StateAbbreviationSelect
                id="state"
                name="state"
                required
                value={address.state}
                onChange={(value) => updateAddressField("state", value)}
                className="field uppercase"
              />
            </div>
            <div className="w-28 space-y-2">
              <label htmlFor="zipCode" className="label">
                ZIP code
              </label>
              <input
                id="zipCode"
                name="zipCode"
                required
                inputMode="numeric"
                value={address.zipCode}
                onChange={(event) => updateAddressField("zipCode", event.target.value)}
                className="field"
              />
            </div>
          </div>
          <Field label="Company size" id="companySize">
            <select id="companySize" name="companySize" required defaultValue={profile?.companySize ?? ""} className="field">
              <option value="" disabled>Select size</option>
              <option>1-10 employees</option>
              <option>11-50 employees</option>
              <option>51-200 employees</option>
              <option>201-500 employees</option>
              <option>500+ employees</option>
            </select>
          </Field>
          <Field label="Website optional" id="website">
            <input id="website" name="website" type="url" defaultValue={profile?.website ?? ""} className="field" placeholder="https://example.com" />
          </Field>
          <Field label="Short company description" id="description" fullWidth>
            <textarea id="description" name="description" rows={5} required defaultValue={profile?.description ?? ""} className="field" />
          </Field>

          <div className="md:col-span-2">
            <button type="submit" className="inline-flex items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950">
              Save company profile
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

function Field({
  label,
  id,
  fullWidth = false,
  children
}: {
  label: string;
  id: string;
  fullWidth?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-2 ${fullWidth ? "md:col-span-2" : ""}`}>
      <label htmlFor={id} className="label">
        {label}
      </label>
      {children}
    </div>
  );
}
