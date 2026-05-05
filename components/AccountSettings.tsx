"use client";

import L from "leaflet";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { MapContainer, Marker, TileLayer, ZoomControl } from "react-leaflet";
import {
  findAccountByEmail,
  normalizeEmail,
  readAccounts,
  setActiveAccount,
  type LocalAccount
} from "../lib/localAccounts";
import { getCityStateForZip, normalizeStateValue, normalizeZipCode } from "../lib/addressHelpers";
import {
  defaultContactPreference,
  getPreferredContactMethods,
  mergeContactMethods,
  type ContactMethod
} from "../lib/contactPreferences";
import { StateAbbreviationSelect } from "./StateAbbreviationSelect";
import { PasswordVisibilityField } from "./PasswordVisibilityField";

type Role = "candidate" | "employer";
type Coordinates = [number, number];

type CompanyProfile = {
  employerEmail: string;
  companyName?: string;
  industry?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
};

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

const candidateAccountKey = "workplace_match_candidate";
const candidateAccountsKey = "workplace_match_candidate_accounts";
const candidateProfileKey = "workplace_match_candidate_profile";
const employerAccountKey = "workplace_match_employer";
const employerAccountsKey = "workplace_match_employer_accounts";
const companyProfileKey = "workplace_match_employer_company_profile";
const activeRoleKey = "workplace_match_active_role";
const activeEmailKey = "workplace_match_active_email";
const stLouisCenter: Coordinates = [38.627, -90.1994];
const stClairCenter: Coordinates = [38.3453, -90.9807];

L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png"
});

export function AccountSettings() {
  const searchParams = useSearchParams();
  const [role, setRole] = useState<Role>("candidate");
  const [account, setAccount] = useState<LocalAccount | null>(null);
  const [settings, setSettings] = useState<SettingsState>({
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
  });
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isEditingMapLocation, setIsEditingMapLocation] = useState(false);
  const [draftMapPosition, setDraftMapPosition] = useState<Coordinates | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showPasswordSection, setShowPasswordSection] = useState(false);
  const applicantMarkerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    const resolvedRole = resolveRole(searchParams.get("role"));
    const activeRole = localStorage.getItem(activeRoleKey);
    if (activeRole !== resolvedRole) {
      window.location.href = resolvedRole === "employer" ? "/employer/login" : "/candidate/login";
      return;
    }

    const activeEmail = localStorage.getItem(activeEmailKey);
    const parsed =
      (activeEmail
        ? findAccountByEmail(getAccountsKey(resolvedRole), getAccountKey(resolvedRole), activeEmail)
        : null) ?? readAccounts(getAccountsKey(resolvedRole), getAccountKey(resolvedRole))[0] ?? null;

    if (!parsed) {
      window.location.href = resolvedRole === "employer" ? "/employer/login" : "/candidate/login";
      return;
    }

    setActiveAccount(getAccountKey(resolvedRole), activeRoleKey, activeEmailKey, resolvedRole, parsed);
    const profile = resolvedRole === "candidate" ? getCandidateProfile() : null;
    const employerCompanyProfile = resolvedRole === "employer" ? getEmployerCompanyProfile(parsed.email) : null;
    const fallbackName = profile?.fullName ?? "";
    setRole(resolvedRole);
    setAccount(parsed);
    setSettings(createSettingsState(parsed, fallbackName, profile, employerCompanyProfile));
    setCompanyProfile(employerCompanyProfile);
  }, [searchParams]);

  function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    console.log("Saving account settings");
    setError("");
    setMessage("");

    if (!account) {
      return;
    }

    if (settings.newPassword || settings.confirmPassword || settings.currentPassword) {
      if (settings.currentPassword !== account.password) {
        setError("Current password does not match.");
        return;
      }

      if (settings.newPassword !== settings.confirmPassword) {
        setError("New passwords do not match.");
        return;
      }

      if (!settings.newPassword) {
        setError("Enter a new password.");
        return;
      }
    }

    const normalizedEmail = normalizeEmail(settings.email);
    if (!normalizedEmail) {
      setError("Enter an email address.");
      return;
    }

    const previousEmail = account.email;
    if (normalizeEmail(previousEmail) !== normalizedEmail) {
      const duplicate = readAccounts(getAccountsKey(role), getAccountKey(role)).some(
        (storedAccount) => normalizeEmail(storedAccount.email) === normalizedEmail
      );

      if (duplicate) {
        setError("An account already exists with that email.");
        return;
      }
    }

    const updatedAccount: LocalAccount = {
      ...account,
      email: normalizedEmail,
      displayName: settings.displayName.trim(),
      companyName: role === "employer" ? settings.displayName.trim() : account.companyName,
      phone: settings.phone.trim(),
      streetAddress: settings.streetAddress.trim(),
      city: settings.city.trim(),
      state: settings.state.trim().toUpperCase(),
      zipCode: settings.zipCode.trim(),
      preferredContactMethods: mergeContactMethods(settings.preferredContactMethods),
      availabilityWindows: role === "employer" ? parseAvailabilityWindows(settings.availabilityText) : account.availabilityWindows,
      location: formatAccountLocation(settings),
      password: settings.newPassword ? settings.newPassword : account.password
    };

    saveAccountWithPossibleEmailChange(role, previousEmail, updatedAccount);
    setActiveAccount(getAccountKey(role), activeRoleKey, activeEmailKey, role, updatedAccount);
    if (role === "candidate") {
      syncCandidateProfileFromAccount(updatedAccount);
      logApplicantLocationSync(updatedAccount);
    }
    const updatedCompanyProfile = role === "employer" ? syncEmployerCompanyProfileFromSettings(updatedAccount, companyProfile, settings) : null;
    setAccount(updatedAccount);
    setCompanyProfile(updatedCompanyProfile);
    setSettings(createSettingsState(updatedAccount, updatedAccount.displayName ?? "", getCandidateProfile(), updatedCompanyProfile));
    setIsEditing(false);
    setMessage("Account settings saved.");
  }

  function updateField(field: keyof SettingsState, value: string) {
    setSettings((current) => {
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

  function updateContactPreference(index: number, method: ContactMethod) {
    setSettings((current) => {
      const nextMethods = [...current.preferredContactMethods];
      const existingIndex = nextMethods.indexOf(method);
      const previousMethod = nextMethods[index];

      nextMethods[index] = method;

      if (existingIndex >= 0 && existingIndex !== index) {
        nextMethods[existingIndex] = previousMethod;
      }

      return {
        ...current,
        preferredContactMethods: mergeContactMethods(nextMethods)
      };
    });
  }

  function cancelEditing() {
    if (!account) {
      return;
    }

    const profile = role === "candidate" ? getCandidateProfile() : null;
    setSettings(createSettingsState(account, profile?.fullName ?? "", profile, companyProfile));
    setError("");
    setMessage("");
    setIsEditing(false);
  }

  function startEditing(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    if (!account) {
      return;
    }

    console.log("Entering account edit mode");
    const profile = role === "candidate" ? getCandidateProfile() : null;
    setSettings(createSettingsState(account, profile?.fullName ?? "", profile, companyProfile));
    setMessage("");
    setError("");
    setIsEditing(true);
  }

  function showProfilePhotoComingSoon() {
    setError("");
    setMessage("Profile photo upload coming soon.");
  }

  function updateProfilePicture(file: File | null) {
    if (!file || !account || role !== "candidate") {
      return;
    }

    if (!file.type.startsWith("image/")) {
      setError("Choose an image file.");
      setMessage("");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const imageDataUrl = String(reader.result ?? "");
      if (!imageDataUrl) {
        return;
      }

      const updatedAccount: LocalAccount = { ...account, profilePictureDataUrl: imageDataUrl };
      saveAccountWithPossibleEmailChange(role, account.email, updatedAccount);
      setActiveAccount(getAccountKey(role), activeRoleKey, activeEmailKey, role, updatedAccount);
      syncCandidateProfileFromAccount(updatedAccount);
      setAccount(updatedAccount);
      setError("");
      setMessage("Profile picture updated.");
    };
    reader.readAsDataURL(file);
  }

  function clearProfilePicture() {
    if (!account || role !== "candidate") {
      return;
    }

    const updatedAccount: LocalAccount = { ...account, profilePictureDataUrl: "" };
    saveAccountWithPossibleEmailChange(role, account.email, updatedAccount);
    setActiveAccount(getAccountKey(role), activeRoleKey, activeEmailKey, role, updatedAccount);
    syncCandidateProfileFromAccount(updatedAccount);
    setAccount(updatedAccount);
    setError("");
    setMessage("Profile picture removed.");
  }

  const mapLocationResolution = useMemo(
    () => (role === "candidate" ? getApplicantMapLocationResolution(account) : null),
    [account, role]
  );
  const mapLocationPosition = isEditingMapLocation && draftMapPosition
    ? draftMapPosition
    : mapLocationResolution?.position ?? null;

  useEffect(() => {
    const marker = applicantMarkerRef.current;
    if (!marker?.dragging) {
      return;
    }

    if (isEditingMapLocation) {
      marker.dragging.enable();
    } else {
      marker.dragging.disable();
    }
  }, [isEditingMapLocation, mapLocationPosition]);

  function startMapLocationEdit() {
    if (!mapLocationPosition) {
      return;
    }

    setDraftMapPosition(mapLocationPosition);
    setMessage("");
    setError("");
    setIsEditingMapLocation(true);
  }

  function cancelMapLocationEdit() {
    setDraftMapPosition(null);
    setIsEditingMapLocation(false);
  }

  function saveManualMapLocation() {
    if (!account || !mapLocationPosition) {
      return;
    }

    const updatedAccount: LocalAccount = {
      ...account,
      manualMapLat: mapLocationPosition[0],
      manualMapLng: mapLocationPosition[1]
    };

    saveAccountWithPossibleEmailChange(role, account.email, updatedAccount);
    setActiveAccount(getAccountKey(role), activeRoleKey, activeEmailKey, role, updatedAccount);
    if (role === "candidate") {
      syncCandidateProfileFromAccount(updatedAccount);
    }
    setAccount(updatedAccount);
    setDraftMapPosition(null);
    setIsEditingMapLocation(false);
    setMessage("Map location saved.");
  }

  function updatePassword() {
    setError("");
    setMessage("");

    if (!account || role !== "employer") {
      return;
    }

    if (!settings.currentPassword || !settings.newPassword || !settings.confirmPassword) {
      setError("Enter your current password, new password, and confirmation.");
      return;
    }

    if (settings.currentPassword !== account.password) {
      setError("Current password does not match.");
      return;
    }

    if (settings.newPassword !== settings.confirmPassword) {
      setError("New passwords do not match.");
      return;
    }

    const updatedAccount: LocalAccount = {
      ...account,
      password: settings.newPassword
    };

    saveAccountWithPossibleEmailChange(role, account.email, updatedAccount);
    setActiveAccount(getAccountKey(role), activeRoleKey, activeEmailKey, role, updatedAccount);
    setAccount(updatedAccount);
    setSettings((current) => ({
      ...current,
      currentPassword: "",
      newPassword: "",
      confirmPassword: ""
    }));
    setMessage("Password updated.");
  }

  if (!account) {
    return (
      <section className="mx-auto max-w-3xl px-4 py-14">
        <p className="text-sm text-zinc-600">Loading account settings...</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-3xl px-4 py-14">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-red-800">
              Account
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-3">
            {isEditing ? (
              <>
                <button
                  type="submit"
                  form="account-settings-form"
                  className="inline-flex items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={cancelEditing}
                  className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={startEditing}
                className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-gray-50 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-100"
              >
                Edit
              </button>
            )}
          </div>
        </div>

        <form id="account-settings-form" onSubmit={saveSettings} className="mt-6 space-y-6">
          {role === "candidate" && isEditing ? (
            <section className="rounded-lg border border-gray-200 bg-gray-50 p-5">
              <div className="flex flex-wrap items-center gap-4">
                {account.profilePictureDataUrl ? (
                  <img
                    src={account.profilePictureDataUrl}
                    alt=""
                    className="h-14 w-14 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gray-200 text-zinc-500">
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className="h-9 w-9"
                      fill="currentColor"
                    >
                      <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4Z" />
                      <path d="M4.75 20c.75-3.16 3.57-5.5 7.25-5.5s6.5 2.34 7.25 5.5H4.75Z" />
                    </svg>
                  </div>
                )}
                <div>
                  <h2 className="text-sm font-semibold text-zinc-950">Profile photo</h2>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <label className="inline-flex cursor-pointer items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50">
                      Upload Profile Picture
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(event) => updateProfilePicture(event.target.files?.[0] ?? null)}
                        className="sr-only"
                      />
                    </label>
                    {account.profilePictureDataUrl ? (
                      <button
                        type="button"
                        onClick={clearProfilePicture}
                        className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          <section className="grid gap-4 md:grid-cols-2">
            {role === "candidate" ? (
              <>
                <EditableField label="Name" fullWidth>
                  <input
                    value={settings.displayName}
                    onChange={(event) => updateField("displayName", event.target.value)}
                    className={getFieldClassName(isEditing)}
                    readOnly={!isEditing}
                  />
                </EditableField>
                <EditableField label="Street address" fullWidth>
                  <input
                    value={settings.streetAddress}
                    onChange={(event) => updateField("streetAddress", event.target.value)}
                    className={getFieldClassName(isEditing)}
                    readOnly={!isEditing}
                  />
                </EditableField>
                <EditableField label="City">
                  <input
                    value={settings.city}
                    onChange={(event) => updateField("city", event.target.value)}
                    className={getFieldClassName(isEditing)}
                    readOnly={!isEditing}
                  />
                </EditableField>
                <div className="grid gap-4 sm:grid-cols-[5rem_minmax(0,1fr)]">
                  <EditableField label="State">
                    <StateAbbreviationSelect
                      value={settings.state}
                      onChange={(value) => updateField("state", value)}
                      className={getFieldClassName(isEditing)}
                      readOnly={!isEditing}
                    />
                  </EditableField>
                  <EditableField label="ZIP">
                    <input
                      value={settings.zipCode}
                      onChange={(event) => updateField("zipCode", event.target.value)}
                      className={getFieldClassName(isEditing)}
                      inputMode="numeric"
                      readOnly={!isEditing}
                    />
                  </EditableField>
                </div>
                <EditableField label="Email address">
                  <input
                    type="email"
                    value={settings.email}
                    onChange={(event) => updateField("email", event.target.value)}
                    className={getFieldClassName(isEditing)}
                    readOnly={!isEditing}
                  />
                </EditableField>
                <EditableField label="Contact phone">
                  <input
                    value={settings.phone}
                    onChange={(event) => updateField("phone", event.target.value)}
                    className={getFieldClassName(isEditing)}
                    inputMode="tel"
                    readOnly={!isEditing}
                  />
                </EditableField>
              </>
            ) : (
              <>
                <EditableField label="Email address">
                  <input
                    type="email"
                    value={settings.email}
                    onChange={(event) => updateField("email", event.target.value)}
                    className={getFieldClassName(isEditing)}
                    readOnly={!isEditing}
                  />
                </EditableField>
                <EditableField label="Company Name">
                  <input
                    value={settings.displayName}
                    onChange={(event) => updateField("displayName", event.target.value)}
                    className={getFieldClassName(isEditing)}
                    readOnly={!isEditing}
                  />
                </EditableField>
                <EditableField label="Contact phone">
                  <input
                    value={settings.phone}
                    onChange={(event) => updateField("phone", event.target.value)}
                    className={getFieldClassName(isEditing)}
                    inputMode="tel"
                    readOnly={!isEditing}
                  />
                </EditableField>
                <EditableField label="Street address" fullWidth>
                  <input
                    value={settings.streetAddress}
                    onChange={(event) => updateField("streetAddress", event.target.value)}
                    className={getFieldClassName(isEditing)}
                    readOnly={!isEditing}
                  />
                </EditableField>
                <EditableField label="City">
                  <input
                    value={settings.city}
                    onChange={(event) => updateField("city", event.target.value)}
                    className={getFieldClassName(isEditing)}
                    readOnly={!isEditing}
                  />
                </EditableField>
                <div className="grid gap-4 sm:grid-cols-[5rem_minmax(0,1fr)]">
                  <EditableField label="State">
                    <StateAbbreviationSelect
                      value={settings.state}
                      onChange={(value) => updateField("state", value)}
                      className={getFieldClassName(isEditing)}
                      readOnly={!isEditing}
                    />
                  </EditableField>
                  <EditableField label="ZIP">
                    <input
                      value={settings.zipCode}
                      onChange={(event) => updateField("zipCode", event.target.value)}
                      className={getFieldClassName(isEditing)}
                      inputMode="numeric"
                      readOnly={!isEditing}
                    />
                  </EditableField>
                </div>
              </>
            )}
          </section>

          <section className="rounded-lg border border-gray-200 bg-gray-50 p-5">
            <h2 className="text-sm font-semibold text-zinc-950">Preferred Contact Method</h2>
            <p className="mt-1 text-sm leading-5 text-zinc-600">
              Rank how you prefer mutual matches to reach you.
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {settings.preferredContactMethods.map((method, index) => (
                <label key={`${method}-${index}`} className="space-y-2">
                  <span className="label">{index + 1}</span>
                  <select
                    value={method}
                    onChange={(event) => updateContactPreference(index, event.target.value as ContactMethod)}
                    className={getFieldClassName(isEditing)}
                    disabled={!isEditing}
                  >
                    <option value="email">Email</option>
                    <option value="text">Text</option>
                    <option value="call">Call</option>
                  </select>
                </label>
              ))}
            </div>
          </section>

          {role === "employer" ? (
            <section className="rounded-lg border border-gray-200 bg-gray-50 p-5">
              <h2 className="text-sm font-semibold text-zinc-950">Availability</h2>
              <p className="mt-1 text-sm leading-5 text-zinc-600">
                Add simple time windows applicants can choose from after a mutual match.
              </p>
              <textarea
                value={settings.availabilityText}
                onChange={(event) => updateField("availabilityText", event.target.value)}
                rows={4}
                className={`${getFieldClassName(isEditing)} mt-4`}
                placeholder={"Monday 9:00 AM - 11:00 AM\nWednesday 1:00 PM - 3:00 PM"}
                readOnly={!isEditing}
              />
            </section>
          ) : null}

          {role === "candidate" ? (
            <section className="rounded-lg border border-gray-200 bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-950">Map location</h2>
                  <p className="mt-1 text-sm leading-5 text-zinc-600">
                    Your exact map placement is only shown to you. Employers see your generalized ZIP area.
                  </p>
                  <p className="mt-2 text-xs font-semibold text-zinc-700">
                    Source: {mapLocationResolution?.source ?? "unresolved"}
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  {isEditingMapLocation ? (
                    <>
                      <button
                        type="button"
                        onClick={saveManualMapLocation}
                        className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-zinc-100 px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:bg-zinc-200"
                      >
                        Save location
                      </button>
                      <button
                        type="button"
                        onClick={cancelMapLocationEdit}
                        className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:bg-zinc-50"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={startMapLocationEdit}
                      disabled={!mapLocationPosition}
                      className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Edit my map location
                    </button>
                  )}
                </div>
              </div>
              {mapLocationPosition ? (
                <div className="mt-4 h-72 overflow-hidden rounded-md border border-gray-200">
                  <MapContainer
                    center={mapLocationPosition}
                    zoom={14}
                    minZoom={8}
                    zoomControl={false}
                    className="h-full w-full"
                  >
                    <ZoomControl position="bottomright" />
                    <TileLayer
                      attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                      url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    />
                    <Marker
                      key={isEditingMapLocation ? "account-map-me-editing" : "account-map-me-view"}
                      ref={applicantMarkerRef}
                      position={mapLocationPosition}
                      icon={createApplicantAreaIcon(account.profilePictureDataUrl)}
                      interactive
                      draggable={isEditingMapLocation}
                      eventHandlers={
                        isEditingMapLocation
                          ? {
                              dragend: (event) => {
                                const marker = event.target as L.Marker;
                                const nextPosition = marker.getLatLng();
                                setDraftMapPosition([nextPosition.lat, nextPosition.lng]);
                              }
                            }
                          : undefined
                      }
                    />
                  </MapContainer>
                </div>
              ) : (
                <p className="mt-4 rounded-md border border-dashed border-gray-300 bg-gray-50 p-3 text-sm text-zinc-600">
                  Add a ZIP or address first to set your map location.
                </p>
              )}
              {isEditingMapLocation ? (
                <p className="mt-3 text-xs leading-5 text-zinc-600">
                  Drag the stick figure to the right spot, then save the location.
                </p>
              ) : null}
            </section>
          ) : null}

          <section className="rounded-lg border border-gray-200 bg-gray-50 p-5">
            <h2 className="text-sm font-semibold text-zinc-950">Password update</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <EditableField label="Current password">
                <PasswordVisibilityField
                  value={settings.currentPassword}
                  isVisible={showPasswordSection}
                  onChange={(value) => updateField("currentPassword", value)}
                  onToggle={() => setShowPasswordSection((current) => !current)}
                  className={getFieldClassName(role === "employer" || isEditing)}
                  readOnly={role !== "employer" && !isEditing}
                />
              </EditableField>
              <EditableField label="New password">
                <PasswordVisibilityField
                  value={settings.newPassword}
                  isVisible={showPasswordSection}
                  onChange={(value) => updateField("newPassword", value)}
                  className={getFieldClassName(role === "employer" || isEditing)}
                  readOnly={role !== "employer" && !isEditing}
                />
              </EditableField>
              <EditableField label="Confirm new password">
                <PasswordVisibilityField
                  value={settings.confirmPassword}
                  isVisible={showPasswordSection}
                  onChange={(value) => updateField("confirmPassword", value)}
                  className={getFieldClassName(role === "employer" || isEditing)}
                  readOnly={role !== "employer" && !isEditing}
                />
              </EditableField>
            </div>
            {role === "employer" ? (
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={updatePassword}
                  className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
                >
                  Update Password
                </button>
              </div>
            ) : null}
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-zinc-950">Security & permissions</h2>
              <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-semibold text-zinc-500">
                Placeholder
              </span>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <Placeholder label="Two-factor authentication" value="Coming soon" />
              <Placeholder label="User permissions" value="Coming soon" />
              <Placeholder label="Login history" value="Coming soon" />
            </div>
          </section>

          {error ? <p className="text-sm font-semibold text-red-700">{error}</p> : null}
          {message ? <p className="text-sm font-semibold text-green-700">{message}</p> : null}

        </form>
      </div>
    </section>
  );
}

function resolveRole(roleParam: string | null): Role {
  if (roleParam === "employer") {
    return "employer";
  }

  if (roleParam === "candidate") {
    return "candidate";
  }

  const activeRole = localStorage.getItem(activeRoleKey);
  return activeRole === "employer" ? "employer" : "candidate";
}

function getAccountKey(role: Role) {
  return role === "employer" ? employerAccountKey : candidateAccountKey;
}

function getAccountsKey(role: Role) {
  return role === "employer" ? employerAccountsKey : candidateAccountsKey;
}

function getCandidateProfile() {
  const savedProfile = localStorage.getItem(candidateProfileKey);
  if (!savedProfile) {
    return null;
  }

  try {
    return JSON.parse(savedProfile) as {
      candidateEmail?: string;
      fullName?: string;
      streetAddress?: string;
      city?: string;
      state?: string;
      zipCode?: string;
      manualMapLat?: number;
      manualMapLng?: number;
      profilePictureDataUrl?: string;
      updatedAt?: string;
    };
  } catch {
    return null;
  }
}

function getEmployerCompanyProfile(employerEmail: string) {
  const savedProfile = localStorage.getItem(companyProfileKey);
  if (!savedProfile) {
    return null;
  }

  try {
    const profile = JSON.parse(savedProfile) as CompanyProfile;
    return profile.employerEmail === employerEmail ? profile : null;
  } catch {
    return null;
  }
}

function createSettingsState(
  account: LocalAccount,
  fallbackName = "",
  profile: ReturnType<typeof getCandidateProfile> = null,
  companyProfile: CompanyProfile | null = null
): SettingsState {
  return {
    email: account.email,
    displayName: companyProfile?.companyName ?? account.companyName ?? account.displayName ?? fallbackName,
    phone: account.phone ?? "",
    streetAddress: companyProfile?.streetAddress ?? account.streetAddress ?? profile?.streetAddress ?? "",
    city: companyProfile?.city ?? account.city ?? profile?.city ?? "",
    state: companyProfile?.state ?? account.state ?? profile?.state ?? "",
    zipCode: companyProfile?.zipCode ?? account.zipCode ?? profile?.zipCode ?? "",
    preferredContactMethods: getPreferredContactMethods(account),
    availabilityText: formatAvailabilityWindows(account.availabilityWindows),
    currentPassword: "",
    newPassword: "",
    confirmPassword: ""
  };
}

function syncEmployerCompanyProfileFromSettings(
  account: LocalAccount,
  existingProfile: CompanyProfile | null,
  settings: SettingsState
) {
  const nextProfile: CompanyProfile = {
    ...existingProfile,
    employerEmail: account.email,
    companyName: settings.displayName.trim(),
    industry: existingProfile?.industry ?? "",
    streetAddress: settings.streetAddress.trim(),
    city: settings.city.trim(),
    state: settings.state.trim().toUpperCase(),
    zipCode: settings.zipCode.trim()
  };

  localStorage.setItem(companyProfileKey, JSON.stringify(nextProfile));
  return nextProfile;
}

function saveAccountWithPossibleEmailChange(role: Role, previousEmail: string, updatedAccount: LocalAccount) {
  const accountsKey = getAccountsKey(role);
  const accountKey = getAccountKey(role);
  const previousNormalizedEmail = normalizeEmail(previousEmail);
  const accounts = readAccounts(accountsKey, accountKey);
  const existingAccountIndex = accounts.findIndex(
    (storedAccount) => normalizeEmail(storedAccount.email) === previousNormalizedEmail
  );
  const updatedAccounts =
    existingAccountIndex >= 0
      ? accounts.map((storedAccount, index) => (index === existingAccountIndex ? updatedAccount : storedAccount))
      : [updatedAccount, ...accounts];

  localStorage.setItem(accountsKey, JSON.stringify(updatedAccounts));
}

function syncCandidateProfileFromAccount(account: LocalAccount) {
  const profile = getCandidateProfile();
  if (!profile) {
    return;
  }

  localStorage.setItem(
    candidateProfileKey,
    JSON.stringify({
      ...profile,
      candidateEmail: account.email,
      fullName: account.displayName?.trim() || profile.fullName || "",
      streetAddress: account.streetAddress ?? "",
      city: account.city ?? "",
      state: account.state ?? "",
      zipCode: account.zipCode ?? profile.zipCode ?? "",
      manualMapLat: account.manualMapLat,
      manualMapLng: account.manualMapLng,
      profilePictureDataUrl: account.profilePictureDataUrl ?? profile.profilePictureDataUrl ?? ""
    })
  );
}

function formatAccountLocation(settings: Pick<SettingsState, "streetAddress" | "city" | "state" | "zipCode">) {
  const cityStateZip = [settings.city, [settings.state, settings.zipCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");

  return [settings.streetAddress, cityStateZip].filter(Boolean).join(", ");
}

function parseAvailabilityWindows(value: string) {
  return value
    .split(/\r?\n/)
    .map((window) => window.trim())
    .filter(Boolean);
}

function formatAvailabilityWindows(windows: string[] | undefined) {
  return Array.isArray(windows) ? windows.join("\n") : "";
}

function logApplicantLocationSync(account: LocalAccount) {
  const savedLocation = {
    streetAddress: account.streetAddress ?? "",
    city: account.city ?? "",
    state: account.state ?? "",
    zipCode: account.zipCode ?? ""
  };
  const applicantViewCoordinates = getApplicantViewCoordinates(account);
  const employerViewCoordinates = getZipCoordinates(account.zipCode);

  console.log("Workplace Match: saved applicant location.", savedLocation);
  console.log("Workplace Match: applicant-view resolved Me coordinates.", applicantViewCoordinates);
  console.log("Workplace Match: employer-view ZIP coordinates.", employerViewCoordinates);
}

function getApplicantViewCoordinates(account: LocalAccount) {
  return getManualCoordinates(account) ?? getExactAddressCoordinates(account) ?? getZipCoordinates(account.zipCode);
}

function getApplicantMapLocationResolution(account: LocalAccount | null): {
  position: Coordinates | null;
  source: "manual coordinates" | "address" | "ZIP" | "unresolved";
} {
  if (!account) {
    return { position: null, source: "unresolved" };
  }

  const manualCoordinates = getManualCoordinates(account);
  if (manualCoordinates) {
    return { position: manualCoordinates, source: "manual coordinates" };
  }

  const addressCoordinates = getExactAddressCoordinates(account);
  if (addressCoordinates) {
    return { position: addressCoordinates, source: "address" };
  }

  const zipCoordinates = getZipCoordinates(account.zipCode);
  if (zipCoordinates) {
    return { position: zipCoordinates, source: "ZIP" };
  }

  return { position: null, source: "unresolved" };
}

function getManualCoordinates(account: LocalAccount) {
  if (typeof account.manualMapLat !== "number" || typeof account.manualMapLng !== "number") {
    return null;
  }

  return [account.manualMapLat, account.manualMapLng] as Coordinates;
}

function getExactAddressCoordinates(account: LocalAccount) {
  const normalizedAddress = normalizeAddress(
    [account.streetAddress, account.city, account.state, account.zipCode].filter(Boolean).join(" ")
  );
  const knownExactAddresses: Record<string, Coordinates> = {
    "213 main st fenton mo 63026": [38.5137, -90.4374],
    "1 main st valley park mo 63088": [38.5497, -90.4928],
    "1 e main st washington mo 63090": [38.5588, -91.0114]
  };

  return knownExactAddresses[normalizedAddress] ?? null;
}

function getZipCoordinates(zipCode?: string) {
  const normalizedZip = zipCode?.replace(/\D/g, "") ?? "";
  const knownExactZips: Record<string, Coordinates> = {
    "63026": [38.5131, -90.4359],
    "63077": stClairCenter,
    "63088": [38.5548, -90.4926],
    "63090": [38.5581, -91.0121],
    "63101": stLouisCenter,
    "63102": [38.6257, -90.1848],
    "63103": [38.6312, -90.2146],
    "63104": [38.6107, -90.2126],
    "63105": [38.6426, -90.3237],
    "63110": [38.6207, -90.2557],
    "63118": [38.5948, -90.2294],
    "63122": [38.5789, -90.4068],
    "63123": [38.5492, -90.3276],
    "63129": [38.4567, -90.3237],
    "63301": [38.7881, -90.4974],
    "63303": [38.7545, -90.5468],
    "63304": [38.7326, -90.6351]
  };

  return knownExactZips[normalizedZip] ?? null;
}

function normalizeAddress(value: string) {
  return value
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getFieldClassName(isEditing: boolean) {
  return isEditing ? "field" : "field cursor-default bg-gray-50 text-zinc-700";
}

function createApplicantAreaIcon(profilePictureDataUrl = "") {
  const markerHtml = profilePictureDataUrl
    ? `<img src="${profilePictureDataUrl}" alt="" style="display:block;width:28px;height:28px;border-radius:9999px;object-fit:cover;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);cursor:grab;pointer-events:auto;" />`
    : '<div style="font-size:28px;line-height:28px;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4));cursor:grab;pointer-events:auto;">🙂</div>';

  return L.divIcon({
    className: "me-marker",
    html: markerHtml,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14]
  });
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-zinc-950">{value}</p>
    </div>
  );
}

function EditableField({
  label,
  fullWidth = false,
  children
}: {
  label: string;
  fullWidth?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`space-y-2 ${fullWidth ? "md:col-span-2" : ""}`}>
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function Placeholder({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
      <p className="text-sm font-semibold text-zinc-950">{label}</p>
      <p className="mt-2 text-sm text-zinc-500">{value}</p>
    </div>
  );
}
