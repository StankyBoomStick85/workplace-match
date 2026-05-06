export const adminSessionKey = "workplace_match_admin_session";

export function setAdminSession() {
  document.cookie = `${adminSessionKey}=true; path=/; SameSite=Lax`;
}

export function clearAdminSession() {
  document.cookie = `${adminSessionKey}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
}

export function hasAdminSession() {
  return document.cookie
    .split(";")
    .map((cookie) => cookie.trim())
    .includes(`${adminSessionKey}=true`);
}
