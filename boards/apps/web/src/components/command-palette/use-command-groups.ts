import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShortcutsPanelStore } from "@/components/shortcuts/shortcuts-panel-store";
import useGetConfig from "@/hooks/queries/config/use-get-config";
import { authClient } from "@/lib/auth-client";
import { hasInstanceAdminRole } from "@/lib/instance-admin";
import { useUserPreferencesStore } from "@/store/user-preferences";
import type { PaletteGroup } from "./palette-filter";

// The dialogs these commands open live in the palette's shell, which stays on
// the page while the palette itself is closed.
export type PaletteActions = {
  openSearch: () => void;
  createTask: () => void;
  createProject: () => void;
  createWorkspace: () => void;
};

export function useCommandGroups(
  workspaceId: string | undefined,
  actions: PaletteActions,
): PaletteGroup[] {
  const { t } = useTranslation();
  const { setTheme } = useUserPreferencesStore();
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const { data: config } = useGetConfig();
  const isAdmin = hasInstanceAdminRole(session?.user?.role);
  const canCreateWorkspace =
    isAdmin || (config !== undefined && !config.disableWorkspaceCreation);
  const openShortcutsPanel = useShortcutsPanelStore((state) => state.setOpen);

  return useMemo<PaletteGroup[]>(
    () => [
      {
        value: "suggestions",
        label: t("navigation:commandPalette.suggestions"),
        kind: "command",
        items: [
          {
            value: "projects",
            label: t("navigation:commandPalette.projects"),
            shortcutId: "goToProjects",
            onRun: () => {
              if (!workspaceId) return;
              navigate({
                to: "/dashboard/workspace/$workspaceId/projects",
                params: { workspaceId },
              });
            },
          },
          {
            value: "search",
            label: t("navigation:commandPalette.search"),
            shortcutId: "openSearch",
            onRun: actions.openSearch,
          },
          {
            value: "members",
            label: t("navigation:commandPalette.members", {
              defaultValue: "Members",
            }),
            onRun: () => {
              navigate({ to: "/dashboard/settings/workspace/members" });
            },
          },
          {
            value: "create-task",
            label: t("navigation:commandPalette.createTask"),
            shortcutId: "createTask",
            onRun: actions.createTask,
          },
          {
            value: "create-project",
            label: t("navigation:commandPalette.createProject"),
            shortcutId: "createProject",
            onRun: actions.createProject,
          },
        ],
      },
      {
        value: "commands",
        label: t("navigation:commandPalette.commands"),
        kind: "command",
        items: [
          ...(canCreateWorkspace
            ? [
                {
                  value: "create-workspace",
                  label: t("navigation:commandPalette.createWorkspace"),
                  onRun: actions.createWorkspace,
                },
              ]
            : []),
          {
            value: "theme-light",
            label: t("navigation:commandPalette.lightTheme"),
            onRun: () => setTheme("light"),
          },
          {
            value: "theme-dark",
            label: t("navigation:commandPalette.darkTheme"),
            onRun: () => setTheme("dark"),
          },
          {
            value: "theme-system",
            label: t("navigation:commandPalette.systemTheme"),
            onRun: () => setTheme("system"),
          },
          {
            value: "keyboard-shortcuts",
            label: t("navigation:commandPalette.keyboardShortcuts"),
            shortcutId: "openShortcuts",
            onRun: () => openShortcutsPanel(true),
          },
        ],
      },
    ],
    [
      actions,
      canCreateWorkspace,
      navigate,
      openShortcutsPanel,
      setTheme,
      t,
      workspaceId,
    ],
  );
}
