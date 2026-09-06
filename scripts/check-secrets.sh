#!/usr/bin/env bash
# Grep de patrones de secretos filtrados en el árbol de trabajo (no en el
# historial de git). Excluye node_modules, artefactos de build y
# .env.example (que intencionalmente documenta nombres de variables con
# valores placeholder, no secretos reales).
#
# Uso: bash scripts/check-secrets.sh
# Sale con código != 0 y lista los hallazgos si encuentra algo sospechoso.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Directorios/paths excluidos de la búsqueda.
EXCLUDE_DIRS=(
  --exclude-dir=node_modules
  --exclude-dir=dist
  --exclude-dir=coverage
  --exclude-dir=.git
  --exclude-dir=.pglite
  --exclude-dir=playwright-report
  --exclude-dir=test-results
)
EXCLUDE_FILES=(
  --exclude='*.env.example'
  --exclude='package-lock.json'
  # Este propio script contiene los patrones como strings literales; sin
  # excluirlo, se detectaría a sí mismo como un falso positivo.
  --exclude='check-secrets.sh'
)

# Patrones de secretos conocidos. Cada línea es un patrón grep -E
# independiente; se reporta el archivo:línea de cualquier coincidencia.
PATTERNS=(
  # OpenAI / Anthropic / proveedores LLM con prefijo de API key reconocible.
  'sk-[A-Za-z0-9_-]{16,}'
  'sk-ant-[A-Za-z0-9_-]{16,}'
  # AWS access key id.
  'AKIA[0-9A-Z]{16}'
  # Claves privadas embebidas.
  '-----BEGIN (RSA|EC|OPENSSH|PGP|DSA) PRIVATE KEY-----'
  '-----BEGIN PRIVATE KEY-----'
  # Tokens de Slack.
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  # GitHub tokens.
  'gh[pousr]_[A-Za-z0-9]{20,}'
  # JWT con forma real (tres segmentos base64url) — ruido alto, se reporta
  # aparte y no cuenta para el código de salida por sí solo salvo que
  # aparezca junto a "secret"/"password" en la misma línea (ver abajo).
  # Dominio de Supabase (si el proyecto llegara a usarlo, no debe haber URLs
  # reales de proyecto commiteadas).
  '[a-z0-9-]+\.supabase\.co'
)

echo "[check-secrets] buscando patrones de secretos en el árbol de trabajo (excluye node_modules, dist, coverage, .env.example)..."

# Filtro de placeholders documentales conocidos (no son secretos reales):
# credenciales de ejemplo en READMEs/.env.example y dominios de muestra.
PLACEHOLDER_FILTER='usuario:password|user:pass|changeme|tu[_-]?password|ejemplo|example|placeholder|<[a-z_-]+>|xxxx'

FOUND=0
for pattern in "${PATTERNS[@]}"; do
  # -I: ignora binarios. -n: número de línea. -E: regex extendida.
  matches=$(grep -RInE "${EXCLUDE_DIRS[@]}" "${EXCLUDE_FILES[@]}" -- "$pattern" . 2>/dev/null \
    | grep -viE "$PLACEHOLDER_FILTER" || true)
  if [ -n "$matches" ]; then
    echo ""
    echo "[check-secrets] posible secreto — patrón: $pattern"
    echo "$matches"
    FOUND=1
  fi
done

# Cadenas de conexión Postgres con credenciales embebidas apuntando a un
# host que NO sea localhost/127.0.0.1 (sin lookahead: grep BSD de macOS no lo
# soporta; se filtra en dos pasos para que este script funcione igual en
# macOS local y en el runner de CI en Ubuntu).
pg_matches=$(grep -RInE "${EXCLUDE_DIRS[@]}" "${EXCLUDE_FILES[@]}" -- 'postgres(ql)?://[^:[:space:]]+:[^@[:space:]]{4,}@[A-Za-z0-9.-]+' . 2>/dev/null \
  | grep -vE '@(localhost|127\.0\.0\.1|db)([:/]|$)' \
  | grep -viE "$PLACEHOLDER_FILTER" || true)
if [ -n "$pg_matches" ]; then
  echo ""
  echo "[check-secrets] posible secreto — cadena de conexión Postgres con credenciales embebidas (host distinto de localhost):"
  echo "$pg_matches"
  FOUND=1
fi

# Aviso adicional, no bloqueante por sí solo: archivos .env reales que se
# hayan colado (deberían estar en .gitignore, pero si un agente los crea sin
# darse cuenta de que igual quedan en el árbol de trabajo, avisamos).
env_files=$(find . -type d \( -name node_modules -o -name .git \) -prune -o -type f -name '.env' -print 2>/dev/null)
if [ -n "$env_files" ]; then
  echo ""
  echo "[check-secrets] AVISO: archivo(s) .env reales presentes en el árbol de trabajo (deberían estar solo en local, nunca commiteados):"
  echo "$env_files"
fi

if [ "$FOUND" -eq 1 ]; then
  echo ""
  echo "[check-secrets] FALLÓ: se encontraron patrones de secretos. Revisa los hallazgos de arriba antes de commitear/mergear."
  exit 1
fi

echo "[check-secrets] OK: no se encontraron patrones de secretos conocidos."
exit 0
