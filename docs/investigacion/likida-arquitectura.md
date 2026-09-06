# Arquitectura de Likida — investigación para Atiende Licitaciones

Solo lectura. Sin ejecutar scripts de Likida, sin copiar secretos.

## 0. Copia de referencia

Comparadas 5 copias (`git log -1`, `git remote -v`, `docs/auditoria-N` más alta):

| Copia | Remoto | Último commit | Auditoría |
|---|---|---|---|
| `2026-08-23/.../audit-likida` | `likida.ai` | 24-ago 09:26 | 18 |
| `.../.worktrees/likida-sql-ci-133e384` | `likida.ai` | 24-ago 07:46 | 18 (idéntica) |
| `2026-08-21/.../work/likida-ai` | `likida.ai` | 21-ago 12:01 | ninguna |
| `2026-08-30/haz-x20/work/repo` | `proyect-x-` | **30-ago 23:18** | **22** |
| Google Drive `likida-ai-enterprise-main` | no es git | archivos ago-2026 | — |

El worktree y `work/likida-ai` son ancestros directos de `audit-likida`. La
copia de Drive no tiene `.git`, se descarta. **`2026-08-30/haz-x20/work/repo`**,
pese al remoto distinto (`proyect-x-`), es el mismo producto — `README.md`
dice "# Likida", `package.json` tiene `"name": "likida"`, su primer commit
(24-jul) muestra que se llamó "Cuadra" antes de renombrarse (migración de
repo). Tiene 1,478 commits (vs. ~1,300 de `audit-likida`), llega a auditoría
22 (vs. 18) y es 6 días más reciente.

**Recomendación: usar `2026-08-30/haz-x20/work/repo` como referencia** (todo
lo que sigue está investigado ahí).

## 1. El bucle de auditoría diaria (`.claude/skills/auditoria-diaria/`)

`SKILL.md`, `references/{desatendido,auditor-prompt,rubros,tablero}.md`.

**Seis fases**: (0) Anclaje — lee `docs/auditoria-<N-1>/00-SINTESIS.md`, corre
`npm test`/`tsc --noEmit`/`lint`/`build` como línea base real, crea
`docs/auditoria-N/`. Si `git status` no está limpio, corre igual pero sin
autofix. (1) **Doce auditores en paralelo, un mensaje, contexto fresco** —
uno por rubro, prompt exacto en `references/auditor-prompt.md`; **prohibido
proponer arreglo** ("un auditor que arregla deja de buscar"); cada uno
escribe **un solo archivo** `docs/auditoria-N/<rubro>.md`. Un hallazgo exige
`archivo:línea` + escenario "entra X → sale Y mal" con valores + severidad, o
no cuenta. (2) Verificación adversarial — el orquestador abre cada hallazgo y
lo confirma; falsos van a "descartados" con razón. (3) Tablero —
`docs/auditoria-N/tablero.html` autocontenido, se abre y **se mira**
(headless + captura `tablero.png`; "un tablero que nunca se renderizó no es
evidencia"). (4) Arreglo de críticos/altos **uno a la vez, en serie**: prueba
que reproduce → arreglo → prueba verde → suite completa → commit atómico; si
la suite se pone roja se revierte y el hallazgo vuelve a `pendiente`. (5)
Recalificación — `00-SINTESIS.md` con las 12 notas, cada movimiento con una
de tres razones obligatorias (*se atacó y subió* / *deuda que cobró factura*
/ *mirada más profunda*), nunca una nota que se mueve sin razón escrita.

**Persistencia/reanudación** (`references/desatendido.md`): el estado vive en
`docs/auditoria-N/` en disco, no en la conversación; `progreso.md` se escribe
**mientras avanza** (una línea por acción, con sha) — si truena a media
ronda, se listan los archivos de rubro que ya existen (no se relanzan) y se
lee `progreso.md` para continuar. **Condición de terminación** verificable
con comandos: existen los 12 archivos + `00-SINTESIS.md` + `tablero.html`/
`.png`, cada crítico/alto en uno de tres estados finales, `npm test`/`tsc`
en verde, commits pusheados. **Presupuesto**: tope duro de 3 vueltas de
arreglo por ronda, un commit por arreglo, máximo un rubro reauditado por
ronda. En la nube: sin `npm run build` en la compuerta, arreglos van a
rama+PR (nunca a `master`), la skill viaja versionada en el repo.

**Rubros** (`references/rubros.md`, 12): frontend, backend/API, agéntico,
tool calling, seguridad, fiscal, legal, arquitectura, pruebas,
operabilidad/DX, rendimiento/costo, modelo de datos. Escala 0–10, 5="camino
feliz funciona, bordes son fe", 8+ exige pruebas/restricciones.

**Formato real** (`docs/auditoria-22/`, 30-ago): `00-SINTESIS.md`, `MAPA.md`,
`RESULTADO.md`, `progreso.md`, `tablero.html`+`.png`, un `.md` por rubro —
6.1 global, 10 CRÍTICOS + 24 ALTOS, **los 34 arreglados** en 13 commits
atómicos, compuerta final 9,995 pruebas en verde.

### Bucle complementario: "mejora diaria" (`scripts/mejora-diaria/`)

`ESQUELETO-AUTONOMIA.md`, `correr.sh`, `auditor.mjs`. Cron `launchd` 05:30:
(1) `auditor.mjs` — modelo barato (OpenRouter, `gpt-oss-120b`) lee **un área
del repo por día de la semana** (rotación fija) y produce hallazgos,
deduplicados contra `.mejora-diaria/registro.jsonl`. (2) `correr.sh` pasa
cada hallazgo a `claude -p` (la **suscripción**, no la API) en un **worktree
git aislado** (`../likida-mejoras`), con encargo: verificar el hallazgo
leyendo código real → si falso, `VEREDICTO: DESCARTADO` sin tocar nada → si
real, arreglo mínimo + prueba → `tsc`/`vitest` del área en verde o revertir →
auto-revisión adversarial del diff → commit local, sin push, `VEREDICTO:
ARREGLADO`. (3) Si arreglado: push a rama `mejora/<fecha>-<slug>` + `gh pr
create` — **PR, jamás merge directo**. Candados: `touch
.mejora-diaria/APAGADO` (kill switch de todas las rutinas), `MEJORA_TOPE_DIA`
(default 3, cuenta corridas no PRs), `--max-turns 60`.

`ESQUELETO-AUTONOMIA.md` cataloga ~25 rutinas más (diarias/semanales/
mensuales: vigilancia normativa DOF, brief de mando por WhatsApp, guardia de
producción cada 2h, auto-mejora semanal que edita *encargos* de otras
rutinas por PR, etc.). Regla que atraviesa todo: **"la IA prepara, el humano
aprueba"** — cada loop termina en PR, cola de aprobación o reporte; ninguno
publica/mergea/manda nada solo.

## 2. Multi-tenant, RLS y roles

Sin ORM: `@supabase/supabase-js` directo. Dos clientes en
`src/lib/supabase/`: `server.ts` (SSR por cookies, respeta RLS) y `admin.ts`
(`supabaseAdmin()`, service-role, **salta RLS** — el filtro `tenant_id` hay
que reimponerlo a mano en cada consulta). Migraciones SQL planas en
`supabase/migrations/` (255 archivos, `NNNN_descripcion.sql`).

**RLS real**, fundada en `supabase/migrations/0001_init.sql` (comentario:
*"Multi-tenant con RLS (patrón atiende endurecido). El aislamiento vive en
Postgres, no en el código."*). Dos funciones `SECURITY DEFINER`:
`get_user_tenant_ids()` (**nunca retorna NULL** —
`coalesce(array_agg(...) filter (...), array[]::uuid[])` — evita el bypass
típico de RLS por NULL) e `is_superadmin()`. Una **policy uniforme aplicada
por bucle `do $$...$$`** sobre el array de tablas tenant-scoped, no copiada a
mano por tabla: `using (tenant_id = any(get_user_tenant_ids()) or
is_superadmin())`.

**Modelo de datos**: tabla `tenant` (id, nombre, rfc, plan). `app_user`
(`id` = `auth.users.id`, `tenant_id` **nullable** = superadmin, `email`,
`rol` con dominio impuesto por `CHECK` — evoluciona por migración:
`0025_dominios_check.sql`, `0044_rol_encargado.sql`,
`0086_retirar_rol_operador.sql`, `0105_zona_vendedores.sql` agrega
`vendedor` con `tenant_id` null). `invitacion` (alta controlada, nunca
insert directo de `app_user`; `token_hash`, nunca el token en claro;
`0053_cuentas_bitacora_arco_campanias.sql`).

**Superadmin/back office**: guard `requireSuperadmin()` en
`src/lib/auth/guard.ts`, invocado **una sola vez** en
`src/app/admin/layout.tsx` (gatea el layout entero de `/admin`). **Doble
capa independiente**: capa 1 = `src/proxy.ts` (gate de sesión + CSP, el
equivalente a middleware aquí), capa 2 = `requireSuperadmin` en el layout —
"las dos tienen que fallar a la vez" para exponer datos. Función cross-tenant
única: `src/lib/admin/negocio.ts` (agrega vía RPCs `resumen_costo_ia()`/
`resumen_negocio()`, no trae filas). `/admin` tiene ~50 subcarpetas (mucho
más que "costo de IA, flotas, agentes": incluye `flotas/`, `cobranza/`,
`analitica/`, `compliance/`, `qa/`, `elegir-flota/` — selector de tenant).

## 3. Registro de tools, autorización, idempotencia, colas

**Dos registros de tools**: (1) `src/lib/llm/tool-executor.ts` — `Map` con
`registerTool(name, {schema, handler, isMutation?})`, schema JSON plano
(`src/lib/likida/tools.ts`, `src/lib/agents/chat-tools.ts`,
`copiloto-tools.ts` con allowlist cross-tenant explícito). (2)
`src/lib/mcp/herramientas.ts` — array `CATALOGO`, cada tool con
`esquema: z.ZodType<T>` validado con `safeParse` en `despacharHerramienta()`.

**Autorización**: tools del LLM reciben `ToolContext` con `tenantId`
inyectado por el servidor — el modelo decide *cuándo*, nunca *con qué
datos* (`properties: {}` vacías a propósito, cierra la inyección de prompt
estructuralmente). MCP exige `alcanza(h.area)` antes de ejecutar
(`src/lib/auth/visibilidad.ts`); el tenant sale solo de la credencial
(`src/lib/mcp/credencial.ts`).

**Idempotencia (lease/fencing en Postgres, no en memoria)**:
`src/lib/llm/tool-idempotency.ts`, RPCs `claim_agente_mutacion`/
`renew_agente_mutacion`/`complete_agente_mutacion`/`fail_agente_mutacion`
con reloj autoritativo en la DB. Tabla `agente_mutacion_idempotencia`
(`0186_runtime_idempotencia_y_presupuesto.sql`): `unique(tenant_id,
effect_key)`, `status`, `lease_until`; la llave del efecto incluye el
`runId` y el executor **rechaza fail-closed** una tool `isMutation` sin él.
Mutación en curso → "reintenta en un minuto", nunca doble ejecución.
**Reintentos/fallback de proveedor** (nivel LLM, no tool): `isTransientError()`
+ mapa `FALLBACK` en `src/lib/llm/openrouter.ts`, con `PartialExecutionError`
para que un fallback nunca re-ejecute una mutación ya corrida.

**Presupuesto/ledger por tenant**: tabla `llm_presupuesto_reserva` (misma
0186) con `reservado_usd`/`costo_real_usd`/`estado` y RPCs
`reservar_presupuesto_llm`/`liquidar_presupuesto_llm` bajo
`pg_advisory_xact_lock` por tenant; `src/lib/llm/budget.ts`
(`createLlmBudget`, propósitos `interactivo`/`ocr_lote`/`fondo`).

**Colas/rate limit**: `@upstash/qstash` para trabajo diferido
(`/api/cron/wa-pendientes`, `/api/cron/facturar`); `src/lib/ratelimit.ts`
(Redis Upstash + Lua atómico, fallback a `Map` en memoria), aplicado en
`/api/mcp` por IP y por flota.

**Trazabilidad**: `agente_corrida` (`0102_agente_corrida.sql`) — una fila
por corrida: `tenant_id` **nullable** (null = corrida de plataforma),
`agente`, `estado`, `disparo`, `tareas_hechas/total`, `resumen jsonb`,
`error`, `costo_usd`; escritor `corridas.ts::registrarCorrida` con la regla
**"registrar JAMÁS lanza"** (un fallo de bitácora nunca tumba el trabajo
real). `agente_definicion` (`0116...sql`) es el catálogo declarativo de
~60 agentes de negocio. `bitacora_auditoria` (`0053...sql`, endurecida en
`0195_bitacora_auditoria_sin_insercion_directa.sql` para que **nada** pueda
insertar salvo su único escritor, `bitacora_escritura.ts`) es la bitácora
genérica de "quién hizo qué"; MCP anota ahí cada `tools/call` (y
`evento_seguridad` para los intentos negados por área).

## 4. Pruebas adversariales de RLS (multi-tenant) y CI

`.github/workflows/ci-postgres.yml` — job dedicado, Postgres 16 como
servicio (contenedor real, no mock de `supabase-js`), demuestra **dos capas
por separado**: (1) RLS real — `supabase/verificaciones.sql` (~88 bloques
`do $$...end$$`, siembran dos tenants A/B, `SET LOCAL ROLE authenticated` +
`SET LOCAL request.jwt.claims` simulando PostgREST, intentan que B lea/
escriba datos de A y esperan 0 filas o rechazo; cada bloque compara contra
un `(esperado ...)` declarado) + `supabase/pruebas-aislamiento/capa1_auditoria_estatica.sql`
(auditoría *schema-driven*: una tabla/vista nueva sin RLS se detecta sola,
sin mantenimiento manual). (2) Filtro de aplicación en consultas
service-role — probado **sin base de datos**, como escaneo estático de
fuente, en `supabase/pruebas-aislamiento/consultas_admin_filtran_tenant.test.ts`
(corre en `ci.yml`, no en `ci-postgres.yml`): exige que todo `.from(...)`
sobre `supabaseAdmin` mencione `tenant_id`, salvo un allowlist con razón
documentada. Las 255 migraciones se aplican **una por una** sobre base
virgen (`andamio_ci.sql` recrea roles/`auth.uid()`/storage mínimo antes).
Motivo de existencia del job: `verificaciones.sql` tenía ~88 bloques que
**nadie corría en CI** — se pegaban a mano en el SQL editor; la primera
corrida automática encontró 4 rotos hacía semanas.

**CI general** (`.github/workflows/ci.yml`, dispara en `push: ['**']`, no
solo `master`, por el trabajo autónomo en ramas `claude/*`): audit
bloqueante (runtime) → typecheck → `lint:ratchet` (no permite subir warnings
vs. baseline) → tests → `test:coverage` → `build` → smoke Playwright sin
secretos. `pruebas-manuales/*.prueba.ts` (llamadas reales de pago) **nunca**
corren en CI ni en automatizaciones.

## 5. Patrones a adaptar para Licitaciones (sin marca Likida)

**Stack**: Next.js App Router + Server Actions/route handlers; Postgres
(Supabase o equivalente) con **RLS como mecanismo primario** de aislamiento,
nunca solo filtrado en aplicación; dos clientes (uno de sesión que respeta
RLS, uno admin/service-role solo para agregaciones y trabajos de fondo, con
prueba estática que verifique que todo uso admin filtra tenant a mano); sin
ORM, SQL plano numerado aplicado uno por uno en CI sobre Postgres efímero;
Vitest (config separada para suite normal-con-cobertura vs. arneses caros
que nunca corren en CI) + Playwright; logger propio con redacción de PII +
Sentry server-only, ambos con prueba de que están cableados.

**Esquema base**:

```sql
create table organizations (
  id uuid primary key default gen_random_uuid(), nombre text not null,
  plan text not null default 'trial', created_at timestamptz not null default now());

create table memberships (              -- usuario + rol en una org
  id uuid primary key,                                -- = auth.users.id
  organization_id uuid references organizations(id) on delete cascade, -- null=superadmin/staff
  email text not null, rol text not null,             -- CHECK versionado por migración
  created_at timestamptz not null default now(), unique (organization_id, email));
alter table memberships add constraint memberships_rol_dominio
  check (rol in ('superadmin','org_admin','analista','lector'));

create table invitations (              -- alta controlada, nunca insert directo en memberships
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null, rol text not null, token_hash text not null,  -- nunca el token en claro
  expira_en timestamptz not null, aceptada_en timestamptz, revocada_en timestamptz);

create table audit_log (                -- bitácora genérica, un solo escritor en código
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id),  -- null = acción de plataforma
  actor_type text not null, actor_id text not null,    -- 'user'|'agent'|'system'
  accion text not null, entidad text, entidad_id text, detalle jsonb,
  created_at timestamptz not null default now());

create table agent_runs (               -- una fila por ejecución de agente
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,                                -- null = corrida de plataforma
  agent_name text not null, disparo text not null,     -- 'cron'|'manual'|'webhook'|'evento'
  estado text not null default 'en_curso',             -- 'ok'|'parcial'|'fallo'|'en_curso'
  inicio timestamptz not null default now(), fin timestamptz,
  tareas_hechas int, tareas_total int, costo_usd numeric,
  resumen jsonb, error text);                          -- resumen SIN datos personales

create table tool_calls (               -- trazabilidad fina dentro de una corrida
  id uuid primary key default gen_random_uuid(),
  agent_run_id uuid not null references agent_runs(id) on delete cascade,
  tool_name text not null, run_id text not null,       -- idempotency key
  args jsonb, resultado jsonb, estado text not null,   -- 'ok'|'error'|'descartado'
  created_at timestamptz not null default now(), unique (tool_name, run_id));

create table jobs (                     -- cola de trabajos de fondo
  id uuid primary key default gen_random_uuid(), organization_id uuid, tipo text not null,
  estado text not null default 'pendiente',            -- 'pendiente'|'en_curso'|'ok'|'fallo'
  intentos int not null default 0, disponible_en timestamptz not null default now(),
  payload jsonb, resultado jsonb, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
```

**Reglas de diseño a copiar, no solo el esquema**:

1. RLS con función `SECURITY DEFINER` que **nunca retorna NULL**
   (`coalesce(..., array[]::uuid[])`) — evita "acceso sin filtro" por NULL.
2. Una policy uniforme aplicada por bucle a todas las tablas tenant-scoped,
   no copiada a mano tabla por tabla.
3. Doble capa de autorización independiente para rutas privilegiadas
   (proxy/middleware de sesión + guard en el layout del segmento), ambas
   deben fallar a la vez para exponer datos.
4. Las tool definitions del agente nunca exponen parámetros que decidan
   sobre el tenant o el dinero — el contexto sale siempre del servidor.
5. `agent_runs`/`tool_calls` con `organization_id` nullable desde el diseño
   — permite agentes de "plataforma" sin forzar un tenant ficticio.
6. Idempotencia con `unique (tool_name, run_id)` en base, no solo en
   memoria — sobrevive a reintentos del proceso completo.
7. "Registrar nunca debe lanzar": escribir en `audit_log`/`agent_runs` jamás
   tumba el trabajo real que se está registrando.
8. Pruebas de aislamiento contra Postgres real en CI (no mocks): aplicar
   todas las migraciones sobre base efímera + ataques dinámicos con `SET
   LOCAL ROLE`/`request.jwt.claims` + auditoría estática *schema-driven*.
9. Separar "encontrar" de "reparar" en cualquier bucle de mejora automática:
   un agente audita con evidencia verificable (archivo:línea + escenario),
   nunca repara; otro, en otra fase y en serie, repara con
   prueba-antes-que-arreglo y puede revertir sin arrastrar otros cambios.
   Todo termina en PR con aprobación humana, nunca en push directo.
