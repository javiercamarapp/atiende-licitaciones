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

### health
- `GET /healthz` — liveness, no toca DB.
- `GET /readyz` — verifica DB con `select 1`, 503 si falla.
- `GET /metrics` — métricas Prometheus (`prom-client`), **sin ningún dato de
  tenant** (solo método/ruta/status code).

### auth
- `POST /auth/register` — responde 201 genérico incluso si el email ya
  existe (anti-enumeración, ver Decisiones de diseño).
- `POST /auth/login` (rate limit 5/min).
- `POST /auth/refresh` — rotación real: revoca el refresh token usado al
  emitir uno nuevo; reusar un token ya rotado responde 401.
- `POST /auth/logout` — revoca el refresh token dado (idempotente).

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
  `/reject` (**solo owner/admin**, más estricto que la DB).
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
  identidad de usuario individual debería poder hacer.

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
- `POST /agents/tool-calls/:id/approve` / `/deny` (owner/admin) — registra
  `approved_by`/`approved_at` + `audit_log`; una `tool_call` ya resuelta no
  puede reaprobarse/redenegarse (409).
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
  es un límite conocido y documentado de `packages/expediente`, EX-EXP-08),
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
  rol de lectura).
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
- **Rate limit**: global por IP (100/min) + override en `/auth/login`
  (5/min). **Alcance limitado**: sin límite verdadero por
  organización/usuario autenticado (mismo pendiente que ronda 1).
- **Auditoría**: `recordAudit` se llama explícitamente dentro de la misma
  transacción de cada mutación relevante (perfil de empresa, tarifas,
  convocatorias ingeridas, decisiones go/no-go, aprobación de tool_calls,
  acciones de back office). `audit_log` mantiene una cadena de hashes
  verificable (`app.verify_audit_log_chain()`, ver `packages/db/README.md`).
- **Almacenamiento de archivos**: disco local (`STORAGE_DIR`) con hash
  sha256, deduplicado por contenido. El contenido llega en base64 dentro
  del cuerpo JSON (no `multipart/form-data`, para no sumar una dependencia
  solo para esto en esta ronda) — límite defensivo ~22MB decodificado.
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
- Re-autenticación (passkey/OTP) específica para aprobaciones económicas
  (REQ-044/REQ-064): la aprobación de tarifas/tool_calls registra
  aprobador y queda en `audit_log`, pero no exige un segundo factor
  adicional en esta ronda.
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
    defecto; el llamador puede pasar `holidays` explícitos, pero no hay una
    lista oficial de feriados mexicanos cableada en esta ronda.
  - **`2FA`/re-autenticación en la aprobación del expediente**: igual que
    el resto de la API (ver punto de aprobaciones económicas arriba), la
    aprobación queda en `audit_log` con el aprobador real, pero no exige un
    segundo factor adicional.

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
