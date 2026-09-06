#!/usr/bin/env bash
# infra/scripts/backup-postgres.sh — respaldo de la base de datos real de
# Atiende Licitaciones (Postgres) con `pg_dump --format=custom` (permite
# `pg_restore` selectivo y es el formato recomendado por Postgres para
# backups de producción), cifrado opcional con GPG, y retención por días.
#
# Complementa (no reemplaza) docs/OPERACION.md §8 "Respaldo / restauración"
# -- ese runbook documenta el comando base; este script lo automatiza con
# retención + cifrado opcional para poder programarlo (cron/systemd timer).
#
# IMPORTANTE (honestidad operativa, ver docs/OPERACION.md §8 y §9): este
# script NO se ha ejercitado contra un Postgres de producción real en este
# repositorio (no hay despliegue todavía) -- pruébalo primero contra un
# Postgres de staging/desarrollo (p. ej. infra/compose/docker-compose.dev.yml)
# y verifica con restore-postgres.sh que el backup restaura de verdad ANTES
# de depender de él en un incidente real.
#
# Uso:
#   DATABASE_URL=postgres://usuario:password@host:5432/basededatos \
#     bash infra/scripts/backup-postgres.sh [directorio_destino]
#
# Variables de entorno:
#   DATABASE_URL        (obligatoria) cadena de conexión Postgres real.
#   BACKUP_DIR           directorio destino (default: ./backups, o el
#                        primer argumento posicional si se da).
#   BACKUP_RETENTION_DAYS  días a conservar backups antes de borrarlos
#                          (default: 14; 0 = no borrar nada nunca).
#   BACKUP_GPG_RECIPIENT   si se define (p. ej. un email/ID de clave GPG
#                          importada en este host), el dump se cifra con
#                          `gpg --encrypt` para ese destinatario y el
#                          archivo `.dump` sin cifrar se borra. Sin esta
#                          variable, el backup queda SIN CIFRAR en disco
#                          (asegúrate de que el destino tenga permisos
#                          restrictivos y/o cifrado de disco).
#
# Salida: <BACKUP_DIR>/atiende-<basededatos>-<timestamp>.dump[.gpg]

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[backup-postgres] ERROR: falta DATABASE_URL (postgres://usuario:password@host:5432/basededatos)." >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "[backup-postgres] ERROR: pg_dump no está instalado en este host (paquete postgresql-client o similar)." >&2
  exit 1
fi

BACKUP_DIR="${1:-${BACKUP_DIR:-./backups}}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Extrae el nombre de la base de datos de la URL (último segmento tras la
# última "/", sin query string) solo para nombrar el archivo -- no se
# reconstruye ninguna credencial a partir de esto.
DB_NAME="$(echo "$DATABASE_URL" | sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#')"
if [ -z "$DB_NAME" ]; then
  DB_NAME="atiende"
fi

mkdir -p "$BACKUP_DIR"
DUMP_FILE="$BACKUP_DIR/atiende-${DB_NAME}-${TIMESTAMP}.dump"

echo "[backup-postgres] Volcando '$DB_NAME' a $DUMP_FILE ..."
pg_dump --format=custom --file="$DUMP_FILE" "$DATABASE_URL"
echo "[backup-postgres] pg_dump OK: $(du -h "$DUMP_FILE" | cut -f1)"

FINAL_FILE="$DUMP_FILE"
if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  if ! command -v gpg >/dev/null 2>&1; then
    echo "[backup-postgres] ERROR: BACKUP_GPG_RECIPIENT definido pero 'gpg' no está instalado." >&2
    exit 1
  fi
  echo "[backup-postgres] Cifrando para '$BACKUP_GPG_RECIPIENT' ..."
  gpg --yes --batch --trust-model always --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "${DUMP_FILE}.gpg" "$DUMP_FILE"
  rm -f "$DUMP_FILE"
  FINAL_FILE="${DUMP_FILE}.gpg"
  echo "[backup-postgres] Cifrado OK: $FINAL_FILE (dump sin cifrar borrado)."
else
  echo "[backup-postgres] AVISO: BACKUP_GPG_RECIPIENT no definido -- backup SIN CIFRAR en $FINAL_FILE."
fi

if [ "$RETENTION_DAYS" != "0" ]; then
  echo "[backup-postgres] Aplicando retención: borrando backups de más de ${RETENTION_DAYS} días en $BACKUP_DIR ..."
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'atiende-*.dump*' -mtime "+${RETENTION_DAYS}" -print -delete
fi

echo "[backup-postgres] Listo: $FINAL_FILE"
