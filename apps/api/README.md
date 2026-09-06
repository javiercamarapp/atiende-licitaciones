# @atiende/api

API HTTP de Atiende Licitaciones. Fastify + TypeScript + Zod
(`fastify-type-provider-zod`) + `@fastify/swagger` (OpenAPI en
`/docs/json`, requiere sesión) + `@fastify/helmet` + `@fastify/cors` +
`prom-client` (`/metrics`) + logs `pino` con `request_id` +
`@fastify/rate-limit`. Persistencia vía `@atiende/db` (PGlite en desarrollo
y tests, Postgres real vía `pg` en producción — ver `packages/db/README.md`),
motor de relevancia de `@atiende/sources` (`MatchingEngine`) y motor del
expediente de participación de `@atiende/expediente` (matriz de
requisitos, propuesta técnica/económica, checklist de integridad, flujo de
aprobación, paquete final — ver sección "expediente" más abajo).

## Arranque

```bash
cp apps/api/.env.example apps/api/.env   # ajusta JWT_SECRET al menos
npm install
npm run -w apps/api dev                  # tsx watch, PGlite en memoria por defecto
```

```bash
npm run -w apps/api typecheck
npm run -w apps/api lint
npm run -w apps/api test                 # integración con fastify.inject + PGlite
```

## Variables de entorno (ver `.env.example`)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `JWT_SECRET` | Sí | Secreto HS256 para firmar/verificar JWT (mín. 16 caracteres). |
| `PORT` | No (3000) | Puerto HTTP. |
| `DATABASE_URL` | No (PGlite en memoria) | `pglite://memory`, `pglite:///ruta` o `postgres://...` (ver `packages/db`). |
| `NODE_ENV` | No (development) | En `production`, los 500 no filtran mensaje/stack interno. |
| `SKIP_MIGRATIONS` | No (false) | Si es `true`, la API no aplica migraciones al arrancar (útil si se aplican en un paso de despliegue separado). |
| `STORAGE_DIR` | No (`.data/storage`) | Directorio local para archivos subidos (documentos de empresa). Disco local con hash sha256, **nunca S3/objeto remoto** en esta ronda. |
| `CORS_ORIGINS` | No (vacío) | Orígenes permitidos para CORS, separados por coma. Vacío = ningún origen cross-site permitido (falla cerrado). |
| `PLATFORM_API_KEY` | No (sin valor = ingesta interna deshabilitada) | Clave de plataforma para `X-Platform-Api-Key` en `POST /internal/tenders/ingest` (autentica a apps/worker, no a un tenant). |
| `RATE_LIMIT_PROFILE` | No (`default`) | `default` (100-300 req/min según ruta) salvo que sea EXACTAMENTE `e2e` (nunca por `NODE_ENV`) — ver "Límites de tasa" más abajo. |
| `TOTP_ENCRYPTION_KEY` | Sí | Clave para cifrar en reposo (AES-256-GCM) el secreto TOTP de cada usuario (REQ-044/064, mín. 16 caracteres). **Limitación documentada**: en producción real debería salir de un KMS, no de una variable de entorno plana. |
| `STEP_UP_WINDOW_MINUTES` | No (5) | Minutos de vigencia de una sesión de verificación en dos pasos (`step_up_sessions`) tras validar el TOTP, antes de exigir verificar de nuevo para aprobar una tarifa/expediente. |

## Cómo se conecta a un Postgres real en producción

Define `DATABASE_URL=postgres://usuario:password@host:5432/basededatos`. El
arranque (`src/index.ts` → `buildApp`) llama a `createDbClientFromEnv` (usa
`pg`) y, si `SKIP_MIGRATIONS` no es `true`, aplica las migraciones de
`packages/db` automáticamente (idempotente). El usuario de esa cadena de
conexión debe poder hacer DDL (ver `packages/db/README.md`); **el runtime de
cada request usa `SET LOCAL ROLE app_role`** internamente, nunca ese usuario
con privilegios de migración, para que RLS aísle de verdad. La única
excepción deliberada es `POST /internal/tenders/ingest` (ver más abajo).

## Módulos y rutas

Todas las rutas (salvo `/healthz`, `/readyz`, `/auth/register`,
`/auth/login`, `/auth/refresh`, `/auth/logout` e `/internal/tenders/ingest`)
requieren `Authorization: Bearer <access token>`. Las que operan sobre una
organización además requieren `X-Org-Id: <uuid>` (validado contra la
membresía real, nunca solo el header).

Dos encabezados adicionales, transversales a toda la API:
- `X-Correlation-Id` (REQ-171): id de correlación de negocio, opcional --
  si se manda un UUID válido se HEREDA (permite a un cliente/orquestador
  correlacionar varias requests de un mismo flujo: convocatoria -> matriz
  -> propuesta -> paquete -> archivo); si no, se genera uno nuevo. Siempre
  se refleja en la respuesta (`X-Correlation-Id`) y se propaga a
  `audit_log`/`jobs`/`proposals`/`package_manifests` (ver `GET
  /audit-log?correlationId=`).
- `X-Step-Up` (REQ-044/064): exigido por `POST .../rates/:id/approve`,
  `POST .../approval/approve`, `POST /agents/tool-calls/:id/approve|deny`
  (R5-11, `purpose: 'tool_call.approval'`) y `POST /admin/tool-calls/:id/
  approve|deny` (R5-11, `purpose: 'admin.action'`, ver detalle en `admin`
  abajo) -- debe ser un `stepUpToken` vigente, NO CONSUMIDO (R5-09: de un
  solo uso) y atado a esta MISMA organización/acción, emitido por `POST
  /auth/2fa/step-up` (o por `POST /auth/2fa/verify-enrollment`, ver módulo
  `2fa` abajo). Sin 2FA enrolado, o sin el encabezado, o con un token
  vencido/ajeno/ya usado/atado a otra organización o acción, la API
  responde 403 con una instrucción explícita.

### health
- `GET /healthz` — liveness, no toca DB.
- `GET /readyz` — verifica DB con `select 1`, 503 si falla.
- `GET /metrics` — métricas Prometheus (`prom-client`), **sin ningún dato de
  tenant** (solo método/ruta/status code).

### legal (ronda 5 — REQ-119/REQ-131)
- `GET /legal/privacy-notice` — **pública** (sin `Authorization`): aviso de
  privacidad versionado, servido desde
  `apps/api/docs/legal/privacy-notice.md` (Markdown con "front matter":
  `version`, `publishedAt`, `responsible`, `supervisoryAuthority`,
  `applicableLaw`, `sourceDocument`). Marcado explícitamente
  `status: "borrador_pendiente_validacion_juridica"` -- el contenido cita
  `docs/legal/verificacion-legal.md` (LFPDPPP nueva DOF 20-mar-2025;
  responsable = Atiende Licitaciones; autoridad supervisora = Secretaría
  Anticorrupción y Buen Gobierno, sucesora del INAI extinto) pero NINGÚN
  abogado mexicano lo ha validado todavía.

### auth
- `POST /auth/register` — responde 201 genérico incluso si el email ya
  existe (anti-enumeración, ver Decisiones de diseño).
- `POST /auth/login` (rate limit 5/min).
- `POST /auth/refresh` — rotación real: revoca el refresh token usado al
  emitir uno nuevo; reusar un token ya rotado responde 401.
- `POST /auth/logout` — revoca el refresh token dado (idempotente).

### 2fa (REQ-044/064 — step-up con TOTP)
Endpoints de USUARIO (no de organización): el enrolamiento es de la
cuenta, válido para cualquier organización de la que sea miembro.
- `GET /auth/2fa/status` — `{enrolled, enrolledAt}`.
- `POST /auth/2fa/enroll` — genera un secreto TOTP (`otplib`, cifrado en
  reposo con AES-256-GCM, ver `lib/step-up.ts`) + 10 códigos de respaldo de
  un solo uso (`XXXX-XXXX`, hasheados con SHA-256). El secreto en claro y
  los códigos de respaldo se devuelven **una única vez**, en esta
  respuesta. 409 si ya hay un enrolamiento verificado (desenrolar está
  fuera de alcance de esta ronda).
- `POST /auth/2fa/verify-enrollment` — body `{code, purpose}` + encabezado
  `X-Org-Id` (ambos OBLIGATORIOS, ver "step-up atado a org/acción" abajo):
  confirma el enrolamiento (`verified_at`) y devuelve de una vez un
  `stepUpToken` vigente (confirmar el enrolamiento ya prueba posesión del
  TOTP), atado a esa organización/acción.
- `POST /auth/2fa/step-up` — body `{code, purpose}` (TOTP de 6 dígitos, o
  un código de respaldo `XXXX-XXXX`) + encabezado `X-Org-Id` (ambos
  OBLIGATORIOS): emite un `stepUpToken` (id de una fila de
  `step_up_sessions`, vigente `STEP_UP_WINDOW_MINUTES`, de UN SOLO USO), a
  usar como `X-Step-Up` en una aprobación económica sensible. Replay
  rechazado: un código de un "time step" TOTP igual o anterior al último
  aceptado para ese usuario se rechaza siempre, aunque siga siendo válido
  dentro de su ventana de tolerancia; un código de respaldo ya usado
  también se rechaza. 400 explícito si falta `X-Org-Id` o `purpose`, o si
  `purpose` no es uno de los valores del enum cerrado (validado DESPUÉS de
  confirmar que el código en sí es válido -- un intento con código
  incorrecto nunca revela nada sobre org/purpose).

**Anti-fuerza-bruta (ronda 5, R5-02/R5-03)**: `enroll`/`verify-enrollment`/
`step-up` aplican un límite de tasa por IP de **5 intentos / 5 minutos**
(tier `twoFactor`, `lib/rate-limit-settings.ts`) — a diferencia de
`global`/`auth`/`sensitiveAction`, este tier es un **mínimo garantizado**:
`RATE_LIMIT_PROFILE=e2e` nunca lo relaja. Además, un contador de fallos
**por usuario** persiste en `twofa_lockouts` (migración 0058) con bloqueo
**progresivo** (5, 10, 20, 40... minutos, tope 24h) — independiente de que
el atacante rote de IP; el bloqueo activo responde `429` con `Retry-After`.
Cada rechazo (código inválido, replay, backup code inválido/usado, cuenta
bloqueada) queda en `audit_log` (`twofa.verification_failed`/
`twofa.step_up_denied`), igual que `auth.login_failed` (API-13) — **R5-10**
(ronda 5, reverificación): el `after` de ese evento incluye además
`ip`/`userAgent` del cliente (misma paridad exacta con `auth.login_failed`,
que ya los incluía).

**step-up atado a org/acción, obligatorio y de un solo uso (ronda 5,
R5-05→R5-09)**: R5-05 hizo `X-Org-Id`/`purpose` OPCIONALES al pedir un
step-up — pero la reverificación adversarial de ronda 5 confirmó que
ningún cliente real (`apps/web`) los declaraba nunca, así que toda sesión
quedaba "genérica" (servía para aprobar cualquier tarifa/expediente de
cualquier organización del usuario, dentro de la ventana de vigencia) y el
alcance nunca se aplicaba en la práctica. **R5-09** los hace OBLIGATORIOS:
`POST /auth/2fa/step-up` y `POST /auth/2fa/verify-enrollment` responden
400 si falta `X-Org-Id` o `purpose`, o si `purpose` no es uno de los
valores del enum cerrado (`company.rate_approval`, `expediente.approval`,
`tool_call.approval`, `admin.action` — ver `lib/step-up.ts#STEP_UP_PURPOSES`,
reforzado además con un CHECK a nivel de esquema, migración 0063).
`requireStepUp` exige que la acción que consuma el `stepUpToken` declare
el MISMO org/purpose exacto (403, "OTRA organización"/"OTRA acción") y
además CONSUME la sesión atómicamente la primera vez que autoriza una
acción (columna `consumed_at`, migración 0062): un `stepUpToken` reutilizado
responde 403 ("un solo uso"), aunque siga vigente y el org/purpose
coincidan. La migración 0062 también invalidó (borró) cualquier sesión
"genérica" preexistente y volvió `org_id`/`purpose` NOT NULL.
`POST /company/rates/:id/approve` y `POST .../approval/approve` declaran
sus propios `purpose` internos (`company.rate_approval`/
`expediente.approval`) al llamar a `requireStepUp`.

**R5-11 (docs/auditoria-2/api-r5-09-10-reverificacion.md, BAJA-MEDIA,
cerrado)**: `tool_call.approval`/`admin.action` estaban reservados en el
enum desde R5-09 pero ningún endpoint real los exigía todavía -- aprobar
o denegar una `tool_call` pendiente de un agente (puede autorizar
gasto/envío/uso de API en nombre de la organización, y en el caso de
superadmin es además cross-org) no pedía ninguna verificación en dos
pasos. Fijado: `POST /agents/tool-calls/:id/approve|deny` (org-scoped,
`owner`/`admin`) ahora llama `requireStepUp` con `purpose:
'tool_call.approval'` y el `orgId` ya validado por `app.requireOrg`, igual
que `company`/`expediente`. `POST /admin/tool-calls/:id/approve|deny`
(superadmin, cross-org) llama `requireStepUp` con `purpose: 'admin.action'`
-- como esta ruta nunca lleva `X-Org-Id` (la organización afectada se
resuelve de la propia fila de `tool_calls`), el `orgId` para el
emparejamiento se obtiene de un SELECT previo sobre esa misma fila: el
superadmin debe pedir su `stepUpToken` atado a la organización DUEÑA de la
`tool_call` concreta que va a resolver (una sesión no sirve para
aprobar/denegar una `tool_call` de otra organización). Un superadmin sin
2FA enrolado recibe el mismo 403 con instrucción que cualquier otro
consumidor de `requireStepUp`. Si la `tool_call` no existe, se responde
404 sin exigir step-up (nada que autorizar todavía).

### organizations
- `POST /organizations`, `GET /organizations`.
- `POST /organizations/invitations` (owner/admin) — el token en claro se
  devuelve **una única vez** en la respuesta (nunca se persiste ni se
  puede recuperar después).
- `POST /organizations/invitations/accept` — cualquier usuario autenticado
  cuyo email coincida con la invitación.
- `PATCH /organizations/memberships/:userId` (owner/admin) — cambiar rol;
  **solo un owner puede conceder el rol `owner`**; protegido contra dejar
  la organización sin ningún owner activo.
- `DELETE /organizations/memberships/:userId` (owner/admin) — misma
  protección del último owner.
- `GET /organizations/:orgId/memberships` (ronda 4) — lista los miembros de
  la organización con su rol real (email/nombre vía `app.org_members`,
  SECURITY DEFINER, `packages/db/migrations/0052`); visible para **member+**
  (cualquier rol activo, incluido `viewer`), paginado por cursor. El
  `:orgId` de la ruta se valida contra `X-Org-Id` (fuente real de la
  organización activa) — nunca se confía en el parámetro de la URL por sí
  solo.

### audit-log (ronda 4 — trazabilidad)
- `GET /audit-log` — bitácora de auditoría (append-only, hash encadenado,
  ver `packages/db/README.md`) de la organización activa (`X-Org-Id`).
  Restringido a `reviewer`/`admin`/`owner` (más estricto que la RLS real de
  `audit_log`, que permite a cualquier rol de la organización). Filtros
  `entity`/`actorId`/`createdFrom`/`createdTo`, paginado por cursor
  (orden descendente, lo más reciente primero); nunca devuelve eventos de
  otra organización, con o sin filtros.
- `GET /admin/audit-log` (superadmin, ver sección "admin" abajo) — misma
  bitácora, sin restricción de organización (todas a la vez), con filtro
  opcional `orgId`.

### me
- `GET /me`.

### company (E2 — perfil de empresa)
Roles: `viewer` solo lee; `writer`/`analyst`/`reviewer` escriben
capabilities/experience/products-services/locations; `owner`/`admin`
escriben profile/registrations/documents/signatories/restrictions (más
sensibles) y aprueban tarifas.

- `GET/PUT /company/profile`, `GET /company/profile/provenance`.
- `GET/POST/PATCH/DELETE /company/capabilities`.
- `GET/POST/PATCH/DELETE /company/experience` (`verifiable` derivado de
  `evidenceRef`, REQ-143).
- `GET/POST/PATCH/DELETE /company/products-services`.
- `GET/POST/PATCH/DELETE /company/locations`.
- `GET/POST/PATCH/DELETE /company/registrations` (owner/admin).
- `GET/POST/DELETE /company/documents` (owner/admin) — `contentBase64` en
  el body, se guarda en `STORAGE_DIR/<orgId>/<sha256>.bin`; `status`
  (`valid`/`expiring_soon`/`expired`/`pending_verification`) se recalcula
  en cada lectura contra la fecha actual, nunca se confía en un valor
  guardado.
- `GET/POST/PATCH/DELETE /company/signatories`, `/company/restrictions`
  (owner/admin).
- `GET /company/rates`, `POST /company/rates` (cualquier rol de escritura
  propone en `draft`), `POST /company/rates/:id/approve` /
  `/reject` (**solo owner/admin**, más estricto que la DB) — transición de
  estado **atómica** (`UPDATE ... WHERE ... AND status='draft' RETURNING`,
  mismo patrón que `tool_calls`/API-09): decidir una tarifa ya decidida
  (aprobada o archivada) responde 409, nunca re-decide en silencio; dos
  decisiones concurrentes de la misma tarifa nunca ambas 200.
- Cada escritura de perfil registra procedencia por fila/campo
  (`field_provenance`: `ownerUserId`, `source='manual'`, `updated_at`) —
  ver `GET .../provenance` en cada subrecurso vía `lib/company-crud.ts`.

### tenders (E3/E4 — convocatorias)
- `GET /tenders` — filtros `status`/`source`, paginación por cursor.
- `GET /tenders/:id`, `GET /tenders/:id/versions`, `GET /tenders/:id/change-events`.
- `GET /tenders/sources/freshness` — cualquier usuario autenticado, sin
  `X-Org-Id` (frescura agregada, no es un dato de tenant).
- `GET/POST /tenders/:tenderId/go-no-go` — rol `reviewer`/`analyst`/
  `admin`/`owner`; **`writer` nunca decide** (enforcement en la app y en
  RLS, ver `packages/db/migrations/0024_go_no_go_reviewer.sql`).
- `POST /internal/tenders/ingest` — autenticado con `X-Platform-Api-Key`
  (no un usuario/tenant). Recibe `TenderRecord[]` normalizados; upsert por
  `(org, source, external_id)`; crea `tender_versions`/`tender_change_events`
  solo si la versión de origen es nueva (dedupe real); invalida
  automáticamente propuestas/requisitos/checklist/aprobaciones
  dependientes vía trigger de base de datos. **Única ruta de escritura de
  toda la API que bypassea `SET LOCAL ROLE app_role` deliberadamente** (ver
  comentario de diseño en `internal-ingest.routes.ts`): replica una
  convocatoria pública a N organizaciones a la vez, algo que ninguna
  identidad de usuario individual debería poder hacer. Acepta/propaga
  `X-Correlation-Id` igual que cualquier otra ruta (plugin global) y, desde
  la ronda 5 (R5-04), ese `correlation_id` **nace aquí y se hereda** en
  `tenders`/`tender_versions` (migración 0060) y en el `audit_log` de
  ingesta — antes la convocatoria (primer eslabón de la cadena
  "convocatoria -> matriz -> propuesta -> paquete -> archivo") nunca
  quedaba correlacionada, aunque el resto de la cadena sí.

### matching (E5)
- `GET /matching/tenders/:tenderId`, `GET /matching/tenders` — relevancia
  (`MatchingEngine` de `@atiende/sources`) y elegibilidad (motor propio
  sobre datos reales de company_profiles/documents/restrictions/
  registrations) como **valores separados**, cada uno con su desglose de
  criterios; `missingProfileFields` lista lo que falta capturar.
  `eligibility.status = 'no_evaluable'` cuando falta el dato necesario
  (nunca `'cumple'` inventado).

### agents (persistencia de `packages/agents`)
- `GET /agents/runs`, `GET /agents/tool-calls` (filtro `status`).
- `POST /agents/tool-calls/:id/approve` / `/deny` (owner/admin) — exige
  `X-Step-Up` (R5-11, `purpose: 'tool_call.approval'`, ver sección
  "Encabezados" arriba); registra `approved_by`/`approved_at` + `audit_log`;
  una `tool_call` ya resuelta no puede reaprobarse/redenegarse (409).
- `PgRunStore`/`PgToolCallStore` (`src/lib/agent-stores.pg.ts`) implementan
  `RunStore`/`ToolCallStore` de `@atiende/agents` sobre Postgres real.

### admin (E10 — back office / superadmin)
Todas gateadas por `app.requireSuperadmin` (tabla `platform_admins`), nunca
por membresía de organización: un superadmin ve **todas** las
organizaciones.

- `GET /admin/organizations`.
- `GET /admin/connectors/freshness` — detalle crudo de `source_runs`, con
  `isStale` explícito (nunca "cero oportunidades" silencioso).
- `GET /admin/jobs` (+`?status=`), `POST /admin/jobs/:id/retry`.
- `GET /admin/costs` — costo estimado por organización desde
  `agent_runs.estimated_cost_usd`, marcado `estimated: true` (nunca se
  presenta como facturación real).
- `GET/POST /admin/incidents`, `POST /admin/incidents/:id/resolve`.
- `GET /admin/approvals` — `tool_calls` pendientes de todas las organizaciones.
- `GET /admin/audit-log` (ronda 4) — bitácora de auditoría de TODAS las
  organizaciones (filtro opcional `orgId`/`entity`/`actorId`/fecha,
  paginado), reutilizando los esquemas de `GET /audit-log`.
- `POST /admin/tool-calls/:id/approve` / `/deny` (ronda 4) — aprobación
  **cross-org** de una `tool_call` pendiente por superadmin, sin necesidad
  de `X-Org-Id` ni de rol owner/admin DE esa organización (antes, `GET
  /admin/approvals` listaba pendientes de todas las organizaciones pero
  decidir de verdad exigía pertenecer a la organización dueña, dejando el
  back office de solo lectura para un superadmin externo). Transición
  atómica igual que la ruta por-org (API-09); `audit_log` con el actor
  superadmin real y la organización afectada. Exige `X-Step-Up` (R5-11,
  `purpose: 'admin.action'`) atado a la organización DUEÑA de la
  `tool_call` (resuelta de la propia fila, ya que esta ruta nunca lleva
  `X-Org-Id`, ver "Encabezados" arriba) — un superadmin sin 2FA enrolado
  recibe 403 igual que cualquier otro consumidor de `requireStepUp`.
- `GET /admin/calendar-holidays` (REQ-050/056, ronda 5, `?jurisdiction=`/
  `?year=`) — calendario oficial de días inhábiles; lectura abierta a
  cualquier usuario autenticado (no solo superadmin: cualquier
  organización lo consume para su propio cómputo de plazos), tabla de
  PLATAFORMA (sin `org_id`, mismo patrón que `source_runs`). `POST
  /admin/calendar-holidays` (solo superadmin) exige `sourceUrl`+
  `sourceConsultedOn` (nunca una fecha "de memoria" — la tabla se
  despliega VACÍA, ver `apps/api/docs/e11-cobertura.md`). `date`/
  `sourceConsultedOn` deben ser una fecha calendario REAL, no solo el
  patrón "YYYY-MM-DD" (ronda 5, R5-07: `"2026-02-30"` responde `422`
  explícito, ya no un `500` de Postgres); `sourceUrl` debe usar esquema
  `http`/`https` (ronda 5, R5-06).

### expediente (E6-E9/E11 — expediente de participación real)
Integra `@atiende/expediente` (paquete puro, sin DB) sobre `packages/db`
mediante adaptadores en `src/lib/expediente/` (ver docstrings de cada
archivo para el detalle de cada decisión de mapeo). **26 rutas** (AE-12,
docs/auditoria-2/api-expediente.md — documentos 7, propuesta 5, checklist
2, aprobación 4, paquete 3, presentación 2, post-adjudicación 3; conteo
verificable con `grep -c "server\.\(get\|post\|patch\|delete\|put\)("
src/modules/expediente/*.routes.ts`), todas bajo el prefijo
`/expediente/tenders/:tenderId/...`; roles con el mismo criterio del resto
de la API (`WRITE_ROLES` = owner/admin/analyst/writer/reviewer para
mutar, `viewer` solo lee), salvo aprobar (ver más abajo).

- **Documentos y matriz (E6)** — `POST/GET /documents` (bóveda en disco con
  sha256, ver `lib/storage.ts`; extracción de texto real vía `pdf-parse`
  para PDF, o texto plano; un PDF sin capa de texto queda
  `textExtractionStatus: "requires_ocr"` explícito, **nunca** vacío en
  silencio — sin OCR real en esta ronda). Subir un nuevo documento
  `document_kind: "bases"` cuando ya existía uno anterior se trata como
  nueva versión de bases: inserta `tender_versions`/`tender_change_events`
  ANTES del documento, lo que dispara el trigger de invalidación ya
  existente (`packages/db/migrations/0022`) sobre
  `requirement_items`/`compliance_items`/`proposals`/`proposal_approvals`
  de esa convocatoria — el historial nunca se borra, solo se marca
  `invalidated_at`. `POST /matrix/build` corre
  `RequirementMatrixBuilder`/`RuleBasedExtractor` real sobre los documentos
  con texto extraído e inserta `requirement_items` nuevos (no invalidados);
  `PATCH /matrix/:id` (writer+) edita `matrixStatus`/`assignedTo`.
  Conflictos entre documentos (`RequirementMatrixBuilder` detecta plazos u
  obligatoriedad contradictorios) se persisten como incidentes visibles en
  `requirement_conflicts` (`GET /conflicts`, `POST /conflicts/:id/resolve`).
- **Propuesta (E7)** — `GET /proposal` (crea el expediente si no existe),
  `POST /proposal/technical/generate` (`TechnicalProposalBuilder` real
  sobre `CompanyDataService`; un mapeo declarado por el llamador
  `{requirementId, kind, refKey}` resuelve a texto trazable, sin mapeo o
  sin evidencia mapeable queda "PENDIENTE" explícito, nunca inventado) y
  `POST /proposal/economic/generate` (`EconomicProposalBuilder`; **A8**:
  una tarifa no aprobada/vencida bloquea ese concepto de punta a punta, sin
  total parcial). `GET/PATCH /proposal/sections/:sectionKey` (writer+, nueva
  versión en cada edición manual). El reporte de bloqueos/faltantes de la
  última generación se persiste en `proposals.generation_report`.
- **Checklist (E8)** — `POST /checklist/run` corre `IntegrityChecklist` real
  (7 dimensiones) y lo persiste en `compliance_items`; `files`/
  `formatLimits`/`requiredSignatures`/`presentAnnexRefs` los declara el
  llamador (esta ronda no modela un "casillero de portal" propio ni un
  tablero de firmas — límite de alcance documentado, no inferencia
  fabricada); anexos obligatorios, documentos usados (con vigencia real) y
  el resultado económico se derivan de datos reales. `GET /checklist` lista
  el resultado vigente.
- **Aprobación (E8)** — `ApprovalWorkflow` real
  (`lib/expediente/approval-store.pg.ts`: la clase vive solo en memoria y no
  expone hidratación, así que se reproduce un log append-only de eventos,
  `proposal_approval_events`, sobre una instancia nueva en cada petición;
  `proposal_approvals` queda como snapshot materializado de lectura simple).
  `POST /approval/request-review` (writer/owner/admin),
  `POST /approval/approve` (**solo reviewer/admin/owner**, reforzado en la
  aplicación y en la política RLS de `proposal_approvals`,
  `packages/db/migrations/0031`; autoaprobación por el mismo `actorId`
  prohibida — la autoaprobación entre dos CUENTAS de la misma persona física
  es un límite conocido y documentado de `packages/expediente`, EX-EXP-08).
  Desde la ronda 4 (AE-11), cada `PATCH .../proposal/sections/:sectionKey`
  persiste además un evento `record_edit` (actor real + `scopeRef`,
  `packages/db/migrations/0053`): `approve()` rechaza a cualquier aprobador
  que conste como autor de contenido del alcance que intenta aprobar (o de
  un descendiente cubierto), aunque OTRA persona haya pedido la revisión —
  cierra el hueco de que un `admin`/`reviewer` redactara una sección y
  luego aprobara igual el expediente completo.
  `POST /approval/comments`, `GET /approval` (recalcula siempre el hash de
  insumos ACTUAL con `sealInputs`/`computeInputsHash` — EX-EXP-17, nunca
  reutiliza un hash guardado — e invalida automáticamente en memoria una
  aprobación divergente al responder). **Nota importante**: la aplicabilidad
  de un requisito condicional (`conditionEvaluations`) NO forma parte de
  `ExpedienteInputs`, así que cambiarla entre dos generaciones de la
  propuesta técnica no mueve el hash — `proposal/technical/generate` la
  compara contra la declaración anterior y, si cambió, invalida
  EXPLÍCITAMENTE (mismo mecanismo de evento persistido) la aprobación
  afectada.
- **Paquete (E8/E9)** — `POST /package/assemble` corre `PackageAssembler`
  real: ZIP en disco (`STORAGE_DIR`) + fila en `package_manifests`
  (`storage_ref`, `inputs_hash`). `status` (`draft`/`ready`) se DERIVA
  siempre dentro del propio paquete (checklist verde + aprobación vigente de
  alcance `"expediente"` con hash coincidente + sin documentos faltantes) —
  esta ruta nunca lo declara por su cuenta (**A13/A14**).
  `GET /package/latest`, `GET /package/download` (autenticada, cualquier
  rol de lectura). Desde la ronda 4 (AE-14), ambas RE-DERIVAN el estado
  actual (`deriveCurrentManifest`) cuando el último `assemble` había
  quedado `"ready"`: si la aprobación vigente ya no cubre el estado actual
  (o el checklist dejó de ser verde), `/latest` reporta `"draft"` con los
  motivos reales y `/download` responde 409 explícito en vez de servir el
  ZIP `"ready"` desactualizado. Un paquete que nació `"draft"` sigue
  descargándose igual que antes (sin regresión de A14).
- **Presentación declarada por el usuario (E9, A15)** — `GET /submission`,
  `POST /submission/declare` (writer+): registra SOLO que el usuario declara
  haber presentado (fecha + acuse opcional subido por el propio usuario,
  guardado en disco). Este módulo **nunca** envía nada a un portal externo
  — ni un cliente HTTP saliente en todo el archivo
  (`modules/expediente/submission.routes.ts`), verificado estáticamente en
  `test/expediente-package-and-submission.test.ts`.
- **Post-adjudicación (E11)** — `GET/POST /post-award`, `PATCH
  /post-award/:id` (writer+): hitos/garantías/facturación/pago.
  `kind: "pago"` calcula `dueDate` a 17 días hábiles desde
  `invoiceVerifiedOn` (`lib/expediente/business-days.ts`, regla
  CONFIGURABLE con la fuente legal vigente como valor por defecto — LAASSP
  nueva Art. 73, ver `docs/legal/verificacion-legal.md` fila REQ-105 y
  `docs/DECISIONES.md` D-07 — nunca un número mágico sin trazabilidad).
  Los recordatorios se ENCOLAN en `jobs` (`kind:
  "post_award_followup_reminder"`) sin ningún envío externo — esta ronda
  entrega la fila encolada, no un canal de notificación real.
  **Ronda 5** (ver `apps/api/docs/e11-cobertura.md`, reconciliación
  honesta contra REQ-050..056): `kind` ampliado con `penalizacion`/
  `convenio_modificatorio`; `kind='hito'` exige `responsibleParty`;
  `kind='garantia'` exige `guaranteeType`; `kind='facturacion'` exige
  `cfdiReference`+`acceptanceDate` y calcula el plazo de pago con el mismo
  motor que `kind='pago'`; `kind='penalizacion'|'convenio_modificatorio'`
  exige `modificationReference`. Cada seguimiento expone `alertLevel`
  (`'vencido'|'proximo'|null`); `GET /expediente/post-award-alerts` agrega
  todos los vencidos/próximos de la organización. El cómputo de días
  hábiles combina el calendario OFICIAL cargado en `calendar_holidays`
  (ver `GET/POST /admin/calendar-holidays` abajo) con los `holidays` que el
  llamador declare a mano — un feriado oficial cargado SÍ excluye el día
  real del cómputo (ronda 5, R5-01: antes se serializaba mal la fecha de
  la DB y nunca tenía efecto real, ver "Reparaciones — ronda 5" abajo);
  `calendarNote` solo afirma que un feriado "fue excluido del plazo" para
  los que de verdad cayeron dentro de la ventana `[verifiedOn, dueDate]` de
  ese cómputo concreto (nunca por todos los cargados para el año).

Todas las rutas devuelven errores en `application/problem+json` (RFC 7807):
`{ type, title, status, detail?, requestId }`. En producción, un error 500
nunca expone mensaje interno ni stack (`lib/errors.ts` +
`plugins/error-handler.ts`).

## Decisiones de diseño relevantes

- **Contraseñas con `scrypt` en vez de argon2/bcrypt**: ver `src/lib/passwords.ts`.
- **Resolución de organización (`X-Org-Id`)**: `app.requireOrg` valida el
  header contra la membresía real vía `app.membership_role(org_id)`
  (`SECURITY DEFINER`, resuelve SIEMPRE la membresía del propio actor
  autenticado — nunca acepta un `user_id` como parámetro, ver DB-01 en
  `docs/auditoria-1/db-api.md`), y rechaza un `X-Org-Id` mal formado con
  400 antes de tocar la base de datos.
- **Contexto de tenant por transacción**: `SET LOCAL ROLE app_role` +
  `set_config` de `app.current_org_id`/`app.current_user_id` en cada
  operación, para que RLS sea la última línea de defensa. Una prueba
  estática (`test/audit-db07-tenant-context-pattern.test.ts`) falla si
  algún `app.db.transaction()` de `modules/`/`plugins/` omite el `SET
  LOCAL ROLE` (con la única excepción documentada de la ingesta interna).
- **Refresh tokens con rotación real**: `refresh_tokens` (hash del `jti`,
  nunca el token en claro) + `app.revoke_refresh_token`/
  `app.revoke_all_refresh_tokens` (SECURITY DEFINER). Reusar un token ya
  rotado, o uno tras logout, responde 401.
- **Anti-enumeración en `/auth/register`**: un email duplicado responde el
  mismo 201 genérico que un alta exitosa, sin crear fila duplicada ni
  filtrar el `id` real de la cuenta existente.
- **`isoTimestamp`/`nullableIsoTimestamp`** (`src/lib/schema-helpers.ts`):
  las columnas `timestamptz`/`date` de Postgres vuelven del driver (tanto
  `pg` como PGlite) como instancias de `Date`, nunca string ISO. Un campo
  de respuesta declarado `z.string()` a secas rechaza esos valores con 500
  ("Response doesn't match the schema"). Todo campo de fecha en una
  respuesta usa estos helpers (`z.union([string,date]).transform(...)`).
- **OpenAPI (`/docs/json`, requiere sesión)**: el registro de
  `@fastify/swagger` incluye `transform: jsonSchemaTransform` (de
  `fastify-type-provider-zod`) — sin él, cualquier ruta con
  `params`/`querystring` en zod rompe la generación del esquema con 500.
  `tenderListQuerySchema.limit` evita deliberadamente `z.coerce.number()`
  por el mismo motivo (no es representable en JSON Schema por esa vía).
- **Idempotencia (`Idempotency-Key`)**: probada en `POST
  /organizations/invitations`. **Alcance limitado**: solo mutaciones con
  `org_id` ya resuelto (igual que ronda 1); `POST /internal/tenders/ingest`
  logra idempotencia real por otra vía (dedupe estructural en
  `tender_versions`, no por `Idempotency-Key`).
- **Rate limit** (ver `src/lib/rate-limit-settings.ts`, ronda 4): límites
  por "tier" configurables por perfil (`config.rateLimitProfile`) en vez de
  números mágicos repartidos:
  - `global` (100→**300**/min, IP, hook `onRequest` — no puede depender de
    `X-Org-Id`/`Authorization` sin verificar: se esquivaría rotándolos).
  - `auth` (`/auth/login`, 5/min sin cambios).
  - `sensitiveAction` (30/min, hook `preHandler` — DESPUÉS de
    `app.requireOrg`/`app.requireSuperadmin`, así que SÍ puede aislar el
    presupuesto por organización/superadmin): `/agents/tool-calls/:id/
    approve|deny` y `/admin/tool-calls/:id/approve|deny`.
  - `RATE_LIMIT_PROFILE=e2e` (literal exacto, nunca por `NODE_ENV`) eleva
    los tres tiers para un harness E2E intensivo (p. ej.
    `apps/web scripts/e2e-full.mjs`) sin confundir su propio volumen con un
    fallo de producto — ver `docs/logs/web-ronda3.log` (429 real de
    `/auth/login` durante Playwright con varios workers/logins).
  - Cabeceras `Retry-After`/`X-RateLimit-*` (`@fastify/rate-limit` las
    agrega por defecto) expuestas a JS cross-origin vía
    `Access-Control-Expose-Headers` (ver CORS abajo).
- **CORS** (`@fastify/cors`, ronda 4): `methods`/`allowedHeaders`/
  `exposedHeaders` explícitos — antes, sin `methods`, el preflight
  respondía `GET,HEAD,POST` (sin PUT/PATCH/DELETE), bloqueando en el propio
  navegador cualquier escritura cross-origin real (bug encontrado por
  apps/web, `docs/logs/web-ronda3.log`).
- **Content-Security-Policy** (`@fastify/helmet`, ronda 4): CSP real
  (`default-src`/`script-src 'self'`; `connect-src 'self'` + `CORS_ORIGINS`;
  `frame-ancestors 'none'`; `object-src 'none'`) + `Permissions-Policy`
  explícito (helmet 8.x no trae middleware propio para esa cabecera) en
  TODA respuesta, incluidas 4xx/5xx.
- **Cuerpo vacío en rutas de acción** (`src/lib/optional-empty-body.ts`,
  ronda 4): un `POST` de acción sin cuerpo (`approve`/`deny`/`retry`/
  `resolve`) con `Content-Type: application/json` y cuerpo vacío ya no
  responde 400 — se registra un content-type parser tolerante SOLO en el
  scope encapsulado de esas rutas concretas; el resto de la API (rutas que
  SÍ exigen cuerpo, p. ej. `POST /organizations`) conserva el 400 estricto
  de Fastify sin cambios.
- **Auditoría**: `recordAudit` se llama explícitamente dentro de la misma
  transacción de cada mutación relevante (perfil de empresa, tarifas,
  convocatorias ingeridas, decisiones go/no-go, aprobación de tool_calls,
  acciones de back office). `audit_log` mantiene una cadena de hashes
  verificable (`app.verify_audit_log_chain()`, ver `packages/db/README.md`).
  `GET /audit-log`/`GET /admin/audit-log` (ronda 4) la exponen por HTTP
  (ver secciones arriba). Eventos de autenticación
  (`app.record_auth_event`, `login_succeeded`/`refresh_*`/`logout`) exigen
  desde la ronda 4 (API-14, `packages/db/migrations/0054`) que el
  `actor_id` declarado coincida con `app.current_user_id()` ya fijado por
  el llamador, salvo `login_failed` (el único evento genuinamente
  pre-autenticación) — cierra un vector de forja de auditoría por un
  llamador con `app_role`.
- **Almacenamiento de archivos**: disco local (`STORAGE_DIR`) con hash
  sha256, deduplicado por contenido. El contenido llega en base64 dentro
  del cuerpo JSON (no `multipart/form-data`, para no sumar una dependencia
  solo para esto en esta ronda) — límite defensivo ~22MB decodificado
  (`MAX_BASE64_LENGTH`, `lib/storage.ts`), y desde la ronda 4 (AE-15) el
  `bodyLimit` real de Fastify se fija coherente con ese límite (antes, el
  1MiB por defecto de Fastify rechazaba con 413 genérico cualquier subida
  bastante antes de llegar al chequeo explícito de tamaño).
- **Matching (relevancia vs. elegibilidad)**: la relevancia reutiliza
  `MatchingEngine` de `@atiende/sources` (paquete puro, sin acceso a la
  base de datos); la elegibilidad dura (documentos/restricciones/
  registros) es un motor propio de `apps/api`, porque requiere datos
  reales de compliance que el paquete de matching no puede ver. Cast
  documentado entre el `source` libre del esquema de ingesta y el enum
  cerrado de `@atiende/sources` (ver `modules/matching/engine.ts`).
- **`packages/agents` — vocabulario de roles inconsistente (TODO de
  unificación, documentado, no resuelto)**: `packages/agents` define su
  propio `Role` (director/licitador/legal/...) que NO coincide con
  `OrgRole` real del sistema (owner/admin/analyst/writer/reviewer/viewer).
  El adaptador Postgres (`lib/agent-stores.pg.ts`) hace un cast explícito
  y comentado en la frontera, en vez de ocultar la discrepancia.

## Tests de integración (`test/*.test.ts`, `fastify.inject` + PGlite)

La suite creció considerablemente en ronda 2 (16 archivos). `vitest.config.ts`
sube `testTimeout`/`hookTimeout` a 20s y acota la concurrencia (`pool:
forks`, `maxForks: 4`) porque ejecutar todo en paralelo sin límite en este
entorno produce timeouts espurios por contención de CPU (cada archivo,
solo, pasa establemente en <2s por caso).

- `auth-and-orgs-flow.test.ts`, `isolation-and-idempotency.test.ts`,
  `rate-limit-and-health.test.ts` — ronda 1.
- `audit-api01` a `audit-api06`, `audit-db07` — un archivo por hallazgo de
  `docs/auditoria-1/db-api.md` (ver esa tabla, columna "Estado reparación",
  para el detalle de qué prueba cada uno).
- `company-profile.test.ts` — E2 completo, incluida prueba mínima A8
  (precio no aprobado rechazado de extremo a extremo).
- `tenders-and-ingest.test.ts` — E3/E4, pruebas mínimas A1/A2/A3.
- `matching-and-go-no-go.test.ts` — E5, prueba mínima A5 (dos
  organizaciones sin fuga) y adversarial de rol en go/no-go.
- `agent-persistence.test.ts` — `PgRunStore`/`PgToolCallStore` persisten de
  verdad (relectura con instancia nueva) + aprobación de `tool_calls` por rol.
- `admin-backoffice.test.ts` — E10, usuario normal 403 en `/admin/*`,
  superadmin ve datos reales de más de una organización.
- `expediente-documents-and-matrix.test.ts` — E6, extracción real de PDF
  (`pdf-lib` genera el fixture) y texto plano, formato no soportado, roles,
  **A6** (conflicto de plazos entre dos versiones de bases, historial
  preservado). `expediente-text-extraction.test.ts` — unitario de
  `lib/expediente/text-extraction.ts` (incluye `"requires_ocr"` vía mock,
  ver docstring del archivo para por qué un PDF "en blanco" real generado
  con `pdf-lib` no sirve para ese caso puntual).
- `expediente-proposal.test.ts` — E7, **A8** de punta a punta (tarifa no
  aprobada bloqueada, luego aprobada y recalculada), requisito sin mapeo
  nunca inventado, edición de sección por rol, e invalidación explícita por
  cambio de `conditionEvaluations`.
- `expediente-checklist-and-approval.test.ts` — E8, checklist real (7
  dimensiones), **A12** (rol indebido/autoaprobación) y **A11** (cambio de
  insumo real invalida automáticamente).
- `expediente-package-and-submission.test.ts` — E8/E9, **A13/A14** (ready
  real vs. draft con motivos) con ZIP releído (`jszip`) y manifiesto
  verificado, **A15** (declaración de presentación + escaneo estático sin
  cliente HTTP saliente).
- `expediente-post-award.test.ts` — E11, plazo de pago a 17 días hábiles
  con fuente legal citada, job de recordatorio encolado, roles.
- `expediente-e2e-flow.test.ts` — flujo completo de extremo a extremo
  (bases → matriz → perfil → propuesta → checklist → aprobación → paquete
  draft → ready → descarga → cambio de bases → invalidación → draft de
  nuevo) sobre la API real, cerrando A6/A8/A10/A11/A13/A14/A15 en un solo
  recorrido.

## Pendiente / fuera de alcance de esta ronda

- Concurrencia real de `jobs` con múltiples conexiones físicas contra
  Postgres real (no disponible en este entorno, ver `packages/db/README.md`).
- Idempotencia y rate limit por organización/usuario con alcance completo
  (ver Decisiones de diseño).
- **Ronda 5**: implementado 2FA/step-up con TOTP (`otplib`) para `POST
  .../rates/:id/approve` y `POST .../approval/approve` (REQ-044/064, ver
  módulo `2fa` arriba). **Sigue pendiente**: passkey/WebAuthn (el
  requisito menciona "passkey/OTP" — esta ronda solo implementó OTP/TOTP,
  no passkey); `tool_calls` (aprobación de agentes) sigue sin exigir un
  segundo factor.
- Cableado completo de `AgentRunner` (packages/agents) con proveedores LLM
  reales, `ToolRegistry` de negocio y guardrails activos desde `apps/api`:
  esta ronda entrega la capa de persistencia (`RunStore`/`ToolCallStore`) y
  el flujo de aprobación humana de `tool_calls`, no la orquestación de
  agentes en sí (ver `packages/agents/README.md`, "Cómo lo consumirá
  apps/api").
- Procedencia por CAMPO individual dentro de una fila de perfil de empresa
  (hoy es por fila completa, `field='*'`, salvo `company_profiles` que sí
  registra procedencia por campo real) — ver `lib/provenance.ts`.
- `DB-07` (docs/auditoria-1/db-api.md): los sitios de escritura de esta
  ronda no se migraron a `withTenantContext`/`applyTenantContext` de
  `@atiende/db` (decisión de alcance documentada); en su lugar, una prueba
  estática cierra el riesgo real (omitir `SET LOCAL ROLE app_role`).
- **Ronda 3 (E6-E9/E11, expediente) — pendientes honestos**:
  - **Sin OCR real**: un PDF sin capa de texto queda `"requires_ocr"`
    explícito; no hay ningún motor de OCR conectado en esta ronda.
  - **Sin firma real**: `IntegrityChecklist`/el checklist persistido solo
    leen `userConfirmedSigned` declarado por el llamador — el sistema
    nunca firma ni simula firma (mismo límite que `packages/expediente`).
  - **Sin envío real a ningún portal**: `submissions` solo registra la
    declaración del usuario; no existe ningún cliente HTTP saliente hacia
    un portal de licitaciones en esta ronda (A15).
  - **Sin extracción de texto por página real**: `extractDocumentText`
    (`pdf-parse`) devuelve el texto completo del PDF como una sola
    "página" (se guarda `page_count` real aparte, pero `source.page` de
    cada requisito siempre es `1`) — limitación documentada, no una
    extracción por página genuina.
  - **`files`/`formatLimits`/`requiredSignatures`/`presentAnnexRefs` del
    checklist son declarados por el llamador**, no inferidos de un
    "casillero de portal" propio (no existe ese modelo en este esquema
    todavía).
  - **Autoaprobación entre dos CUENTAS de la misma persona física**
    (EX-EXP-08, límite documentado de `packages/expediente`): solo se
    compara `actorId`; una persona con dos cuentas/roles activos podría
    aprobar su propio trabajo sin que este control lo detecte.
  - **Recordatorios post-adjudicación sin canal de notificación real**: se
    encolan en `jobs` (`kind: "post_award_followup_reminder"`); ningún
    worker de esta ronda los consume para enviar nada (correcto: la tarea
    pide "sin envío externo", no un canal de notificación).
  - **Calendario oficial de días inhábiles incompleto**: `addBusinessDays`
    (17 días hábiles, LAASSP Art. 73) solo excluye sábados/domingos por
    defecto; **ronda 5** agregó la tabla `calendar_holidays` + `GET/POST
    /admin/calendar-holidays` para cargar el calendario oficial, pero se
    despliega VACÍA (sin verificación en línea confiable del lineamiento
    SABG vigente en esta ronda, ver `docs/legal/verificacion-legal.md`) --
    cargarla con fechas reales sigue siendo tarea de un administrador.
  - **`2FA` en la aprobación del expediente**: implementado en ronda 5
    (`POST .../approval/approve` exige `X-Step-Up`, ver módulo `2fa`).
  - **E11 (REQ-051..055)**: máquina de estados del contrato, extracción
    estructurada del contrato firmado, redactor de inconformidades,
    autopsia del fallo y radar de renovaciones NO están construidos --
    fuera de alcance de la ronda 5 (ver `apps/api/docs/e11-cobertura.md`).

## Reparaciones — auditoría 2 (`docs/auditoria-2/api-expediente.md`)

- **AE-01 (ALTA)**: `asOfIso` ya no lo decide el cliente -- se deriva
  SIEMPRE de `tenders.submission_deadline` (`resolveExpedienteAsOfIso`,
  `lib/expediente/dates.ts`); sin `submission_deadline` fijado, 422
  explícito ("fecha de presentación desconocida") en vez de usar "ahora".
- **AE-02 (ALTA)**: editar el CONTENIDO de una sección de la propuesta
  (`PATCH /proposal/sections/:sectionKey`) invalida explícitamente
  (`workflow.recordChange`) cualquier aprobación vigente que la cubra --
  mismo mecanismo que ya usaba `conditionEvaluations`.
- **AE-03 (MEDIA)**: `assertSafeFileContent` (`lib/storage.ts`) busca cada
  firma peligrosa (ejecutables, PEM) en TODO el buffer, no solo en el
  offset 0; añade validación estructural de PDF (`%PDF-` en los primeros
  1024 bytes exige también `%%EOF`).
- **AE-04 (MEDIA)**: el texto extraído (`lib/expediente/text-extraction.ts`)
  se sanitiza (se elimina `<script>`/`<style>` y cualquier otra etiqueta
  HTML) antes de persistirse en `extracted_text`.
- **AE-05 (BAJA-MEDIA)**: cualquier firma de ZIP se rechaza de forma
  fail-closed en `assertSafeFileContent` (ningún flujo de este dominio
  espera legítimamente un ZIP subido por el cliente) -- elimina el vector
  de zip-bomb en vez de intentar limitar ratio/tamaño descomprimido.
  Además, límites anti "PDF bomb" (páginas/tamaño de texto extraído).
- **AE-06/AE-07 (BAJA)**: **fuera del ámbito de este corrector** -- ambos
  hallazgos viven en `packages/expediente` (`package-assembler.ts`/
  `types.ts`: sha256 de JSON en vez de bytes reales; Zip Slip latente sin
  sanitizar `filename`), un paquete no asignado a este agente. En
  `apps/api` el vector de Zip Slip NO es explotable hoy (`package.routes.ts`
  solo pasa `filename: "${section_key}.txt"`, fijo por el servidor).
- **AE-09 (MEDIA)**: `POST/GET /post-award` expone `calendarNote`
  ("solo excluye sábados y domingos; días inhábiles oficiales pendientes")
  y `legalRegime` (REQ-050: LAASSP nueva/Art. 73/17 días hábiles vs.
  LAASSP 2000 abrogada/Art. 51/20 días naturales, decidido por
  `tenders.published_at`, nunca "hoy").
- **AE-10 (BAJA hoy/MEDIA latente)**: `runContextCache`
  (`lib/agent-stores.pg.ts`) es ahora un `BoundedCache` (LRU acotado,
  `lib/bounded-cache.ts`) en vez de un `Map` sin límite de tamaño.
- **AE-12 (documentación)**: corregido el conteo de rutas de `/expediente`
  a 26 (ver arriba).
- **DB-13 / API-13**: ver `packages/db/README.md`
  (`migrations/0050`/`0051`) y `lib/audit.ts` (`recordAuthAudit`) — vigencia
  de tarifas evaluada siempre en `America/Mexico_City`, y eventos de
  autenticación (login/refresh/reutilización/logout) en `audit_log`.

## Reparaciones — auditoría adversarial ronda 5 (`docs/auditoria-2/api-ronda5.md`)

- **R5-01 (CRÍTICA)**: `loadOfficialHolidays` (`post-award.routes.ts`)
  serializaba la columna `date` con `String(dateObject)`
  (`Date.prototype.toString()`, dependiente de `TZ` del proceso) en vez de
  `toISOString()` -- un feriado oficial cargado NUNCA excluía el día real
  del plazo de pago, mientras `calendarNote` afirmaba lo contrario. Fijado
  con `toDateOnlyString` (getters UTC); `calendarNote` ahora solo afirma
  inclusión para los feriados que de verdad cayeron dentro de la ventana
  `[verifiedOn, dueDate]` de ese cómputo (antes contaba todos los cargados
  para el año, cayeran o no en rango, o aunque el régimen fuera de días
  naturales).
- **R5-02 (CRÍTICA)**: `/auth/2fa/{enroll,verify-enrollment,step-up}` sin
  límite de tasa específico (solo el `global`, 300/min por IP). Tier
  `twoFactor` (5/5min, mínimo garantizado, no relajado por
  `RATE_LIMIT_PROFILE=e2e`) + contador de fallos por usuario en DB
  (`twofa_lockouts`, migración 0058) con bloqueo progresivo.
- **R5-03 (MEDIA)**: fallos de verificación de 2FA no quedaban en
  `audit_log` (asimetría con `auth.login_failed`). Se agregan
  `twofa.verification_failed`/`twofa.step_up_denied` (migración 0059,
  misma función `app.record_security_event`).
- **R5-04 (MEDIA)**: `tenders`/`tender_versions` sin `correlation_id`
  (migración 0060) -- la convocatoria (primer eslabón de la cadena
  REQ-171) nunca era correlacionable. Ahora nace en
  `POST /internal/tenders/ingest` y se hereda en ambas tablas y en el
  `audit_log` de ingesta.
- **R5-05 (BAJA-MEDIA, diseño)**: `step_up_sessions` sin columna de
  organización/acción -- un `stepUpToken` servía para cualquier
  tarifa/expediente en cualquier organización dentro de la ventana. Se
  agregan `org_id`/`purpose` OPCIONALES (migración 0061): si el cliente
  los declara al pedir el step-up, `requireStepUp` exige que coincidan
  exactamente o rechaza. Sin declararlos (comportamiento previo), la
  sesión sigue siendo "genérica" -- no rompe clientes existentes. **Nota:**
  la reverificación adversarial confirmó que este alcance opcional nunca
  se ejercía en la práctica (ningún cliente real lo declaraba) -- ver
  R5-09 abajo, que lo vuelve obligatorio.
- **R5-06 (BAJA)**: `sourceUrl` de `calendar_holidays` restringido a
  esquema `http`/`https` (antes aceptaba `javascript:`/`data:`/`ftp:`).
- **R5-07 (BAJA)**: `date`/`sourceConsultedOn` de `calendar_holidays`
  ahora exigen una fecha calendario REAL (`realCalendarDateString`,
  `lib/schema-helpers.ts`) -- antes una fecha inexistente como
  `"2026-02-30"` pasaba la validación de Zod y reventaba en Postgres con
  500 en vez de 422.
- **R5-08 (documentación, `docs/TABLERO.md`/`docs/BACKLOG.md`)**: fuera
  del ámbito de este corrector (ver "Nota de alcance" de
  `docs/auditoria-2/api-ronda5.md`) -- ninguno de esos dos archivos está
  dentro de `apps/api/**`/`packages/db/**`.

## Reparaciones — reverificación adversarial ronda 5 (`docs/auditoria-2/api-ronda5-reverificacion.md`)

- **R5-09 (BAJA-MEDIA)**: la reverificación adversarial confirmó que el
  alcance opcional de R5-05 (`org_id`/`purpose` nullable, migración 0061)
  NUNCA se activaba en el flujo real de `apps/web` -- toda sesión de
  step-up en producción quedaba "genérica", así que el riesgo original de
  R5-05 (un mismo `stepUpToken` aprueba cualquier tarifa/expediente en
  cualquier organización del usuario) seguía completamente vigente.
  Fijado: `X-Org-Id`/`purpose` OBLIGATORIOS al pedir un step-up (400
  explícito si faltan, o si `purpose` no es uno de los cuatro valores del
  enum cerrado, ver `lib/step-up.ts#STEP_UP_PURPOSES`, reforzado con un
  CHECK de esquema, migración 0063); migración 0062 invalidó (borró) las
  sesiones "genéricas" preexistentes e hizo `org_id`/`purpose` NOT NULL.
  Además, cada sesión de step-up es ahora de UN SOLO USO (columna
  `consumed_at`, consumo atómico tipo `UPDATE ... WHERE consumed_at IS
  NULL RETURNING`, mismo patrón que `app.rotate_refresh_token`) -- un
  `stepUpToken` reutilizado responde 403, aunque siga vigente y el
  org/purpose coincidan. Tests: `apps/api/test/security-r505-stepup-scope.test.ts`
  (400 sin org/purpose, 400 con `purpose` fuera del enum, reutilización
  cruzada de org/purpose rechazada, reuso de un mismo token rechazado) y
  `packages/db/test/security-r509-step-up-mandatory-scope.test.ts`
  (invalidación de sesiones genéricas preexistentes al migrar, NOT NULL,
  CHECK del enum).
- **R5-10 (MEDIA-BAJA)**: los fallos/bloqueos/replay de 2FA
  (`twofa.verification_failed`/`twofa.step_up_denied`) se auditaban sin la
  IP del cliente, rompiendo la paridad que la propia justificación de
  R5-03 invoca con `auth.login_failed` (API-13), que sí la incluye. Fijado:
  `ip`/`userAgent` agregados al `after` de `recordFailure`
  (`modules/twofa/routes.ts`), mismo patrón `auditContext` que
  `modules/auth/routes.ts` -- sin migración nueva (`after` ya es `jsonb`
  sin esquema fijo). Test en el mismo archivo que R5-02/R5-03
  (`security-r502-r503-twofa-brute-force.test.ts`).
- **R5-11 (BAJA-MEDIA, cerrado)**: `tool_call.approval`/`admin.action`
  existían en `STEP_UP_PURPOSES` (y en el CHECK de la migración 0063)
  desde R5-09, pero ningún endpoint real los exigía todavía -- aprobar o
  denegar una `tool_call` pendiente de un agente (puede autorizar
  gasto/envío/uso de API en nombre de la organización, y en el caso de
  superadmin es además cross-org) no pedía ninguna verificación en dos
  pasos, pese a que el propio enum ya reservaba un valor específico para
  cada caso. No era una regresión de R5-09/R5-10 (ninguno de los dos
  commits tocó `modules/agents/routes.ts`/`modules/admin/routes.ts`) y ya
  estaba declarado honestamente en `docs/PROGRESO.md` ("tool_calls sin
  2FA"), pero se consideró que el riesgo era real y se cerró en esta
  ronda. Fijado: `POST /agents/tool-calls/:id/approve|deny` (org-scoped)
  llama `requireStepUp` con `purpose: 'tool_call.approval'` y el `orgId`
  ya validado por `app.requireOrg` (mismo patrón que `company`/
  `expediente`). `POST /admin/tool-calls/:id/approve|deny` (superadmin,
  cross-org, sin `X-Org-Id`) llama `requireStepUp` con `purpose:
  'admin.action'`, resolviendo el `orgId` de un SELECT previo sobre la
  propia fila de `tool_calls` (la organización afectada, nunca de un
  header) -- un superadmin sin 2FA enrolado recibe el mismo 403 con
  instrucción que cualquier otro consumidor de `requireStepUp`; una
  `tool_call` inexistente sigue respondiendo 404 sin exigir step-up. Tests:
  `apps/api/test/security-r511-tool-call-stepup.test.ts` (org-scoped: sin
  2FA, sin `X-Step-Up`, `purpose`/organización incorrectos, éxito con
  sesión consumida) y `apps/api/test/ronda4-admin-tool-calls.test.ts`
  (cross-org: superadmin sin 2FA, sin `X-Step-Up`, `purpose` incorrecto,
  éxito con sesión consumida, 404 sin exigir step-up); ajustados además
  `agent-persistence.test.ts`, `security-api09-tool-calls-atomic.test.ts` y
  `ronda4-empty-body.test.ts` para pedir un `stepUpToken` por cada acción
  que ahora lo exige.
