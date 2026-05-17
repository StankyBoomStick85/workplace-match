"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getCityStateForZip, normalizeStateValue, normalizeZipCode } from "../lib/addressHelpers";
import {
  defaultContactPreference,
  mergeContactMethods,
  type ContactMethod
} from "../lib/contactPreferences";
import { supabase } from "../lib/supabase";
import { StateAbbreviationSelect } from "./StateAbbreviationSelect";

type Role = "candidate" | "employer";

type SettingsState = {
  email: string;
  displayName: string;
  phone: string;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
  preferredContactMethods: ContactMethod[];
  availabilityText: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

const initialSettings: SettingsState = {
  email: "",
  displayName: "",
  phone: "",
  streetAddress: "",
  city: "",
  state: "",
  zipCode: "",
  preferredContactMethods: defaultContactPreference,
  availabilityText: "",
  currentPassword: "",
  newPassword: "",
  confirmPassword: ""
};

export function AccountSettings() {
  const searchParams = useSearchParams();
  const roleParam = searchParams.get("role");
  const [role, setRole] = useState<Role>("candidate");
  const [userId, setUserId] = useState("");
  const originalEmailRef = useRef("");
  const [settings, setSettings] = useState<SettingsState>(initialSettings);
  const [isEditing, setIsEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showPasswordSection, setShowPasswordSection] = useState(false);

  useEffect(() => {
    loadSettings();

    async function loadSettings() {
      const resolvedRole = resolveRole(roleParam);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        window.location.href = resolvedRole === "employer" ? "/employer/login" : "/applicant/login";
        return;
      }

      const userResponse = await fetch("/api/user/me");
      const userRecord = await userResponse.json();
      if (userRecord?.role !== resolvedRole) {
        window.location.href = resolvedRole === "employer" ? "/employer/login" : "/applicant/login";
        return;
      }

      setRole(resolvedRole);
      setUserId(user.id);
      originalEmailRef.current = user.email ?? "";

      if (resolvedRole === "candidate") {
        const profileResponse = await fetch(`/api/mvp/read?resource=candidate-profile&userId=${encodeURIComponent(user.id)}`);
        const { data } = await profileResponse.json();
        const zipCode = data?.zip_code ?? "";
        const zipMatch = getCityStateForZip(zipCode);
        setSettings({
          ...initialSettings,
          email: user.email ?? "",
          displayName: data?.display_name ?? "",
          phone: data?.phone ?? "",
          streetAddress: data?.street_address ?? "",
          city: data?.city ?? zipMatch?.city ?? "",
          state: data?.state ?? zipMatch?.state ?? "",
          zipCode,
          preferredContactMethods: defaultContactPreference
        });
      } else {
        const profileResponse = await fetch(`/api/mvp/read?resource=employer-profile&userId=${encodeURIComponent(user.id)}`);
        const { data } = await profileResponse.json();
        const zipCode = data?.location_zip ?? "";
        const zipMatch = getCityStateForZip(zipCode);
        setSettings({
          ...initialSettings,
          email: user.email ?? "",
          displayName: data?.company_name ?? "",
          phone: data?.phone ?? "",
          streetAddress: data?.street_address ?? "",
          city: data?.city ?? zipMatch?.city ?? "",
          state: data?.state ?? zipMatch?.state ?? "",
          zipCode,
          availabilityText: "",
          preferredContactMethods: defaultContactPreference
        });
      }
    }
  }, [roleParam]);

  async function handleSave() {
    setError("");
    setMessage("");

    if (!userId) {
      return;
    }

    if (settings.newPassword || settings.confirmPassword) {
      if (settings.newPassword !== settings.confirmPassword) {
        setError("New passwords do not match.");
        return;
      }

      if (!settings.newPassword) {
        setError("Enter a new password.");
        return;
      }

      const { error: passwordError } = await supabase.auth.updateUser({ password: settings.newPassword });
      if (passwordError) {
        setError(passwordError.message);
        return;
      }
    }

    const normalizedEmail = settings.email.trim().toLowerCase();
    const emailChanged = normalizedEmail !== originalEmailRef.current.trim().toLowerCase();

    if (emailChanged && normalizedEmail) {
      const { error: emailError } = await supabase.auth.updateUser({ email: normalizedEmail });
      if (emailError) {
        setError(emailError.message);
        return;
      }
      const accountResponse = await writeMvpData("account-settings", { email: normalizedEmail });
      if (!accountResponse.ok) {
        setError(accountResponse.error);
        return;
      }
      originalEmailRef.current = normalizedEmail;
    }

    if (role === "candidate") {
      const profileResponse = await writeMvpData("candidate-profile", {
        displayName: settings.displayName,
        zipCode: settings.zipCode,
        phone: settings.phone,
        streetAddress: settings.streetAddress,
        city: settings.city,
        state: settings.state
      });
      if (!profileResponse.ok) {
        setError(profileResponse.error);
        return;
      }
    } else {
      const profileResponse = await writeMvpData("employer-profile", {
        displayName: settings.displayName,
        email: normalizedEmail,
        zipCode: settings.zipCode,
        phone: settings.phone,
        streetAddress: settings.streetAddress,
        city: settings.city,
        state: settings.state
      });
      if (!profileResponse.ok) {
        setError(profileResponse.error);
        return;
      }
    }

    setSettings((current) => ({
      ...current,
      preferredContactMethods: mergeContactMethods(current.preferredContactMethods),
      currentPassword: "",
      newPassword: "",
      confirmPassword: ""
    }));
    setMessage("Account settings saved.");
    setIsEditing(false);
  }

  function updateAddressField(field: "streetAddress" | "city" | "state" | "zipCode", value: string) {
    setSettings((current) => {
      if (field === "state") {
        return { ...current, state: normalizeStateValue(value) };
      }

      if (field !== "zipCode") {
        return { ...current, [field]: value };
      }

      const normalizedZip = normalizeZipCode(value);
      const zipMatch = getCityStateForZip(normalizedZip);
      return {
        ...current,
        zipCode: normalizedZip,
        city: zipMatch?.city ?? current.city,
        state: zipMatch?.state ?? current.state
      };
    });
  }

  async function handleZipBlur() {
    const zip = settings.zipCode.trim();
    if (zip.length !== 5) return;
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(zip)}&country=US&format=json&limit=1&addressdetails=1`,
        { headers: { "Accept-Language": "en" } }
      );
      const data: Array<{ address?: { city?: string; town?: string; village?: string; county?: string; state_code?: string; "ISO3166-2-lvl4"?: string } }> = await res.json();
      const addr = data?.[0]?.address;
      if (!addr) return;
      const city = addr.city ?? addr.town ?? addr.village ?? addr.county ?? "";
      const iso = addr["ISO3166-2-lvl4"] ?? "";
      const state = addr.state_code ?? (iso.includes("-") ? iso.split("-").pop() ?? "" : iso);
      if (city || state) {
        setSettings((current) => ({
          ...current,
          city: city || current.city,
          state: state ? normalizeStateValue(state) : current.state,
        }));
      }
    } catch {
      // silent fail — user can enter manually
    }
  }

  return (
    <>
      {isEditing ? (
        <div className="fixed top-0 left-0 z-[1001] w-full flex items-center justify-end gap-2 border-b border-gray-200 bg-white/95 px-6 py-3 shadow-sm backdrop-blur-sm">
          <button
            type="button"
            onClick={() => { setIsEditing(false); setMessage(""); setError(""); }}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
          >
            Save
          </button>
        </div>
      ) : null}
      <section className={`mx-auto max-w-5xl px-4 py-12${isEditing ? " pt-20" : ""}`}>
        <form onSubmit={(e) => e.preventDefault()} className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.16em] text-red-800">Account</p>
              <p className="mt-2 text-sm text-zinc-600">
                Manage your {role === "employer" ? "employer" : "applicant"} account information.
              </p>
            </div>
            <div className="flex gap-2">
              {!isEditing ? (
                <button
                  type="button"
                  onClick={() => setIsEditing(true)}
                  className="rounded-md border border-gray-300 bg-gray-50 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-white"
                >
                  Edit
                </button>
              ) : null}
            </div>
          </div>

          {isEditing ? (
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <Field label={role === "employer" ? "Company Name" : "Name"} id="displayName">
                <input
                  id="displayName"
                  value={settings.displayName}
                  onChange={(event) => setSettings((current) => ({ ...current, displayName: event.target.value }))}
                  className="field"
                />
              </Field>
              <Field label="Email" id="email">
                <input
                  id="email"
                  type="email"
                  value={settings.email}
                  onChange={(event) => setSettings((current) => ({ ...current, email: event.target.value }))}
                  className="field"
                />
              </Field>
              <Field label="Street address" id="streetAddress" fullWidth>
                <input
                  id="streetAddress"
                  value={settings.streetAddress}
                  onChange={(event) => updateAddressField("streetAddress", event.target.value)}
                  className="field"
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_4rem_7rem] md:col-span-2">
                <Field label="City" id="city">
                  <input
                    id="city"
                    value={settings.city}
                    onChange={(event) => updateAddressField("city", event.target.value)}
                    className="field"
                  />
                </Field>
                <Field label="State" id="state">
                  <StateAbbreviationSelect
                    id="state"
                    value={settings.state}
                    onChange={(value) => updateAddressField("state", value)}
                    className="field uppercase"
                  />
                </Field>
                <Field label="ZIP" id="zipCode">
                  <input
                    id="zipCode"
                    value={settings.zipCode}
                    onChange={(event) => updateAddressField("zipCode", event.target.value)}
                    onBlur={handleZipBlur}
                    className="field"
                  />
                </Field>
              </div>
              <Field label="Phone" id="phone">
                <input
                  id="phone"
                  value={settings.phone}
                  onChange={(event) => setSettings((current) => ({ ...current, phone: event.target.value }))}
                  className="field"
                />
              </Field>
            </div>
          ) : (
            <dl className="mt-6 grid gap-4 md:grid-cols-2">
              <ViewField label={role === "employer" ? "Company Name" : "Name"} value={settings.displayName} />
              <ViewField label="Email" value={settings.email} />
              <ViewField label="Street address" value={settings.streetAddress} fullWidth />
              <ViewField label="City" value={settings.city} />
              <ViewField label="State" value={settings.state} />
              <ViewField label="ZIP" value={settings.zipCode} />
              <ViewField label="Phone" value={settings.phone} />
            </dl>
          )}

          {isEditing ? (
            <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
              <button
                type="button"
                onClick={() => setShowPasswordSection((current) => !current)}
                className="text-sm font-semibold text-red-800"
              >
                {showPasswordSection ? "Hide password update" : "Update password"}
              </button>
              {showPasswordSection ? (
                <div className="mt-4 grid gap-4 md:grid-cols-3">
                  <Field label="Current password" id="currentPassword">
                    <input
                      id="currentPassword"
                      type="password"
                      value={settings.currentPassword}
                      onChange={(event) => setSettings((current) => ({ ...current, currentPassword: event.target.value }))}
                      className="field"
                    />
                  </Field>
                  <Field label="New password" id="newPassword">
                    <input
                      id="newPassword"
                      type="password"
                      value={settings.newPassword}
                      onChange={(event) => setSettings((current) => ({ ...current, newPassword: event.target.value }))}
                      className="field"
                    />
                  </Field>
                  <Field label="Confirm new password" id="confirmPassword">
                    <input
                      id="confirmPassword"
                      type="password"
                      value={settings.confirmPassword}
                      onChange={(event) => setSettings((current) => ({ ...current, confirmPassword: event.target.value }))}
                      className="field"
                    />
                  </Field>
                </div>
              ) : null}
            </div>
          ) : null}

          {message ? <p className="mt-4 text-sm font-semibold text-green-700">{message}</p> : null}
          {error ? <p className="mt-4 text-sm font-semibold text-red-700">{error}</p> : null}
        </form>
      </section>
    </>
  );
}

async function writeMvpData(resource: "account-settings" | "candidate-profile" | "employer-profile", data: Record<string, string>) {
  const response = await fetch("/api/mvp/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resource, data })
  });
  const payload = await response.json().catch(() => ({}));

  return {
    ok: response.ok,
    error: typeof payload.error === "string" ? payload.error : "Unable to save account settings."
  };
}

function resolveRole(value: string | null): Role {
  return value === "employer" ? "employer" : "candidate";
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

function ViewField({ label, value, fullWidth = false }: { label: string; value: string; fullWidth?: boolean }) {
  return (
    <div className={`space-y-1 ${fullWidth ? "md:col-span-2" : ""}`}>
      <dt className="label">{label}</dt>
      <dd className="text-sm text-zinc-900">{value || "—"}</dd>
    </div>
  );
}
