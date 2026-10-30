import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { NotionConnectForm } from "@/components/import/connect-forms/notion-connect-form";
import { EMPTY_CONNECT_VALUES } from "@/components/import/connect-values";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

function renderWith(error: string | null, errorCode: string | null) {
  render(
    <NotionConnectForm
      values={EMPTY_CONNECT_VALUES}
      onChange={vi.fn()}
      error={error}
      errorCode={errorCode}
      trelloAuthorizeUrl={null}
    />,
  );
  return {
    token: screen.getByLabelText("settings:workspaceImport.notion.tokenLabel"),
    databases: screen.getByLabelText(
      "settings:workspaceImport.notion.databasesLabel",
    ),
  };
}

describe("NotionConnectForm", () => {
  it("shows an unshared database under the databases, not the token", () => {
    const { token, databases } = renderWith(
      "No database is shared with the integration yet.",
      "NOTION_NOTHING_SHARED",
    );

    expect(databases).toHaveAttribute("aria-invalid", "true");
    expect(databases).toHaveAccessibleDescription(
      /settings:workspaceImport\.notion\.errors\.nothingShared/,
    );
    expect(token).not.toHaveAttribute("aria-invalid");
  });

  it("calls a refused token invalid under the token", () => {
    const { token, databases } = renderWith(
      "Notion did not accept this integration token.",
      "NOTION_TOKEN_INVALID",
    );

    expect(token).toHaveAttribute("aria-invalid", "true");
    expect(token).toHaveAccessibleDescription(
      /settings:workspaceImport\.notion\.errors\.tokenInvalid/,
    );
    expect(databases).not.toHaveAttribute("aria-invalid");
  });

  it("keeps the server's message for a failure it has no copy for", () => {
    const { token } = renderWith("Could not reach Notion.", "BAD_GATEWAY");

    expect(token).toHaveAccessibleDescription(/Could not reach Notion\./);
  });
});
