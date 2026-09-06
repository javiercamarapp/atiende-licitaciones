# Atiende Licitaciones

Plataforma de IA de la marca **Atiende** para gestionar el ciclo completo de
participación en **licitaciones públicas en México**: descubrimiento de
convocatorias (ComprasMX/CompraNet y otras fuentes oficiales), matching por
empresa, análisis de bases, armado del expediente de participación (técnico +
económico), checklist de integridad, aprobación por roles y paquete final
listo para que la persona usuaria revise y presente — **nunca envío
automático de ofertas ni firma en nombre del cliente**.

Este repositorio está en construcción activa bajo un ciclo Likida-adaptado
(implementación → pruebas → auditoría adversarial → corrección →
reverificación, todo con evidencia real en `docs/`). No asumas que un módulo
está "terminado" solo porque existe: ver `docs/PROGRESO.md`,
`docs/BLOQUEOS.md` y el estado real de integraciones más abajo.

## Arquitectura del monorepo

npm workspaces (`apps/*`, `packages/*`), TypeScript en todo el código,
Postgres como única base de datos (real en producción/CI, embebido vía
PGlite en desarrollo y tests — mismo motor, mismo SQL).

```
                        ┌──────────────────────────┐
                        │   Fuentes oficiales MX    │
                        │ ComprasMX · DOF · OCDS-   │
                        │ SHCP · PDN S6 · estatales │
                        └────────────┬──────────────┘
                                     │ descubre/normaliza
                                     ▼
                        ┌──────────────────────────┐
                        │   packages/sources        │   librería pura:
                        │   conectores + matching   │   sin DB, sin red
                        │   determinista + versiones│   propia en tests
                        └────────────┬──────────────┘
                                     │ TenderRecord[]
                                     ▼
┌───────────────┐   jobs   ┌──────────────────────────┐   POST /internal/…
│  apps/worker   │◄────────┤  scheduler + handlers     │──────────────┐
│  cola sobre     │  (jobs) │  discover_tenders,        │              │
│  Postgres       │────────►│  run_agent                │              │
└───────┬────────┘          └──────────────────────────┘              │
        │ usa                                                          ▼
        │                                              ┌──────────────────────┐
        ▼                                              │       apps/api        │
┌───────────────┐          ┌──────────────────────┐    │  Fastify + Zod + JWT   │
│ packages/agents│◄─────────┤ librería pura: auth., │   │  RLS por org/rol vía   │
│  runner de      │ contratos│ guardrails, idempot.,│   │  @atiende/db           │
│  agentes de IA  │          │ presupuesto, trazas   │◄──┤  /healthz /readyz      │
└───────────────┘           └──────────────────────┘    │  /metrics (Prometheus) │
                                                          └──────────┬────────────┘
┌────────────────────┐        ┌──────────────────────┐              │
│ packages/expediente │◄───────┤ requisitos, datos de  │              │ persiste
│ requisitos, datos   │        │ empresa, propuesta    │              ▼
│ empresa, propuesta,  │        │ técnica/económica,    │   ┌──────────────────────┐
│ checklist, paquete   │        │ aprobaciones, ZIP     │   │     packages/db       │
│ final (librería pura)│        └──────────────────────┘   │  esquema SQL + RLS +   │
└─────────────────────┘                                     │  runner de migraciones │
                                                             │  (PGlite en tests,     │
        ┌──────────────────────────┐                        │   pg real en prod/CI)  │
        │        apps/web           │◄───────────────────────┴──────────────────────┘
        │  back office (React+Vite) │        REST (VITE_API_URL)
        │  consume apps/api          │
        └──────────────────────────┘
```

| Paquete/app | Rol | Depende de |
|---|---|---|
| `apps/web` | Back office (React 18 + Vite + Tailwind + Radix). Ronda actual: interfaz sola, sin `apps/api` conectado todavía en producción real. | — |
| `apps/api` | API HTTP (Fastify + Zod + JWT + RLS por transacción). Salud/observabilidad, auth, organizaciones. | `@atiende/db`, `@atiende/sources` |
| `apps/worker` | Cola de jobs sobre Postgres: scheduler de descubrimiento, `discover_tenders`, `run_agent`. | `@atiende/db`, `@atiende/agents`, `@atiende/sources` |
| `packages/db` | Esquema SQL multi-tenant con RLS (Row-Level Security) por organización/rol + runner de migraciones (PGlite y `pg`). | — |
| `packages/sources` | Descubrimiento/normalización de convocatorias, matching determinista, detección de cambios. Sin persistencia propia. | — |
| `packages/agents` | Runner de agentes de IA: autorización, guardrails anticorrupción, no-fabricación, idempotencia, presupuesto, trazabilidad. Sin DB. | — |
| `packages/expediente` | Motor del expediente de participación: matriz de requisitos, datos de empresa, propuesta técnica/económica, checklist, aprobaciones, ensamblado del ZIP final. Sin DB. | — |

## Cómo correr cada app

Requiere Node ≥20 (probado con Node 22 en CI, Node 25 en desarrollo) y npm.
No requiere Docker ni Postgres local para desarrollo o pruebas (PGlite corre
embebido en el proceso de Node).

```bash
npm install   # una vez, en la raíz (workspaces)
```

**apps/api**

```bash
cp apps/api/.env.example apps/api/.env   # ajusta al menos JWT_SECRET
npm run -w apps/api dev                  # tsx watch, PGlite en memoria por defecto
```

**apps/worker**

```bash
cp apps/worker/.env.example apps/worker/.env
npm run -w apps/worker dev               # tsx watch, PGlite en memoria por defecto
```

**apps/web**

```bash
cp apps/web/.env.example apps/web/.env   # VITE_API_URL apunta a apps/api
npm run -w apps/web dev                  # servidor de desarrollo, puerto 8080
```

Detalle de arquitectura interna, decisiones de diseño y endpoints de cada
app/paquete: ver el `README.md` de cada uno (`apps/api/README.md`,
`apps/web/README.md`, `apps/worker/README.md`, `packages/*/README.md`).

## Variables de entorno

Cada app trae su propio `.env.example` (nunca commitees un `.env` real —
`.gitignore` ya lo excluye salvo `*.env.example`):

- `apps/api/.env.example` — `PORT`, `JWT_SECRET`, `DATABASE_URL`, `NODE_ENV`,
  `SKIP_MIGRATIONS`, `STORAGE_DIR`, `CORS_ORIGINS`, `PLATFORM_API_KEY`.
- `apps/worker/.env.example` — `DATABASE_URL`, `NODE_ENV`, `SKIP_MIGRATIONS`,
  `WORKER_ID`, `WORKER_POLL_INTERVAL_MS`, `WORKER_LEASE_SECONDS`,
  `WORKER_HEARTBEAT_INTERVAL_MS`, `WORKER_SHUTDOWN_TIMEOUT_MS`, `LOG_LEVEL`,
  `WORKER_SCHEDULE_JSON`, `API_BASE_URL`, `PLATFORM_API_KEY`,
  `OPENAI_API_KEY` (opcional, ver estado de integraciones abajo).
- `apps/web/.env.example` — `VITE_API_URL`.

`DATABASE_URL` es el mismo formato en `apps/api` y `apps/worker` (ver
`packages/db/README.md`): vacío o `pglite://memory` (PGlite en memoria,
por defecto), `pglite:///ruta` (PGlite con persistencia en disco), o
`postgres://usuario:password@host:5432/basededatos` (Postgres real).

## Cómo correr las pruebas

Por workspace (ninguna requiere Postgres real ni Docker; PGlite embebido):

```bash
npm run -w apps/api test
npm run -w apps/web test              # o test:coverage
npm run -w apps/worker test
npm run -w packages/db test
npm run -w packages/agents test:coverage
npm run -w packages/expediente test
npm run -w packages/sources test:coverage
```

E2E real de `apps/web` (Playwright + axe-core, navegador real):

```bash
npm run -w apps/web test:e2e
```

Todo el workspace a la vez (equivalente a lo que corre en CI, salvo el job
`db-postgres` que necesita un servicio Postgres real):

```bash
bash scripts/ci-local.sh          # ver también: npm run ci:local
bash scripts/ci-local.sh --e2e    # incluye Playwright
bash scripts/check-secrets.sh     # grep de patrones de secretos filtrados
```

`scripts/ci-local.sh` guarda toda su salida en `docs/logs/ci-local.log` y
**registra los fallos reales, no los oculta** — incluye el resultado
completo de la última corrida real (ver ese archivo).

CI real (GitHub Actions): `.github/workflows/quality.yml` — typecheck/lint/
test(+cobertura donde existe)/build por workspace, un job `db-postgres`
dedicado que aplica TODAS las migraciones de `packages/db` una a una contra
un Postgres 16 real de servicio y ejecuta ataques RLS dinámicos, un job
`e2e-web` (Playwright), `npm audit --omit=dev --audit-level=high` y el grep
de secretos, con artefactos de cobertura/reportes subidos y
`concurrency: cancel-in-progress`.

## Estado real de integraciones (no inflar)

| Integración | Estado | Evidencia |
|---|---|---|
| **ComprasMX / CompraNet** (fuente oficial de convocatorias) | **BLOQUEADO** — API real localizada, pero protegida por reCAPTCHA (401/403 reales capturados). Sin intento de evasión. | `docs/BLOQUEOS.md` B-02, `packages/sources/README.md` |
| **DOF** | Parcialmente verificado (dominio y patrón de URLs reales; formato exacto de convocatorias no confirmado en la ventana de prueba). | `packages/sources/README.md` |
| **OCDS-SHCP / PDN Sistema 6 / portales estatales** | No verificado en vivo (host inalcanzable, bot-detection, o sin API localizable). | `packages/sources/README.md` |
| **CSV histórico ComprasMX (SABG, datos.gob.mx)** | Verificado 100% en vivo; único conector con integración real ejercitada de punta a punta. | `packages/sources/README.md` |
| **OpenAI (`OPENAI_API_KEY`)** | Pendiente de credenciales de producción. `apps/worker` usa `FakeProvider` determinista si la variable no está definida; el código de `OpenAIResponsesProvider` existe en `packages/agents` pero **no se ha ejercitado contra la API real**. | `apps/worker/.env.example`, `apps/worker/README.md` |
| **Postgres real** | Solo se ejercita en el job `db-postgres` de CI (servicio Postgres 16) y en producción. Desarrollo y todas las suites de test usan PGlite (mismo motor Postgres compilado a WASM, mismo SQL). | `.github/workflows/quality.yml`, `packages/db/README.md` |
| **WhatsApp** (interfaz de trabajo primaria, REQ-090) | No implementado en este alcance. | `docs/REQUISITOS.md` secc. 21 |

## Documentación

- `docs/REQUISITOS.md` — requisitos verificables (REQ-001 en adelante), con
  fuente, tipo, prioridad y criterio de verificación por fila.
- `docs/ACEPTACION.md` — criterios de aceptación / pruebas de cierre.
- `docs/AMPLIACION-BACKOFFICE.md` — alcance del ciclo completo de back
  office (flujo de 8 pasos, reglas duras de no-fabricación/no-actuación).
- `docs/BACKLOG.md` — orden de trabajo.
- `docs/PROGRESO.md` — bitácora real de cada ronda (qué se hizo, con qué
  commit, con qué resultado de pruebas).
- `docs/BLOQUEOS.md` — bloqueos externos reales (ComprasMX/B-02, ubicación
  de carpeta/B-01) con intentos documentados.
- `docs/DECISIONES.md` — decisiones de arquitectura/producto tomadas.
- `docs/AGENTES.md` — registro de qué agente hizo qué.
- `docs/auditoria-N/` — hallazgos de auditoría adversarial, un archivo por
  rubro, separado de su corrección.
- `docs/operacion-bucle.md` — cómo está orquestado el ciclo de construcción
  autónomo de este repositorio (bucle, cron de respaldo, modelos usados).
- `docs/OPERACION.md` — runbook operativo (despliegue, migraciones,
  variables, healthchecks, logs, jobs/reintentos/dead-letter, rotación de
  secretos, respaldo/restauración, incidentes, límites conocidos).
- `docs/investigacion/` — investigación de arquitectura de referencia
  (incluye `likida-arquitectura.md`, patrón de CI adaptado en este repo).
- `docs/legal/` — verificación puntual del marco legal de contratación
  pública en México aplicable al producto.

## Alcance y reglas duras (no negociables)

- Nunca se inventa un dato, precio, certificación, experiencia o firma: todo
  valor sensible requiere `source_ref`/aprobación explícita; si falta, el
  estado es `missing`/`blocked`/`PENDIENTE`, nunca un valor plausible.
- Nunca se envía una oferta, se firma en nombre de un cliente, ni se actúa
  en un portal oficial sin autorización específica de la persona usuaria.
- Aislamiento estricto multi-tenant vía RLS en Postgres (no solo filtrado en
  la capa de aplicación) — ver `packages/db/README.md`.
- Ver `docs/REQUISITOS.md` secc. 33 y `docs/AMPLIACION-BACKOFFICE.md` para
  el listado completo de reglas duras.
