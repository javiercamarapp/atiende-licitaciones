#!/usr/bin/env bash
# Reproduce localmente el pipeline de .github/workflows/quality.yml, salvo el
# job `db-postgres`: ese job necesita un servicio Postgres 16 real (ver
# `services:` en el workflow) que este script NO levanta (este repo no usa
# Docker para pruebas, ver README raíz). Ese job SOLO corre en CI.
#
# Tampoco corre `e2e-web` (Playwright) por defecto: instala un navegador y
# tarda bastante. Pásale `--e2e` para incluirlo.
#
# Uso:
#   bash scripts/ci-local.sh                 # typecheck+lint+test(+cobertura)+build por workspace, npm audit, check-secrets
#   bash scripts/ci-local.sh --e2e           # además, apps/web test:e2e (Playwright)
#   bash scripts/ci-local.sh --skip-install  # no corre `npm ci` (usa node_modules ya instalado)
#
# Guarda TODA la salida en docs/logs/ci-local.log (se sobreescribe cada
# corrida) además de imprimirla en la terminal. No aborta en el primer
# fallo: registra el resultado real de CADA paso, incluso si algún workspace
# falla por trabajo en curso de otros agentes — no se oculta ningún fallo.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_FILE="docs/logs/ci-local.log"
mkdir -p "$(dirname "$LOG_FILE")"

RUN_E2E=0
SKIP_INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --e2e) RUN_E2E=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    *) echo "Argumento desconocido: $arg" >&2; exit 2 ;;
  esac
done

# Todo lo que sigue se duplica a la terminal y al log.
exec > >(tee "$LOG_FILE") 2>&1

echo "=== ci-local.sh — $(date -u +'%Y-%m-%dT%H:%M:%SZ') ==="
echo "Node: $(node -v)   npm: $(npm -v)"
echo "Reproduce .github/workflows/quality.yml EXCEPTO db-postgres (requiere Postgres real, solo en CI)."
[ "$RUN_E2E" -eq 1 ] && echo "Incluye e2e-web (--e2e)." || echo "NO incluye e2e-web (pasa --e2e para incluirlo)."
echo ""

WORKSPACES=(apps/api apps/web apps/worker packages/db packages/agents packages/expediente packages/sources)

# Nota de portabilidad: NO se usan arrays asociativos (`declare -A`) porque
# el bash 3.2 que trae macOS por defecto (sin homebrew) no los soporta y este
# script debe correr igual en una laptop de desarrollo que en el runner de
# CI (bash 5). El resumen se acumula como líneas de texto en un archivo
# temporal en su lugar.
RESULTS_FILE="$(mktemp)"
trap 'rm -f "$RESULTS_FILE"' EXIT
OVERALL_STATUS=0

record() {
  local key="$1" status="$2"
  printf '%-40s %s\n' "$key" "$status" >> "$RESULTS_FILE"
  if [ "$status" != "OK" ] && [ "$status" != "N/A" ]; then
    OVERALL_STATUS=1
  fi
}

run_step() {
  # run_step <clave-para-el-resumen> <comando...>
  local key="$1"; shift
  echo "--- $key: $* ---"
  if "$@"; then
    echo "--- $key: OK ---"
    record "$key" "OK"
  else
    local code=$?
    echo "--- $key: FALLÓ (exit $code) ---"
    record "$key" "FALLÓ (exit $code)"
  fi
  echo ""
}

if [ "$SKIP_INSTALL" -eq 0 ]; then
  run_step "npm ci" npm ci
else
  echo "--- npm ci: omitido (--skip-install) ---"
  echo ""
fi

for ws in "${WORKSPACES[@]}"; do
  echo "=================================================================="
  echo "Workspace: $ws"
  echo "=================================================================="

  run_step "$ws:typecheck" npm run typecheck --workspace="$ws" --if-present

  run_step "$ws:lint" npm run lint --workspace="$ws" --if-present

  if npm run --workspace="$ws" 2>/dev/null | grep -q '^  test:coverage$'; then
    run_step "$ws:test:coverage" npm run test:coverage --workspace="$ws"
  else
    run_step "$ws:test" npm run test --workspace="$ws" --if-present
  fi

  run_step "$ws:build" npm run build --workspace="$ws" --if-present
done

if [ "$RUN_E2E" -eq 1 ]; then
  echo "=================================================================="
  echo "e2e-web (Playwright + axe-core, apps/web)"
  echo "=================================================================="
  run_step "e2e-web:install-chromium" npx --prefix apps/web playwright install --with-deps chromium
  run_step "e2e-web:test:e2e" npm run test:e2e --workspace=apps/web
fi

echo "=================================================================="
echo "npm audit --omit=dev --audit-level=high"
echo "=================================================================="
run_step "npm audit" npm audit --omit=dev --audit-level=high

echo "=================================================================="
echo "check-env-parity (IN-01, docs/auditoria-2/infra.md)"
echo "=================================================================="
run_step "check-env-parity" node infra/scripts/check-env-parity.mjs

echo "=================================================================="
echo "check-secrets"
echo "=================================================================="
run_step "check-secrets" bash scripts/check-secrets.sh
run_step "check-secrets:selftest" bash scripts/check-secrets.test.sh

echo "=================================================================="
echo "RESUMEN"
echo "=================================================================="
sort "$RESULTS_FILE"

echo ""
if [ "$OVERALL_STATUS" -eq 0 ]; then
  echo "ci-local.sh: TODO OK."
else
  echo "ci-local.sh: HAY FALLOS (ver arriba). Esto refleja el estado REAL del árbol de trabajo en este momento,"
  echo "incluyendo cambios en curso de otros agentes si los hubiera — no se oculta ningún fallo."
fi
echo "Recordatorio: el job db-postgres de CI (migraciones + RLS contra Postgres real) NO se reprodujo aquí; solo corre en GitHub Actions."
echo "Log completo: $LOG_FILE"

exit "$OVERALL_STATUS"
