import { describe, expect, it } from "vite-plus/test";
import { httpExceptionResponse } from "../../errors/http-exception-response";
import { importHttpError } from "./open-import-source";

describe("importHttpError", () => {
  it("sends a source's access code to the client", async () => {
    const response = await httpExceptionResponse(
      importHttpError({
        status: 400,
        message: "No database is shared with the integration yet.",
        code: "NOTION_NOTHING_SHARED",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      message: "No database is shared with the integration yet.",
      code: "NOTION_NOTHING_SHARED",
    });
  });

  it("names any other failure by its status", async () => {
    const response = await httpExceptionResponse(
      importHttpError({ status: 502, message: "Notion took too long." }),
    );
    expect(await response.json()).toEqual({
      message: "Notion took too long.",
      code: "BAD_GATEWAY",
    });
  });
});
