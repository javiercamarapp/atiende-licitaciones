// ─────────────────────────────────────────────────────────────────────────
// npm run -w packages/mail preview
//
// Renderiza CADA plantilla del catálogo con sus datos de ejemplo
// (`sampleData`, ya marcados con "(ejemplo)" en el propio texto) a
// `packages/mail/preview/<id>.html`, más un índice en
// `packages/mail/preview/index.html`. Es un GENERADO: no se commitea (ver
// `.gitignore`), se regenera con este script cuando alguien quiera mirar el
// render real de un cambio.
// ─────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listTemplates } from "../src/templates/registry";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "preview");
mkdirSync(outDir, { recursive: true });

interface IndexRow {
  id: string;
  name: string;
  category: string;
  mandatory: boolean;
  subject: string;
}

async function main(): Promise<void> {
  const rows: IndexRow[] = [];

  for (const template of listTemplates()) {
    const rendered = await template.render(template.sampleData);
    writeFileSync(join(outDir, `${template.id}.html`), rendered.html, "utf8");
    writeFileSync(join(outDir, `${template.id}.txt`), rendered.text, "utf8");
    rows.push({
      id: template.id,
      name: template.name,
      category: template.category,
      mandatory: template.mandatory,
      subject: rendered.subject,
    });
  }

  const indexHtml = renderIndex(rows);
  writeFileSync(join(outDir, "index.html"), indexHtml, "utf8");

  console.log(`Vista previa generada: ${rows.length} plantillas en ${outDir}`);
  for (const row of rows) {
    console.log(`  - ${row.id} (${row.category}${row.mandatory ? ", obligatoria" : ""}): "${row.subject}"`);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderIndex(rows: IndexRow[]): string {
  const items = rows
    .map(
      (row) => `
      <li class="row">
        <div class="meta">
          <span class="id">${escapeHtml(row.id)}</span>
          <span class="badge ${row.mandatory ? "badge-mandatory" : "badge-optional"}">${row.mandatory ? "obligatoria" : "categoría: " + escapeHtml(row.category)}</span>
        </div>
        <div class="name">${escapeHtml(row.name)}</div>
        <div class="subject">"${escapeHtml(row.subject)}"</div>
        <div class="links">
          <a href="./${row.id}.html" target="_blank" rel="noopener">Ver HTML</a>
          <a href="./${row.id}.txt" target="_blank" rel="noopener">Ver texto plano</a>
        </div>
      </li>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Vista previa — @atiende/mail</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Arial, sans-serif; background: #f7f9fc; color: #0f1b2d; margin: 0; padding: 32px; }
  h1 { font-size: 22px; margin: 0 0 4px 0; }
  p.note { color: #5b6b82; font-size: 13px; margin: 0 0 24px 0; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
  .row { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px 20px; }
  .meta { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .id { font-family: ui-monospace, monospace; font-size: 12px; color: #5b6b82; }
  .badge { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 8px; border-radius: 999px; }
  .badge-mandatory { background: #fef2f2; color: #c0122a; }
  .badge-optional { background: #eef2f7; color: #5b6b82; }
  .name { font-weight: 600; font-size: 15px; margin-bottom: 2px; }
  .subject { color: #3f4a5c; font-size: 13px; margin-bottom: 8px; }
  .links a { font-size: 12px; color: #1d4ed8; text-decoration: none; margin-right: 16px; }
  .links a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <h1>Catálogo de correos — Atiende Licitaciones</h1>
  <p class="note">Todos los datos de cada plantilla son de EJEMPLO (marcados "(ejemplo)" en el propio texto renderizado) — generado por <code>npm run -w packages/mail preview</code>, no se commitea.</p>
  <ul>
    ${items}
  </ul>
</body>
</html>`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
