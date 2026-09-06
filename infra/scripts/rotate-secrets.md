# Rotación de secretos en producción (docker-compose)

Procedimiento operativo para el despliegue basado en
`infra/compose/docker-compose.prod.yml`. La política de CADA secreto (qué
invalida, con qué frecuencia, riesgos) ya está documentada en
`docs/OPERACION.md` §7 "Rotación de secretos" — este archivo es el
complemento mecánico específico de Docker Compose (cómo aplicarlo sin
downtime evitable), no una política nueva. No hay automatización de
rotación en este repo (ni Vault, ni un cron de rotación): es manual, como
en `docs/OPERACION.md`.

## Procedimiento general (aplica a cualquier variable de `infra/env/.env.prod.example`)

1. Genera el nuevo valor (`openssl rand -base64 48` para secretos
   simétricos).
2. Edita `infra/compose/.env` (el real, nunca el `.env.prod.example`) con
   el nuevo valor.
3. Recrea SOLO los servicios que consumen esa variable (evita reiniciar
   todo el stack sin necesidad):
   ```bash
   cd infra/compose
   docker compose -f docker-compose.prod.yml up -d --no-deps <servicio1> <servicio2>
   ```
4. Verifica con `infra/scripts/healthcheck.sh https://api.tudominio.mx`
   que `apps/api` volvió a responder antes de dar la rotación por
   terminada.

## `JWT_SECRET`

Invalida TODOS los access/refresh tokens vigentes de inmediato (HS256 sin
lista de revocación, ver `apps/api/README.md` § Pendiente). No hay forma
de rotarlo sin que todas las sesiones activas se cierren.

```bash
cd infra/compose
# 1. Anuncia la ventana de mantenimiento (todos los usuarios re-inician sesión).
# 2. Edita JWT_SECRET en .env con el valor nuevo.
docker compose -f docker-compose.prod.yml up -d --no-deps api
```

Solo `api` lo consume (`apps/worker` no firma/verifica JWT) — no hace
falta recrear `worker`/`web`.

## `PLATFORM_API_KEY`

Compartida entre `apps/api` y `apps/worker` (cabecera `X-Platform-Api-Key`
en `POST /internal/tenders/ingest`). **Sin mecanismo de dos claves válidas
a la vez** (ver `docs/OPERACION.md` §7 y §9: límite conocido) — rotarla
implica una ventana corta donde la ingesta de convocatorias falla con
401/403 si un proceso ya tiene la clave nueva y el otro todavía no.

```bash
cd infra/compose
# Edita PLATFORM_API_KEY en .env con el valor nuevo (MISMO valor para
# ambos servicios -- ya es la misma variable de entorno compose).
docker compose -f docker-compose.prod.yml up -d --no-deps api worker
```

Recreando ambos en el mismo comando se minimiza la ventana de
desincronización (Compose los recrea en paralelo), pero no la elimina del
todo — es una limitación real del diseño actual de esta clave, no de este
procedimiento.

## `TOTP_ENCRYPTION_KEY` (documentada también como `2FA_ENCRYPTION_KEY`)

Rotarla invalida el descifrado de los secretos TOTP YA enrolados
(quedarían ilegibles con la clave nueva) — no hay una migración de
re-cifrado en este repo. Rotar esta clave, en la práctica, obliga a que
TODOS los usuarios re-enrolen su 2FA. Solo hazlo si sospechas que la clave
actual se filtró; si no, prefiere no rotarla nunca.

```bash
cd infra/compose
# Edita TOTP_ENCRYPTION_KEY en .env.
docker compose -f docker-compose.prod.yml up -d --no-deps api
# Comunica a los usuarios que deben re-enrolar 2FA (GET /auth/2fa/status
# seguirá devolviendo enrolled:true con datos ya ilegibles -- documentar
# como incidente conocido si esto se ejecuta contra datos reales).
```

## Credenciales de `DATABASE_URL` (`POSTGRES_PASSWORD`)

1. Rota la contraseña en el motor de Postgres primero (dentro del propio
   contenedor `postgres`, o en el proveedor gestionado si se reemplazó el
   contenedor por uno externo — ver nota en
   `infra/env/.env.prod.example`):
   ```bash
   docker compose -f docker-compose.prod.yml exec postgres \
     psql -U "$POSTGRES_USER" -c "ALTER USER $POSTGRES_USER WITH PASSWORD 'NUEVA_PASSWORD';"
   ```
2. Edita `POSTGRES_PASSWORD` en `infra/compose/.env` con el mismo valor.
3. Recrea `api`, `worker` (y `migrate` no hace falta, ya terminó — solo se
   usa en el próximo despliegue):
   ```bash
   docker compose -f docker-compose.prod.yml up -d --no-deps api worker
   ```

Ventana real: entre el paso 1 y el paso 3, `api`/`worker` siguen usando la
contraseña vieja en sus conexiones activas del pool — Postgres no cierra
conexiones existentes al cambiar la contraseña, así que el impacto real es
menor al que parece (las conexiones vivas siguen sirviendo; solo las
NUEVAS conexiones del pool fallarían hasta el paso 3). Aun así, ejecuta
los tres pasos en la misma ventana de mantenimiento.

## `OPENAI_API_KEY`

Rota en el proveedor (OpenAI) y actualiza aquí; sin ella, `apps/worker`
sigue funcionando con `FakeProvider` (fail-safe, no fail-open — ver
`docs/OPERACION.md` §7).

```bash
cd infra/compose
docker compose -f docker-compose.prod.yml up -d --no-deps worker
```

## Certificados TLS (Caddy)

No es un "secreto" que se rote manualmente: Caddy renueva los certificados
Let's Encrypt/ZeroSSL solo, antes de su expiración, mientras el volumen
`caddy_data` (donde guarda las claves de cuenta ACME y los certificados)
persista entre despliegues. Si necesitas forzar una reemisión (p. ej. tras
sospechar que la clave privada del certificado se filtró):

```bash
cd infra/compose
docker compose -f docker-compose.prod.yml down caddy
docker volume rm atiende-licitaciones_caddy_data
docker compose -f docker-compose.prod.yml up -d caddy
```

Esto borra el estado ACME completo de Caddy (fuerza una emisión nueva
desde cero) — usarlo solo si es necesario, Let's Encrypt tiene límites de
tasa de emisión por dominio.
