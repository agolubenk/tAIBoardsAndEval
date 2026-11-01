import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ForestJournalEntry } from "./forest-types";
import { JournalTab } from "./journal-tab";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values ? `${key} ${Object.values(values).join(" ")}` : key,
  }),
}));

vi.mock("@/lib/format", () => ({
  formatDateTime: (value: string) => value,
  formatRelativeTime: () => "5 min ago",
}));

vi.mock("./forest-task-link", () => ({
  ForestTaskLink: ({ title }: { title: string }) => <a href="#card">{title}</a>,
}));

const state = vi.hoisted(() => ({
  items: [] as unknown[],
  filters: [] as unknown[],
}));

vi.mock("@/hooks/queries/forest/use-journal", () => ({
  default: (_workspaceId: string, filter: unknown) => {
    state.filters.push(filter);
    return {
      data: { pages: [{ items: state.items, nextCursor: null }] },
      isLoading: false,
      isError: false,
      hasNextPage: false,
    };
  },
}));

function entry(overrides: Partial<ForestJournalEntry>): ForestJournalEntry {
  return {
    id: "j1",
    actorKind: "agent",
    actorName: "dev #1",
    action: "task.update",
    targetType: "task",
    targetId: "t1",
    outcome: "allowed",
    detail: "status",
    createdAt: "2026-10-29T05:00:00.000Z",
    taskNumber: 7,
    taskTitle: "Аренда",
    projectId: "p1",
    projectName: "t-boards",
    ...overrides,
  };
}

describe("JournalTab", () => {
  it("shows each action with its card, and a gone card by its id", () => {
    state.items = [
      entry({}),
      entry({
        id: "j2",
        action: "fell",
        targetId: "gone-1",
        outcome: "denied",
        detail: null,
        taskTitle: null,
        projectId: null,
        projectName: null,
      }),
    ];

    render(<JournalTab workspaceId="ws" />);

    expect(screen.getByRole("link", { name: "Аренда" })).toBeTruthy();
    expect(screen.getByText("t-boards")).toBeTruthy();
    expect(screen.getByText("status")).toBeTruthy();
    expect(
      screen.getByText("workspace:forest.journal.target task gone-1"),
    ).toBeTruthy();
    expect(screen.getAllByText("workspace:forest.journal.denied")).toHaveLength(
      1,
    );
  });

  it("asks for agents by default and for refusals once switched", () => {
    state.items = [];
    state.filters = [];

    render(<JournalTab workspaceId="ws" />);
    expect(state.filters.at(-1)).toEqual({ actor: "agent", denied: false });
    expect(screen.getByText("workspace:forest.journal.empty")).toBeTruthy();

    fireEvent.click(screen.getByRole("switch"));
    expect(state.filters.at(-1)).toEqual({ actor: "agent", denied: true });
  });
});
