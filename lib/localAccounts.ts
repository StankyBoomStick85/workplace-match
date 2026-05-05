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

export function readAccounts(accountsKey: string, legacyAccountKey: string) {
  const accounts = parseStoredAccounts(localStorage.getItem(accountsKey));
  const legacyAccount = parseStoredAccount(localStorage.getItem(legacyAccountKey));
  const mergedAccounts = mergeAccounts(accounts, legacyAccount ? [legacyAccount] : []);

  if (legacyAccount || localStorage.getItem(accountsKey)) {
    localStorage.setItem(accountsKey, JSON.stringify(mergedAccounts));
  }

  return mergedAccounts;
}

export function findAccountByEmail(accountsKey: string, legacyAccountKey: string, email: string) {
  const normalizedEmail = normalizeEmail(email);

  return (
    readAccounts(accountsKey, legacyAccountKey).find(
      (account) => normalizeEmail(account.email) === normalizedEmail
    ) ?? null
  );
}

export function saveNewAccount(accountsKey: string, legacyAccountKey: string, account: LocalAccount) {
  const normalizedEmail = normalizeEmail(account.email);
  const accounts = readAccounts(accountsKey, legacyAccountKey);
  const duplicateExists = accounts.some((storedAccount) => normalizeEmail(storedAccount.email) === normalizedEmail);

  if (duplicateExists) {
    return { ok: false as const, reason: "duplicate" as const };
  }

  const nextAccount = { ...account, email: normalizedEmail };
  const updatedAccounts = [nextAccount, ...accounts];
  localStorage.setItem(accountsKey, JSON.stringify(updatedAccounts));
  localStorage.setItem(legacyAccountKey, JSON.stringify(nextAccount));

  return { ok: true as const, account: nextAccount };
}

export function setActiveAccount(
  legacyAccountKey: string,
  activeRoleKey: string,
  activeEmailKey: string,
  role: "candidate" | "employer",
  account: LocalAccount
) {
  localStorage.setItem(legacyAccountKey, JSON.stringify(account));
  localStorage.setItem(activeRoleKey, role);
  localStorage.setItem(activeEmailKey, account.email);
}

export function updateStoredAccount(accountsKey: string, legacyAccountKey: string, account: LocalAccount) {
  const normalizedEmail = normalizeEmail(account.email);
  const accounts = readAccounts(accountsKey, legacyAccountKey);
  const accountExists = accounts.some((storedAccount) => normalizeEmail(storedAccount.email) === normalizedEmail);
  const updatedAccounts = accountExists
    ? accounts.map((storedAccount) =>
        normalizeEmail(storedAccount.email) === normalizedEmail ? account : storedAccount
      )
    : [account, ...accounts];

  localStorage.setItem(accountsKey, JSON.stringify(updatedAccounts));
  localStorage.setItem(legacyAccountKey, JSON.stringify(account));
}

function parseStoredAccounts(value: string | null) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as LocalAccount[] | LocalAccount;
    return Array.isArray(parsed) ? parsed.filter(isAccountLike) : isAccountLike(parsed) ? [parsed] : [];
  } catch {
    return [];
  }
}

function parseStoredAccount(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as LocalAccount[] | LocalAccount;
    return Array.isArray(parsed) ? null : isAccountLike(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mergeAccounts(primaryAccounts: LocalAccount[], secondaryAccounts: LocalAccount[]) {
  const accountsByEmail = new Map<string, LocalAccount>();

  [...primaryAccounts, ...secondaryAccounts].forEach((account) => {
    const normalizedEmail = normalizeEmail(account.email);
    if (!normalizedEmail) {
      return;
    }

    accountsByEmail.set(normalizedEmail, account);
  });

  return Array.from(accountsByEmail.values());
}

function isAccountLike(value: unknown): value is LocalAccount {
  if (!value || typeof value !== "object") {
    return false;
  }

  const account = value as { email?: unknown; password?: unknown };
  return typeof account.email === "string" && typeof account.password === "string";
}
