import { describe, expect, it } from "vite-plus/test";
import { notionConnectError } from "./notion-connect-error";

describe("notionConnectError", () => {
  it("puts a refused token under the token field", () => {
    expect(notionConnectError("NOTION_TOKEN_INVALID")).toEqual({
      field: "token",
      messageKey: "settings:workspaceImport.notion.errors.tokenInvalid",
    });
  });

  it("puts an unshared database under the databases field", () => {
    expect(notionConnectError("NOTION_NOTHING_SHARED").field).toBe("databases");
    expect(notionConnectError("NOTION_DATABASE_NOT_SHARED").field).toBe(
      "databases",
    );
    expect(notionConnectError("NOTION_NOT_A_DATABASE").field).toBe("databases");
  });

  it("keeps any other failure under the token with the server's message", () => {
    for (const code of [null, undefined, "BAD_GATEWAY", "toString"]) {
      expect(notionConnectError(code)).toEqual({
        field: "token",
        messageKey: null,
      });
    }
  });
});
