import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { citationAnchor } from "./citation-anchor";
import { MessageItem } from "./message-item";
import type { NotebookCitation, NotebookMessage } from "./notebook-types";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const citation: NotebookCitation = {
  n: 1,
  chunkId: "chunk-1",
  kind: "repo-doc",
  ref: "docs/forest.md",
  title: "Лес",
  heading: "Аренда",
};

function message(overrides: Partial<NotebookMessage>): NotebookMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    status: "answered",
    citations: [citation],
    model: null,
    createdAt: "2026-10-28T20:00:00.000Z",
    ...overrides,
  };
}

describe("MessageItem", () => {
  it("turns known markers into buttons that bring the cited source into view", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    render(
      <MessageItem
        message={message({
          content: "Аренда до 2024 года [1], см. [2024].",
          model: "nvidia/nemotron",
        })}
      />,
    );

    const marker = screen.getByRole("button", { name: "[1]" });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText(/см\. \[2024\]\./)).toBeTruthy();
    expect(screen.getByText("nvidia/nemotron")).toBeTruthy();

    const item = document.getElementById(citationAnchor("m1", 1));
    expect(item?.textContent).toContain("Лес");
    expect(item?.textContent).toContain("docs/forest.md");

    fireEvent.click(marker);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(item);
  });

  it("explains a missing answer while still listing the sources", () => {
    render(
      <MessageItem
        message={message({ content: "", status: "retrieval-only" })}
      />,
    );

    expect(
      screen.getByText("workspace:notebook.chat.answerStatus.retrieval-only"),
    ).toBeTruthy();
    expect(document.getElementById(citationAnchor("m1", 1))).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says nothing was found when there are no sources", () => {
    render(
      <MessageItem
        message={message({ status: "retrieval-only", citations: [] })}
      />,
    );

    expect(
      screen.getByText("workspace:notebook.chat.answerStatus.nothingFound"),
    ).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("shows the reader's question as plain text", () => {
    render(
      <MessageItem
        message={message({
          role: "user",
          content: "<b>Когда</b> аренда?",
          status: null,
          citations: [],
        })}
      />,
    );

    expect(screen.getByText("<b>Когда</b> аренда?")).toBeTruthy();
    expect(screen.queryByRole("article")).toBeNull();
  });
});
