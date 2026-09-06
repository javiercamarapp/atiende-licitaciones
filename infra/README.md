# Infraestructura de despliegue — Atiende Licitaciones

Este directorio contiene TODO lo necesario para construir y correr
Atiende Licitaciones con Docker/Docker Compose: no reemplaza
`docs/OPERACION.md` (el runbook operativo, basado en el código real, sigue
siendo la fuente de verdad de CÓMO se comporta cada pieza) — lo
complementa con el empaquetado y el paso a paso de salida a producción.

**Nada de esto se ha desplegado ni ejecutado contra infraestructura real**
en esta ronda (no hay Docker disponible en el entorno donde se escribió —
ver `docs/logs/infra-ronda6.log` para el detalle exacto de qué se validó y
qué no). Antes de depender de esto en producción real, constrúyelo y
pruébalo de punta a punta en un entorno de staging.

## Estructura

```
infra/
  README.md                    este archivo
  docker/
    Caddyfile                   reverse proxy de borde (TLS automático)
    nginx.conf                   nginx.conf principal de apps/web (no-root)
    nginx.web.conf               server block de apps/web (SPA estática)
  compose/
    docker-compose.prod.yml      stack completo de producción
    docker-compose.dev.yml       Postgres real para desarrollo (opcional)
  env/
    .env.prod.example             TODAS las variables documentadas
  scripts/
    backup-postgres.sh            pg_dump + retención + cifrado GPG opcional
    restore-postgres.sh           pg_restore + migraciones
    healthcheck.sh                curl a /healthz y /readyz
    rotate-secrets.md             procedimiento de rotación (Docker Compose)

apps/api/Dockerfile        (fuera de infra/ por convención Docker: cada
apps/worker/Dockerfile      Dockerfile vive junto a la app que empaqueta)
apps/web/Dockerfile
.dockerignore                (raíz — compartido por los tres builds)
```

## Arquitectura de despliegue

```
Internet
   │  HTTPS (443) / HTTP->HTTPS redirect (80)
   ▼
┌─────────────────────────┐
│  caddy (TLS automático)  │  infra/docker/Caddyfile
│  Let's Encrypt/ZeroSSL   │  dos dominios: $WEB_DOMAIN / $API_DOMAIN
└───────────┬──────┬───────┘
            │      │
   $WEB_DOMAIN    $API_DOMAIN
            │      │
            ▼      ▼
      ┌────────┐ ┌────────┐        ┌──────────┐
      │  web    │ │  api    │──────►│  worker   │ (no expone puerto propio)
      │ nginx   │ │ Fastify │◄──────│  cola de   │
      │(estático)│ │  :3000  │       │  jobs      │
      └────────┘ └────┬────┘        └─────┬─────┘
                       │                    │
                       └─────────┬──────────┘
                                  ▼
                          ┌───────────────┐
                          │   postgres     │  volumen `pgdata`
                          │  (16-alpine)   │
                          └───────┬───────┘
                                  ▲
                          ┌───────┴───────┐
                          │   migrate      │  servicio de un solo uso,
                          │ (mismo imagen  │  aplica packages/db/migrations
                          │  que `api`)    │  ANTES de que arranquen api/worker
                          └───────────────┘
```

`api`/`worker` NO se exponen directamente a Internet — solo `caddy` publica
80/443. `postgres` no publica ningún puerto al host en producción.

**Por qué dos dominios (`$WEB_DOMAIN`/`$API_DOMAIN`) y no un único origen
con rutas `/api/*`**: `apps/web` llama a la API con
`import.meta.env.VITE_API_URL` (absoluto, horneado en el build — ver
`apps/web/Dockerfile`). Un proxy por rutas exigiría enumerar aquí, y
mantener sincronizada, la lista completa de prefijos reales de `apps/api`
(crece en cada ronda — auth, 2fa, legal, organizations, me, company,
tenders, expediente, matching, admin, audit-log, internal, agents...). Dos
dominios evita ese acoplamiento fragil; el cross-origin resultante lo
resuelve `CORS_ORIGINS` (ya con `methods`/`allowedHeaders`/`exposedHeaders`
explícitos en `apps/api/src/app.ts`, no depende de defaults frágiles de
`@fastify/cors`).

## Requisitos

- Un host con Docker Engine + Docker Compose v2 (`docker compose`, no el
  binario viejo `docker-compose` v1).
- Un dominio real con acceso a su DNS (dos registros A/AAAA:
  `$WEB_DOMAIN` y `$API_DOMAIN` apuntando a la IP pública del host).
- Puertos 80/443 (TCP) y 443 (UDP, HTTP/3) accesibles desde Internet para
  que Caddy pueda emitir certificados TLS automáticos.

## Despliegue paso a paso (primera vez)

1. **DNS**: crea los registros A/AAAA de `$WEB_DOMAIN` y `$API_DOMAIN`
   apuntando al host. Espera a que propaguen (`dig +short $WEB_DOMAIN`)
   antes del paso 5 — Caddy reintenta solo si falla, pero no hay razón
   para hacerlo esperar.
2. **Clona el repo en el host** y sitúate en su raíz.
3. **Variables de entorno**:
   ```bash
   cp infra/env/.env.prod.example infra/compose/.env
   ```
   Completa CADA variable de `infra/compose/.env` (ver esa plantilla para
   la descripción de cada una — distingue `[ACTIVA]` de `[RESERVADA]`).
   Genera secretos con `openssl rand -base64 48`. **Nunca commitees este
   archivo** (`.gitignore` raíz ya excluye `.env`/`.env.*` salvo
   `*.env.example`).
4. **Construye las imágenes**:
   ```bash
   cd infra/compose
   docker compose -f docker-compose.prod.yml build
   ```
5. **Levanta el stack**:
   ```bash
   docker compose -f docker-compose.prod.yml up -d
   ```
   Orden real forzado por `depends_on`/`healthcheck` en el compose:
   `postgres` (sano) → `migrate` (aplica `packages/db/migrations/*.sql`,
   termina) → `api`/`worker` → `web`/`caddy`.
6. **Verifica**:
   ```bash
   docker compose -f docker-compose.prod.yml ps
   bash ../scripts/healthcheck.sh https://$API_DOMAIN
   curl -I https://$WEB_DOMAIN
   ```
7. **Primer superadmin** (no existe un endpoint de auto-promoción a
   propósito — ver `packages/db/README.md`/`docs/auditoria-1/db-api.md`:
   "un usuario normal no puede auto-nombrarse superadmin"):
   1. Registra una cuenta normal desde `https://$WEB_DOMAIN` (o
      `POST /auth/login`'s `/auth/register`).
   2. Conéctate a Postgres real y promuévela a mano:
      ```bash
      docker compose -f docker-compose.prod.yml exec postgres \
        psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
        "insert into platform_admins (user_id) select id from users where lower(email) = lower('correo@tudominio.mx');"
      ```
   3. Verifica: esa cuenta debería ver ahora las secciones de back office
      restringidas a superadmin (Conectores/Fuentes, Aprobaciones
      cross-org, etc. — ver `apps/api/README.md` módulo `admin`).
8. **Backups**: programa `infra/scripts/backup-postgres.sh` (cron/systemd
   timer) apuntando a `DATABASE_URL` de producción — ver esa sección más
   abajo.

## Migraciones en despliegues posteriores (no el primero)

El servicio `migrate` corre en cada `docker compose up`/`up -d migrate` —
es idempotente (ver `docs/OPERACION.md` §2: las ya aplicadas se saltan).
Para un despliegue normal de una nueva versión:

```bash
cd infra/compose
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm migrate
docker compose -f docker-compose.prod.yml up -d api worker web
```

Nunca edites una migración ya aplicada (ver `docs/OPERACION.md` §2 y
`packages/db/README.md`): el runner lanza un error explícito si detecta
que el checksum de un archivo ya registrado cambió.

## Monitoreo

- `GET https://$API_DOMAIN/metrics` (Prometheus, `prom-client`) — **sin
  autenticación propia** (ver `docs/OPERACION.md` §4): en este stack no
  está expuesto públicamente por Caddy (el `Caddyfile` de este repo solo
  enruta `/` completo hacia `api:3000`, así que si expones el dominio
  completo, `/metrics` también queda accesible salvo que agregues una
  regla de bloqueo/autenticación adicional en el `Caddyfile` — hazlo antes
  de considerar el despliegue completo si `$API_DOMAIN` es público sin
  restricciones de red).
- `infra/scripts/healthcheck.sh` como probe externo periódico
  (cron/uptime-checker) además del `HEALTHCHECK` nativo de
  `apps/api/Dockerfile` (que solo reinicia el proceso local, no alerta a
  nadie).
- Logs: `docker compose -f docker-compose.prod.yml logs -f api worker web
  caddy` (stdout/stderr, formato JSON de pino en api/worker — ver
  `docs/OPERACION.md` §5). Sin backend de logs centralizado configurado en
  este repo (Loki/CloudWatch/Datadog es responsabilidad de quien
  despliegue).
- `SENTRY_DSN` (`infra/env/.env.prod.example`): reservado, NO consumido
  todavía por el código (no hay SDK de Sentry instalado en `apps/api` —
  ver esa plantilla).

## Backups / restauración

Ver `infra/scripts/backup-postgres.sh` y `restore-postgres.sh` (uso
detallado en el encabezado de cada script) y `docs/OPERACION.md` §8 para
la política completa (qué cubre un `pg_dump` de la base completa, por qué
RLS/roles deben viajar en el mismo dump, etc.). Resumen:

```bash
# Backup (agrega esto a cron, p. ej. diario a las 03:00):
DATABASE_URL=postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:5432/$POSTGRES_DB \
  BACKUP_GPG_RECIPIENT=ops@tudominio.mx \
  bash infra/scripts/backup-postgres.sh /ruta/segura/backups

# Restauración (incidente):
DATABASE_URL=postgres://... bash infra/scripts/restore-postgres.sh backups/atiende-xxx.dump.gpg
```

Con el stack en Docker Compose, `DATABASE_URL` para un backup/restore
ejecutado DESDE EL HOST (no dentro de un contenedor) necesita que el
puerto 5432 de `postgres` esté alcanzable — este compose de producción NO
lo publica al host a propósito (ver comentario en
`docker-compose.prod.yml`). Dos formas de correr un backup real:
- Ejecuta `backup-postgres.sh` DENTRO de la red de Docker (p. ej.
  `docker compose -f docker-compose.prod.yml run --rm -v
  $(pwd)/../scripts:/scripts:ro migrate bash /scripts/backup-postgres.sh`
  reutilizando la imagen `atiende/api` que ya trae `pg_dump`... **no**: la
  imagen de `apps/api` es `node:22-alpine`, sin `pg_dump` instalado —
  usa en su lugar una imagen con cliente de Postgres, p. ej.
  `docker run --rm --network atiende-licitaciones_atiende -e
  DATABASE_URL=... -v $(pwd)/backups:/backups postgres:16-alpine
  bash -c "apk add --no-cache bash gnupg >/dev/null && bash
  /scripts/backup-postgres.sh /backups"` montando también
  `infra/scripts/`.
- O publica temporalmente el puerto de `postgres` solo hacia `localhost`
  (`ports: ["127.0.0.1:5432:5432"]` en un override de compose) mientras
  corres el backup desde el host, y quítalo después.

**Nada de esto se ha probado contra un backup/restore real en este
repositorio** (ver `docs/OPERACION.md` §8 y §9) — verifícalo en staging
antes de depender de ello en un incidente real.

## Rollback

1. Vuelve a la imagen anterior (si usaste `IMAGE_TAG` con versiones, ver
   `infra/env/.env.prod.example`):
   ```bash
   cd infra/compose
   IMAGE_TAG=<tag_anterior> docker compose -f docker-compose.prod.yml up -d api worker web
   ```
2. **Las migraciones NO tienen "down"** (ver `docs/OPERACION.md` §2): un
   rollback de código a una versión anterior con una base de datos que ya
   tiene migraciones más nuevas aplicadas puede ser incompatible si esa
   versión anterior no tolera las columnas/tablas nuevas. Revisa el
   changelog de `packages/db/migrations/` entre ambas versiones antes de
   hacer rollback de código sin también restaurar un backup de datos
   anterior a esas migraciones.
3. Si el rollback es por una migración con datos corruptos/incompatibles,
   la única vía real es `restore-postgres.sh` contra un backup previo a
   esa migración (nunca editar/borrar el archivo de migración ya
   aplicado).

## Limitaciones conocidas de esta infraestructura

- **`apps/api`/`apps/worker` corren con `tsx` sobre el código fuente, no
  con `node dist/*.js`** — verificado en este entorno que
  `packages/db`/`packages/agents`/`packages/expediente`/`packages/sources`
  exportan TypeScript sin compilar (`main`/`exports` -> `./src/index.ts`)
  y que `node` plano no puede resolverlo (`ERR_MODULE_NOT_FOUND`). Ver el
  comentario extendido en `apps/api/Dockerfile` y
  `docs/logs/infra-ronda6.log`. Consecuencia: las imágenes son más grandes
  de lo idealmente posible (incluyen devDependencies y código fuente en
  vez de un `dist/` mínimo). Solucionarlo de raíz requeriría tocar
  `package.json`/`tsconfig` de `packages/*`/`apps/*` (mover `tsx` a
  `dependencies`, o adoptar un bundler real) — fuera del ámbito de esta
  ronda (solo `infra/**`, Dockerfiles y docs).
- **`STORAGE_DIR` es disco local** (volumen `api_storage`, una sola
  réplica de `api`) — escalar `api` horizontalmente exigiría moverlo a
  almacenamiento compartido (S3/objeto remoto), no implementado.
- **`/metrics` sin autenticación propia** expuesto vía `$API_DOMAIN` en la
  configuración de Caddy de este repo tal como está — restringe el acceso
  antes de un despliegue público real (ver "Monitoreo" arriba).
- **Sin rotación sin downtime de `PLATFORM_API_KEY`** (una sola clave
  activa a la vez) — ver `infra/scripts/rotate-secrets.md`.
- **`OPENAI_API_KEY` nunca ejercitada contra la API real de OpenAI** en
  este repositorio — definirla en producción es la primera vez que ese
  camino de código correría de verdad.
- **Nada de esto se validó con Docker real** (no disponible en el entorno
  donde se escribió esta ronda de infraestructura) — solo sintaxis
  (`dockerfile-utils lint`, YAML, `shellcheck`, `sh -n`) y revisión manual.
  Ver `docs/logs/infra-ronda6.log` para el detalle exacto.

## Qué requiere decisión/credenciales del usuario (bloqueos externos)

Nada de esto lo puede resolver un agente sin acceso a esas cuentas —
documentado también en `docs/AMPLIACION-2-SALIDA.md` § "Bloqueos externos
previstos":

- **Hosting**: dónde corre el host Docker (VPS, VM en una nube, servidor
  propio). No incluido/decidido en este repo.
- **Dominio**: registro y DNS de `$WEB_DOMAIN`/`$API_DOMAIN`.
- **Base de datos gestionada** (opcional, alternativa al contenedor
  `postgres` de este compose): RDS/Cloud SQL/Supabase/etc., si se prefiere
  no operar Postgres uno mismo — ver nota en
  `infra/env/.env.prod.example`.
- **Proveedor de correo transaccional** (Resend/Postmark/SMTP) + dominio
  remitente con SPF/DKIM — bloqueante para `docs/AMPLIACION-2-SALIDA.md`
  punto 2 (correos), NO bloqueante para el despliegue de infraestructura
  en sí (el código de correo todavía no existe).
- **Credenciales OAuth de Google** (consola de Google Cloud) — bloqueante
  para `docs/AMPLIACION-2-SALIDA.md` punto 1 (login con Google), NO
  bloqueante para este despliegue de infraestructura.
- **Sentry** (u otro backend de errores) — opcional, cuenta/proyecto y DSN
  del usuario si se decide integrarlo.

## Checklist de go-live

- [ ] DNS de `$WEB_DOMAIN`/`$API_DOMAIN` propagado y verificado (`dig`).
- [ ] `infra/compose/.env` completo, con secretos generados (no los
      valores de ejemplo) y **no commiteado**.
- [ ] `docker compose -f docker-compose.prod.yml build` sin errores.
- [ ] `docker compose -f docker-compose.prod.yml up -d` — los 6 servicios
      `Up`/`Exited (0)` (`migrate` debe terminar en `Exited (0)`, no
      quedarse corriendo).
- [ ] `infra/scripts/healthcheck.sh https://$API_DOMAIN` → OK.
- [ ] `curl -I https://$WEB_DOMAIN` → 200 con cabeceras de seguridad
      presentes (`content-security-policy`, `x-frame-options`, etc. — ver
      `infra/docker/nginx.web.conf`).
- [ ] Certificados TLS emitidos (candado válido en el navegador para
      ambos dominios).
- [ ] Primer superadmin creado y verificado (ver paso 7 arriba).
- [ ] `CORS_ORIGINS`/`$API_DOMAIN` verificado: login real desde
      `$WEB_DOMAIN` contra `$API_DOMAIN` funciona (sin error de CORS en la
      consola del navegador).
- [ ] Backup manual de prueba ejecutado y RESTAURADO en un entorno de
      staging (no en producción) antes de confiar en él para un
      incidente real.
- [ ] `infra/scripts/healthcheck.sh` (o un uptime-checker externo)
      programado periódicamente, con alerta real a alguien.
- [ ] `/metrics` revisado: ¿debe restringirse antes de exponer
      `$API_DOMAIN` públicamente? (ver "Monitoreo" arriba).
- [ ] Runbook de rollback (esta página, sección "Rollback") leído por
      quien va a operar el sistema, no solo escrito.
- [ ] `infra/scripts/rotate-secrets.md` leído — saber qué invalida cada
      secreto ANTES de necesitar rotarlo en un incidente.
