export type LocalAccount = {
  email: string;
  password: string;
  displayName?: string;
  phone?: string;
  location?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  manualMapLat?: number;
  manualMapLng?: number;
  profilePictureDataUrl?: string;
  profileComplete?: boolean;
  companyProfileComplete?: boolean;
  companyName?: string;
  preferredContactMethods?: ("email" | "text" | "call")[];
  availabilityWindows?: string[];
  createdAt?: string;
};

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function readAccounts() {
  return [] as LocalAccount[];
}

export function findAccountByEmail() {
  return null;
}

export function saveNewAccount() {
  return { ok: false as const, reason: "supabase_auth_required" as const };
}

export function setActiveAccount() {
  return;
}

export function updateStoredAccount() {
  return;
}
