#!/usr/bin/env bash
# Grep de patrones de secretos filtrados en el árbol de trabajo (no en el
# historial de git). Excluye node_modules, artefactos de build y
# .env.example (que intencionalmente documenta nombres de variables con
# valores placeholder, no secretos reales).
#
# Uso: bash scripts/check-secrets.sh
# Sale con código != 0 y lista los hallazgos si encuentra algo sospechoso.

set -uo pipefail

# CHECK_SECRETS_ROOT: override solo para pruebas (ver
# scripts/check-secrets.test.sh) -- permite ejecutar este script contra un
# árbol de fixtures aislado en /tmp en vez del repositorio real, sin arriesgar
# que un secreto sintético de prueba quede commiteado por accidente. Sin
# definir, se comporta exactamente igual que antes (raíz real del repo).
ROOT_DIR="${CHECK_SECRETS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT_DIR" || exit 1

# IN-02 (docs/auditoria-2/infra.md): este script escanea el CONTENIDO de los
# archivos que git considera parte de un posible commit -- trackeados
# (`--cached`) más nuevos sin trackear que NO estén en .gitignore
# (`--others --exclude-standard`, respeta .gitignore anidados como
# apps/web/.gitignore) -- en vez de recorrer el filesystem crudo con
# `grep -r .`. Motivo real, no teórico: al agregar el patrón de JWT más
# abajo se descubrió que el árbol de trabajo real de este repo tiene
# `.env.local`/`apps/web/.env.local` (token OIDC real de `vercel env pull`)
# y `apps/web/e2e/.artifacts/*.json` (tokens de sesión reales de una corrida
# de Playwright) -- los tres correctamente gitignored, NUNCA en riesgo de
# commitearse, pero que un `grep -r .` crudo sí reportaría como "hallazgo"
# cada vez que existan localmente. Ese ruido es exactamente lo opuesto al
# propósito de este script ("antes de commitear/mergear"): un archivo que el
# propio git ya garantiza que nunca se commiteará no debería poder fallar
# este chequeo. Un archivo NUEVO sin trackear que SÍ sería commiteado
# (`git add` + `git commit`) sigue estando cubierto por `--others
# --exclude-standard`.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[check-secrets] ERROR: '$ROOT_DIR' no es (o no se pudo determinar que sea) un repositorio git -- no se puede aplicar el filtro de .gitignore de forma segura." >&2
  exit 2
fi

# Archivos/paths excluidos del escaneo AUNQUE git los liste (no por estar
# gitignorados, sino porque son ruido conocido para este propósito concreto).
is_excluded_file() {
  local path="$1"
  case "$path" in
    *.env.example) return 0 ;;
    package-lock.json|*/package-lock.json) return 0 ;;
    # Este propio script (y su suite de pruebas, que genera A PROPÓSITO
    # fixtures con forma de secreto real para verificar que cada patrón SÍ
    # los detecta -- ver check-secrets.test.sh) contienen los patrones y
    # ejemplos como strings literales; sin excluirlos, se detectarían a sí
    # mismos como un falso positivo cada vez que corra este chequeo sobre el
    # repositorio real.
    scripts/check-secrets.sh|scripts/check-secrets.test.sh) return 0 ;;
    # Logs de ejecuciones de CI local (docs/logs/*.log). Cuando check-secrets
    # falla, su propia salida (que reproduce las líneas "sospechosas"
    # encontradas) queda grabada en estos logs; si no se excluyeran, un log
    # que documentó un hallazgo pasado volvería a activarlo para siempre,
    # incluso después de corregir el original (problema autorreferencial).
    # Los .log no son código fuente ni deben contener secretos reales.
    *.log) return 0 ;;
    # IN-02 (docs/auditoria-2/infra.md): docs/auditoria-2/**/*.md son
    # informes de auditoría adversarial que, por su propia naturaleza, CITAN
    # literalmente ejemplos de secretos sintéticos usados para verificar que
    # este mismo script SÍ los detecta (p. ej. "AKIAABCDEFGHIJKLMNOP", un
    # bloque "-----BEGIN PRIVATE KEY-----" de prueba, o
    # "sk-test-super-secreta-...") -- mismo problema autorreferencial que
    # *.log arriba. Ninguno de estos archivos es código fuente ni debe
    # contener secretos reales.
    docs/auditoria-2/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Lista de archivos candidatos, separados por NUL (para sobrevivir espacios y
# saltos de línea en nombres de archivo), ya sin los excluidos de arriba.
#
# A PROPÓSITO un archivo temporal, NUNCA una variable de bash: bash (probado
# en 3.2, el que trae macOS sin homebrew -- el mismo que ejecuta este script
# en este entorno) representa sus variables como cadenas terminadas en NUL
# al estilo C, así que CUALQUIER intento de acumular una lista NUL-delimitada
# en una variable (`v="${v}${f}"$'\0'`) pierde en silencio cada separador al
# ejecutarse como script real (`bash archivo.sh`, no interactivo) -- se
# verificó de forma reproducible en esta ronda: la lista de candidatos
# "colapsaba" a una sola cadena sin separadores y ningún patrón volvía a
# encontrar nada, un falso "OK" total y silencioso. Un archivo en disco no
# tiene ese límite.
CANDIDATES_FILE="$(mktemp)"
trap 'rm -f "$CANDIDATES_FILE"' EXIT
git ls-files --cached --others --exclude-standard -z -- . 2>/dev/null \
  | while IFS= read -r -d '' f; do
      is_excluded_file "$f" && continue
      printf '%s\0' "$f"
    done > "$CANDIDATES_FILE"

# grep sobre la lista de candidatos (NUL-delimitada, vía el archivo de
# arriba). Silencioso (matches vacío) si no hay candidatos, para que `xargs`
# nunca corra sin argumentos de archivo (leería de stdin y colgaría el
# script -- BSD/macOS `xargs` no tiene `-r`/`--no-run-if-empty` como GNU).
grep_candidates() {
  local pattern="$1"
  [ -s "$CANDIDATES_FILE" ] || return 0
  # -H: fuerza el prefijo "archivo:" SIEMPRE, incluso cuando `xargs` termine
  # invocando `grep` con un solo argumento de archivo (grep lo omite por
  # defecto en ese caso, lo que rompía el reporte "archivo:línea:contenido"
  # de abajo -- p. ej. is_test_fixture_path()/filter_fixture_marker_exemptions()
  # dependen de poder extraer la ruta antes de los ":").
  xargs -0 grep -HInE -- "$pattern" < "$CANDIDATES_FILE" 2>/dev/null || true
}

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
  # IN-02 (docs/auditoria-2/infra.md): esta ronda introdujo
  # RESEND_API_KEY/RESEND_WEBHOOK_SECRET (packages/mail) sin ningún patrón
  # que detectara un token real filtrado. Forma real de Resend:
  # "re_" + segmento + "_" + segmento (ver dashboard.resend.com/api-keys).
  're_[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}'
  # JWT con forma real (tres segmentos base64url, el primero típicamente
  # empieza con "eyJ" -- base64 de '{"'). Antes solo documentado en un
  # comentario ("se reporta aparte... salvo que aparezca junto a
  # secret/password") pero NUNCA implementado (IN-02) -- se trata ahora
  # igual que el resto de patrones: sujeto al mismo PLACEHOLDER_FILTER y al
  # mismo $FIXTURE_MARKER que cualquier otro secreto de esta lista, sin la
  # excepción de proximidad a "secret"/"password" (un JWT real filtrado no
  # suele aparecer junto a esas palabras literales). Solo puede reportar
  # sobre archivos que git commitearía -- ver el filtro de candidatos arriba
  # para el motivo por el que esto importa concretamente para este patrón.
  'eyJ[A-Za-z0-9_=-]{10,}\.[A-Za-z0-9_=-]{10,}\.[A-Za-z0-9_=-]{10,}'
  # Dominio de Supabase (si el proyecto llegara a usarlo, no debe haber URLs
  # reales de proyecto commiteadas).
  '[a-z0-9-]+\.supabase\.co'
  # Google OAuth client secret real (prefijo usado por Google Cloud Console
  # desde 2021). Ancla al prefijo del VALOR, no al nombre de la variable, para
  # no capturar "GOOGLE_CLIENT_SECRET=" vacío o con placeholder.
  'GOCSPX-[A-Za-z0-9_-]{20,}'
)

echo "[check-secrets] buscando patrones de secretos en los archivos que git commitearía (trackeados + nuevos sin trackear, respetando .gitignore)..."

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
# "apps/api/test/foo.test.ts") corresponde a un archivo de test/e2e.
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
  matches=$(grep_candidates "$pattern" | grep -viE "$PLACEHOLDER_FILTER" || true)
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
#
# Excluye también el caso en que usuario Y password son EXACTAMENTE
# interpolación de variables de entorno estilo Compose/shell (${VAR}) —
# es la forma correcta de parametrizar credenciales (p. ej.
# infra/compose/docker-compose.prod.yml: DATABASE_URL con
# ${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432), no un secreto
# literal. Si CUALQUIERA de los dos segmentos no es ${...} completo, la
# línea se sigue reportando (evita que "usuario:${PASSWORD_REAL_HARDCODEADA}"
# se cuele como si fuera seguro).
pg_matches=$(grep_candidates 'postgres(ql)?://[^:[:space:]]+:[^@[:space:]]{4,}@[A-Za-z0-9.-]+' \
  | grep -vE '@(localhost|127\.0\.0\.1|db)([:/]|$)' \
  | grep -vE ':\/\/\$\{[A-Za-z_][A-Za-z0-9_]*\}:\$\{[A-Za-z_][A-Za-z0-9_]*\}@' \
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
# darse cuenta de que igual quedan en el árbol de trabajo, avisamos). A
# propósito por filesystem crudo (no por la lista de candidatos de git): el
# objetivo aquí es avisar de la MERA PRESENCIA del archivo, incluso uno
# legítimamente gitignorado, no escanear su contenido en busca de patrones.
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
