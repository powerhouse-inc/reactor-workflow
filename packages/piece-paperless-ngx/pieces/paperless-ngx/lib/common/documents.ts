// The document JSON's `content` field holds the whole OCR text, routinely
// megabytes, and every step output is journalled. It is therefore dropped
// unless the workflow explicitly asks for it.
export function trimContent<T>(document: T, includeContent: boolean): T {
  if (includeContent) return document;
  if (typeof document !== "object" || document === null) return document;
  if (!("content" in document)) return document;
  const { content: _content, ...rest } = document as Record<string, unknown>;
  return rest as T;
}

export function trimContentAll<T>(rows: T[], includeContent: boolean): T[] {
  return includeContent ? rows : rows.map((row) => trimContent(row, false));
}
