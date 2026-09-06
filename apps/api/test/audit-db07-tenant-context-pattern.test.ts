import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * DB-07 (docs/auditoria-1/db-api.md, BAJA): "apps/api/src/** usa
 * app.db.transaction con `set local role app_role` escrito a mano en cada
 * sitio, en vez del helper withTenantContext/applyTenantContext de
 * @atiende/db. Hoy no hay ninguna ruta que omita el SET LOCAL ROLE
 * (verificado), pero el patrón está duplicado sin ningún lint/test que
 * impida omitirlo en una ruta futura."
 *
 * DECISIÓN DE ALCANCE (documentada, no oculta): refactorizar TODOS los
 * sitios de escritura de esta ronda (decenas, no los 8 originales de ronda
 * 1) a `withTenantContext` es un cambio grande y de bajo riesgo real (BAJA
 * severidad, sin vulnerabilidad activa) frente al resto de hallazgos ALTA/
 * MEDIA de esta misma auditoría, que tuvieron prioridad. En su lugar, este
 * test cierra el riesgo REAL que describe el hallazgo -- "una ruta futura
 * podría olvidar `set local role app_role`" -- con una prueba estática que
 * falla si eso ocurre, sin necesidad de migrar el estilo de cada sitio:
 * cualquier bloque `app.db.transaction(async (tx) => { ... })` en
 * `apps/api/src/modules/**` o `apps/api/src/plugins/**` debe contener el
 * texto `set local role app_role` en su cuerpo (con la única excepción
 * documentada y explícita de `internal-ingest.routes.ts`, que bypassea RLS
 * a propósito para la ingesta multi-organización -- ver el comentario de
 * diseño en ese archivo).
 */
describe('DB-07: ninguna transacción de apps/api omite SET LOCAL ROLE app_role', () => {
  const ROOT = join(__dirname, '..', 'src');
  const ALLOWED_BYPASS_FILES = new Set(['internal-ingest.routes.ts']);

  function listTsFiles(dir: string): string[] {
    const entries = readdirSync(dir);
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        files.push(...listTsFiles(full));
      } else if (entry.endsWith('.ts')) {
        files.push(full);
      }
    }
    return files;
  }

  it('todo app.db.transaction() en modules/ y plugins/ fija app_role (o está en la lista de excepciones documentada)', () => {
    const files = [...listTsFiles(join(ROOT, 'modules')), ...listTsFiles(join(ROOT, 'plugins'))];
    const offenders: string[] = [];

    for (const file of files) {
      const basename = file.split('/').pop()!;
      if (ALLOWED_BYPASS_FILES.has(basename)) continue;

      const content = readFileSync(file, 'utf8');
      // Encuentra cada llamada a `app.db.transaction(` y su bloque asociado
      // (aproximación por conteo de llaves, suficiente para este código
      // real: no hay strings/comentarios con llaves desbalanceadas que
      // engañen al conteo en los archivos de apps/api).
      let searchFrom = 0;
      while (true) {
        const idx = content.indexOf('app.db.transaction(', searchFrom);
        if (idx === -1) break;
        const braceStart = content.indexOf('{', idx);
        if (braceStart === -1) break;
        let depth = 0;
        let end = braceStart;
        for (; end < content.length; end++) {
          if (content[end] === '{') depth++;
          else if (content[end] === '}') {
            depth--;
            if (depth === 0) break;
          }
        }
        const block = content.slice(idx, end + 1);
        if (!block.includes('set local role app_role')) {
          const line = content.slice(0, idx).split('\n').length;
          offenders.push(`${file}:${line}`);
        }
        searchFrom = end + 1;
      }
    }

    expect(offenders).toEqual([]);
  });
});
