#!/usr/bin/env bash
set -euo pipefail

# WK6-01 (docs/auditoria-2/worker-agentes.md, ALTA): prueba de mutación
# automatizada que reproduce, de forma repetible, el hallazgo original de la
# auditoría — quitar el filtro `org_id` de `fetchTender()`
# (apps/worker/src/agents/business-tools.ts, única lectura detrás de la
# herramienta `proponer_matching`) NO debía hacer fallar ningún test/eval
# existente. Tras la reparación de esta ronda (contenido verificado en
# `test/business-tools.test.ts` y `test/agent-evals.test.ts`, no solo
# `status: 'ok'`), este script debe terminar en FALLO DE LA SUITE bajo la
# mutación (es decir, "OK" para este script = "la mutación fue detectada").
#
# Qué hace, en orden:
#   1. Crea un `git worktree` DESECHABLE en un directorio temporal, sobre el
#      HEAD real del repo (nunca toca el árbol de trabajo principal: ningún
#      `git reset`/`checkout <commit>`/`stash`/`rebase` se ejecuta aquí ni en
#      el repo principal).
#   2. SUPERPONE sobre el worktree el estado ACTUAL del árbol de trabajo de
#      `apps/worker` (cambios sin commitear, incluidos archivos nuevos). Sin
#      este paso el script probaría solo lo que ya está en HEAD y reportaría
#      un falso "mutación NO detectada" mientras la reparación esté sin
#      commitear (comprobado en vivo: la primera corrida de este script sobre
#      HEAD, con los tests de contenido aún sin commitear, dio exactamente ese
#      falso positivo). El repo principal nunca se modifica: solo se lee
#      (`git diff HEAD`/`git ls-files`) y se copia hacia el worktree.
#   3. Enlaza (symlink) el `node_modules` YA INSTALADO del repo principal
#      dentro del worktree — evita repetir un `npm install` completo (818
#      paquetes, ver `docs/logs/audit-worker-k.log`) solo para esta prueba
#      dirigida. Es seguro: `@atiende/db`/`@atiende/agents` NO se mutan aquí
#      (sus imports resuelven al paquete real sin tocar), y los tests de
#      `apps/worker` importan `business-tools.ts` por RUTA RELATIVA (no vía
#      `node_modules`), así que sí ven el archivo mutado del worktree.
#   4. Aplica la mutación EXACTA de la auditoría: en la copia del worktree de
#      `apps/worker/src/agents/business-tools.ts`, la consulta de
#      `fetchTender()` pasa de `where id = $1 and org_id = $2` a
#      `where id = $1` (y su arreglo de parámetros de `[tenderId, orgId]` a
#      `[tenderId]`, para que la consulta siga siendo válida en Postgres/
#      PGlite en vez de fallar por conteo de parámetros).
#   5. Corre la suite de `apps/worker` (por defecto, `test/business-tools.test.ts`
#      y `test/agent-evals.test.ts`; con `--full` la suite completa) DENTRO
#      del worktree mutado.
#   6. Reporta el resultado y SIEMPRE limpia el worktree temporal
#      (`git worktree remove --force`), incluso si la suite falló o el script
#      se interrumpe (trap EXIT).
#
# Salida de ESTE script:
#   - exit 0  ("mutación detectada"): la suite FALLÓ bajo la mutación — hay
#     red de seguridad real para una regresión futura en `fetchTender`.
#   - exit 1  ("mutación NO detectada" / regresión de WK6-01): la suite pasó
#     igual, sin ningún fallo, pese a que el filtro de aislamiento por
#     organización ya no existe — repetir el hallazgo original de la
#     auditoría. Debe tratarse como un bug en la suite de pruebas, no en el
#     código de producción (que puede seguir siendo correcto).
#
# Uso:
#   apps/worker/scripts/wk6-01-mutation-test-org-isolation.sh            # rápido (2 archivos)
#   apps/worker/scripts/wk6-01-mutation-test-org-isolation.sh --full     # suite completa de apps/worker
#
# Requiere: repo git real, node_modules ya instalado en la raíz del repo
# (`npm install` previo, como para correr la suite normalmente).

MODE="${1:-fast}"

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
WORKTREE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wk6-01-mutation-XXXXXX")"

cleanup() {
  local exit_code=$?
  echo "[wk6-01] limpiando worktree temporal: $WORKTREE_DIR" >&2
  git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || rm -rf "$WORKTREE_DIR"
  exit $exit_code
}
trap cleanup EXIT

echo "[wk6-01] repo principal: $REPO_ROOT (HEAD=$HEAD_SHA, sin tocar)" >&2
echo "[wk6-01] creando worktree desechable en: $WORKTREE_DIR" >&2
git -C "$REPO_ROOT" worktree add --detach "$WORKTREE_DIR" "$HEAD_SHA" >&2

# Superposición del árbol de trabajo actual (ver paso 2 de la cabecera): sin
# esto el worktree solo tendría lo ya commiteado en HEAD.
echo "[wk6-01] superponiendo el estado actual del árbol de trabajo de apps/worker sobre el worktree..." >&2
WORKTREE_PATCH="$WORKTREE_DIR/../wk6-01-worktree-overlay.patch"
if git -C "$REPO_ROOT" diff HEAD --binary -- apps/worker > "$WORKTREE_PATCH" && [ -s "$WORKTREE_PATCH" ]; then
  git -C "$WORKTREE_DIR" apply --whitespace=nowarn "$WORKTREE_PATCH"
  echo "[wk6-01] cambios sin commitear de apps/worker aplicados al worktree." >&2
else
  echo "[wk6-01] no hay cambios sin commitear en apps/worker (el worktree ya es idéntico a HEAD)." >&2
fi
rm -f "$WORKTREE_PATCH"

# Archivos NUEVOS todavía no rastreados por git (`git diff HEAD` no los incluye).
UNTRACKED_COUNT=0
while IFS= read -r -d '' rel; do
  mkdir -p "$WORKTREE_DIR/$(dirname "$rel")"
  cp -p "$REPO_ROOT/$rel" "$WORKTREE_DIR/$rel"
  UNTRACKED_COUNT=$((UNTRACKED_COUNT + 1))
done < <(git -C "$REPO_ROOT" ls-files --others --exclude-standard -z -- apps/worker)
echo "[wk6-01] archivos nuevos sin rastrear copiados al worktree: $UNTRACKED_COUNT" >&2

if [ ! -d "$REPO_ROOT/node_modules" ]; then
  echo "[wk6-01] ERROR: $REPO_ROOT/node_modules no existe — corre 'npm install' en el repo principal primero." >&2
  exit 2
fi
ln -s "$REPO_ROOT/node_modules" "$WORKTREE_DIR/node_modules"

TARGET_FILE="$WORKTREE_DIR/apps/worker/src/agents/business-tools.ts"
if [ ! -f "$TARGET_FILE" ]; then
  echo "[wk6-01] ERROR: no se encontró $TARGET_FILE en el worktree." >&2
  exit 2
fi

echo "[wk6-01] aplicando mutación: fetchTender() sin filtro org_id..." >&2
python3 - "$TARGET_FILE" <<'PYEOF'
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

original = (
    "     from tenders where id = $1 and org_id = $2`,\n"
    "    [tenderId, orgId],\n"
)
mutated = (
    "     from tenders where id = $1`,\n"
    "    [tenderId],\n"
)

if original not in content:
    print("[wk6-01] ERROR: no se encontró el texto exacto a mutar en fetchTender() "
          "-- el archivo cambió de forma incompatible con este script.", file=sys.stderr)
    sys.exit(3)

occurrences = content.count(original)
if occurrences != 1:
    print(f"[wk6-01] ERROR: se esperaba EXACTAMENTE 1 ocurrencia del texto a mutar, se encontraron {occurrences}.", file=sys.stderr)
    sys.exit(3)

content = content.replace(original, mutated, 1)
with open(path, "w", encoding="utf-8") as f:
    f.write(content)

print("[wk6-01] mutación aplicada.", file=sys.stderr)
PYEOF

echo "[wk6-01] --- diff de la mutación (solo dentro del worktree temporal) ---" >&2
git -C "$WORKTREE_DIR" diff -- apps/worker/src/agents/business-tools.ts >&2 || true
echo "[wk6-01] ------------------------------------------------------------" >&2

cd "$WORKTREE_DIR/apps/worker"

set +e
if [ "$MODE" = "--full" ] || [ "$MODE" = "full" ]; then
  echo "[wk6-01] corriendo la suite COMPLETA de apps/worker bajo la mutación..." >&2
  "$WORKTREE_DIR/node_modules/.bin/vitest" run
else
  echo "[wk6-01] corriendo test/business-tools.test.ts + test/agent-evals.test.ts bajo la mutación (usa --full para la suite completa)..." >&2
  "$WORKTREE_DIR/node_modules/.bin/vitest" run test/business-tools.test.ts test/agent-evals.test.ts
fi
TEST_EXIT_CODE=$?
set -e

if [ "$TEST_EXIT_CODE" -ne 0 ]; then
  echo "[wk6-01] OK: la suite FALLÓ bajo la mutación (exit=$TEST_EXIT_CODE) -- la regresión de aislamiento por organización SÍ se detecta." >&2
  exit 0
else
  echo "[wk6-01] ALERTA (regresión de WK6-01): la suite pasó igual (exit=0) sin el filtro org_id de fetchTender() -- ninguna prueba detecta esta fuga cross-org. Revisar los tests de contenido de proponer_matching en test/business-tools.test.ts y test/agent-evals.test.ts." >&2
  exit 1
fi
