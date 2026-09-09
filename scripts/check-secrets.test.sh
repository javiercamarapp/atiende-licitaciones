#!/usr/bin/env bash
# Pruebas de scripts/check-secrets.sh contra fixtures SINTÉTICOS, generados
# en tiempo de ejecución dentro de repositorios git AISLADOS en /tmp (nunca
# escritos al árbol real de este repo, y nunca commiteados aquí) -- IN-02
# (docs/auditoria-2/infra.md) pedía explícitamente "fixtures positivas/
# negativas" para los patrones nuevos (Resend, JWT) y para el marcador
# check-secrets:allow-fixture, además de una prueba real (no solo lectura de
# código) de que el filtro de .gitignore introducido junto con IN-02 no
# rompe la detección de secretos reales en archivos que SÍ se commitearían.
#
# Uso: bash scripts/check-secrets.test.sh
# Sale con código != 0 (y detalla qué aserción falló) si algo no se comporta
# como se espera.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_SECRETS="$REPO_ROOT/scripts/check-secrets.sh"

FAILURES=0

assert_true() {
  local description="$1" condition="$2"
  if [ "$condition" -eq 0 ]; then
    echo "  OK   - $description"
  else
    echo "  FAIL - $description"
    FAILURES=$((FAILURES + 1))
  fi
}

assert_contains() {
  local description="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "  OK   - $description"
  else
    echo "  FAIL - $description (no se encontró: $needle)"
    FAILURES=$((FAILURES + 1))
  fi
}

assert_not_contains() {
  local description="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "  OK   - $description"
  else
    echo "  FAIL - $description (NO debía aparecer: $needle)"
    FAILURES=$((FAILURES + 1))
  fi
}

POS_DIR="$(mktemp -d)"
NEG_DIR="$(mktemp -d)"
NOGIT_DIR="$(mktemp -d)"
trap 'rm -rf "$POS_DIR" "$NEG_DIR" "$NOGIT_DIR"' EXIT

# ---------------------------------------------------------------------------
# Escenario 1: solo hallazgos POSITIVOS -- debe FALLAR (exit 1) y reportar
# cada patrón, incluidos los nuevos de esta ronda (Resend, JWT).
# ---------------------------------------------------------------------------
echo "=== Escenario 1: fixtures positivas (debe fallar) ==="

git -C "$POS_DIR" init -q
git -C "$POS_DIR" config user.email "test@example.com"
git -C "$POS_DIR" config user.name "test"
mkdir -p "$POS_DIR/src" "$POS_DIR/infra/compose"

cat > "$POS_DIR/src/leak-aws.ts" <<'EOF'
export const key = "AKIAABCDEFGHIJKLMNOPQRS";
EOF

cat > "$POS_DIR/src/leak-pem.ts" <<'EOF'
export const pem = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDA
-----END PRIVATE KEY-----`;
EOF

# Forma real de un token de Resend (re_<segmento>_<segmento>) -- IN-02: antes
# de esta ronda ningún patrón lo detectaba.
cat > "$POS_DIR/src/leak-resend.ts" <<'EOF'
export const resendKey = "re_c3Ntg8fh_HdaK9vXqR2pL7mNfG4tYzWq";
EOF

# JWT de tres segmentos con forma real -- IN-02: antes de esta ronda ningún
# patrón lo detectaba (el comentario que lo mencionaba nunca se implementó).
cat > "$POS_DIR/src/leak-jwt.ts" <<'EOF'
export const token =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
EOF

cat > "$POS_DIR/src/leak-google.ts" <<'EOF'
export const googleSecret = "GOCSPX-abcdefghijklmnopqrstuvwx";
EOF

# Cadena Postgres con credenciales LITERALES (no ${VAR}) contra un host que
# no es localhost/127.0.0.1/db -- debe seguir detectándose como antes.
cat > "$POS_DIR/infra/compose/docker-compose.prod.yml" <<'EOF'
services:
  api:
    environment:
      DATABASE_URL: postgres://real_user:S0meR3alPassw0rd@db-prod.internal-hostname.io:5432/prod
EOF

# El marcador check-secrets:allow-fixture FUERA de un path de test/e2e NO
# debe eximir nada -- sigue fallando.
cat > "$POS_DIR/src/not-a-test.ts" <<'EOF'
export const key = "AKIAZZZZZZZZZZZZZZZZ"; // check-secrets:allow-fixture
EOF

git -C "$POS_DIR" add -A >/dev/null

OUTPUT_POS="$(CHECK_SECRETS_ROOT="$POS_DIR" bash "$CHECK_SECRETS" 2>&1)"
CODE_POS=$?

assert_true "sale con código 1 (hallazgos positivos)" "$([ "$CODE_POS" -eq 1 ] && echo 0 || echo 1)"
assert_contains "detecta la clave AWS (AKIA...)" "$OUTPUT_POS" "leak-aws.ts"
assert_contains "detecta el bloque PEM" "$OUTPUT_POS" "leak-pem.ts"
assert_contains "detecta el token Resend (re_..., patrón NUEVO IN-02)" "$OUTPUT_POS" "leak-resend.ts"
assert_contains "detecta el JWT de forma real (patrón NUEVO IN-02)" "$OUTPUT_POS" "leak-jwt.ts"
assert_contains "detecta el client secret de Google (GOCSPX-...)" "$OUTPUT_POS" "leak-google.ts"
assert_contains "detecta la cadena Postgres con credenciales literales" "$OUTPUT_POS" "db-prod.internal-hostname.io"
assert_contains "el marcador allow-fixture FUERA de test/e2e NO exime" "$OUTPUT_POS" "not-a-test.ts"

# ---------------------------------------------------------------------------
# Escenario 2: solo fixtures NEGATIVAS (falsos positivos conocidos y casos
# legítimamente exentos) -- debe PASAR (exit 0), sin ningún hallazgo.
# ---------------------------------------------------------------------------
echo ""
echo "=== Escenario 2: fixtures negativas (debe pasar) ==="

git -C "$NEG_DIR" init -q
git -C "$NEG_DIR" config user.email "test@example.com"
git -C "$NEG_DIR" config user.name "test"
mkdir -p "$NEG_DIR/src" "$NEG_DIR/infra/compose" "$NEG_DIR/test" "$NEG_DIR/docs/auditoria-2"

# .env.example: excluido por nombre de archivo, aunque documente un valor
# con forma de secreto real.
cat > "$NEG_DIR/apps-api.env.example" <<'EOF'
AWS_KEY=AKIAABCDEFGHIJKLMNOPQRS
EOF

# Placeholder documental conocido (PLACEHOLDER_FILTER) -- "ejemplo" en la
# misma línea exime la coincidencia de forma real de sk-.
cat > "$NEG_DIR/src/ok-placeholder.ts" <<'EOF'
export const key = "sk-ejemplo1234567890123456"; // valor de ejemplo, no real
EOF

# Cadena Postgres PARAMETRIZADA (${VAR}:${VAR}@host) -- forma correcta de
# interpolación de Compose, no un secreto literal.
cat > "$NEG_DIR/infra/compose/docker-compose.prod.yml" <<'EOF'
services:
  api:
    environment:
      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/prod
EOF

# El marcador check-secrets:allow-fixture DENTRO de un path de test/e2e SÍ
# exime esa línea.
cat > "$NEG_DIR/test/fixture.test.ts" <<'EOF'
export const key = "AKIAABCDEFGHIJKLMNOPQRS"; // check-secrets:allow-fixture
EOF

# Informe de auditoría (docs/auditoria-2/**) citando un ejemplo de secreto
# sintético -- excluido por directorio (mismo criterio que *.log).
cat > "$NEG_DIR/docs/auditoria-2/example-audit.md" <<'EOF'
Prueba positiva de detección: una clave AWS sintética (`AKIAABCDEFGHIJKLMNOPQRS`)
fue detectada correctamente por check-secrets.sh en esta ronda.
EOF

# package-lock.json y *.log: excluidos por nombre de archivo.
cat > "$NEG_DIR/package-lock.json" <<'EOF'
{ "note": "AKIAABCDEFGHIJKLMNOPQRS" }
EOF
cat > "$NEG_DIR/ci-run.log" <<'EOF'
[check-secrets] posible secreto -- patron: AKIA[0-9A-Z]{16}
AKIAABCDEFGHIJKLMNOPQRS
EOF

# Archivo gitignorado y SIN trackear -- exactamente el caso real que motivó
# el filtro basado en `git ls-files` de esta ronda (ver check-secrets.sh):
# un token real (aquí, con forma de JWT) que vive solo en el árbol de
# trabajo local y que git JAMÁS commitearía. No debe reportarse.
cat > "$NEG_DIR/.gitignore" <<'EOF'
secret-artifact/
EOF
mkdir -p "$NEG_DIR/secret-artifact"
cat > "$NEG_DIR/secret-artifact/token.json" <<'EOF'
{"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}
EOF

git -C "$NEG_DIR" add -A >/dev/null

OUTPUT_NEG="$(CHECK_SECRETS_ROOT="$NEG_DIR" bash "$CHECK_SECRETS" 2>&1)"
CODE_NEG=$?

assert_true "sale con código 0 (sin hallazgos reales)" "$([ "$CODE_NEG" -eq 0 ] && echo 0 || echo 1)"
assert_not_contains ".env.example excluido por nombre de archivo" "$OUTPUT_NEG" "apps-api.env.example"
assert_not_contains "placeholder ('ejemplo') exime la coincidencia" "$OUTPUT_NEG" "ok-placeholder.ts"
assert_not_contains "Postgres parametrizada (\${VAR}) no es un secreto" "$OUTPUT_NEG" "docker-compose.prod.yml"
assert_not_contains "marcador allow-fixture DENTRO de test/ sí exime" "$OUTPUT_NEG" "fixture.test.ts"
assert_not_contains "docs/auditoria-2/** excluido por directorio" "$OUTPUT_NEG" "example-audit.md"
assert_not_contains "package-lock.json excluido por nombre de archivo" "$OUTPUT_NEG" "package-lock.json"
assert_not_contains "*.log excluido por nombre de archivo" "$OUTPUT_NEG" "ci-run.log"
assert_not_contains "archivo gitignorado+sin trackear NUNCA se escanea (fix de esta ronda)" "$OUTPUT_NEG" "token.json"

# ---------------------------------------------------------------------------
# Escenario 3: CHECK_SECRETS_ROOT que no es un repositorio git -- debe
# abortar con un error explícito (nunca "pasar" silenciosamente sin haber
# escaneado nada).
# ---------------------------------------------------------------------------
echo ""
echo "=== Escenario 3: raíz sin repositorio git (debe abortar con error) ==="

OUTPUT_NOGIT="$(CHECK_SECRETS_ROOT="$NOGIT_DIR" bash "$CHECK_SECRETS" 2>&1)"
CODE_NOGIT=$?

assert_true "sale con código distinto de 0 y de 1 (error explícito, no falso OK)" "$([ "$CODE_NOGIT" -eq 2 ] && echo 0 || echo 1)"
assert_contains "el mensaje explica que no es un repositorio git" "$OUTPUT_NOGIT" "no es (o no se pudo determinar que sea) un repositorio git"

# ---------------------------------------------------------------------------
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "[check-secrets.test.sh] OK: todas las aserciones pasaron."
  exit 0
else
  echo "[check-secrets.test.sh] FALLÓ: $FAILURES aserción(es) no se cumplieron (ver arriba)."
  exit 1
fi
