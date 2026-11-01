import { describe, expect, it } from "vite-plus/test";
import {
  isValidSignInLogin,
  LOCAL_ADMIN_EMAIL,
  resolveSignInEmail,
} from "./local-admin-login";

describe("resolveSignInEmail", () => {
  it("maps the local admin login to its seeded email", () => {
    expect(resolveSignInEmail("admin")).toBe(LOCAL_ADMIN_EMAIL);
    expect(resolveSignInEmail("  Admin ")).toBe(LOCAL_ADMIN_EMAIL);
  });

  it("passes other logins through trimmed", () => {
    expect(resolveSignInEmail(" user@example.com ")).toBe("user@example.com");
    expect(resolveSignInEmail("administrator")).toBe("administrator");
  });
});

describe("isValidSignInLogin", () => {
  it("accepts emails and the admin alias only", () => {
    expect(isValidSignInLogin("admin")).toBe(true);
    expect(isValidSignInLogin("user@example.com")).toBe(true);
    expect(isValidSignInLogin("root")).toBe(false);
    expect(isValidSignInLogin("")).toBe(false);
  });
});
