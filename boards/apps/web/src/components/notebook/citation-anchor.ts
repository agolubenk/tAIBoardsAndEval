// The id of a source line under an answer, so a [n] marker can scroll to it.
export function citationAnchor(messageId: string, n: number) {
  return `notebook-cite-${messageId}-${n}`;
}
