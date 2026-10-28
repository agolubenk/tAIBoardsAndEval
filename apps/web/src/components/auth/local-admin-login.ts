import { z } from "zod/v4";

// t-boards: inside the private network the owner signs in as admin/admin
// (spec R-006). The account is seeded by apps/api/scripts/seed-local-admin.ts
// under this email; the login field accepts the short name as an alias.
export const LOCAL_ADMIN_LOGIN = "admin";
export const LOCAL_ADMIN_EMAIL = "admin@t-boards.local";

export function resolveSignInEmail(login: string): string {
  const value = login.trim();
  return value.toLowerCase() === LOCAL_ADMIN_LOGIN ? LOCAL_ADMIN_EMAIL : value;
}

export function isValidSignInLogin(login: string): boolean {
  return z.email().safeParse(resolveSignInEmail(login)).success;
}
