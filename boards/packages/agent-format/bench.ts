import { defaultCounter, encodeResponse } from "./src/index.ts";

function makeCard(variant: number) {
  const base = {
    id: `B-${variant}`,
    title: `Синтетическая карточка ${variant}: проверка формата ответа`,
    status: "in_progress",
    priority: "high",
    tags: ["импорт", "notion", "зеркало"],
    description: [
      "## Постановка",
      "",
      `Описание карточки ${variant} с **Markdown** внутри: списки, ссылки и код.`,
      "",
      "- пункт первый",
      "- пункт второй с `inline code`",
      "",
      "```ts",
      'const answer: number = 42; // "pipe | и: двоеточие, внутри"',
      "```",
    ].join("\n"),
  };
  if (variant === 1) return base;
  const comments = Array.from({ length: variant === 2 ? 8 : 40 }, (_, i) => ({
    author: `agent-${i % 3}`,
    createdAt: `2026-10-${String(10 + (i % 17)).padStart(2, "0")}T12:00:00Z`,
    body: `Комментарий ${i}: промежуточный статус по задаче, пара предложений текста для объёма.`,
  }));
  return {
    ...base,
    comments,
    history: comments.map((c) => ({ ...c, kind: "note" })),
  };
}

console.log("| карточка | JSON tokens | TOON tokens | TOON/JSON |");
console.log("| --- | ---: | ---: | ---: |");
for (const variant of [1, 2, 3]) {
  const card = makeCard(variant);
  const json = encodeResponse(card, { format: "json" });
  const toon = encodeResponse(card, { format: "toon" });
  if (toon.fallbackError)
    throw new Error(`TOON fallback: ${toon.fallbackError}`);
  const jsonTokens = defaultCounter.count(json.text);
  const toonTokens = defaultCounter.count(toon.text);
  console.log(
    `| card-${variant} | ${jsonTokens} | ${toonTokens} | ${(toonTokens / jsonTokens).toFixed(2)} |`,
  );
}
