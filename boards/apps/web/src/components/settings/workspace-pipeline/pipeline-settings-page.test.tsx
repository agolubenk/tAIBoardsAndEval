import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

const mutate = vi.fn();
const state = {
  canEdit: true,
  settings: {
    automation: true,
    toggles: {
      abJudge: true,
      askOnce: true,
      handoffDupes: true,
      successorAuto: true,
      grillHint: true,
      nerveWakes: true,
      swarm: false,
      councilReview: true,
      cardAutofill: true,
    },
    updatedAt: null,
    updatedBy: null,
  } as { automation: boolean; toggles: Record<string, boolean> } | undefined,
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/page-title", () => ({ default: () => null }));
vi.mock("@/hooks/queries/workspace/use-active-workspace", () => ({
  default: () => ({ data: { id: "ws-1", name: "Product" } }),
}));
vi.mock("@/hooks/queries/pipeline-settings/use-pipeline-settings", () => ({
  default: () => ({
    data: state.settings,
    isPending: !state.settings,
    isError: false,
  }),
}));
vi.mock(
  "@/hooks/mutations/pipeline-settings/use-update-pipeline-settings",
  () => ({
    default: () => ({ mutate }),
  }),
);
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({ canManageSettings: () => state.canEdit }),
}));

const { PipelineSettingsPage } = await import("./pipeline-settings-page");

const sw = (key: string) =>
  screen.getByRole("switch", {
    name: `settings:workspacePipeline.toggles.${key}.title`,
  });

describe("PipelineSettingsPage", () => {
  beforeEach(() => {
    mutate.mockReset();
    state.canEdit = true;
  });
  afterEach(cleanup);

  it("shows every switch with its stored value and saves one change", () => {
    render(<PipelineSettingsPage />);
    expect(sw("swarm").getAttribute("aria-checked")).toBe("false");
    expect(sw("cardAutofill").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw("cardAutofill"));
    expect(mutate).toHaveBeenCalledWith({ toggles: { cardAutofill: false } });
  });

  it("is read-only for people who cannot manage settings", () => {
    state.canEdit = false;
    render(<PipelineSettingsPage />);
    expect(
      screen.getByText("settings:workspacePipeline.readOnly"),
    ).toBeTruthy();
    expect(sw("swarm").hasAttribute("data-disabled")).toBe(true);
    fireEvent.click(sw("swarm"));
    expect(mutate).not.toHaveBeenCalled();
  });
});
