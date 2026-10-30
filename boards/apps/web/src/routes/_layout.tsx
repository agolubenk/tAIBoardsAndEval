import { createFileRoute, Outlet } from "@tanstack/react-router";
import CommandPalette from "@/components/command-palette";

// layout for the main app
export const Route = createFileRoute("/_layout")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <>
      <Outlet />
      <CommandPalette />
    </>
  );
}
