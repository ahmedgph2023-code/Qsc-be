/** Username that may run QSC historical-sheet import. Not a secret. */
export const SUPER_ADMIN_USERNAME = process.env.SUPER_ADMIN_USERNAME || "super_admin@gmail.com";

export function isSuperAdminUsername(username?: string | null): boolean {
  return (username || "").trim().toLowerCase() === SUPER_ADMIN_USERNAME.toLowerCase();
}
