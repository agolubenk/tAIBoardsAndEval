import { describe, expect, it } from "vite-plus/test";
import { parseNotionDatabaseIds } from "@/components/import/notion-database-ids";

const ID = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

describe("parseNotionDatabaseIds", () => {
  it("takes the id from a database URL and ignores the view", () => {
    expect(
      parseNotionDatabaseIds(
        `https://www.notion.so/acme/Tasks-${ID}?v=${OTHER}`,
      ),
    ).toEqual([ID]);
  });

  it("accepts dashed and bare ids separated by commas, spaces or lines", () => {
    expect(
      parseNotionDatabaseIds(
        ` 01234567-89AB-cdef-0123-456789abcdef,\n${OTHER} ${ID}`,
      ),
    ).toEqual([ID, OTHER]);
  });

  it("drops text that holds no id", () => {
    expect(parseNotionDatabaseIds("tasks, 1234")).toEqual([]);
  });
});
