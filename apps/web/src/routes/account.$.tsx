import { createFileRoute, redirect } from "@tanstack/react-router";

// HR Helper's login lives at /account/login, and this host served HR Helper
// before t-boards: browsers still offer that address. Send it to our sign-in.
export const Route = createFileRoute("/account/$")({
  beforeLoad: () => {
    throw redirect({ to: "/auth/sign-in" });
  },
});
