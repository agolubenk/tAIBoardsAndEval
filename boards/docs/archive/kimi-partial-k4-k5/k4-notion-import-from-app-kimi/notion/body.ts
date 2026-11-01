import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import {
  blockPayload,
  type NotionBlock,
  type NotionRichText,
} from "./api-types.js";

let service: TurndownService | undefined;

// Blocks are rendered to a small HTML subset and handed to turndown, the same
// converter the other importers use; there is no block-to-Markdown logic here.
export function blocksToMarkdown(blocks: NotionBlock[]): string {
  if (blocks.length === 0) return "";
  service ??= createService();
  return service
    .turndown(blocksToHtml(blocks))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function blocksToHtml(blocks: NotionBlock[]): string {
  return renderBlocks(blocks);
}

function createService(): TurndownService {
  const instance = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  instance.use(gfm);
  return instance;
}

function renderBlocks(blocks: NotionBlock[]): string {
  let html = "";
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index] as NotionBlock;
    const listTag = listTagOf(block);
    if (listTag) {
      let items = "";
      while (
        index < blocks.length &&
        listTagOf(blocks[index] as NotionBlock) === listTag
      ) {
        items += renderListItem(blocks[index] as NotionBlock);
        index++;
      }
      html += `<${listTag}>${items}</${listTag}>`;
      continue;
    }
    html += renderBlock(block);
    index++;
  }
  return html;
}

function listTagOf(block: NotionBlock): "ul" | "ol" | null {
  if (block.type === "bulleted_list_item" || block.type === "to_do")
    return "ul";
  if (block.type === "numbered_list_item") return "ol";
  return null;
}

function renderListItem(block: NotionBlock): string {
  const payload = blockPayload(block);
  const checkbox =
    block.type === "to_do"
      ? `<input type="checkbox" disabled${payload.checked ? " checked" : ""}> `
      : "";
  const children = block.children?.length ? renderBlocks(block.children) : "";
  return `<li>${checkbox}${richTextToHtml(payload.rich_text)}${children}</li>`;
}

function renderBlock(block: NotionBlock): string {
  const payload = blockPayload(block);
  const text = richTextToHtml(payload.rich_text);
  const children = block.children?.length ? renderBlocks(block.children) : "";

  switch (block.type) {
    case "heading_1":
      return `<h1>${text}</h1>`;
    case "heading_2":
      return `<h2>${text}</h2>`;
    case "heading_3":
      return `<h3>${text}</h3>`;
    case "quote":
    case "callout":
      return `<blockquote><p>${text}</p>${children}</blockquote>`;
    case "code":
      return `<pre><code${languageClass(payload.language)}>${escapeHtml(plainCode(payload))}</code></pre>`;
    case "divider":
      return "<hr>";
    case "image": {
      const src = payload.external?.url ?? payload.file?.url ?? "";
      return src ? `<img src="${escapeAttribute(src)}" alt="">` : "";
    }
    case "bookmark":
    case "link_preview": {
      const url = payload.url ?? "";
      return url ? `<p><a href="${escapeAttribute(url)}">${escapeHtml(url)}</a></p>` : "";
    }
    case "child_page":
      return `<p>${escapeHtml(payload.title ?? "")}</p>`;
    case "toggle":
      return `<p>${text}</p>${children}`;
    case "paragraph":
      return text ? `<p>${text}</p>${children}` : children;
    default:
      return text ? `<p>${text}</p>${children}` : children;
  }
}

function plainCode(payload: { rich_text?: NotionRichText[] }): string {
  return (payload.rich_text ?? []).map((part) => part.plain_text).join("");
}

function languageClass(language: string | undefined): string {
  return language ? ` class="language-${escapeAttribute(language)}"` : "";
}

function richTextToHtml(rich: NotionRichText[] | undefined): string {
  return (rich ?? [])
    .map((part) => {
      let html = part.annotations?.code
        ? `<code>${escapeHtml(part.plain_text)}</code>`
        : escapeHtml(part.plain_text);
      if (part.annotations?.bold) html = `<strong>${html}</strong>`;
      if (part.annotations?.italic) html = `<em>${html}</em>`;
      if (part.annotations?.strikethrough) html = `<del>${html}</del>`;
      if (part.href) html = `<a href="${escapeAttribute(part.href)}">${html}</a>`;
      return html;
    })
    .join("");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;",
  );
}

function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}
