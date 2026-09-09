#!/usr/bin/env bash
# infra/scripts/healthcheck.sh — verifica /healthz (liveness) y /readyz
# (readiness real, toca la base de datos) de apps/api en marcha, tal como
# los describe docs/OPERACION.md §4.
#
# Uso:
#   bash infra/scripts/healthcheck.sh [base_url]
#
#   base_url por defecto: http://localhost:3000 (o $API_BASE_URL si está
#   definida). En producción con el compose de infra/compose, usa el
#   dominio público real: https://api.tudominio.mx
#
# Salida: 0 si AMBOS endpoints responden 200; distinto de 0 si cualquiera
# falla (útil como probe externo -- p. ej. cron + alerta, o un paso manual
# de verificación tras desplegar). No sustituye al HEALTHCHECK nativo de
# apps/api/Dockerfile (ese solo cubre /healthz, pensado para que el propio
# orquestador reinicie el proceso; este script cubre ambos para un chequeo
# operativo manual/externo, incluyendo el estado real de la base de datos).

set -uo pipefail

BASE_URL="${1:-${API_BASE_URL:-http://localhost:3000}}"
BASE_URL="${BASE_URL%/}"

if ! command -v curl >/dev/null 2>&1; then
  echo "[healthcheck] ERROR: 'curl' no está instalado en este host." >&2
  exit 1
fi

check() {
  local path="$1"
  local url="${BASE_URL}${path}"
  local code
  # IN-11 (docs/auditoria-2/infra.md): antes usaba una ruta predecible
  # (/tmp/healthcheck-body.$$) en /tmp (mundialmente escribible) -- superficie
  # TOCTOU de bajo impacto práctico (solo se lee un cuerpo HTTP no sensible),
  # pero el resto de scripts de este repo ya usa `mktemp`, así que este
  # también, por consistencia y para cerrar la brecha sin costo real.
  local body_file
  body_file="$(mktemp)"
  code="$(curl -s -o "$body_file" -w '%{http_code}' --max-time 5 "$url")"
  local body
  body="$(cat "$body_file" 2>/dev/null || true)"
  rm -f "$body_file"
  if [ "$code" = "200" ]; then
    echo "[healthcheck] OK   $url -> $code $body"
    return 0
  else
    echo "[healthcheck] FAIL $url -> $code $body" >&2
    return 1
  fi
}

STATUS=0
check "/healthz" || STATUS=1
check "/readyz" || STATUS=1

if [ "$STATUS" -eq 0 ]; then
  echo "[healthcheck] apps/api saludable (liveness + readiness OK) en $BASE_URL"
else
  echo "[healthcheck] apps/api NO saludable en $BASE_URL -- ver docs/OPERACION.md §9 'Incidentes y escalado'." >&2
fi

exit "$STATUS"
