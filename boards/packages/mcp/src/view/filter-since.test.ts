import { describe, expect, it } from "vite-plus/test";
import { filterSince } from "./filter-since.js";

const SINCE = "2026-10-27T10:00:00.000Z";
const BEFORE = "2026-10-27T09:00:00.000Z";
const AFTER = "2026-10-27T11:00:00.000Z";

describe("filterSince", () => {
  it("returns the value untouched without since", () => {
    const value = [{ id: "a", updatedAt: BEFORE }];

    expect(filterSince(value, undefined)).toBe(value);
  });

  it("drops entities that did not change after since", () => {
    const value = {
      items: [
        { id: "old", createdAt: BEFORE, updatedAt: BEFORE },
        { id: "new", createdAt: BEFORE, updatedAt: AFTER },
        { id: "decided", createdAt: BEFORE, decidedAt: AFTER },
        { id: "no-time" },
      ],
      nextCursor: null,
    };

    expect(filterSince(value, SINCE)).toEqual({
      items: [
        { id: "new", createdAt: BEFORE, updatedAt: AFTER },
        { id: "decided", createdAt: BEFORE, decidedAt: AFTER },
        { id: "no-time" },
      ],
      nextCursor: null,
    });
  });

  it("keeps an old entity with children and filters the children", () => {
    const value = [
      {
        id: "log",
        felledAt: BEFORE,
        seeds: [
          { id: "s1", createdAt: BEFORE },
          { id: "s2", createdAt: AFTER },
        ],
      },
    ];

    expect(filterSince(value, SINCE)).toEqual([
      { id: "log", felledAt: BEFORE, seeds: [{ id: "s2", createdAt: AFTER }] },
    ]);
  });

  it("leaves out the old text of a container that did not change", () => {
    const value = {
      id: "card",
      updatedAt: BEFORE,
      title: "Card",
      description: "a page of old text",
      comments: [{ id: "c1", content: "new note", createdAt: AFTER }],
    };

    expect(filterSince(value, SINCE)).toEqual({
      id: "card",
      updatedAt: BEFORE,
      title: "Card",
      comments: [{ id: "c1", content: "new note", createdAt: AFTER }],
    });
  });

  it("answers changed: false for an unchanged single entity", () => {
    expect(
      filterSince({ id: "t1", title: "x", updatedAt: BEFORE }, SINCE),
    ).toEqual({
      id: "t1",
      changed: false,
    });
  });
});
