import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ForestSession } from "./forest-types";
import { SessionsTab } from "./sessions-tab";

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
  data: undefined as ForestSession[] | undefined,
}));

vi.mock("@/hooks/queries/forest/use-work-state", () => ({
  default: () => ({ data: state.data, isLoading: false, isError: false }),
}));

function session(overrides: Partial<ForestSession>): ForestSession {
  return {
    actorName: "dev #1",
    actorKind: "agent",
    step: "Пишу тесты",
    branch: null,
    waiting: null,
    updatedAt: "2026-10-29T05:00:00.000Z",
    taskId: null,
    number: null,
    title: null,
    projectId: null,
    projectName: null,
    ...overrides,
  };
}

describe("SessionsTab", () => {
  it("shows each session's step, card, branch and what it waits for", () => {
    state.data = [
      session({
        taskId: "t1",
        number: 12,
        title: "Блокнот в UI",
        projectId: "p1",
        projectName: "t-boards",
        branch: "feat/notebook",
        waiting: "ревью",
      }),
      session({ actorName: "Owner", actorKind: "owner-ui", step: "Читаю" }),
    ];

    render(<SessionsTab workspaceId="ws" />);

    expect(screen.getByText("Пишу тесты")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Блокнот в UI" })).toBeTruthy();
    expect(screen.getByText("t-boards")).toBeTruthy();
    expect(
      screen.getByText("workspace:forest.sessions.branch feat/notebook"),
    ).toBeTruthy();
    expect(
      screen.getByText("workspace:forest.sessions.waiting ревью"),
    ).toBeTruthy();
    // A session without a card shows no link and no badges.
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText("Читаю")).toBeTruthy();
  });

  it("says so when no session has recorded its state", () => {
    state.data = [];

    render(<SessionsTab workspaceId="ws" />);

    expect(screen.getByText("workspace:forest.sessions.empty")).toBeTruthy();
  });
});
