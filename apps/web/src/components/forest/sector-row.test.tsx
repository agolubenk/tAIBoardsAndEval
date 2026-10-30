import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ForestSector } from "./forest-types";
import { SectorRow } from "./sector-row";

afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/format", () => ({ formatDateShort: (value: string) => value }));

vi.mock("./fell-dialog", () => ({ FellDialog: () => null }));

function sector(id: string, name: string) {
  return {
    id,
    name,
    treeIds: [],
    detectedBy: "agent",
    createdAt: "2026-10-30T10:00:00.000Z",
  } as unknown as ForestSector;
}

describe("SectorRow", () => {
  it("brings the sector the palette jumped to into view and focuses it", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    render(
      <ul>
        <SectorRow
          workspaceId="workspace-1"
          sector={sector("sector-1", "Auth")}
          trees={new Map()}
        />
        <SectorRow
          workspaceId="workspace-1"
          sector={sector("sector-2", "Billing")}
          trees={new Map()}
          focused
        />
      </ul>,
    );

    const target = screen.getByText("Billing").closest("li");
    expect(document.activeElement).toBe(target);
    expect(target).toHaveAttribute("aria-current", "location");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Auth").closest("li")).not.toHaveAttribute(
      "aria-current",
    );
  });
});
