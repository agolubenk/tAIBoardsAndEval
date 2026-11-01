import { describe, expect, it } from "vite-plus/test";
import { entityOfPath, isCorpusPath } from "./corpus";

describe("ssr corpus", () => {
  it("reads the eval tree in the incubator layout and in the product home", () => {
    for (const root of ["supertick-eval", "eval"]) {
      expect(entityOfPath(`${root}/pipeline/genome/coord.json`)).toEqual({
        kind: "genome",
        name: "coord.json",
        path: `${root}/pipeline/genome/coord.json`,
      });
      expect(entityOfPath(`${root}/prompts/launch-3010/README.md`)?.kind).toBe(
        "prompt",
      );
      expect(entityOfPath(`${root}/nerve/config.json`)?.name).toBe(
        "config.json",
      );
    }
  });

  it("keeps paths outside the registry out, so push-back refuses them", () => {
    expect(isCorpusPath("evaluation/prompts/x.md")).toBe(false);
    expect(isCorpusPath("boards/eval/nerve/x.py")).toBe(false);
    expect(isCorpusPath("eval/data/run.jsonl")).toBe(false);
  });

  it("folds a skill's files into its folder entity", () => {
    expect(entityOfPath(".claude/skills/grill-task/protocol.md")).toEqual({
      kind: "skill",
      name: "grill-task",
      path: ".claude/skills/grill-task",
    });
  });
});
