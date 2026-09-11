<p align="center">
  <img src="docs/brand/atiende-wordmark.svg" width="240" alt="atiende" />
</p>

<h3 align="center">El agente de IA que vigila las licitaciones públicas de México y arma el expediente antes de que se cierre el plazo.</h3>

<p align="center">
  <a href="https://atiende-licitaciones.vercel.app">Demo en vivo</a> ·
  <a href="docs/BLOQUEOS.md">Estado real y bloqueos</a> ·
  <a href="docs/REQUISITOS.md">Requisitos verificables</a>
</p>

---

> *Una empresa no pierde una licitación por no calificar. La pierde porque se
> enteró tarde: la convocatoria salió hace ocho días, la junta de
> aclaraciones ya pasó, y el expediente técnico se arma la noche anterior a
> mano, en Excel y PDFs sueltos.*

**Atiende Licitaciones vigila los portales oficiales, arma el expediente con
los datos que la empresa ya tiene aprobados, y nunca envía una oferta ni
firma nada en su nombre.**

---

## El problema

Participar en compras de gobierno en México significa competir contra el
reloj tanto como contra otros proveedores. Cada convocatoria trae sus
propios plazos de aclaraciones, su propia junta, su propio formato de
requisitos técnicos y económicos — y hoy esa vigilancia la hace una persona
revisando portales a mano, con la información dispersa entre PDFs de bases,
carpetas de documentos vigentes de la empresa (actas, poderes, opinión de
cumplimiento del SAT, experiencia) y hojas de cálculo para la propuesta
económica. Un documento vencido, un plazo mal leído o una versión de bases
que cambió sin que nadie lo notara cuesta la licitación completa, no un
descuento en el puntaje.

## Mercado

Sin inventar un tamaño de mercado: estas son las únicas cifras que
encontramos con fuente citable y verificable.

Según [IMCO](https://imco.org.mx/compras-publicas-una-mirada-al-cierre-del-sexenio/),
entre 2018 y 2024 el gobierno federal mexicano destinó **2.6 billones de
pesos** a compras públicas; solo en 2023, las instituciones de la
Administración Pública Federal contrataron **702 mil millones de pesos**
(8% del Presupuesto de Egresos de la Federación). El mismo análisis
documenta que, desde 2020, varias instituciones adjudican directamente más
del 90% de ese monto en vez de licitar en público — un proceso donde la
información se dispersa entre miles de convocatorias, plazos y portales, y
donde monitorear a tiempo es, en sí mismo, una ventaja competitiva. No
construimos un TAM/SAM/SOM propio a partir de esto: haría falta el número
de empresas activas como licitantes en la Plataforma Digital de
Contrataciones Públicas (antes CompraNet), y esa cifra no está publicada en
ninguna fuente que hayamos podido verificar.

## Qué hace hoy

Lo que sigue está basado en el código real de este repositorio, no en un
plan. Cada punto indica si está construido y probado, o si depende de un
acceso/decisión pendiente — ver `docs/BLOQUEOS.md` para el detalle completo.

- **Motor de descubrimiento** (`packages/sources`): conectores para
  ComprasMX, DOF, OCDS-SHCP/PDN Sistema 6 y portales estatales, con
  deduplicación, versionado (detecta qué cambió entre una revisión y otra:
  bases, plazos, anexos, estatus) y un estado de salud explícito por fuente
  (`ok`/`down`/`captcha_detected`/`interface_changed`/...) para que un
  silencio nunca se lea como "cero oportunidades nuevas". **El único
  conector con datos reales verificados de punta a punta hoy es el histórico
  CSV de ComprasMX** (SABG, vía datos.gob.mx). Las convocatorias vigentes de
  ComprasMX están bloqueadas por reCAPTCHA en el endpoint oficial (401/403
  reales, capturados y documentados) — es una limitación de acceso a datos,
  no un error del código, y el proyecto no intenta evadirla.
- **Matching determinista**: perfil de empresa (giro, palabras clave,
  presupuesto, cobertura geográfica) contra cada convocatoria, con un score
  de relevancia explicado por criterio y una elegibilidad dura separada
  (`cumple`/`no_cumple`/`no_evaluable`) — sin LLM en la decisión.
- **Motor del expediente** (`packages/expediente`): extrae la matriz de
  requisitos de las bases, resuelve los datos de la empresa contra lo que
  tiene aprobado y vigente (un dato ausente o vencido queda `missing` o
  `blocked`, nunca se rellena), genera propuesta técnica con trazabilidad a
  su fuente y propuesta económica 100% determinista (aritmética en
  centavos), corre un checklist de integridad de 7 dimensiones, exige
  aprobación por rol antes de considerarse listo, y arma el ZIP final con un
  manifiesto verificable.
- **Runner de agentes de IA** (`packages/agents`): autorización, guardrails
  anticorrupción, no-fabricación, presupuesto e idempotencia por
  organización. Hoy corre en desarrollo/CI con un proveedor simulado
  (`FakeProvider`, determinista, sin red) porque no hay credenciales de
  producción de OpenAI; el conector real existe en el código pero no se ha
  ejercitado contra la API real.
- **Back office** (`apps/web`, React + Vite): conectado a `apps/api` real,
  sin datos de ejemplo en producción — toda pantalla sin endpoint real
  detrás lo dice explícitamente en vez de simularlo.
- **Multi-tenant real**: aislamiento por organización vía Row-Level Security
  en Postgres, no solo un filtro en la capa de aplicación.
- **Reglas duras que el código no rompe**: nunca se envía una oferta, se
  firma en nombre de un cliente o se actúa en un portal oficial sin
  autorización explícita de la persona usuaria; ningún dato sensible se
  inventa — sin fuente, queda `missing`/`blocked`/`PENDIENTE`.

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

## Stack

| Para | Qué |
|---|---|
| API | Fastify 5 + Zod + JWT (jose) + `@fastify/{cors,helmet,rate-limit,swagger}` · TypeScript |
| Web | React 18 + Vite 6 + TypeScript · Tailwind + Radix UI · TanStack Query · React Hook Form + Zod |
| Worker | Node + pino, cola de jobs propia sobre Postgres (sin cola externa) |
| Datos | Postgres con Row-Level Security por organización/rol · PGlite (mismo motor, WASM) en desarrollo y tests · runner de migraciones propio |
| Documentos | `jszip`, `pdfjs-dist`/`pdf-lib` (expediente y extracción de texto) |
| IA | Runner de agentes propio (`packages/agents`) sobre la Responses API de OpenAI — hoy sin credenciales de producción, corre con un proveedor simulado |
| Pruebas | Vitest por workspace (con cobertura donde aplica) · Playwright + axe-core para e2e/accesibilidad de `apps/web` |
| CI | GitHub Actions (`quality.yml`): typecheck/lint/test/build por workspace, Postgres 16 real de servicio, e2e, `npm audit`, grep de secretos |
| Hosting | Vercel (frontend) · backend gestionado (Supabase + Vercel serverless) en curso, ver Estado |

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

## Estado

Honesto, sin inflar. El detalle completo, con evidencia y fecha, vive en
`docs/BLOQUEOS.md`.

| Integración | Estado | Evidencia |
|---|---|---|
| **ComprasMX / CompraNet** (fuente oficial de convocatorias vigentes) | **Bloqueado** — API real localizada, protegida por reCAPTCHA (401/403 reales capturados). Sin intento de evasión: es una decisión de producto, no un límite técnico que falte resolver en código. | `docs/BLOQUEOS.md` B-02, `packages/sources/README.md` |
| **CSV histórico de ComprasMX** (SABG, datos.gob.mx) | Verificado 100% en vivo — único conector con integración real ejercitada de punta a punta. | `packages/sources/README.md` |
| **DOF** | Parcialmente verificado (dominio y patrón de URLs reales; formato exacto de convocatorias no confirmado en la ventana de prueba). | `packages/sources/README.md` |
| **OCDS-SHCP / PDN Sistema 6 / portales estatales** | No verificado en vivo (host inalcanzable, bot-detection, o sin API localizable). | `packages/sources/README.md` |
| **Backend en producción** | En curso — el frontend está desplegado en Vercel; API/worker/Postgres gestionado (Supabase) están en integración, no en producción todavía. | `docs/BLOQUEOS.md` B-08, `docs/despliegue-supabase-vercel.md` |
| **OpenAI (`OPENAI_API_KEY`)** | Pendiente de credenciales de producción — el código del proveedor real existe y está probado con un simulador determinista, pero no se ha ejercitado contra la API real. | `apps/worker/.env.example`, `apps/worker/README.md` |
| **Modelo comercial** | Sin decidir — B2B directo vs. self-serve determina si se construyen precios, checkout y trial. | `docs/BLOQUEOS.md` B-04 |
| **WhatsApp** (interfaz de trabajo primaria, REQ-090) | No implementado en este alcance. | `docs/REQUISITOS.md` secc. 21 |

En resumen: el motor de expediente, el matching y el multi-tenant están
construidos y cubiertos por pruebas automatizadas que corren contra
Postgres real en CI. Lo que falta depende de accesos y decisiones externas
(acceso oficial a la fuente de datos, modelo comercial, credenciales de
producción), no de trabajo de ingeniería pendiente sin identificar.

## Documentación

- `docs/REQUISITOS.md` — requisitos verificables (REQ-001 en adelante), con
  fuente, tipo, prioridad y criterio de verificación por fila.
- `docs/ACEPTACION.md` — criterios de aceptación / pruebas de cierre.
- `docs/AMPLIACION-BACKOFFICE.md` — alcance del ciclo completo de back
  office (flujo de 8 pasos, reglas duras de no-fabricación/no-actuación).
- `docs/BACKLOG.md` — orden de trabajo.
- `docs/PROGRESO.md` — bitácora real de cada ronda (qué se hizo, con qué
  commit, con qué resultado de pruebas).
- `docs/BLOQUEOS.md` — bloqueos externos reales (ComprasMX/B-02, modelo
  comercial/B-04, backend en producción/B-08) con intentos documentados.
- `docs/DECISIONES.md` — decisiones de arquitectura/producto tomadas.
- `docs/AGENTES.md` — registro de qué agente hizo qué.
- `docs/auditoria-N/` — hallazgos de auditoría adversarial, un archivo por
  rubro, separado de su corrección.
- `docs/operacion-bucle.md` — cómo está orquestado el ciclo de construcción
  autónomo de este repositorio (bucle, cron de respaldo, modelos usados).
- `docs/OPERACION.md` — runbook operativo (despliegue, migraciones,
  variables, healthchecks, logs, jobs/reintentos/dead-letter, rotación de
  secretos, respaldo/restauración, incidentes, límites conocidos).
- `docs/despliegue-supabase-vercel.md` — estado real del despliegue
  serverless (Supabase + Vercel), qué está hecho y qué falta.
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

---

<p align="center">
  <sub>Una vertical de <b>atiende.ai</b> · agentes de IA para empresas que
  participan en compras de gobierno en México.</sub>
</p>
