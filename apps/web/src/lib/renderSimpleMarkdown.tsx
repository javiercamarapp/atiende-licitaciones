import type { ReactNode } from "react";

/**
 * Renderizador de Markdown deliberadamente mínimo (sin dependencia nueva):
 * solo cubre lo que `apps/api/docs/legal/privacy-notice.md` de verdad usa
 * (encabezados `#`/`##`, listas `- `, negritas `**texto**`, código en línea
 * `` `texto` ``) — no es un parser de Markdown general. El contenido viene
 * de un archivo controlado por el propio repositorio (nunca de un usuario
 * final), pero igual se construyen elementos React directamente (nunca
 * `dangerouslySetInnerHTML`).
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("**")) {
      parts.push(<strong key={`${keyPrefix}-${i}`}>{token.slice(2, -2)}</strong>);
    } else {
      parts.push(
        <code key={`${keyPrefix}-${i}`} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          {token.slice(1, -1)}
        </code>,
      );
    }
    lastIndex = pattern.lastIndex;
    i += 1;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

export function renderSimpleMarkdown(markdown: string): ReactNode {
  const lines = markdown.split("\n");
  const blocks: ReactNode[] = [];
  let listItems: string[] = [];
  let paragraphLines: string[] = [];
  let key = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={`ul-${key++}`} className="list-inside list-disc space-y-1">
        {listItems.map((item, i) => (
          <li key={i}>{renderInline(item, `li-${key}-${i}`)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    const text = paragraphLines.join(" ").trim();
    if (text) blocks.push(<p key={`p-${key++}`}>{renderInline(text, `p-${key}`)}</p>);
    paragraphLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("## ")) {
      flushList();
      flushParagraph();
      blocks.push(
        <h2 key={`h2-${key++}`} className="mb-2 mt-6 font-display text-lg font-semibold first:mt-0">
          {renderInline(line.slice(3), `h2-${key}`)}
        </h2>,
      );
    } else if (line.startsWith("# ")) {
      flushList();
      flushParagraph();
      blocks.push(
        <h1 key={`h1-${key++}`} className="sr-only">
          {line.slice(2)}
        </h1>,
      );
    } else if (line.startsWith("- ")) {
      flushParagraph();
      listItems.push(line.slice(2));
    } else if (line.trim() === "") {
      flushList();
      flushParagraph();
    } else {
      paragraphLines.push(line.trim());
    }
  }
  flushList();
  flushParagraph();

  return <div className="space-y-3 text-sm leading-relaxed text-foreground">{blocks}</div>;
}
