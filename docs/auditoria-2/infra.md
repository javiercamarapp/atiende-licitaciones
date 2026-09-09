# Auditoría adversarial — Infraestructura (ampliación 2)

Agente Sonnet auditor independiente, solo hallazgos (no corrige código).
Worktree git desechable en `HEAD` = `7f393a8` (detached, sin tocar el
árbol de trabajo real, que tenía cambios en curso de otros agentes al
momento de iniciar esta ronda). Ver `docs/logs/audit-infra.log` para los
comandos ejecutados y sus salidas literales.

**Límite del entorno**: `which docker` → *not found*. No se pudo correr
`docker build`, `docker compose config` ni `docker compose up` — coincide
con lo ya documentado en `infra/README.md`/`docs/ACEPTACION.md` (S11,
REQ-199/200 → `BLOQUEADO_EXTERNO`). Validación realizada en su lugar:
lectura estática cruzada de código real (`apps/*/src/config.ts`,
`csp.ts`) contra `infra/**`, `npx dockerfile-utils lint` (3/3 sin
hallazgos), `python3 -c "import yaml"` / `json.load` sobre los 4 YAML/JSON
del alcance (parsean sin error), `shellcheck` (0.11.0, homebrew) sobre los
5 scripts de `infra/scripts/` + `scripts/ci-local.sh` +
`scripts/check-secrets.sh` (0 hallazgos en todos), y ejecución REAL de
`scripts/check-secrets.sh` contra el árbol de trabajo (sin red, sin
Docker: no tiene esa dependencia).

## Resumen (≤10 líneas)

`docker-compose.prod.yml` omite del `environment:` de `api` TODAS las
variables de correo/OIDC nuevas — incluida `MAIL_LINK_SECRET`, que
`apps/api/src/config.ts` exige o revienta al arrancar: el compose de
producción, tal cual está, **no levanta `api`** aunque hubiera Docker
(IN-01, ALTA). `scripts/check-secrets.sh`, invocado por CI y por
`ci-local.sh`, **falla ahora mismo en HEAD** por dos falsos positivos
propios (uno de ellos en `infra/compose/docker-compose.prod.yml`) y
además no detecta tokens Resend (`re_…`) ni JWT reales (IN-02, ALTA). El
archivo `infra/env/.env.prod.example` citado como evidencia en
`docs/ACEPTACION.md` (REQ-200, "34 variables") **no existe** en el
repositorio ni en su historial (IN-03, ALTA). La CSP `connect-src 'self'`
horneada en `apps/web` es incompatible con la arquitectura de dos
dominios que el propio `infra/**` documenta y despliega (IN-10, ALTA).
Dockerfiles, backup/restore y CI por lo demás están en buen estado
(multi-stage, no-root, `HEALTHCHECK`, `shellcheck` limpio).

## 1. Dockerfiles (`apps/{api,worker,web}/Dockerfile`)

- **Multi-stage**: los tres. `api`/`worker`: `deps` (solo manifiestos +
  `npm ci`) → `runtime`. `web`: `build` (vite build) → `runtime` (nginx).
  Correcto.
- **Usuario no root**: `api`/`worker` → `USER node` (imagen base ya trae
  ese usuario). `web` → `USER nginx`, con `nginx.conf` reescrito para que
  el proceso maestro (no solo los workers) corra sin privilegios (`pid`/
  `*_temp_path` en `/tmp`, puerto 8080). Confirmado leyendo los tres
  Dockerfiles + `infra/docker/nginx.conf`.
- **`npm ci` con lockfile**: los tres copian `package.json` +
  `package-lock.json` de la raíz y de cada workspace relevante antes de
  `RUN npm ci` (sin `npm install`). Correcto.
- **Imagen base con versión fija**: `node:22-alpine` (api/worker/build de
  web), `nginx:1.27-alpine` (runtime de web). Fijas a major.minor, **no**
  a dígito SHA256 — un rebuild en fechas distintas puede traer parches de
  SO distintos bajo el mismo tag (IN-12, BAJA: mejora, no incumplimiento
  del criterio pedido, que solo exige "versión fija").
- **`HEALTHCHECK`**:
  - `apps/api/Dockerfile`: sí, `CMD node -e "fetch('.../healthz')..."`
    cada 30s, `start_period=15s`. Correcto, no toca la base de datos
    (coincide con `docs/OPERACION.md` §4).
  - `apps/web/Dockerfile`: sí, `wget` a `/index.html` en 8080.
  - `apps/worker/Dockerfile`: **NO tiene `HEALTHCHECK`** — CONFIRMADO. Es
    una decisión documentada explícitamente en el propio Dockerfile y en
    `docs/OPERACION.md` §4/§10 ("`apps/worker` no expone healthcheck HTTP
    propio"), no un descuido oculto — coincide exactamente con lo que
    señalaba el pase de trazabilidad. Severidad ajustada a MEDIA (IN-09):
    sigue siendo un hueco real de observabilidad para el orquestador (sin
    mecanismo nativo de Docker/Compose para detectar un worker colgado,
    solo logs + tabla `jobs`/`source_runs`).
- **Sin secretos en capas**: revisadas las tres — ningún `ARG`/`ENV` con
  valor de secreto embebido; `VITE_API_URL` (build-arg de `web`) es una
  URL pública, no un secreto. Correcto.
- **`.dockerignore` (raíz)**: excluye `node_modules/`, `dist/`,
  `coverage/`, `playwright-report/`, `test-results/`, `.pglite/`,
  `.data/`, `.env`/`.env.*` (con excepción de `*.env.example` — y de
  `infra/env/.env.prod.example`, que **no existe**, ver IN-03: la
  excepción es inofensiva pero apunta a un archivo fantasma), `.git/`,
  `.vscode/`, `.idea/`, `*.log`. **Sí excluye todo lo pedido** (`.env`,
  `.git`, `coverage`, `test-results`). Correcto, con la nota anterior.
- Lint estático: `npx dockerfile-utils lint` → **0 hallazgos en los
  tres** (ejecutado en este entorno, con red disponible para `npx`).

## 2. `infra/compose/docker-compose.prod.yml`

- **`depends_on` con `condition: service_healthy`**: SOLO
  `migrate → postgres` la usa. `api` depende de `migrate` con
  `condition: service_completed_successfully` (correcto para un job de
  un solo uso). Pero **`worker → api` usa `condition: service_started`**
  (no `service_healthy`) pese a que `apps/api/Dockerfile` SÍ declara
  `HEALTHCHECK`, y **`caddy → [web, api]` usa la forma corta sin
  `condition` en absoluto** (equivalente a `service_started`) pese a que
  ambas imágenes declaran `HEALTHCHECK`. CONFIRMADO tal como señalaba el
  pase de trazabilidad (`docs/ACEPTACION.md` REQ-202: "el compose no lo
  consume"). Riesgo real: Caddy puede enrutar tráfico a `api`/`web` antes
  de que respondan de verdad (IN-04, MEDIA-ALTA).
- **Redes**: una sola red bridge (`atiende`) para los 6 servicios — sin
  segmentación (p. ej. aislar `postgres` en una red sin acceso desde
  `caddy`/`web`). Funcional para un despliegue de una sola VM, pero es
  defensa en profundidad ausente (BAJA, no listada aparte).
- **Volumen de Postgres**: `pgdata` nombrado y persistente, montado en
  `/var/lib/postgresql/data`. Correcto. Sin puerto publicado al host
  (comentario explícito en el archivo). Correcto.
- **Límites de recursos**: NINGÚN servicio declara
  `deploy.resources.limits` (cpus/memory) — CONFIRMADO, ausente en los 6
  servicios (IN-06, MEDIA).
- **`restart`**: `unless-stopped` en postgres/api/worker/web/caddy;
  `restart: "no"` en `migrate` (correcto y documentado: un fallo de
  migración exige diagnóstico humano, no un bucle de reinicio). Correcto.
- **Puertos expuestos**: solo `caddy` publica `80/443/443-udp` al host.
  `postgres`, `api`, `worker`, `web` no publican nada — solo lo
  necesario. Correcto.
- **Variables obligatorias sin defaults inseguros**: `POSTGRES_USER`,
  `POSTGRES_PASSWORD`, `POSTGRES_DB`, `JWT_SECRET`, `PLATFORM_API_KEY`,
  `TOTP_ENCRYPTION_KEY`, `WEB_DOMAIN`, `API_DOMAIN`, `ACME_EMAIL` se
  interpolan como `${VAR}` simple, **sin** la sintaxis estricta
  `${VAR:?mensaje}`. Si `infra/compose/.env` omite alguna, Docker Compose
  sustituye una cadena VACÍA con solo una advertencia — no aborta el
  `up` (IN-05, MEDIA: `apps/api` sí fallaría cerrado para
  `JWT_SECRET`/`TOTP_ENCRYPTION_KEY` vía `loadConfig()`, pero
  `POSTGRES_PASSWORD=""` dependería del comportamiento por defecto de la
  imagen `postgres:16-alpine`, no verificable sin Docker).
- **Secretos por `env_file`, no inline**: CONFIRMADO que NO se usa
  `env_file:` en ningún servicio — los secretos (`POSTGRES_PASSWORD`,
  `JWT_SECRET`, `PLATFORM_API_KEY`, `TOTP_ENCRYPTION_KEY`,
  `OPENAI_API_KEY`) se declaran inline como
  `environment: NOMBRE: ${VAR}`, interpolados por Compose desde
  `infra/compose/.env` (IN-07, MEDIA). Funcionalmente el proceso ve lo
  mismo dentro del contenedor, pero `docker compose config` (cuando haya
  Docker) volcaría los valores YA RESUELTOS en texto plano a stdout —
  más fácil de filtrar por accidente que si vivieran solo en un
  `env_file` no versionado.
- **Variables NUEVAS ausentes del `environment:` de `api`** (ver rubro 3
  para el detalle completo): `MAIL_LINK_SECRET`, `PUBLIC_URL`,
  `MAIL_FROM`, `CONTACT_INBOX`, `MAIL_PROVIDER`, `RESEND_API_KEY`,
  `RESEND_EMAIL_DOMAIN`, `RESEND_WEBHOOK_SECRET`,
  `POSTMARK_SERVER_TOKEN`, `POSTMARK_FROM_ADDRESS`, `SMTP_*`,
  `MAIL_CAPTURE_FILE`, `REQUIRE_EMAIL_VERIFICATION`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `OIDC_ISSUER_URL` — cero
  ocurrencias de cada una en el archivo (`grep -c` = 0 para las 21,
  confirmado). `WORKER_DISABLED_AGENTS`/`WORKER_AGENT_BUDGET_USD_PER_ORG`
  tampoco están en el `environment:` de `worker`. Ver IN-01/IN-08.
- `docker-compose.dev.yml`: correcto para su propósito (Postgres real
  opcional en 5433, credenciales de ejemplo no secretas, documentado como
  tal); `adminer` sí usa `depends_on: condition: service_healthy` — un
  detalle irónico: el compose de DESARROLLO usa la condición correcta que
  el de PRODUCCIÓN no usa para sus servicios de aplicación.

## 3. `.env.prod.example` y variables reales

**No existe ningún archivo `.env.prod.example` en el repositorio.**
`infra/README.md`, `infra/compose/docker-compose.prod.yml` (comentario de
cabecera), `infra/docker/Caddyfile` y `infra/scripts/rotate-secrets.md`
lo citan repetidamente como `infra/env/.env.prod.example`, y
`docs/ACEPTACION.md` fila REQ-200 lo cita como evidencia concreta ("+
`infra/env/.env.prod.example` (34 variables)"). Verificado con
`find . -iname '*.env.prod*'` (vacío), `git ls-files | grep -i env.prod`
(vacío) y `git log --all --diff-filter=A -- '*.env.prod.example'`
(vacío): el archivo **nunca fue commiteado**, en ningún commit de
`main`. **IN-03 (ALTA)**: la afirmación de `docs/ACEPTACION.md` REQ-200
es no verificable / falsa tal como está redactada, y el rubro 3 de esta
auditoría (comparar variables documentadas vs. las que leen
`config.ts`/`env.ts` reales) no puede ejecutarse contra ese archivo
porque no existe — se ejecutó en su lugar contra
`apps/{api,worker,web}/.env.example` (sí existen) comparándolos con el
`environment:` real de `docker-compose.prod.yml`:

| Variable leída por el código | Declarada en `docker-compose.prod.yml` (`api`) |
|---|---|
| `PORT`, `NODE_ENV`, `SKIP_MIGRATIONS`, `DATABASE_URL`, `JWT_SECRET`, `STORAGE_DIR`, `CORS_ORIGINS`, `PLATFORM_API_KEY`, `RATE_LIMIT_PROFILE`, `TOTP_ENCRYPTION_KEY`, `STEP_UP_WINDOW_MINUTES` | Sí |
| `SENTRY_DSN` (reservada, sin SDK instalado) | Sí (con default vacío) |
| `MAIL_LINK_SECRET` — **obligatoria, `loadConfig()` revienta sin ella (`apps/api/src/config.ts:91-96`)** | **NO** |
| `PUBLIC_URL`, `MAIL_FROM`, `CONTACT_INBOX`, `REQUIRE_EMAIL_VERIFICATION` (con default en código) | **NO** |
| `MAIL_PROVIDER`, `RESEND_API_KEY`, `RESEND_EMAIL_DOMAIN`, `RESEND_WEBHOOK_SECRET`, `POSTMARK_SERVER_TOKEN`, `POSTMARK_FROM_ADDRESS`, `SMTP_HOST/PORT/SECURE/USER/PASS/FROM_ADDRESS`, `MAIL_CAPTURE_FILE` | **NO** |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `OIDC_ISSUER_URL` (opcionales, degradan a 503) | **NO** |

**IN-01 (ALTA)**: `apps/api/src/config.ts:91-96` —

```
const mailLinkSecret = env.MAIL_LINK_SECRET;
if (!mailLinkSecret || mailLinkSecret.length < 16) {
  throw new Error('MAIL_LINK_SECRET no definido o demasiado corto...');
}
```

— con el mismo criterio de "falla cerrado" que `JWT_SECRET`/
`TOTP_ENCRYPTION_KEY` (que SÍ están en el compose). El comentario de
cabecera del propio `docker-compose.prod.yml` es explícito: "docker
compose NO inyecta automáticamente todo `.env` a cada contenedor, solo
lo usa para resolver este archivo [...] cada servicio [...] declara
explícitamente qué variables recibe". Como `MAIL_LINK_SECRET` no está en
esa lista para `api`, **el contenedor `api` no arrancaría nunca**
siguiendo el compose tal cual, sin importar qué tan completo esté
`infra/compose/.env` — el valor jamás llegaría al proceso. Esto bloquea
REQ-200 ("levanta api+worker+web+postgres") por una razón propia,
independiente del bloqueo por ausencia de Docker.

**IN-08 (MEDIA)**: aun si `MAIL_LINK_SECRET` se agrega, las variables con
default en código (`PUBLIC_URL` → `https://app.atiende.mx` hardcodeado,
`MAIL_FROM`, `REQUIRE_EMAIL_VERIFICATION` → `true` por defecto) seguirían
sin declararse. Combinación real de riesgo para un primer go-live que
siga el runbook de `infra/README.md` al pie de la letra: `PUBLIC_URL` por
defecto apunta a un dominio de ejemplo (no a `$WEB_DOMAIN` real, que es
lo que exige la arquitectura de dos dominios del propio README) →
enlaces de verificación/invitación/restablecimiento rotos; `MAIL_PROVIDER`
sin definir → degrada a `CaptureProvider` (ningún correo sale de verdad);
`REQUIRE_EMAIL_VERIFICATION` por defecto activo → ninguna cuenta nueva
podría iniciar sesión hasta que alguien configure un proveedor de correo
real y declare estas variables explícitamente en el compose.

`apps/worker`: `WORKER_DISABLED_AGENTS`, `WORKER_AGENT_BUDGET_USD_PER_ORG`
(ambas con default seguro en código) tampoco están en el `environment:`
de `worker` — impacto bajo, mismo patrón que IN-08 pero sin consecuencia
de arranque.

`docs/OPERACION.md` §3 "Variables de entorno" tampoco menciona ninguna
variable de correo/OIDC nueva — el runbook operativo quedó desactualizado
en la misma ronda que introdujo `packages/mail`/OIDC.

## 4. Backup / restore

- `infra/scripts/backup-postgres.sh`: `set -euo pipefail` ✓. Idempotente
  por diseño (cada corrida genera un archivo con timestamp único, nunca
  sobreescribe). Cifrado GPG opcional y claramente avisado cuando no se
  usa ("AVISO: [...] backup SIN CIFRAR"). Retención por `find ... -mtime
  +N -delete` (acotado a `$BACKUP_DIR`, con `-maxdepth 1` y patrón de
  nombre — no hay `rm -rf` genérico). `shellcheck` → 0 hallazgos.
- `infra/scripts/restore-postgres.sh`: `set -euo pipefail` ✓. Confirmación
  interactiva explícita (`escribe RESTAURAR`) salvo `--yes`; redacta la
  contraseña del `DATABASE_URL` en el mensaje impreso; descifrado GPG a
  archivo temporal con `trap cleanup EXIT` (`rm -f` acotado a ese único
  archivo, no genérico). Advierte correctamente que `pg_restore --clean
  --if-exists` es destructivo y que un dump sin roles/RLS rompería el
  aislamiento multi-tenant en silencio. `shellcheck` → 0 hallazgos.
- **Retención/cifrado**: documentados (`BACKUP_RETENTION_DAYS=14` por
  defecto, `BACKUP_GPG_RECIPIENT` opcional) tanto en el propio script
  como en `infra/README.md` y `docs/OPERACION.md` §8.
- **Restauración probada / drill**: **NO existe ningún drill ejecutado**
  — ni siquiera contra `docker-compose.dev.yml` (que existe explícitamente
  para ensayar estos dos scripts, según su propio comentario de
  cabecera). El propio `infra/README.md` lo declara: "Nada de esto se ha
  probado contra un backup/restore real en este repositorio". Coincide
  con REQ-203 (`EN_EVIDENCIA`, no bloqueado — el criterio de aceptación
  permite "sin ejecución real"), pero sigue siendo un hueco operativo real
  antes de cualquier incidente de producción genuino.
- `infra/scripts/healthcheck.sh`: `set -uo pipefail` (sin `-e`,
  deliberado: agrega el resultado de ambos checks antes de salir).
  Usa `/tmp/healthcheck-body.$$` en vez de `mktemp` — ruta predecible en
  `/tmp` mundialmente escribible (IN-11, BAJA: superficie TOCTOU de bajo
  impacto práctico, ya que solo se lee un cuerpo HTTP no sensible; los
  demás scripts del mismo repo sí usan `mktemp`).
- `infra/scripts/rotate-secrets.md`: cubre `JWT_SECRET`,
  `PLATFORM_API_KEY`, `TOTP_ENCRYPTION_KEY`, `POSTGRES_PASSWORD` — **no
  cubre `MAIL_LINK_SECRET`** pese a que `apps/api/.env.example` advierte
  explícitamente "ROTARLA INVALIDA todos los enlaces ya enviados" (mismo
  patrón de "documentación de infra no actualizada tras la ronda de
  correo" que IN-01/IN-08).

## 5. CI (`.github/workflows/quality.yml` vs. `scripts/ci-local.sh`)

- **Equivalencia de jobs**: `ci-local.sh` reproduce
  `workspace-checks` (typecheck/lint/test.coverage/build por workspace),
  `npm-audit` (`--omit=dev --audit-level=high`) y `check-secrets`
  (idéntico comando). NO reproduce `db-postgres` (requiere Postgres real
  — documentado y correcto, ese job solo corre en CI) ni `e2e-web` por
  defecto (opcional vía `--e2e`, documentado). Equivalencia correcta y
  honesta en sus límites.
- **Node**: `NODE_VERSION: "22"` en CI, coincide con `node:22-alpine` en
  los tres Dockerfiles. Consistente.
- **Postgres real**: el job `db-postgres` sí usa un servicio Postgres
  real (`postgres:16`, no PGlite) para migraciones + ataques RLS
  dinámicos — nota menor: la imagen de CI es `postgres:16` (Debian) y la
  de producción es `postgres:16-alpine` — mismo major, base de SO
  distinta (BAJA, no crítico para SQL puro).
- **`permissions` mínimos**: `permissions: contents: read` a nivel de
  workflow, sin overrides por job que amplíen — correcto y mínimo.
- **Acciones pineadas**: `actions/checkout@v4`, `actions/setup-node@v4`,
  `actions/upload-artifact@v4` — pineadas por versión mayor (no por SHA),
  que es una de las dos opciones que pide el encargo. Cumple.
- **Sin secretos en logs**: no hay bloque `secrets:` en ningún job del
  workflow ni credenciales de terceros usadas (Postgres del servicio usa
  credenciales de ejemplo `postgres/postgres`, solo válidas dentro del
  runner efímero). Coincide con el comentario de cabecera del propio
  archivo. El bloqueo B-06 (facturación) es externo y no aplica a este
  workflow.
- **`check-secrets` — IN-02 (ALTA), reproducido en vivo en este entorno**:

  ```
  $ bash scripts/check-secrets.sh; echo "EXIT:$?"
  [check-secrets] posible secreto — patrón: sk-[A-Za-z0-9_-]{16,}
  ./docs/auditoria-2/worker-agentes.md:476:  `Authorization: Bearer sk-ejemplo_super-secreta` (cadena de ejemplo) para confirmar que la
  [check-secrets] posible secreto — cadena de conexión Postgres con credenciales embebidas (host distinto de localhost):
  ./infra/compose/docker-compose.prod.yml:84: DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}
  ./infra/compose/docker-compose.prod.yml:101: (misma línea, servicio api)
  ./infra/compose/docker-compose.prod.yml:126: (misma línea, servicio worker)
  [check-secrets] FALLÓ: se encontraron patrones de secretos.
  EXIT:1
  ```

  Dos falsos positivos reales, sin ningún secreto real presente:
  1. `docs/auditoria-2/worker-agentes.md:476` — cadena documental de
     ejemplo con prefijo `sk-` (fixture de una prueba unitaria, nunca una
     clave real; reescrita en la ronda de corrección de CI para incluir
     la palabra "ejemplo" y así calzar con `PLACEHOLDER_FILTER`, ver nota
     más abajo); el filtro de placeholders (`PLACEHOLDER_FILTER`) incluye
     `ejemplo|example|placeholder` pero **no** `test`, así que la cadena
     original (prefijo `sk-` + el texto `test-super-secreta-...` pegado
     sin espacio) no se excluía.
  2. Las 3 líneas `DATABASE_URL: postgres://${POSTGRES_USER}:...@postgres:5432/...`
     de `infra/compose/docker-compose.prod.yml` — el patrón de "cadena
     Postgres con credenciales embebidas" excluye hosts
     `localhost|127.0.0.1|db`, pero el nombre real del servicio Compose es
     `postgres` (no está en la lista), y la plantilla `${POSTGRES_USER}:
     ${POSTGRES_PASSWORD}` (nombres de variable sin resolver, no
     credenciales reales) igual cumple el patrón `[^@[:space:]]{4,}`.
     **Esto significa que `check-secrets.sh` falla siempre que exista
     este archivo, sin relación con ningún secreto real** — rompe tanto
     el job `check-secrets` de CI como el resumen de `ci-local.sh` en
     cada corrida desde que se introdujo `infra/compose/docker-compose.prod.yml`
     (commit `beddc41`).
  - Corroboración de que es una regresión no detectada: `git log --oneline
    -- docs/logs/ci-local.log` muestra que el contenido commiteado de ese
    log (que sí reporta `check-secrets: OK`) es del commit `d1239a3`,
    **anterior** a `beddc41` (el commit que introdujo el compose de
    producción) — el log guardado en el repo está desactualizado y da una
    falsa sensación de que `check-secrets` pasa.
  - **Prueba positiva de detección** (inyecté un archivo temporal fuera
    del árbol versionado, luego lo borré): una clave AWS de ejemplo
    (`AKIA<EJEMPLO-16-CHARS>`) y un bloque de ejemplo
    `-----BEGIN PRIVATE (ejemplo) KEY-----`
    **sí fueron detectados** correctamente.
  - **Prueba negativa de detección** (mismo archivo temporal): un token
    Resend sintético (`re_c3Ntg8fh_HdaK9vXqR2pL7mNfG4tYzWq`) y un JWT de
    tres segmentos con forma válida (`eyJhbGci....eyJzdWI....SflKx...`)
    **NO fueron detectados por ningún patrón** — el array `PATTERNS` no
    tiene ninguna entrada para tokens `re_...` de Resend (a pesar de que
    esta ronda introdujo justamente `RESEND_API_KEY`/
    `RESEND_WEBHOOK_SECRET`), y el comentario del script que describe
    lógica de detección de JWT ("se reporta aparte [...] salvo que
    aparezca junto a 'secret'/'password'") **nunca se implementó**: no
    hay ningún patrón de JWT en `PATTERNS`.
  - Marcador `check-secrets:allow-fixture`: revisado el código
    (`is_test_fixture_path`/`filter_fixture_marker_exemptions`) — solo
    exime una línea marcada explícitamente Y ubicada en
    `*.test.ts`/`*.spec.ts`/`*/test/*`/`*/e2e/*`; una coincidencia con el
    marcador fuera de esos paths sigue fallando. Lógica correcta,
    verificada por lectura (no se ejercitó con un caso real en esta
    ronda, pero el código es directo y sin ramas ocultas).

## 6. Vercel (`vercel.json`)

- `outputDirectory: apps/web/dist`, `installCommand: npm ci`,
  `buildCommand: npm run build --workspace apps/web` — correctos, coherentes
  con el monorepo de workspaces.
- `rewrites: [{ source: "/(.*)", destination: "/index.html" }]` — SPA
  fallback correcto para `react-router-dom`.
- Headers de seguridad: `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options: DENY`, `Permissions-Policy`. **No incluye
  `Content-Security-Policy` como cabecera HTTP** ni `Strict-Transport-Security`
  — la CSP real llega solo vía el `<meta http-equiv>` que inyecta el
  plugin de `vite.config.ts` en tiempo de build (cubre `script-src`/
  `connect-src`/etc., pero el propio estándar CSP ignora `frame-ancestors`
  dentro de un `<meta>` — mitigado aquí por `X-Frame-Options: DENY`, que sí
  está). Ausencia de HSTS explícito: impacto bajo porque Vercel sirve
  HTTPS por defecto, pero no está garantizado como cabecera propia del
  proyecto (BAJA).
- **CSP `connect-src` y host de API — IN-10 (ALTA), no es solo "pendiente"**:
  `apps/web/src/lib/security/csp.ts` fija `connect-src: ["'self'"]` de
  forma estática (mismo archivo usado para el `<meta>` de Vercel Y
  replicado literalmente en `infra/docker/nginx.web.conf` para el
  despliegue Docker). `apps/web/README.md:848-854` ya advierte:
  "`connect-src 'self'` asume que producción sirve `apps/web` y `apps/api`
  en el mismo origen [...] si la API vive en un dominio/subdominio
  distinto, `connect-src` debe ampliarse [...] de lo contrario el propio
  navegador bloqueará las peticiones a la API". Pero `infra/README.md`,
  `infra/docker/Caddyfile` y `infra/compose/docker-compose.prod.yml`
  documentan y despliegan **exactamente ese caso**: dos dominios
  distintos, `$WEB_DOMAIN`/`$API_DOMAIN`, a propósito (justificación
  extensa en el propio `infra/README.md`). Ningún archivo de `infra/**`
  (`nginx.web.conf`, `Caddyfile`, `apps/web/Dockerfile`) amplía
  `connect-src` para incluir `$API_DOMAIN`. Confirmado por lectura
  cruzada y estática de los tres archivos — no es una ambigüedad ni una
  decisión pendiente, es una contradicción reproducible: tal como está
  escrito, ni el despliegue Docker documentado en `infra/README.md` NI un
  despliegue en Vercel con backend en otro dominio funcionarían en el
  navegador para ninguna llamada `fetch`/XHR de `apps/web` hacia la API.

## 7. `scripts/check-secrets.sh`

Ver rubro 5 (IN-02) para el detalle completo, incluidas las pruebas
positivas (AWS, PEM) y negativas (Resend, JWT) realizadas en este entorno
y los dos falsos positivos reproducidos en HEAD.

## 8. Trazabilidad — qué puede marcarse y con qué evidencia

| Fila | Estado recomendado | Motivo |
|---|---|---|
| REQ-199 | `BLOQUEADO_EXTERNO` (sin cambio) | Confirmado sin Docker; `dockerfile-utils lint` limpio verificado de forma independiente en esta ronda (3/3, 0 hallazgos) — corrobora, no cambia el estado. |
| REQ-200 | `BLOQUEADO_EXTERNO`, **pero con la evidencia corregida** | La cita "`infra/env/.env.prod.example` (34 variables)" es falsa/no verificable (IN-03: el archivo no existe). Además, **incluso con Docker disponible, `api` no arrancaría** por IN-01 (`MAIL_LINK_SECRET` ausente del compose) — el bloqueo real hoy no es solo la falta de Docker. |
| REQ-201 | `EN_EVIDENCIA` (sin cambio) | Idempotencia probada contra PGlite (`packages/db/test/migrate.test.ts`), no contra un contenedor real — límite ya declarado honestamente en la fila existente. |
| REQ-202 | `EN_EVIDENCIA (parcial)` (sin cambio, reconfirmado) | `apps/worker` sin healthcheck HTTP (documentado, IN-09) + compose sin `condition: service_healthy` para `worker`/`caddy` (IN-04) — ambos hechos confirmados de forma independiente en esta ronda. |
| REQ-203 | `EN_EVIDENCIA` (sin cambio) | Scripts de buena calidad (`shellcheck` limpio, `set -euo pipefail`, sin `rm -rf` peligroso, cifrado/retención documentados) pero sin drill de restauración real ejecutado — confirmado, coincide con la fila existente. |
| REQ-204 | `EN_EVIDENCIA` (sin cambio) | Runbook cubre las 4 secciones exigidas; no se detectaron omisiones nuevas en esta ronda. |
| REQ-205 | Fuera de alcance técnico de esta auditoría (proceso/gobierno) | No verificable por lectura de código; sin cambios de mi parte. |
| REQ-206/207 | Fuera de alcance de `infra/**` | Pertenecen a `apps/api`/`packages/mail` (auth Google / correo), no a esta auditoría de infraestructura. |
| S11 | `BLOQUEADO_EXTERNO` (sin cambio, pero agravado) | Confirmado sin Docker. Nota adicional: aunque se resolviera el bloqueo de Docker hoy mismo, S11 seguiría sin poder pasar por IN-01 (arranque de `api`) — el bloqueo por Docker ya no es la única causa. |

## Hallazgos numerados (resumen de severidad)

- **IN-01 (ALTA)** — `docker-compose.prod.yml` omite `MAIL_LINK_SECRET`
  (obligatoria) del `environment:` de `api`; el contenedor no arrancaría.
- **IN-02 (ALTA)** — `scripts/check-secrets.sh` falla hoy en HEAD por dos
  falsos positivos propios (uno en `infra/compose/docker-compose.prod.yml`)
  y no detecta tokens Resend ni JWT reales.
- **IN-03 (ALTA)** — `infra/env/.env.prod.example` no existe; la evidencia
  de REQ-200 que lo cita es falsa/no verificable.
- **IN-10 (ALTA)** — CSP `connect-src 'self'` incompatible con la
  arquitectura de dos dominios que `infra/**` documenta y despliega.
- **IN-04 (MEDIA-ALTA)** — `worker`/`caddy` no usan
  `condition: service_healthy` pese a que las imágenes declaran
  `HEALTHCHECK`.
- **IN-08 (MEDIA)** — Variables de correo con default en código
  (`PUBLIC_URL`, etc.) ausentes del compose: trampa operativa en el
  primer go-live si se sigue el runbook al pie de la letra.
- **IN-05 (MEDIA)** — Secretos obligatorios sin `${VAR:?...}` estricto en
  el compose.
- **IN-06 (MEDIA)** — Sin límites de recursos (`deploy.resources.limits`)
  en ningún servicio.
- **IN-07 (MEDIA)** — Secretos inline (`environment:`) en vez de
  `env_file:`.
- **IN-09 (MEDIA)** — `apps/worker` sin `HEALTHCHECK` (confirmado,
  documentado, no oculto).
- **IN-11 (BAJA)** — `healthcheck.sh` usa `/tmp/...$$` en vez de `mktemp`.
- **IN-12 (BAJA)** — Imágenes base fijas por tag, no por dígito SHA256.
- **IN-13 (BAJA)** — Sin drill de restauración real (ya declarado
  honestamente, confirmado por esta ronda).
