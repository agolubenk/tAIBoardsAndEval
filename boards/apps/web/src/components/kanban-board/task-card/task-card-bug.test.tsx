import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { TaskCardBug } from "./task-card-bug";

const bugs = new Map([
  ["bug", { taskId: "bug", severity: "high" }],
  ["plain", { taskId: "plain", severity: null }],
]);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/queries/forest/use-board-bugs", () => ({
  default: () => ({ data: bugs }),
}));

afterEach(cleanup);

const renderCard = (taskId: string) =>
  render(<TaskCardBug workspaceId="w" projectId="p" taskId={taskId} />);

describe("TaskCardBug", () => {
  it("marks a bug with its severity", () => {
    renderCard("bug");
    expect(screen.getByText("tasks:card.kind.bug")).toBeVisible();
    expect(screen.getByText("· high")).toBeVisible();
  });

  it("marks a bug without a severity", () => {
    renderCard("plain");
    expect(screen.getByText("tasks:card.kind.bug")).toBeVisible();
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it("leaves a task unmarked", () => {
    const { container } = renderCard("task");
    expect(container).toBeEmptyDOMElement();
  });
});
