# Arquitectura de Likida — investigación para Atiende Licitaciones

Investigación de solo lectura sobre el repo de Likida (SaaS de liquidación de
viajes de flotas de carga en México, por WhatsApp) para extraer patrones de
back office, superadmin, agentes/automatizaciones y bucle de mejora continua,
adaptables a Atiende Licitaciones. No se ejecutó ningún script contra
servicios de Likida ni se copiaron secretos.

## 0. Qué copia es la de referencia

Se compararon cinco copias locales candidatas:

| Copia | Remoto git | Último commit | Rama | Auditoría más alta |
|---|---|---|---|---|
| `2026-08-23/.../audit-likida` | `github.com/javiercamarapp/likida.ai` | `3f98a961` — 2026-08-24 09:26 | `release/audit-likida-133e384` | `docs/auditoria-18` |
| `2026-08-23/.../.worktrees/likida-sql-ci-133e384` | `github.com/javiercamarapp/likida.ai` | `87a9dfb8` — 2026-08-24 07:46 | `fix/sql-ci-clock-133e384` | `docs/auditoria-18` (idéntico al de audit-likida) |
| `2026-08-21/.../work/likida-ai` | `github.com/javiercamarapp/likida.ai` | `a3aa882d` — 2026-08-21 12:01 | `master` | ninguna (sin `docs/auditoria-*`) |
| `2026-08-30/haz-x20/work/repo` | `github.com/javiercamarapp/proyect-x-` | `6f3d61f7` — 2026-08-30 23:18 | `master` | `docs/auditoria-22` |
| Google Drive `likida-ai-enterprise-main` | no es repo git | archivos fechados 2 y 11-ago-2026 | — | — |

Hallazgos de la comparación:

- El worktree `fix/sql-ci-clock-133e384` es un ancestro directo de `audit-likida`
  (su único commit propio, `87a9dfb8`, no está en `audit-likida`, pero
  `audit-likida` contiene 3 commits más allá del ancestro común `133e384c`); su
  `docs/auditoria-18` es byte-a-byte idéntico al de `audit-likida`
  (`diff -rq` sin salida). No aporta nada nuevo.
- `work/likida-ai` (rama `master`, 2026-08-21) es un ancestro directo de
  `audit-likida` (`a3aa882d` es ancestro de `3f98a961`) — es simplemente un
  checkout más viejo del mismo histórico.
- La carpeta de Google Drive **no es un repositorio git** (no tiene `.git`);
  es un export de archivos sueltos fechado principios de agosto, muy anterior
  y sin forma de verificar su procedencia. Se descarta como referencia.
- **`2026-08-30/haz-x20/work/repo` (remoto `proyect-x-`) es, pese al nombre de
  repo distinto, el mismo producto Likida** — su `README.md` dice literalmente
  "# Likida... Liquidación de viajes de flotas de carga en México, por
  WhatsApp" y su `package.json` tiene `"name": "likida"`. Su primer commit
  (`a3c9978b`, 2026-07-24, "Scaffold inicial de Cuadra") muestra que el
  producto se llamó "Cuadra" antes de renombrarse a Likida, y vive en un
  repositorio (`proyect-x-`) distinto del `likida.ai` original — probablemente
  una migración de repo en algún punto del proyecto. Tiene **1,478 commits**
  (24-jul a 30-ago-2026) frente a los ~1,300 y pico de `audit-likida`, llega a
  **`docs/auditoria-22`** (frente a `auditoria-18` de `audit-likida`), y su
  fecha de commit más reciente es 6 días posterior.

**Recomendación: usar `/Users/javiercamaraportepetit/Documents/Codex/2026-08-30/haz-x20/work/repo` como referencia definitiva.** Es estrictamente más
reciente y más maduro que `audit-likida` (más auditorías corridas, más
migraciones — 255 vs. las de la copia de agosto —, servidor MCP añadido,
back office mucho más extenso). Todo lo que sigue en este documento está
investigado sobre esa copia (en adelante "el repo").

## 1. El bucle de auditoría diaria (`auditoria-diaria`)

Fuente: `.claude/skills/auditoria-diaria/SKILL.md`,
`.claude/skills/auditoria-diaria/PROMPT.md`,
`.claude/skills/auditoria-diaria/references/{desatendido,auditor-prompt,rubros,tablero}.md`,
todos bajo `/Users/javiercamaraportepetit/Documents/Codex/2026-08-30/haz-x20/work/repo/.claude/skills/auditoria-diaria/`.

### Qué invoca qué (las seis fases)

1. **Anclaje** — se lee `docs/auditoria-<N-1>/00-SINTESIS.md` (nota previa),
   se corren `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`
   como línea base real (nunca de memoria), se crea `docs/auditoria-N/` y se
   actualiza `MAPA.md` con el diff desde la ronda anterior
   (`git log <sha-anterior>..HEAD --stat`). Si `git status` no está limpio,
   la auditoría corre pero el autofix se apaga.
2. **Doce auditores en paralelo, contexto fresco** — un subagente por rubro,
   **en un solo mensaje** con doce llamadas a la herramienta de agentes
   (`references/auditor-prompt.md`), cada uno recibe: `MAPA.md`, su sección
   de `references/rubros.md`, su nota previa y sus hallazgos abiertos. Al
   auditor se le **prohíbe tocar código y proponer el arreglo** (solo
   encuentra y califica) y se le exige listar también "lo que revisé y está
   bien" y "lo que NO alcancé a revisar" — para poder distinguir un rubro
   sano de uno sin revisar. Cada uno escribe **un único archivo**,
   `docs/auditoria-N/<rubro>.md` (evita colisiones de escritura).
3. **Verificación adversarial** — el orquestador (el agente principal, no un
   subagente) abre cada hallazgo y lo confirma leyendo el código; los falsos
   van a una sección "descartados" con la razón (en auditoría 22, uno se
   descartó así: `ticket_monedero`, cubierto por el portón `xmlVerificado`).
4. **Tablero** — `docs/auditoria-N/tablero.html`, HTML autocontenido (sin CDN)
   con los 12 rubros, delta contra la ronda anterior, serie histórica y
   hallazgos por severidad; se **abre y se mira** (headless con
   `--force-prefers-reduced-motion`) y se captura como `tablero.png` — "un
   tablero que nunca se renderizó no es evidencia de nada".
5. **Arreglo de críticos y altos, uno a la vez, en serie**: prueba que
   reproduce → arreglo → prueba verde → suite completa → commit atómico
   citando el ID del hallazgo. Si la suite se pone roja o la prueba nueva
   pasa igual sin el arreglo, se revierte (`git revert`/`git reset --hard`) y
   el hallazgo vuelve a `pendiente`. Medios/bajos quedan solo propuestos.
6. **Recalificación y cierre** — se corre la suite completa otra vez, se
   escribe `00-SINTESIS.md` con las 12 notas y el porqué de cada movimiento
   (una de tres razones obligatorias: *se atacó y subió* / *deuda que cobró
   factura* / *mirada más profunda* — nunca una nota que se mueve sin razón
   escrita), y se commitea.

### Separación hallazgo / reparación (el diseño central)

- Un hallazgo exige **`archivo:línea` + escenario "entra X → sale Y mal" con
  valores concretos + consecuencia para alguien real + severidad**
  (CRÍTICO/ALTO/MEDIO/BAJO); sin eso "es una opinión" y se descarta sin
  discusión (`references/auditor-prompt.md`).
- Los auditores tienen prohibido proponer el arreglo — "un auditor que
  arregla deja de buscar, y 12 agentes escribiendo sobre el mismo repo se
  pisan" (`SKILL.md` CRITICAL). La reparación es una fase y un agente
  distintos (el orquestador, fase 4), y ocurre **después** de la síntesis de
  hallazgos, en serie (no en paralelo), para poder revertir sin arrastrar
  otros cambios.
- "No se arregla lo que no se pudo reproducir": primero la prueba que falla,
  luego el arreglo, luego la prueba en verde.

### Persistencia de progreso y reanudación

- El estado vive en `docs/auditoria-N/` en disco, **no en la conversación**:
  cada auditor escribe su archivo de rubro en cuanto termina.
- `docs/auditoria-N/progreso.md` se escribe **mientras avanza** (una línea
  por acción, con su sha) — "un diario que se escribe al final no existe
  cuando se necesita" (`references/desatendido.md`).
- Si truena a media ronda: se listan qué archivos de rubro ya existen (esos
  auditores no se relanzan), se lee `progreso.md` para saber qué arreglos ya
  entraron, y se continúa desde ahí.

### Condición de terminación y presupuesto (modo desatendido)

`references/desatendido.md` fija una condición de término **verificable con
comandos**, nunca de memoria: existen los 12 archivos de rubro,
`00-SINTESIS.md` con las 12 notas y su razón, `tablero.html` **y**
`tablero.png`, cada crítico/alto en uno de tres estados finales
(commiteado con prueba / pendiente con razón / descartado por falso),
`npm test` y `npx tsc --noEmit` en verde sobre el árbol final, y los commits
pusheados. Presupuesto: **tope duro de 3 vueltas de arreglo** por ronda
(un crítico que resiste tres intentos exige una decisión humana, no un cuarto
intento), un commit por arreglo, y máximo un rubro reauditado por ronda si un
arreglo tocó su código.

Corriendo como *routine* en la nube (Claude Code cloud), cambian tres cosas: la
compuerta no incluye `npm run build` (necesita Supabase/OpenRouter/Facturapi/
Upstash, ausentes en la nube), los arreglos van a una rama `auditoria-N` y
salen como PR (nunca a `master`), y la skill viaja versionada dentro del repo
en `.claude/skills/auditoria-diaria/`.

### Los 12 rubros auditados (`references/rubros.md`)

Frontend · Backend y API · Sistema agéntico y orquestación · Tool calling ·
Seguridad · Cumplimiento fiscal · Cumplimiento legal · Arquitectura y
mantenibilidad · Pruebas · Operabilidad y DX · Rendimiento y costo · Modelo de
datos y esquema. Cada rubro tiene: dónde mirar (rutas concretas), qué cuenta
como hallazgo, y anclas de calificación 0–10 (5 = "camino feliz funciona,
bordes son fe"; 8+ exige red de pruebas/restricciones/alertas, no solo lectura
correcta). El fiscal se audita distinto: se compara texto normativo transcrito
en `normas/*.yaml` contra la línea de código, no solo lectura de código.

### Formato de `docs/auditoria-N`

Evidencia real en `docs/auditoria-22/` (30-ago-2026, la ronda más reciente):
`00-SINTESIS.md` (nota global y las 12, con "porqué del movimiento"),
`MAPA.md` (anclaje + qué cambió), `RESULTADO.md` (resumen ejecutivo de cierre),
`progreso.md`, `tablero.html` + `tablero.png`, y un archivo por rubro
(`frontend.md`, `backend.md`, `agentico.md`, `tool-calling.md`, `seguridad.md`,
`fiscal.md`, `legal.md`, `arquitectura.md`, `pruebas.md`, `operabilidad.md`,
`rendimiento.md`, `datos.md`). La auditoría 22 real: **6.1 global**, 10
CRÍTICOS + 24 ALTOS encontrados, **los 34 arreglados** en 13 commits atómicos,
compuerta final: 9,995 pruebas en 708 archivos en verde, `tsc` y `lint` en 0
errores. Nota curiosa de esa ronda: `.gitignore` ignora `docs/auditoria-*/`,
así que ninguna ronda deja rastro en `master` — cada corrida en la nube
recalifica "en frío" sin poder leer la nota anterior (limitación documentada
en el propio `MAPA.md` de la 22, no oculta).

## 2. El bucle de "mejora diaria" (loop distinto y complementario)

Fuente: `scripts/mejora-diaria/ESQUELETO-AUTONOMIA.md`,
`scripts/mejora-diaria/correr.sh`, `scripts/mejora-diaria/auditor.mjs`,
`scripts/mejora-diaria/instalar.sh` (todos bajo
`/Users/javiercamaraportepetit/Documents/Codex/2026-08-30/haz-x20/work/repo/scripts/mejora-diaria/`).

Este es un **segundo bucle**, más barato y de grano fino, que corre a diario
por `launchd` (cron de macOS) a las 05:30, distinto de la auditoría de 12
rubros:

1. **`auditor.mjs`** (modelo barato, `openai/gpt-oss-120b` vía OpenRouter,
   `.env.local` con `OPENROUTER_API_KEY`, `data_collection: 'deny'`) lee **un
   área del repo por día de la semana** (rotación fija: domingo
   `src/lib/llm`+`src/lib/agents`, lunes `src/lib/likida`, martes
   `src/app/api`, miércoles `src/lib/admin`, jueves `src/app/dashboard`,
   viernes `src/app/admin`, sábado `supabase/migrations`+`src/lib`) y produce
   una lista de hallazgos (`hoy-hallazgos.json`), deduplicados contra
   `.mejora-diaria/registro.jsonl` para no repetir lo ya visto/descartado.
   Falla cerrado: sin `OPENROUTER_API_KEY` o sin JSON válido, sale con código
   de error — nunca finge "0 hallazgos".
2. **`correr.sh`** (el orquestador bash) toma cada hallazgo y lo pasa a
   `claude -p` (la **suscripción** de Claude Code, no la API de pago por
   token) corriendo en un **worktree git aislado** (`../likida-mejoras`,
   creado por `instalar.sh` con `git worktree add --detach`) para que nunca
   choque con las sesiones interactivas del repo principal. El encargo
   embebido en el prompt exige, en orden: (1) verificar el hallazgo leyendo
   el código real — si no es real, terminar con `VEREDICTO: DESCARTADO —
   <motivo>` sin tocar nada; (2) si es real, el arreglo mínimo + prueba que
   lo cubra; (3) verificar `tsc --noEmit` y `vitest run` de las suites del
   área tocada en verde, o revertir todo; (4) auto-revisión adversarial del
   diff completo; (5) commit local (sin `[deploy]` en el asunto, sin push) y
   terminar con `VEREDICTO: ARREGLADO — <qué cambió>`. Se invoca con
   `--output-format json` y el veredicto se lee del campo `result` de la
   salida estructurada (nunca grep sobre texto libre).
3. Si el veredicto es `ARREGLADO` y hay commits nuevos: push de la rama
   `mejora/<fecha>-<slug>` y `gh pr create` — **PR, jamás merge directo**.
   Si es `DESCARTADO`: se registra el motivo en `registro.jsonl` y se limpia
   el worktree. Si no hay veredicto claro (límite de turnos): se registra
   como `sin_veredicto` y queda pendiente.

### Candados y detención

- **Kill switch**: `touch .mejora-diaria/APAGADO` detiene todas las rutinas
  del repo sin desinstalar nada (`correr.sh` revisa ese archivo al arrancar).
- **Tope diario**: `MEJORA_TOPE_DIA` (default 3) — cuenta *corridas* de
  `claude -p`, no PRs abiertos, porque un descarte también consume la bolsa
  de la suscripción.
- **`--max-turns 60`** acota cada corrida individual.
- Notificación de cierre por WhatsApp (`wa-notificar.sh`) con el resumen
  ("N PRs abiertos de M corridas") y notificación nativa de macOS.

### El mapa completo de rutinas (`ESQUELETO-AUTONOMIA.md`)

El documento cataloga **todos** los loops del sistema en tres capas:

- **Capa 1 — loops locales vivos (`launchd`)**: además de `mejora-diaria`
  (05:30), hay rutinas diarias (`noticias-diaria`, `promos-diaria`,
  `render-video`, `dof-diario` — vigilancia normativa del Diario Oficial,
  `jarvis-brief` — resumen de mando por WhatsApp, `vigia-produccion` — guardia
  determinista cada 2h contra producción real, $0 de costo) y semanales/
  mensuales (`auditoria-semanal`, `automejora-semanal` — meta-loop que edita
  los *encargos* de otras rutinas por PR, `salud-mensual`,
  `documentacion-quincenal`, `experto-fiscal`, etc.)
- **Capa 2 — loops en la nube ya cableados** esperando activación por token
  (ej. runner de outreach por email vía Vercel cron).
- **Capa 3 — sin loop todavía**, documentado explícitamente como decisión
  pendiente, no como omisión.
- **Regla que atraviesa todo**: "la IA prepara, el humano aprueba" — cada
  loop termina en PR, cola de aprobación o reporte; **ninguno publica,
  mergea o manda nada solo**.

## 3. Stack backend

- **Framework**: Next.js **16** (App Router), confirmado en `package.json`
  (`"next": "^16.3.2"`) y en `README.md:203`. Rutas en
  `src/app/api/**/route.ts` (incluye `v1/`, `webhook/`, `cron/`, `stripe/`,
  `mcp/`) y Server Actions inline (`'use server'`, ej. `cerrarSesion` en
  `src/app/admin/layout.tsx`).
- **Sin ORM**: acceso directo con `@supabase/supabase-js` (^2.112.4) +
  `@supabase/ssr` (^0.12.5). Dos clientes en `src/lib/supabase/`:
  `server.ts` (cliente SSR por cookies, respeta RLS con la sesión real) y
  `admin.ts` (`supabaseAdmin()`, service-role, **salta RLS** — el propio
  código deja dicho que el filtro por tenant hay que reimponerlo a mano con
  `.eq('tenant_id', ...)`; incluye timeout backstop de 25s). Para
  agregaciones pesadas usan RPCs de Postgres (`resumen_costo_ia()`,
  `resumen_negocio()`) en vez de traer filas.
- **Migraciones**: `supabase/migrations/*.sql`, 255 archivos, convención
  `NNNN_descripcion.sql` (`0001_init.sql` … más allá de `0270`), aplicadas
  vía Supabase CLI (scripts `scripts/seed.sh`,
  `scripts/aplicar-migraciones-y-humos.sh`); no hay migraciones "declarativas"
  ni herramienta ORM — SQL plano, una migración por cambio.
- **RLS multi-tenant real** (no solo filtrado en aplicación): patrón fundado
  en `supabase/migrations/0001_init.sql` (el propio comentario dice
  *"Multi-tenant con RLS (patrón atiende endurecido). El aislamiento vive en
  Postgres, no en el código."* — línea 2). Dos funciones `SECURITY DEFINER`:
  `get_user_tenant_ids()` (nunca retorna NULL, evita el bypass típico de RLS
  por NULL) e `is_superadmin()`; una policy uniforme `tenant_data` aplicada
  por bucle `do $$ ... $$` sobre el array de tablas
  (`['terminal','operador','politica_gasto','viaje','gasto','liquidacion','wa_conversacion']`)
  con `using`/`with check` idénticos:
  `tenant_id = any(get_user_tenant_ids()) or is_superadmin()`. 87 de las 255
  migraciones tocan RLS/policies (grep `create policy` case-insensitive: 27
  archivos con definiciones nuevas).
- **Doble capa de defensa documentada** (ver rubro Seguridad en
  `references/rubros.md` y CI): (1) RLS en Postgres protege cualquier sesión
  con rol `authenticated`; (2) el filtro `tenant_id` que la aplicación agrega
  a mano en cada consulta hecha con `service_role` (que sí puede saltarse
  RLS) — la garantía real del camino de producción, verificada en
  `src/lib/supabase/admin.ts` y probada estáticamente (ver §7).

## 4. Modelo de datos: organizaciones, roles y permisos

Tabla raíz `tenant` (= "flota" en el lenguaje de producto; no existe una
tabla literal `flota`), `supabase/migrations/0001_init.sql:9-13`:
`id uuid pk`, `nombre`, `rfc`, `ciudad`, `plan` (default `'demo'`),
`created_at`.

`app_user` (mismo archivo, líneas 15-21) — la tabla de membresía/rol en una:
`id uuid pk` (= `auth.users.id` de Supabase Auth), `tenant_id uuid references
tenant(id)` **nullable** ("null = superadmin"), `email unique`, `nombre`,
`rol text not null default 'flota_admin'`. El dominio de `rol` se impone con
un `CHECK` (`app_user_rol_dominio`, migración `0025_dominios_check.sql`) y
evoluciona con el producto: parte de `superadmin | flota_admin | contador |
operador`, gana `encargado` (`0044_rol_encargado.sql`), pierde `operador`
del dominio de `app_user` cuando ese rol se separa a su propia tabla de
choferes (`0086_retirar_rol_operador.sql` — "operador" pasa a ser entidad de
negocio, no de acceso), y gana `vendedor` con `tenant_id` null
(`0105_zona_vendedores.sql`, rol de Likida-empresa, no de una flota). Estado
documentado en `CLAUDE.md:46-47`.

Otras tablas con `tenant_id` FK (todas en `0001_init.sql`): `terminal`,
`operador` (choferes), `politica_gasto`, `viaje`, `gasto`, `liquidacion`,
`wa_conversacion` (esta última con `tenant_id` **nullable** por diseño —
`wa_mensaje_procesado` no tiene `tenant_id` en absoluto, documentado como
limitación conocida en `CLAUDE.md`).

`invitacion` (alta por invitación, no altas directas de `app_user`):
`supabase/migrations/0053_cuentas_bitacora_arco_campanias.sql:31-46` —
`tenant_id`, `email`, `rol` (CHECK acotado), `token_hash` (nunca el token en
claro), `expira_en`, `aceptada_en`, `revocada_en`, índice único de invitación
viva por `(tenant_id, lower(email))`.

Determinación del tenant efectivo en runtime (tres piezas, todas en
`src/lib/auth/`): `session.ts` (`getSessionTenant`, el caso normal),
`admin-context.ts` (selección explícita de flota por el superadmin, cookie
firmada, vía `/admin/elegir-flota`) y `tenant-efectivo.ts` (flujo auditado de
"ver como" con querystring `?tenant=`/`?vista=demo`/`?rol=` para demos y
soporte).

Identidad de tokens MCP atada a la identidad de usuario (no solo al tenant):
migración `0271_mcp_oauth_identidad_atada_y_dominio_de_rol.sql` añade una FK
compuesta `unique (id, tenant_id, rol)` en `app_user` y hace que
`mcp_oauth_codigo`/`mcp_oauth_token` referencien esa tripleta — evita que un
token cargue una combinación `(usuario, tenant, rol)` que ya no es
consistente con la tabla de origen.

## 5. Superadmin / back office

- **Guard**: `src/lib/auth/guard.ts`, función `requireSuperadmin()` — obtiene
  la sesión (`getSessionTenant()`) y redirige a `/dashboard` si
  `rol !== 'superadmin'`. Se invoca **una sola vez**, en
  `src/app/admin/layout.tsx`, que gatea el layout entero de `/admin` — "el
  `requireSuperadmin()` vive AQUÍ... ninguna página nueva bajo `/admin` puede
  olvidarlo" (comentario del propio archivo). El dibujo visual vive aparte en
  `chrome.tsx` para poder verificarse sin sesión.
- **Doble capa de autorización** (mismo patrón que el de datos): capa 1 es
  `src/proxy.ts` (el equivalente a middleware de Next en este repo — gate de
  sesión Supabase + cabeceras CSP, excluye `/api`), capa 2 es
  `requireSessionTenant`/`requireSuperadmin` en `guard.ts` — "las dos tienen
  que fallar a la vez para que el panel se sirva sin autorización" (así se
  documenta explícitamente el rubro Seguridad de `rubros.md`, que exige
  exactamente dos capas independientes para 8+).
- **La función cross-tenant**: `src/lib/admin/negocio.ts` — única función
  del repo con permiso de leer TODA la base a la vez (costo de IA en dólares
  por fase, de Likida completa), agrega vía RPCs (`resumen_costo_ia()` mig.
  0062, `resumen_negocio()` mig. 0153) en vez de traer filas, con caché de
  60s (`getResumenNegocio`).
- **Tamaño real del back office**: `src/app/admin/` tiene ~50 subcarpetas,
  mucho más allá de "costo de IA, flotas, agentes" (la descripción corta de
  `CLAUDE.md`/`README.md`): incluye `flotas/` (alta y gestión de tenants),
  `agentes/`, `agente-cuadre/`, `agente-ocr/`, `agente-whatsapp/`,
  `costos-facturacion/`, `consumo/`, `crecimiento/`, `cobranza/`,
  `analitica/`, `compliance/`, `qa/`, `calidad-evals/`, `crons/`,
  `elegir-flota/` (selector de tenant), `command-palette.tsx`, entre otras.
  `src/lib/admin/` tiene ~30 módulos paralelos (`bus.ts`, `guardia.ts`,
  `salud.ts`, `slo.ts`, `soporte.ts`, `qa-*.ts`, `github.ts`, `calcom.ts`).
- **El "60-agent company"**: el README describe una "agent company" (~60
  agentes de negocio, no solo el agente conversacional de liquidación) que
  vive en `src/lib/likida/agentes/`, cubriendo ventas, cobranza,
  financieros, dirección, prospección, éxito de cliente, crecimiento
  (marketing) e ingeniería interna — ver §6.

## 6. Sistema de agentes y herramientas

### El agente conversacional (el que habla con el operador)

- **Registro**: `src/lib/agents/registry.ts` — `AGENT_REGISTRY`, hoy con un
  único agente (`liquidacion`, rol `cuadre`, modelo Claude Sonnet). El
  comentario de cabecera es explícito sobre el diseño: *"A diferencia de
  atiende (~18 agentes médicos), Likida es mono-propósito"* — confirma que
  Likida reusa un framework de agentes previamente construido para otro
  producto ("atiende") con soporte multi-agente real.
- **Dos registros de tools separados, con dos formatos de schema distintos**:
  1. `src/lib/llm/tool-executor.ts` — el motor de tool-calling del agente
     WhatsApp/copiloto: un `Map<string, RegisteredTool>` (`REGISTRY`)
     poblado por `registerTool(name, { schema, handler, isMutation? })`,
     donde `schema` es JSON Schema plano (`OpenAI.Chat.ChatCompletionTool`,
     **no Zod**). Las tools concretas se registran al importar
     `src/lib/likida/tools.ts` (agente `liquidacion`:
     `consultar_politica`, `estado_viaje`, `cuadrar_viaje`,
     `guardar_liquidacion`), `src/lib/agents/chat-tools.ts` (agente
     `analista_flota`, solo lectura, ej. `kpis_flota`) y
     `src/lib/agents/copiloto-tools.ts` (agente del fundador, cross-tenant,
     acotado por un allowlist explícito `TOOLS_COPILOTO_LECTURA`).
  2. `src/lib/mcp/herramientas.ts` — catálogo del servidor MCP: un array
     `CATALOGO` de objetos `Herramienta<T>` (tipos en `src/lib/mcp/tipos.ts`)
     donde cada uno sí trae `esquema: z.ZodType<T>`, validado con
     `h.esquema.safeParse(args)` dentro de `despacharHerramienta()`
     (ejemplo: `src/lib/mcp/herramientas/viajes.ts`).
- **Tools con `properties: {}` vacías, a propósito**: las tools del agente
  conversacional declaran `parameters: { type: 'object', properties: {},
  additionalProperties: false }` — el rubro Tool calling de `rubros.md`
  explica que es una decisión estructural, no un descuido: "el modelo
  decide *cuándo*, nunca *con qué datos*; `tenantId`/`viajeId` salen del
  contexto resuelto en servidor" (`ToolContext`, inyectado por el servidor,
  `tool-executor.ts:13-46`) — así se cierra la inyección de prompt de forma
  estructural en vez de por validación de input. Cada handler filtra
  explícitamente `.eq('tenant_id', ctx.tenantId)` (ej. `estado_viaje` en
  `src/lib/likida/tools.ts:96-99`).
- **Autorización por tool en MCP**: `despacharHerramienta` exige
  `alcanza(h.area)` (área `operacion`/`dinero`/`administracion`, tipo `Area`
  en `src/lib/auth/visibilidad.ts`) **antes** de ejecutar, y pasa el
  `tenantId` explícito — resuelto exclusivamente de la credencial
  (`src/lib/mcp/credencial.ts`) — a `h.ejecutar(tenantId, args, contexto)`.
- **Idempotencia con lease/fencing durable en Postgres** (no solo un check
  en memoria): `src/lib/llm/tool-idempotency.ts` implementa claim/renew/
  complete/fail vía RPCs de Postgres (`claim_agente_mutacion`,
  `renew_agente_mutacion`, `complete_agente_mutacion`,
  `fail_agente_mutacion`, con el reloj autoritativo viviendo en la base, no
  en el proceso Node — de ahí el commit `fix(sql-ci): use postgres clock
  for tool idempotency`). Tabla `agente_mutacion_idempotencia`
  (`supabase/migrations/0186_runtime_idempotencia_y_presupuesto.sql:1-26`):
  `unique(tenant_id, effect_key)`, `status in ('running','succeeded',
  'failed')`, `lease_until`. La llave del efecto
  (`mutationEffectKey`, `tool-executor.ts:~317`) incluye el **`runId`** de
  la conversación — sin él, reabrir un viaje ya liquidado no podía volver a
  liquidarse. El executor **rechaza fail-closed** cualquier tool marcada
  `isMutation` que llegue sin `ctx.runId`. Una mutación ya en curso (lease
  vigente, hasta 10 renovaciones de 120s) responde "reintenta en un minuto"
  al operador en vez de ejecutar dos veces.
- **Reintentos/fallback a nivel de proveedor LLM** (distinto de la
  idempotencia de tools): `isTransientError()` + mapa `FALLBACK` en
  `src/lib/llm/openrouter.ts` — fallback cross-provider automático ante
  5xx/429/408/errores de conexión, con una `PartialExecutionError` dedicada
  para que un fallback **nunca** re-ejecute una mutación que ya corrió.
- **Presupuesto de dinero (ledger scoped por tenant), distinto del
  presupuesto de tiempo**: tabla `llm_presupuesto_reserva`
  (misma migración 0186): `reservado_usd`, `costo_real_usd`,
  `estado in ('reservado','liquidado')`, con RPCs
  `reservar_presupuesto_llm`/`liquidar_presupuesto_llm` protegidas por
  `pg_advisory_xact_lock` por tenant (evita condiciones de carrera entre
  llamadas concurrentes al mismo presupuesto). Extendida por
  `0193_presupuesto_llm_dia_mx_y_expiracion.sql` y
  `0244_antijoin_por_igualdad_y_presupuesto_por_proposito.sql` (dimensión de
  "propósito": `interactivo` — reserva para el operador humano —,
  `ocr_lote`, `fondo`). Módulo: `src/lib/llm/budget.ts`
  (`createLlmBudget(tenantId, runId, proposito, limits)`,
  `LlmBudgetExceededError` con scope `run`/`tenant`/`proposito`). El "cobro
  del redactor por ledger tenant-scoped" es
  `src/lib/likida/agentes/redactor.ts:~120-152`
  (`presupuestoDelRedactor()`); en modo `plataforma` (gasto de Likida-empresa,
  sin tenant) el techo se vigila en su lugar contra
  `agente_definicion.presupuesto_dia_usd`, medido en `agente_corrida.costo_usd`.
- **Presupuesto de tiempo** (independiente del de dinero):
  `src/lib/likida/presupuesto.ts` documenta con precisión el peor caso de
  cada paso de red del cierre de una liquidación (consulta, `sendText`,
  `sendDocument`, URL firmada) y compara la suma contra `maxDuration` de
  Vercel con una prueba que falla si algún paso nuevo no se contabiliza.
- **Catálogo declarativo de agentes** (el "registry" a nivel de negocio, no
  de código): tabla `agente_definicion`
  (`supabase/migrations/0116_agente_definicion.sql`) — departamento,
  disparador, ciclo de vida (`disenado/vivo/pausado/retirado`), presupuesto
  diario en USD.

### El "agent company" (agentes de negocio, back office)

`src/lib/likida/agentes/corridas.ts` define el tipo `AgenteConCorridas`, un
enum de **~60 agentes de negocio** (no conversacionales) agrupados por área:
liquidación/facturas/cobranza/conductores/peajes/proveedores (flota),
ventas/redactor/scorer/dossier/sdr/enviador (prospección),
analista_metricas/control_costos/tesoreria/cierre_mensual (financieros),
kpi_whatsapp/desempeno_startup/orquestador (dirección), onboarding_cliente/
exito_cliente/retencion (éxito de cliente), contenido_fiscal/lead_magnet/
guiones/visuales/video_demo (crecimiento/marketing), migraciones/seguridad/
rendimiento/pruebas/auditor_codigo (ingeniería interna), automejora/
fundraising (dirección), etc. La tabla que registra sus ejecuciones es
`agente_corrida` (función `registrarCorrida()`):

```
agente_corrida:
  tenant_id   uuid null   -- NULL = corrida de Likida-empresa (no de una flota)
  agente      text        -- uno de los ~60 del enum AgenteConCorridas
  inicio, fin timestamptz
  estado      text        -- 'ok' | 'parcial' | 'fallo'
  disparo     text        -- 'cron' | 'manual' | 'correo' | 'whatsapp'
  tareas_hechas, tareas_total  int null   -- el "2/2" de la ficha visible al cliente
  resumen     jsonb null  -- conteos/folios para desplegar, SIN datos personales
  error       text null   -- motivo YA redactado para una persona
  costo_usd   numeric null -- gasto de modelo de ESTA corrida (alimenta el techo diario)
```

Regla de robustez explícita en el código: **"registrar JAMÁS lanza"** — un
fallo al escribir la bitácora de ejecución nunca debe tumbar la corrida real
que ya hizo su trabajo; se traga el error y se loguea (`logger.error`), nunca
se propaga.

Migración de origen de `agente_corrida`:
`supabase/migrations/0102_agente_corrida.sql`.

### Bitácora de auditoría (trazabilidad de acciones, no solo de corridas)

`bitacora_auditoria` es la tabla genérica de "quién hizo qué" — se define en
`supabase/migrations/0053_cuentas_bitacora_arco_campanias.sql` y se endurece
más adelante en `0195_bitacora_auditoria_sin_insercion_directa.sql` para que
**nada pueda insertar en ella salvo su único escritor**,
`src/lib/likida/bitacora_escritura.ts` (función `anotarBitacora`) — patrón
deliberado de "un solo punto de escritura" para una tabla de auditoría (evita
que un bug en cualquier otro módulo la corrompa o la salte). El servidor MCP
llama a `anotarBitacora` (más `registrarEventoSeguridad` para los intentos
negados por área) en cada `tools/call`, en
`src/app/api/mcp/route.ts:94-125,170`.

### Servidor MCP (Model Context Protocol)

Documentado en detalle en `docs/mcp/servidor.md`. Piezas:

| Pieza | Archivo |
|---|---|
| Endpoint MCP (JSON-RPC, gateo, bitácora) | `src/app/api/mcp/route.ts` |
| Protocolo (versiones soportadas) | `src/lib/mcp/protocolo.ts` |
| Credencial (llave `lk_live_` u OAuth) | `src/lib/mcp/credencial.ts` |
| Motor OAuth (códigos, tokens, rotación) | `src/lib/mcp/oauth.ts` |
| Catálogo y despachador de tools | `src/lib/mcp/herramientas.ts` + `herramientas/` |
| Descubrimiento (.well-known) | `src/app/.well-known/…` + `src/lib/mcp/metadata.ts` |
| Tablas (clientes, códigos, tokens OAuth) | `supabase/migrations/0260_mcp_oauth.sql` |

Reglas no negociables documentadas: el tenant sale **solo** de la credencial
(sin tenant resoluble → 401/503, jamás datos); la service-role key de
Supabase nunca sale del servidor (el cliente MCP recibe tokens propios
`lk_mcp_at_...`); el catálogo entero es **solo lectura**
(`readOnlyHint: true`, con una prueba que lo fija); autorización por área
antes de ejecutar cada tool (`despacharHerramienta` — llave → su área
emitida, OAuth → áreas del rol vía `visibilidad.ts`); ningún secreto en claro
(SHA-256 con `CHECK` de 64 hex en la base); **bitácora** de cada `tools/call`
(y cada intento negado) en tabla `bitacora_auditoria` con actor y
herramienta, más `evento_seguridad` para los intentos negados;
**rate limits**: 60/min por IP sin identificar, 240/min por flota, 10/min el
registro DCR, 30/min el token OAuth. Vida de credenciales: código de
autorización 5 min/un solo uso, access token 8h, refresh token 60 días con
rotación en cada uso (reuso revoca toda la familia de tokens).

### Colas y rate limiting

- **Colas**: `@upstash/qstash` (^2.11.3) para trabajo diferido/programado
  (el runner de nivel 2 de outreach corre por Vercel cron cada 4h,
  `/api/cron/runner`, según `ESQUELETO-AUTONOMIA.md`).
- **Rate limiting**: `src/lib/ratelimit.ts` (con `ratelimit_redis.test.ts` —
  hay una variante respaldada por Redis/Upstash) y guardias por ruta API.

## 7. Observabilidad y testing

- **Sentry**: `@sentry/nextjs` (^10.70.0), **server-only a propósito** — el
  propio `next.config.ts:167-169` documenta que no hay
  `instrumentation-client.ts` ni DSN público. El cableado real vive en
  `src/instrumentation.ts` (hook `register()` de Next, solo runtime
  `nodejs`, llama `avisarObservabilidad()`/`precargar()` al arrancar, y
  `onRequestError(err, request, context)` — capturado por Next ante
  cualquier error no atrapado de Server Components/route handlers/acciones —
  que loguea, reporta la excepción y hace `flushObservabilidad()` antes de
  que la invocación serverless se congele) y
  `src/lib/observability/sentry.ts` (import dinámico de `@sentry/nextjs`
  solo si existe `SENTRY_DSN`; `tracesSampleRate` configurable, default
  0.05; `sendDefaultPii: false`; hooks `beforeSend`/`beforeSendTransaction`
  → `sanitizarEventoSentry()` que sanea query/cookies/headers/body/
  breadcrumbs/spans antes de salir del proceso). Se instrumentan tanto
  errores como performance (transacciones). Pruebas dedicadas:
  `src/instrumentation.test.ts`, `src/lib/observability/sentry.test.ts`.
- **Logging estructurado propio con redacción de PII**: `src/lib/logger.ts`
  — redacta RFC, teléfonos MX y CLABE/tarjeta, y en vez de borrar UUIDs los
  reemplaza por una "huella" FNV-1a estable (`huellaId`) para poder
  correlacionar logs del mismo actor/entidad sin exponer el dato crudo.
  Sentry se alimenta de este mismo logger/redactor, no de una config aparte.
- **Testing — cuatro configuraciones de Vitest, cada una con propósito
  distinto**: `vitest.config.ts` (suite normal; cobertura v8 con umbrales
  tipo trinquete — 78% líneas/statements, 69% branches, 82% funciones —,
  `LIKIDA_COBERTURA=1` bajo `--coverage` hace que dos pruebas sensibles al
  tiempo se salten bajo instrumentación de v8, y CI las recupera aparte con
  `npx vitest run fundamento duplicados` sin cobertura), `vitest.audit.config.ts`
  (colecta solo `scripts/auditoria/**/*.audit.ts` — el motor de la skill de
  auditoría diaria, script npm `auditoria`), `vitest.qa.config.ts` (colecta
  `scripts/qa-agentes/**/*.qa.ts` + `pruebas-manuales/qa-agentes/**/*.prueba.ts`,
  script `qa:nocturno` — hace llamadas reales de pago, OCR + OpenRouter,
  contra un tenant de prueba dedicado "ZZZ QA", timeouts de 15 min por
  prueba), `vitest.manual.config.ts` (colecta `pruebas-manuales/**/*.prueba.ts`
  — pegan contra la base y proveedores REALES vía `.env.local`, corren
  seriales (`fileParallelism: false`), **nunca en CI**: ejemplos
  `arnes_ticket_real` — script `npm run ticket` —,
  `capufe-prevuelo.prueba.ts`, `factura-punta-a-punta.prueba.ts`,
  `inyeccion.prueba.ts`).
- **E2E/smoke**: Playwright. `pruebas-navegador/*.nav.ts` (login real por
  magic link, tableros por rol, `/admin` bloqueado para no-superadmin,
  filtros, dinero, vista móvil) contra un Supabase local — corre en el
  workflow dedicado `e2e-navegador.yml`, que levanta la pila local de
  Supabase (GoTrue/PostgREST/Storage/Mailpit), aplica migraciones y semilla,
  y ejecuta `npm run test:e2e`. Aparte, `npm run test:smoke` →
  `scripts/ci/playwright-smoke.mjs` (Chromium headless vía
  `@sparticuz/chromium`, arranca el build ya compilado y visita **solo**
  rutas públicas — `/`, `/terminos`, `/privacidad` —, sin credenciales,
  fallando ante overlay de error de Next o consola con errores) es el que
  corre dentro de `ci.yml`.

### Pruebas adversariales de RLS multi-tenant (el hallazgo más valioso de esta investigación)

Documentado con extremo detalle en
`.github/workflows/ci-postgres.yml`. El job **`aislamiento-postgres`** existe
porque, según su propia cabecera, `supabase/verificaciones.sql` tenía ~88
bloques de ataque escritos a mano que **nadie corría en CI** — se pegaban
manualmente en el SQL editor de Supabase cuando alguien se acordaba; la
primera corrida automatizada (15-ago-2026) encontró 4 bloques rotos desde
hacía semanas sin que nadie lo notara.

El job demuestra **dos capas por separado, con Postgres real (contenedor de
servicio `postgres:16.4`), nunca con un mock de `supabase-js`**:

1. **RLS** — la red que protege una sesión de navegador con rol
   `authenticated`. Se prueba con `SET LOCAL ROLE` + `SET LOCAL
   request.jwt.claims` dentro de una transacción (simula exactamente lo que
   hace PostgREST en cada request), contra dos archivos:
   `supabase/pruebas-aislamiento/capa1_auditoria_estatica.sql` (auditoría
   estática, *schema-driven*: una tabla/vista/función nueva sin protección
   se detecta sola, sin mantenimiento manual) y `supabase/verificaciones.sql`
   (los ~88 ataques dinámicos con tenants reales — intentan leer/escribir
   datos de otro tenant y esperan que la base lo impida).
2. **El filtro `tenant_id` de la aplicación** en las consultas hechas con
   `service_role` (que salta RLS) — se prueba **sin base de datos**, como un
   escaneo estático de fuente, en
   `supabase/pruebas-aislamiento/consultas_admin_filtran_tenant.test.ts`
   (corre en el job normal `ci.yml`, no en `ci-postgres.yml`).

Mecánica del runner: las 255 migraciones se aplican **una por una** (no
concatenadas) sobre una base virgen, para que un fallo señale exactamente
cuál migración no aplica limpia — algo que `supabase db push` normal nunca
prueba, porque corre siempre contra una base con el estado acumulado. Antes
de las migraciones se levanta un "andamio" (`andamio_ci.sql`) que recrea los
roles `anon`/`authenticated`/`service_role` y un `auth`/`storage` mínimos, tal
como Supabase los provisiona. Adicionalmente hay pruebas pgTAP
(`supabase/tests/wa_leases_fencing.sql`, vía `pg_prove`) para contratos de
leases/fencing de WhatsApp y tools. El runner de la batería SQL
(`scripts/ci/correr-verificaciones.mjs`) parte cada bloque `do $$...end$$;`
en su propia transacción y compara el mensaje de error contra el
`(esperado ...)` que el propio bloque declara.

### CI

`.github/workflows/`: `ci.yml` (job `verificar`: `npm audit --omit=dev`
bloqueante para runtime + `npm audit --include=dev` no bloqueante y visible,
`typecheck`, `lint:ratchet` — un linter con "trinquete" que no permite subir
warnings, tests offline de resiliencia, `test:coverage`, pruebas de tiempo
sin instrumentar, `build`, y smoke de Playwright arrancando el server real),
`ci-postgres.yml` (aislamiento multi-tenant descrito arriba, corre **en
paralelo** a `verificar`, no lo bloquea), `codeql.yml`, `e2e-navegador.yml`,
`deploy-preview-promote.yml`, `rollback-production.yml`,
`auto-merge-rutina.yml` (automerge acotado para PRs de rutina),
`backup-storage.yml`, `salud-produccion.yml`. Ambos workflows de CI disparan
en `push: branches: ['**']` (no solo `master`) — corregido explícitamente
porque el trabajo autónomo aterriza en ramas `claude/*` que antes no
disparaban CI nunca. `concurrency` cancela la corrida anterior de la misma
rama en cada push nuevo.

## 8. Patrones a adaptar para Licitaciones (sin marca Likida)

### Stack recomendado (calcado del patrón que ya funciona aquí)

- **Next.js App Router** + Server Actions para mutaciones simples, rutas
  `app/api/**/route.ts` para webhooks/cron/integraciones externas.
- **Postgres + Supabase (o Postgres gestionado equivalente) con RLS como
  mecanismo primario de aislamiento multi-tenant** — nunca solo filtrado en
  aplicación. Dos clientes: uno "de sesión" (respeta RLS, para todo lo que
  sirve al usuario autenticado) y uno "admin"/service-role (para agregaciones
  cross-tenant y trabajos de fondo), con la regla explícita de que **todo uso
  del cliente admin debe traer su propio filtro `tenant_id` a mano** y estar
  cubierto por una prueba estática que lo verifique (ver `consultas_admin_filtran_tenant.test.ts`).
- **Sin ORM**: SQL directo + funciones `SECURITY DEFINER` para RLS
  (evita reimplementar reglas de negocio en dos capas). Migraciones SQL
  planas numeradas, aplicadas una por una en CI sobre Postgres efímero.
- **Vitest** para unit/integration con al menos dos configuraciones
  separadas (suite normal con cobertura vs. suite de pruebas "caras"/reales
  que nunca corren en CI ni en automatizaciones), **Playwright** para
  smoke/e2e.
- **Un logger estructurado propio + Sentry**, ambos con prueba de que están
  cableados (no solo "instalados").

### Esquema de tablas base (adaptado del patrón `tenant`/`app_user`/`agente_corrida` de Likida)

```sql
-- Organización / tenant
create table organizations (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  plan text not null default 'trial',
  created_at timestamptz not null default now()
);

-- Membresía = usuario + rol dentro de una organización (o NULL = staff interno)
create table memberships (
  id uuid primary key,                       -- = auth.users.id si 1 membresía por login,
                                              -- o una tabla intermedia si un usuario
                                              -- puede pertenecer a varias orgs
  organization_id uuid references organizations(id) on delete cascade, -- null = superadmin/staff
  email text not null,
  rol text not null,                         -- CHECK: dominio explícito, versionado por migración
  created_at timestamptz not null default now(),
  unique (organization_id, email)
);

-- Roles: dominio impuesto por CHECK, no solo por convención de aplicación
alter table memberships add constraint memberships_rol_dominio
  check (rol in ('superadmin','org_admin','analista','lector'));

-- Invitaciones (alta controlada, nunca inserción directa de membership)
create table invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  rol text not null,
  token_hash text not null,                  -- nunca el token en claro
  expira_en timestamptz not null,
  aceptada_en timestamptz,
  revocada_en timestamptz
);

-- Bitácora de auditoría genérica (acciones humanas y de agentes)
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id),  -- null = acción de plataforma
  actor_type text not null,                  -- 'user' | 'agent' | 'system'
  actor_id text not null,
  accion text not null,
  entidad text, entidad_id text,
  detalle jsonb,
  created_at timestamptz not null default now()
);

-- Ejecuciones de agentes (equivalente a agente_corrida de Likida)
create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,                      -- null = corrida de plataforma, no de un tenant
  agent_name text not null,
  disparo text not null,                     -- 'cron' | 'manual' | 'webhook' | 'evento'
  estado text not null default 'en_curso',   -- 'ok' | 'parcial' | 'fallo' | 'en_curso'
  inicio timestamptz not null default now(),
  fin timestamptz,
  tareas_hechas int, tareas_total int,
  costo_usd numeric,
  resumen jsonb,                             -- sin datos personales
  error text
);

-- Llamadas a herramientas dentro de una corrida (trazabilidad fina)
create table tool_calls (
  id uuid primary key default gen_random_uuid(),
  agent_run_id uuid not null references agent_runs(id) on delete cascade,
  tool_name text not null,
  run_id text not null,                      -- idempotency key: dedup de reintentos
  args jsonb,                                -- SOLO lo que decide el humano/servidor,
                                              -- nunca campos que el modelo pueda rellenar
                                              -- para decidir sobre datos de otro tenant
  resultado jsonb,
  estado text not null,                      -- 'ok' | 'error' | 'descartado'
  created_at timestamptz not null default now(),
  unique (tool_name, run_id)                 -- la idempotencia vive en la base, no solo en código
);

-- Trabajos en cola (jobs de fondo, cron o dirigidos por evento)
create table jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  tipo text not null,
  estado text not null default 'pendiente',  -- 'pendiente' | 'en_curso' | 'ok' | 'fallo'
  intentos int not null default 0,
  disponible_en timestamptz not null default now(), -- backoff / reintento programado
  payload jsonb,
  resultado jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Reglas de diseño a copiar literalmente, no solo el esquema:

1. **RLS con función `SECURITY DEFINER` que nunca retorna NULL** —
   `coalesce(array_agg(...) filter (...), array[]::uuid[])` — para que un
   usuario sin membresías obtenga "ningún acceso" y no "acceso sin filtro"
   por accidente de NULL en una comparación SQL.
2. **Una sola policy uniforme aplicada por bucle a todas las tablas
   tenant-scoped**, no una policy copiada a mano por tabla — reduce el
   riesgo de que una tabla nueva se quede sin RLS.
3. **Doble capa de autorización independiente** para cualquier ruta
   privilegiada (ej. middleware/proxy de sesión + guard en el layout del
   segmento de rutas), con la regla explícita de que ambas deben fallar a la
   vez para exponer datos.
4. **Las tool definitions del agente nunca exponen parámetros que decidan
   sobre el tenant o el dinero** — el contexto (`organizationId`, IDs de
   entidad) sale siempre del servidor, nunca de lo que el modelo rellena;
   esto cierra la inyección de prompt estructuralmente.
5. **`agent_runs`/`tool_calls` con `organization_id` nullable** desde el
   diseño — permite agentes de "plataforma" (auditoría, ventas, contenido)
   que no pertenecen a ningún tenant, sin forzar un tenant ficticio.
6. **Idempotencia con `unique (tool_name, run_id)` en base**, no solo un
   chequeo en memoria — sobrevive a reintentos del proceso completo.
7. **Registrar nunca debe lanzar**: escribir en `audit_log`/`agent_runs`
   jamás debe poder tumbar el trabajo real que se está registrando; se
   loguea el fallo y se sigue.
8. **Pruebas de aislamiento contra Postgres real en CI**, no solo contra
   mocks del cliente de base de datos: aplicar todas las migraciones sobre
   una base efímera y correr ataques dinámicos con `SET LOCAL ROLE` +
   `request.jwt.claims`, más una auditoría estática *schema-driven* que
   detecte sola una tabla nueva sin RLS.
9. **Separar "encontrar" de "reparar" en cualquier bucle de mejora
   automática**: un agente audita y califica con evidencia verificable
   (archivo:línea + escenario concreto), nunca repara; otro agente —en otra
   fase, en serie— repara con prueba-antes-que-arreglo y puede revertir sin
   arrastrar otros cambios. Todo termina en PR con aprobación humana, nunca
   en push directo a producción.
