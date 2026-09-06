#!/usr/bin/env bash
# infra/scripts/restore-postgres.sh — restauración de un backup producido
# por infra/scripts/backup-postgres.sh (o cualquier dump `pg_dump
# --format=custom`) contra un Postgres real, seguida de
# `scripts/db-postgres-migrate.mjs` (idempotente -- ver docs/OPERACION.md
# §8: si el backup ya tiene todas las migraciones aplicadas no hace nada;
# si es de antes de una migración nueva, la aplica).
#
# ADVERTENCIA (léase antes de correr esto contra cualquier base con datos
# reales): `pg_restore --clean --if-exists` BORRA los objetos existentes
# antes de recrearlos. Esto es DESTRUCTIVO. Este script pide confirmación
# explícita salvo que se pase --yes.
#
# RLS y roles (ver docs/OPERACION.md §8 y packages/db/README.md): un dump
# de solo datos, sin las migraciones 0001/0007/0008 (roles `app_role`,
# funciones SECURITY DEFINER, políticas), rompe el aislamiento
# multi-tenant EN SILENCIO. Este script asume que el `.dump` a restaurar
# incluye esquema+roles+funciones (el que produce backup-postgres.sh, que
# hace `pg_dump` de la base completa) -- no un `--data-only`.
#
# IMPORTANTE (honestidad operativa): este script NO se ha ejercitado en
# este repositorio contra un backup/restore real de producción (no hay
# despliegue todavía) -- pruébalo primero de punta a punta (backup ->
# restore -> verificar datos) contra un Postgres de desarrollo/staging
# antes de depender de él en un incidente real.
#
# Uso:
#   DATABASE_URL=postgres://usuario:password@host:5432/basededatos \
#     bash infra/scripts/restore-postgres.sh backups/atiende-xxx.dump [--yes]
#
#   # Si el backup está cifrado con GPG (ver backup-postgres.sh):
#   DATABASE_URL=... bash infra/scripts/restore-postgres.sh backups/atiende-xxx.dump.gpg

set -euo pipefail

DUMP_FILE="${1:-}"
CONFIRM="${2:-}"

if [ -z "$DUMP_FILE" ]; then
  echo "Uso: DATABASE_URL=postgres://... bash $0 <archivo.dump[.gpg]> [--yes]" >&2
  exit 1
fi

if [ ! -f "$DUMP_FILE" ]; then
  echo "[restore-postgres] ERROR: no existe el archivo '$DUMP_FILE'." >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[restore-postgres] ERROR: falta DATABASE_URL (postgres://usuario:password@host:5432/basededatos)." >&2
  exit 1
fi

for bin in pg_restore npx; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[restore-postgres] ERROR: falta el comando '$bin' en este host." >&2
    exit 1
  fi
done

REDACTED_URL="$(echo "$DATABASE_URL" | sed -E 's#(://[^:@/]+):[^@]*@#\1:***@#')"

echo "[restore-postgres] Vas a RESTAURAR (destructivo, --clean --if-exists) sobre:"
echo "  $REDACTED_URL"
echo "  desde: $DUMP_FILE"
if [ "$CONFIRM" != "--yes" ]; then
  read -r -p "Escribe RESTAURAR para continuar: " ANSWER
  if [ "$ANSWER" != "RESTAURAR" ]; then
    echo "[restore-postgres] Cancelado (no se escribió 'RESTAURAR' exactamente)."
    exit 1
  fi
fi

RESTORE_FILE="$DUMP_FILE"
CLEANUP_DECRYPTED=""
case "$DUMP_FILE" in
  *.gpg)
    if ! command -v gpg >/dev/null 2>&1; then
      echo "[restore-postgres] ERROR: el archivo termina en .gpg pero 'gpg' no está instalado." >&2
      exit 1
    fi
    RESTORE_FILE="$(mktemp)"
    echo "[restore-postgres] Descifrando $DUMP_FILE ..."
    gpg --yes --batch --decrypt --output "$RESTORE_FILE" "$DUMP_FILE"
    CLEANUP_DECRYPTED="$RESTORE_FILE"
    ;;
esac

cleanup() {
  if [ -n "$CLEANUP_DECRYPTED" ] && [ -f "$CLEANUP_DECRYPTED" ]; then
    rm -f "$CLEANUP_DECRYPTED"
  fi
}
trap cleanup EXIT

echo "[restore-postgres] Ejecutando pg_restore --clean --if-exists ..."
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$RESTORE_FILE"
echo "[restore-postgres] pg_restore OK."

echo "[restore-postgres] Aplicando migraciones pendientes (idempotente) con scripts/db-postgres-migrate.mjs ..."
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
(cd "$REPO_ROOT" && DATABASE_URL="$DATABASE_URL" npx tsx scripts/db-postgres-migrate.mjs)

echo "[restore-postgres] Listo. Verifica manualmente datos/RLS antes de dar el incidente por resuelto (ver docs/OPERACION.md §8)."
