import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { PaletteContent } from "./palette-content";

const { navigate, setTheme, useSectors, useGlobalSearch } = vi.hoisted(() => ({
  navigate: vi.fn(),
  setTheme: vi.fn(),
  useSectors: vi.fn((_workspaceId: string) => ({
    data: [{ id: "sector-1", name: "Auth rework" }],
  })),
  useGlobalSearch: vi.fn((params: { q: string }) => ({
    data: params.q
      ? {
          results: [
            {
              id: "task-70",
              type: "task",
              title: "Palette for the forest",
              projectId: "project-1",
              projectSlug: "tb",
              taskNumber: 70,
            },
          ],
        }
      : undefined,
  })),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/queries/workspace/use-active-workspace", () => ({
  default: () => ({ data: { id: "workspace-1" } }),
}));
vi.mock("@/hooks/queries/forest/use-sectors", () => ({ default: useSectors }));
vi.mock("@/hooks/queries/search/use-global-search", () => ({
  default: useGlobalSearch,
}));
vi.mock("@/hooks/queries/config/use-get-config", () => ({
  default: () => ({ data: { disableWorkspaceCreation: false } }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: null }) },
}));
vi.mock("@/store/user-preferences", () => ({
  useUserPreferencesStore: () => ({ setTheme }),
}));
vi.mock("@/components/shortcuts/shortcut-keys", () => ({
  ShortcutKeys: () => null,
}));

const actions = {
  openSearch: vi.fn(),
  createTask: vi.fn(),
  createProject: vi.fn(),
  createWorkspace: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPalette() {
  render(<PaletteContent actions={actions} onRun={(run) => run()} />);
  return screen.getByPlaceholderText(
    "navigation:commandPalette.inputPlaceholder",
  );
}

describe("PaletteContent", () => {
  it("lists commands alone until something is typed", () => {
    renderPalette();

    expect(screen.getByText("navigation:commandPalette.projects")).toBeTruthy();
    expect(screen.queryByText("workspace:forest.tabs.leases")).toBeNull();
    expect(screen.queryByText("Auth rework")).toBeNull();
    // No sector or card request leaves before a query exists.
    expect(useSectors).toHaveBeenLastCalledWith("");
    expect(useGlobalSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "" }),
    );
  });

  it("opens a forest tab from the keyboard", () => {
    const input = renderPalette();

    fireEvent.change(input, { target: { value: "leases" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(navigate).toHaveBeenCalledWith({
      to: "/dashboard/workspace/$workspaceId/forest",
      params: { workspaceId: "workspace-1" },
      search: { tab: "leases", sector: undefined },
    });
  });

  it("jumps to a sector on the forest's sectors tab", () => {
    const input = renderPalette();

    fireEvent.change(input, { target: { value: "auth re" } });
    expect(useSectors).toHaveBeenLastCalledWith("workspace-1");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: { tab: "sectors", sector: "sector-1" },
      }),
    );
  });

  it("finds a card by its short id and opens it", async () => {
    const input = renderPalette();

    fireEvent.change(input, { target: { value: "TB-70" } });
    await waitFor(() =>
      expect(screen.getByText("Palette for the forest")).toBeTruthy(),
    );
    expect(screen.getByText("TB-70")).toBeTruthy();
    expect(useGlobalSearch).toHaveBeenLastCalledWith({
      q: "TB-70",
      type: "tasks",
      workspaceId: "workspace-1",
      limit: 8,
    });

    fireEvent.keyDown(input, { key: "Enter" });

    expect(navigate).toHaveBeenCalledWith({
      to: "/dashboard/workspace/$workspaceId/project/$projectId/task/$taskId",
      params: {
        workspaceId: "workspace-1",
        projectId: "project-1",
        taskId: "task-70",
      },
    });
  });

  it("moves between results with the arrow keys", () => {
    const input = renderPalette();

    fireEvent.change(input, { target: { value: "theme" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    // The first match (light) is highlighted on its own; one step down is dark.
    expect(setTheme).toHaveBeenCalledWith("dark");
  });
});
