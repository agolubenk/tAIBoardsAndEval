import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ForestGraphPage } from "../forest-types";
import { graphCard, graphPage } from "./graph-fixtures";
import { GraphTab } from "./graph-tab";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key} ${Object.values(values).join(" ")}` : key,
  }),
}));

vi.mock("../forest-task-link", () => ({
  ForestTaskLink: ({ title }: { title: string }) => <a href="#card">{title}</a>,
}));

const state = vi.hoisted(() => ({
  pages: [] as unknown[],
  hasNextPage: false,
  fetchNextPage: () => {},
}));

vi.mock("@/hooks/queries/forest/use-graph", () => ({
  default: () => ({
    data: { pages: state.pages },
    isLoading: false,
    isError: false,
    hasNextPage: state.hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: state.fetchNextPage,
  }),
}));

const small = graphPage({
  cards: [
    graphCard("a", { number: 7, title: "Вход", sectorIds: ["s1"] }),
    graphCard("b", { number: 8, title: "Отчёты", sectorIds: ["s1"] }),
  ],
  files: [{ id: "file:src/auth.ts", path: "src/auth.ts" }],
  decisions: [{ id: "decision:D-011", ref: "D-011" }],
  edges: [
    { source: "a", target: "b", type: "blocks" },
    { source: "a", target: "file:src/auth.ts", type: "file" },
    { source: "b", target: "decision:D-011", type: "decision" },
  ],
  sectors: [{ id: "s1", name: "Миграция auth" }],
});

const node = (name: string) => screen.getByRole("button", { name });

describe("GraphTab", () => {
  it("draws cards, files, decisions and the sector, and shows a node's links", () => {
    state.pages = [small];
    render(<GraphTab workspaceId="ws" />);

    expect(
      screen.getByText("workspace:forest.graph.counts 2 1 1"),
    ).toBeTruthy();
    expect(screen.getByText("Миграция auth")).toBeTruthy();
    node("workspace:forest.graph.node.file auth.ts");
    node("workspace:forest.graph.node.decision D-011");

    fireEvent.click(node("workspace:forest.graph.node.card #7 Вход"));
    expect(screen.getByText("Вход")).toBeTruthy();
    expect(
      screen.getByText("workspace:forest.graph.relation.blocks"),
    ).toBeTruthy();
    expect(
      screen.getByText("workspace:forest.graph.relation.file"),
    ).toBeTruthy();

    // Following a link selects the card at its other end.
    fireEvent.click(screen.getByRole("button", { name: "#8 Отчёты" }));
    expect(
      screen.getByText("workspace:forest.graph.relation.blockedBy"),
    ).toBeTruthy();
    expect(
      screen.getByText("workspace:forest.graph.relation.decision"),
    ).toBeTruthy();
  });

  it("hides files on request", () => {
    state.pages = [small];
    render(<GraphTab workspaceId="ws" />);
    const [filesSwitch] = screen.getAllByRole("switch");
    if (!filesSwitch) throw new Error("no switch");
    fireEvent.click(filesSwitch);
    expect(
      screen.queryByRole("button", {
        name: "workspace:forest.graph.node.file auth.ts",
      }),
    ).toBeNull();
    node("workspace:forest.graph.node.decision D-011");
  });

  it("draws more than 200 nodes by groups and opens a group on request", () => {
    const cards = Array.from({ length: 201 }, (_, at) =>
      graphCard(`c${at}`, {
        projectId: at < 150 ? "p1" : "p2",
        projectName: at < 150 ? "Ядро" : "Доки",
      }),
    );
    state.pages = [graphPage({ cards } satisfies Partial<ForestGraphPage>)];
    render(<GraphTab workspaceId="ws" />);

    expect(
      screen.getByText("workspace:forest.graph.clustered 200"),
    ).toBeTruthy();
    expect(
      screen.queryAllByRole("button", { name: /node\.card/ }),
    ).toHaveLength(0);
    fireEvent.click(node("workspace:forest.graph.node.cluster Доки 51"));
    fireEvent.click(
      screen.getByRole("button", { name: "workspace:forest.graph.expand 51" }),
    );
    expect(screen.getAllByRole("button", { name: /node\.card/ })).toHaveLength(
      51,
    );
    node("workspace:forest.graph.node.cluster Ядро 150");
    expect(
      screen.getByRole("button", {
        name: "workspace:forest.graph.collapseAll",
      }),
    ).toBeTruthy();
  });

  it("offers the next page and shows an empty graph", () => {
    const fetchNextPage = vi.fn();
    state.pages = [small];
    state.hasNextPage = true;
    state.fetchNextPage = fetchNextPage;
    render(<GraphTab workspaceId="ws" />);
    fireEvent.click(
      screen.getByRole("button", { name: "workspace:forest.graph.loadMore" }),
    );
    expect(fetchNextPage).toHaveBeenCalledOnce();
    cleanup();

    state.pages = [graphPage({})];
    state.hasNextPage = false;
    render(<GraphTab workspaceId="ws" />);
    expect(screen.getByText("workspace:forest.graph.empty")).toBeTruthy();
  });
});
