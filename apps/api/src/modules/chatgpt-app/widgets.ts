/**
 * REQ-067 — plantillas `text/html+skybridge` (Apps SDK) de los widgets que
 * renderizan el `toolOutput` de las herramientas de lectura de
 * `tools.ts`.
 *
 * Regla dura, verificada por `test/chatgpt-app-widget.test.ts`: cada
 * plantilla SOLO lee `window.openai.toolOutput` (el resultado ya devuelto
 * por `tools/call`, ver `mcp.routes.ts`) y lo pinta en el DOM. Ninguna
 * plantilla llama `window.openai.callTool(...)`, `fetch(...)` ni referencia
 * ningún recurso externo (ninguna etiqueta `<script src=...>` ni
 * `<link href=...>`) — el widget no puede, por construcción, disparar una
 * segunda herramienta ni salir a la red por su cuenta. Esto es justamente
 * lo que exige el criterio de aceptación de REQ-067 ("widget renderiza solo
 * `toolOutput` de lectura"): no es solo una descripción, es la única forma
 * en la que este HTML sabe pintar algo.
 */

export interface WidgetResource {
  uri: string;
  name: string;
  description: string;
  mimeType: 'text/html+skybridge';
  html: string;
}

const BASE_STYLE = `
  body { font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 12px; color: #1a1a1a; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e5e5; font-size: 13px; }
  th { color: #666; font-weight: 600; }
  dl { margin: 0; }
  dt { color: #666; font-size: 12px; margin-top: 8px; }
  dd { margin: 0 0 4px 0; font-size: 14px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; }
  .badge-verde { background: #e6f4ea; color: #1e7e34; }
  .badge-ambar { background: #fff4e5; color: #b7791f; }
  .badge-rojo { background: #fdecea; color: #c0392b; }
  .badge-aprobado { background: #e6f4ea; color: #1e7e34; }
  .badge-en_revision { background: #fff4e5; color: #b7791f; }
  .badge-borrador { background: #eee; color: #555; }
  .badge-vigente { background: #e6f4ea; color: #1e7e34; }
  .badge-invalidada { background: #fdecea; color: #c0392b; }
  .empty { color: #888; padding: 8px 0; }
`;

function escFn() {
  // Se serializa como texto dentro del <script> de cada widget -- ver uso abajo.
  return `function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
      }`;
}

const CONVOCATORIAS_URI = 'ui://chatgpt-app/convocatorias-widget';
const TENDER_URI = 'ui://chatgpt-app/convocatoria-widget';
const APROBACION_URI = 'ui://chatgpt-app/aprobacion-widget';
const MATRIZ_URI = 'ui://chatgpt-app/matriz-widget';

function moneyFn() {
  return `function money(n, currency) {
        if (n == null) return '—';
        try { return new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency || 'MXN' }).format(n); }
        catch (e) { return String(n); }
      }`;
}

const CONVOCATORIAS_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"/><style>${BASE_STYLE}</style></head>
<body>
  <div id="root"><p class="empty">Cargando convocatorias…</p></div>
  <script>
    (function () {
      // Único punto de datos permitido: el toolOutput ya devuelto por
      // tools/call. Nunca window.openai.callTool, nunca fetch.
      var output = (window.openai && window.openai.toolOutput) || { items: [] };
      var items = Array.isArray(output.items) ? output.items : [];
      var root = document.getElementById('root');
      if (items.length === 0) {
        root.innerHTML = '<p class="empty">Sin convocatorias que coincidan.</p>';
        return;
      }
      ${escFn()}
      ${moneyFn()}
      var rows = items.map(function (it) {
        return '<tr>' +
          '<td>' + esc(it.title) + '</td>' +
          '<td>' + esc(it.contractingBody || '—') + '</td>' +
          '<td>' + money(it.budgetAmount, it.currency) + '</td>' +
          '<td>' + esc(it.submissionDeadline ? String(it.submissionDeadline).slice(0, 10) : '—') + '</td>' +
          '<td>' + esc(it.status) + '</td>' +
          '</tr>';
      }).join('');
      root.innerHTML = '<table><thead><tr><th>Convocatoria</th><th>Dependencia</th><th>Monto</th><th>Fecha límite</th><th>Estado</th></tr></thead><tbody>' + rows + '</tbody></table>';
    })();
  </script>
</body>
</html>`;

const TENDER_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"/><style>${BASE_STYLE}</style></head>
<body>
  <div id="root"><p class="empty">Cargando convocatoria…</p></div>
  <script>
    (function () {
      var it = (window.openai && window.openai.toolOutput) || null;
      var root = document.getElementById('root');
      if (!it || !it.id) {
        root.innerHTML = '<p class="empty">Sin datos de convocatoria.</p>';
        return;
      }
      ${escFn()}
      ${moneyFn()}
      root.innerHTML = '<dl>' +
        '<dt>Convocatoria</dt><dd>' + esc(it.title) + '</dd>' +
        '<dt>Dependencia</dt><dd>' + esc(it.contractingBody || '—') + '</dd>' +
        '<dt>Monto</dt><dd>' + money(it.budgetAmount, it.currency) + '</dd>' +
        '<dt>Fecha límite</dt><dd>' + esc(it.submissionDeadline ? String(it.submissionDeadline).slice(0, 10) : '—') + '</dd>' +
        '<dt>Estado</dt><dd>' + esc(it.status) + '</dd>' +
        '</dl>';
    })();
  </script>
</body>
</html>`;

const APROBACION_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"/><style>${BASE_STYLE}</style></head>
<body>
  <div id="root"><p class="empty">Cargando estado de aprobación…</p></div>
  <script>
    (function () {
      var output = (window.openai && window.openai.toolOutput) || { state: 'borrador', approvals: [], comments: [] };
      var root = document.getElementById('root');
      ${escFn()}
      var approvals = Array.isArray(output.approvals) ? output.approvals : [];
      var comments = Array.isArray(output.comments) ? output.comments : [];
      var html = '<p><strong>Estado:</strong> <span class="badge badge-' + esc(output.state) + '">' + esc(output.state) + '</span></p>';
      if (approvals.length > 0) {
        html += '<table><thead><tr><th>Alcance</th><th>Rol que aprobó</th><th>Fecha</th><th>Vigencia</th></tr></thead><tbody>' +
          approvals.map(function (a) {
            return '<tr><td>' + esc(a.scopeRef) + '</td><td>' + esc(a.approvedByRole) + '</td><td>' + esc(String(a.approvedAt).slice(0, 10)) + '</td><td><span class="badge badge-' + esc(a.status) + '">' + esc(a.status) + '</span></td></tr>';
          }).join('') + '</tbody></table>';
      } else {
        html += '<p class="empty">Todavía sin ninguna aprobación registrada.</p>';
      }
      if (comments.length > 0) {
        html += '<p><strong>Comentarios</strong></p><ul>' + comments.map(function (c) { return '<li>' + esc(c.text) + '</li>'; }).join('') + '</ul>';
      }
      root.innerHTML = html;
    })();
  </script>
</body>
</html>`;

const MATRIZ_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"/><style>${BASE_STYLE}</style></head>
<body>
  <div id="root"><p class="empty">Cargando matriz de cumplimiento…</p></div>
  <script>
    (function () {
      var output = (window.openai && window.openai.toolOutput) || { items: [], overallStatus: null };
      var items = Array.isArray(output.items) ? output.items : [];
      var root = document.getElementById('root');
      ${escFn()}
      var header = '<p><strong>Semáforo general:</strong> <span class="badge badge-' + esc(output.overallStatus || 'rojo') + '">' + esc(output.overallStatus || 'sin datos') + '</span></p>';
      if (items.length === 0) {
        root.innerHTML = header + '<p class="empty">Sin expediente/checklist todavía para esta convocatoria.</p>';
        return;
      }
      var rows = items.map(function (it) {
        return '<tr>' +
          '<td>' + esc(it.label) + '</td>' +
          '<td><span class="badge badge-' + esc(it.result || 'rojo') + '">' + esc(it.result || '—') + '</span></td>' +
          '<td>' + esc(it.notes || '—') + '</td>' +
          '</tr>';
      }).join('');
      root.innerHTML = header + '<table><thead><tr><th>Requisito</th><th>Resultado</th><th>Notas</th></tr></thead><tbody>' + rows + '</tbody></table>';
    })();
  </script>
</body>
</html>`;

export const WIDGET_RESOURCES: readonly WidgetResource[] = [
  {
    uri: CONVOCATORIAS_URI,
    name: 'Convocatorias',
    description: 'Tabla de convocatorias detectadas para la organización (solo lectura).',
    mimeType: 'text/html+skybridge',
    html: CONVOCATORIAS_HTML,
  },
  {
    uri: TENDER_URI,
    name: 'Convocatoria',
    description: 'Detalle de solo lectura de una convocatoria.',
    mimeType: 'text/html+skybridge',
    html: TENDER_HTML,
  },
  {
    uri: APROBACION_URI,
    name: 'Estado de aprobación',
    description: 'Estado de solo lectura del flujo de primera aprobación del expediente (nunca aprueba ni firma desde aquí).',
    mimeType: 'text/html+skybridge',
    html: APROBACION_HTML,
  },
  {
    uri: MATRIZ_URI,
    name: 'Matriz de cumplimiento',
    description: 'Semáforo de cumplimiento de una convocatoria (solo lectura, sin evidencia descargable).',
    mimeType: 'text/html+skybridge',
    html: MATRIZ_HTML,
  },
];

export function findWidgetResource(uri: string): WidgetResource | undefined {
  return WIDGET_RESOURCES.find((w) => w.uri === uri);
}

export const CONVOCATORIAS_WIDGET_URI = CONVOCATORIAS_URI;
export const TENDER_WIDGET_URI = TENDER_URI;
export const APROBACION_WIDGET_URI = APROBACION_URI;
export const MATRIZ_WIDGET_URI = MATRIZ_URI;
