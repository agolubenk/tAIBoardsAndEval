import { useLocation } from "@tanstack/react-router";
import { lazy, Suspense, useMemo, useState } from "react";
import LazySearchCommandMenu from "@/components/search-command-menu/lazy-search-command-menu";
import CreateTaskModal from "@/components/shared/modals/create-task-modal";
import CreateWorkspaceModal from "@/components/shared/modals/create-workspace-modal";
import { useOpenedOnce } from "@/hooks/use-opened-once";
import { useShortcut } from "@/lib/shortcuts/use-shortcut";
import CreateProjectModal from "../shared/modals/create-project-modal";
import type { PaletteActions } from "./use-command-groups";

// Only the shortcuts and the dialogs the palette opens stay on every page; the
// palette's own code loads with its first open (R-090).
const CommandPaletteDialog = lazy(() => import("./command-palette-dialog"));

function CommandPalette() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const opened = useOpenedOnce(open);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isCreateTaskOpen, setIsCreateTaskOpen] = useState(false);
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false);
  const [isCreateWorkspaceOpen, setIsCreateWorkspaceOpen] = useState(false);
  const projectIdFromRoute =
    location.pathname.match(/\/project\/([^/]+)/)?.[1] ?? undefined;
  const isBacklogView = location.pathname.endsWith("/backlog");

  useShortcut("openCommandMenu", () => setOpen((prev) => !prev));
  useShortcut("createTask", () => setIsCreateTaskOpen(true));
  useShortcut("createProject", () => setIsCreateProjectOpen(true));

  const actions = useMemo<PaletteActions>(
    () => ({
      openSearch: () => setIsSearchOpen(true),
      createTask: () => setIsCreateTaskOpen(true),
      createProject: () => setIsCreateProjectOpen(true),
      createWorkspace: () => setIsCreateWorkspaceOpen(true),
    }),
    [],
  );

  return (
    <>
      {opened ? (
        <Suspense fallback={null}>
          <CommandPaletteDialog
            open={open}
            onOpenChange={setOpen}
            actions={actions}
          />
        </Suspense>
      ) : null}

      <LazySearchCommandMenu open={isSearchOpen} setOpen={setIsSearchOpen} />
      <CreateTaskModal
        open={isCreateTaskOpen}
        projectId={projectIdFromRoute}
        status={isBacklogView ? "planned" : undefined}
        onClose={() => setIsCreateTaskOpen(false)}
        instant
      />
      <CreateWorkspaceModal
        open={isCreateWorkspaceOpen}
        onClose={() => setIsCreateWorkspaceOpen(false)}
      />
      <CreateProjectModal
        open={isCreateProjectOpen}
        onClose={() => setIsCreateProjectOpen(false)}
      />
    </>
  );
}

export default CommandPalette;
