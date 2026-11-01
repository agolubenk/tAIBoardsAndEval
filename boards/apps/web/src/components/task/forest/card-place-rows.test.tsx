import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CardPlaceRows } from "./card-place-rows";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${Object.values(values).join(" ")}` : key,
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="#sector">{children}</a>
  ),
}));

vi.mock("@/components/forest/forest-task-link", () => ({
  ForestTaskLink: ({ title }: { title: string }) => <a href="#card">{title}</a>,
}));

vi.mock("../properties/property-row", () => ({
  PropertyRow: ({
    label,
    children,
  }: {
    label: string;
    children: React.ReactNode;
  }) => (
    <div>
      <span>{label}</span>
      {children}
    </div>
  ),
}));

const state = vi.hoisted(() => ({ data: null as unknown }));

vi.mock("@/hooks/queries/forest/use-card-place", () => ({
  default: () => ({ data: state.data, isLoading: false, isError: false }),
}));

const count = (total: number, done: number) => ({ total, done });

describe("CardPlaceRows", () => {
  it("names a root and leaves the whole-tree row out", () => {
    state.data = {
      rootId: "t1",
      ancestors: [],
      hiddenAncestors: 0,
      subcards: count(3, 1),
      tree: count(3, 1),
      sectors: [],
    };
    render(<CardPlaceRows workspaceId="w1" taskId="t1" />);

    expect(screen.getByText("tasks:card.place.isRoot")).toBeTruthy();
    expect(screen.getByText("tasks:card.place.progress 1 3")).toBeTruthy();
    expect(screen.queryByText("tasks:card.place.tree")).toBeNull();
  });

  it("shows the parents, hidden ones counted, the tree's progress and sector", () => {
    state.data = {
      rootId: null,
      ancestors: [
        {
          id: "p1",
          number: 4,
          title: "Parent",
          projectId: "pr",
          projectSlug: "TB",
        },
      ],
      hiddenAncestors: 1,
      subcards: count(0, 0),
      tree: count(5, 2),
      sectors: [{ id: "s1", name: "Auth" }],
    };
    render(<CardPlaceRows workspaceId="w1" taskId="t2" />);

    expect(screen.getByText("tasks:card.place.hidden 1")).toBeTruthy();
    expect(screen.getByText("Parent")).toBeTruthy();
    expect(screen.getByText("tasks:card.place.none")).toBeTruthy();
    expect(screen.getByText("tasks:card.place.progress 2 5")).toBeTruthy();
    expect(screen.getByText("Auth")).toBeTruthy();
  });
});
