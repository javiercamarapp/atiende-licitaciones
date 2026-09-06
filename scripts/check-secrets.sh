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
  # Logs de ejecuciones de CI local (docs/logs/*.log). Cuando check-secrets
  # falla, su propia salida (que reproduce las líneas "sospechosas"
  # encontradas) queda grabada en estos logs; si no se excluyeran, un log
  # que documentó un hallazgo pasado volvería a activarlo para siempre,
  # incluso después de corregir el original (problema autorreferencial).
  # Los .log no son código fuente ni deben contener secretos reales.
  --exclude='*.log'
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

# Marcador inline explícito para eximir UNA línea concreta (no el archivo
# completo) cuando es un fixture de prueba legítimo (p. ej. una clave PEM
# falsa usada para probar el rechazo de e.firma). Para que aplique:
#   1. La línea debe contener literalmente "check-secrets:allow-fixture"
#      (normalmente como comentario al final de la línea).
#   2. El archivo debe ser un archivo de test/e2e: *.test.ts, *.spec.ts,
#      o estar bajo un directorio /test/ o /e2e/.
# Cualquier coincidencia sin el marcador, o con el marcador pero fuera de un
# archivo de test/e2e, sigue fallando el chequeo.
FIXTURE_MARKER='check-secrets:allow-fixture'

# Determina si una ruta de archivo (tal como la reporta grep, p. ej.
# "./apps/api/test/foo.test.ts") corresponde a un archivo de test/e2e.
is_test_fixture_path() {
  local path="$1"
  case "$path" in
    *.test.ts|*.spec.ts) return 0 ;;
    */test/*|*/e2e/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Filtra de un bloque de resultados de grep ("archivo:linea:contenido", una
# coincidencia por línea) aquellas líneas marcadas explícitamente como
# fixture de prueba mediante $FIXTURE_MARKER Y ubicadas en un archivo de
# test/e2e. El resto de líneas se preserva sin cambios (incluyendo líneas
# marcadas pero fuera de test/e2e, que deben seguir fallando).
filter_fixture_marker_exemptions() {
  local input="$1"
  local line path
  [ -z "$input" ] && return 0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    path="${line%%:*}"
    if [[ "$line" == *"$FIXTURE_MARKER"* ]] && is_test_fixture_path "$path"; then
      continue
    fi
    printf '%s\n' "$line"
  done <<< "$input"
}

FOUND=0
for pattern in "${PATTERNS[@]}"; do
  # -I: ignora binarios. -n: número de línea. -E: regex extendida.
  matches=$(grep -RInE "${EXCLUDE_DIRS[@]}" "${EXCLUDE_FILES[@]}" -- "$pattern" . 2>/dev/null \
    | grep -viE "$PLACEHOLDER_FILTER" || true)
  matches=$(filter_fixture_marker_exemptions "$matches")
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
pg_matches=$(filter_fixture_marker_exemptions "$pg_matches")
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
