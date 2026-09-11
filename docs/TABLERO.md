# TABLERO — Atiende Licitaciones

**Fecha**: 2026-09-06, ~17:3x CST. **Commit HEAD auditado**: `9a12173`. Snapshot previo: `a644803` (cierre de ronda 5, tablero anterior). Fuente primaria: `docs/ACEPTACION.md` (**237 filas** = 210 REQ + 15 pruebas mínimas A1–A15 + 12 pruebas mínimas S1–S12), todos los `docs/auditoria-1/*.md` y `docs/auditoria-2/*.md`, `docs/PROGRESO.md`, `docs/BLOQUEOS.md`, `docs/DECISIONES.md` y los logs de test citados fila a fila.

**Qué es este pase.** No es el cierre de una ronda de construcción: es un **pase de trazabilidad**. Desde el tablero anterior se construyeron y cerraron seis bloques de trabajo (login con Google en `apps/api` y `apps/web`, `packages/mail`, integración de correos en `apps/api`, `infra/`, `apps/web` rondas 7 y 8a, `apps/api` ronda 6 y `apps/worker` ronda K) que `docs/ACEPTACION.md` **no reflejaba**: su sección de Ampliación 2 seguía declarando «Sin código / PENDIENTE» para casi todo. Eso era el hallazgo **ML-07** (MEDIA, trazabilidad), levantado en `docs/auditoria-2/mail.md` y reconfirmado sin corregir en `mail-reverificacion.md`. **Este pase lo cierra**: se abrió el test, log o commit que cubre cada fila y se reescribió su evidencia y su estado.

**Regla de lectura, sin cambios.** Ningún `CUMPLIDO` corresponde a un mock, fixture o integración simulada: cada uno cita un informe de reverificación independiente con veredicto CERRADO explícito. `LÍMITE_ACEPTADO` no es un defecto abierto: es un residual de severidad ≤MEDIA documentado tras tres vueltas de corrección. `BLOQUEADO_EXTERNO` es dependencia de credencial, acceso o herramienta que el entorno no tiene (hoy: credenciales de Google Cloud, proveedor de correo, **Docker no instalado**, facturación de GitHub Actions, Deployment Protection de Vercel, validación por abogado).

**Advertencia principal de este pase, dicha sin adorno.** La Ampliación 2 tiene mucho código real y mucha prueba real en verde, pero **casi nada llega a CUMPLIDO porque le falta el eslabón de reverificación independiente que exige REQ-210**. No existe informe de auditoría de `apps/web` rondas 7/8a ni de `infra/`; la auditoría del login con Google no tiene reverificación de sus correcciones (una de ellas, GO-10, era ALTA); la auditoría de la integración de correos en `apps/api` está en curso. Solo `packages/mail` tiene la cadena completa.

---

## 1. Conteo por estado (`docs/ACEPTACION.md`, 237 filas)

| Estado | Filas | % | Antes de este pase (`a644803`) | Antes de ronda 5 (`e61156e`, 186 filas) |
|---|---:|---:|---:|---:|
| CUMPLIDO | 57 | 24.1% | 54 | 47 |
| EN_EVIDENCIA | 101 | 42.6% | 54 | 53 |
| PENDIENTE | 65 | 27.4% | 117 | 77 |
| BLOQUEADO_EXTERNO | 6 | 2.5% | 4 | 1 |
| LÍMITE_ACEPTADO | 5 | 2.1% | 5 | 5 |
| NO_APLICA_A_PAQUETE | 3 | 1.3% | 3 | 3 |
| **Total** | **237** | **100%** | **237** | **186** |

**Cómo leer el salto de −52 en PENDIENTE.** No es trabajo hecho hoy: es deuda de trazabilidad saldada. 46 de esas 52 filas son de la Ampliación 2, que se había escrito el 2026-09-06 por la mañana declarando «Sin código» para todo y nunca se actualizó tras las rondas 6–8a; las otras 6 son REQ-051..055 (construidos en la ronda 6 de `apps/api`) y REQ-169 (panel real de la ronda 7 de `apps/web`).

**Los 3 CUMPLIDO nuevos** son REQ-181 (catálogo de plantillas), REQ-184 (previsualización) y S4 (render + validación HTML/accesibilidad de las 16 plantillas) — **todos de `packages/mail`**, el único paquete de esta ampliación con cadena auditoría→corrección→reverificación cerrada (`mail.md` → ML-01..ML-06 → `mail-reverificacion.md`). Ninguna otra fila de la Ampliación 2 califica hoy.

**Los 2 BLOQUEADO_EXTERNO nuevos** son REQ-199 y REQ-200 (Dockerfiles y compose de producción): los archivos existen y pasan validación estática, pero `docker build` / `docker compose up` no se han ejecutado jamás porque **Docker no está instalado en esta máquina** — reverificado hoy: `which docker` → *not found*.

### 1.1 Desglose de la Ampliación 2 (51 filas: 39 REQ + 12 S)

| Estado | REQ-172..210 | S1–S12 | Total | Antes de este pase |
|---|---:|---:|---:|---:|
| CUMPLIDO | 2 | 1 | 3 | 0 |
| EN_EVIDENCIA | 32 | 10 | 42 | 1 |
| PENDIENTE | 2 | 0 | 2 | 48 |
| BLOQUEADO_EXTERNO | 3 | 1 | 4 | 2 |
| **Total** | **39** | **12** | **51** | **51** |

Las **2 filas que siguen genuinamente PENDIENTE** son las únicas sin código que las implemente: **REQ-193** (estados vacíos con guía de siguiente acción — el componente `EmptyState` acepta `actionLabel`/`onAction`, pero ninguna de las 29 páginas que lo usan se los pasa) y **REQ-198** (analítica sin PII — no hay analítica de ningún tipo en `apps/web`).

**Avance parcial de REQ-193 (2026-09-07, commit `f6b4ddf`, sesión de Claude Code):** se auditaron las ~50 invocaciones reales de `EmptyState` en `apps/web/src` antes de tocar nada (no solo se contó cuántas les faltaba el prop). Hallazgo: la mayoría de los casos "Selecciona una organización" ya son honestos sin botón (la acción real vive en el selector del encabezado global, no en la página) y la mayoría de los "aún no hay X" ya tienen su formulario de creación siempre visible arriba en la misma página (`TarifasAprobadasPage`, `DocumentosVigenciasPage`, `UsuariosRolesPage`, `SeguimientoPage`, `CumplimientoDocumentalPage`, `AnalisisBasesPage`) — añadirles un botón sería ruido redundante, no guía nueva. Se corrigieron 4 casos genuinamente rotos, verificados (typecheck + lint + 225/225 tests + build): `OrganizacionesPage` prometía "crea la primera organización" en una pantalla de solo lectura de superadmin sin forma de crear nada (se corrigió el texto, no se inventó un botón que no correspondería); `MatchingPage`, `GoNoGoPage` y `AprobacionesPage` mostraban "Sin convocatorias" sin ruta hacia Descubrimiento (se agregó `actionLabel`/`onAction` navegando a `/convocatorias/descubrimiento`). **Queda sin revisar:** `AgentesHerramientasPage`, `JobsPage` (filtro activo — candidato a "Limpiar filtro"), `AuditoriaPage` (ídem), `RedaccionPage`/`SectionEditor`. Se deja PENDIENTE (no EN_EVIDENCIA) porque la cobertura sigue incompleta — reclasificar solo cuando se audite el resto.

### 1.2 Ampliación 2 por paquete responsable primario (39 REQ)

| Paquete | PENDIENTE | EN_EVIDENCIA | CUMPLIDO | BLOQUEADO_EXTERNO | Total |
|---|---:|---:|---:|---:|---:|
| apps/api | 0 | 12 | 0 | 1 | 13 |
| apps/web | 2 | 9 | 0 | 0 | 11 |
| packages/mail | 0 | 6 | 2 | 0 | 8 |
| infra/ | 0 | 2 | 0 | 2 | 4 |
| transversal / gobierno | 0 | 2 | 0 | 0 | 2 |
| packages/db | 0 | 1 | 0 | 0 | 1 |
| **Total** | **2** | **32** | **2** | **3** | **39** |

### 1.3 Épicas E13–E21 (Ampliación 2, `docs/BACKLOG.md`)

| Épica | Estado real | Qué falta para cerrar |
|---|---|---|
| E13 — Autenticación con Google (OIDC) | **Construida y auditada, sin reverificar** | Reverificación independiente de GO-03/GO-07/**GO-10 (ALTA)**; prueba de contrato de REQ-175; patrón de client secret de Google en `scripts/check-secrets.sh`; credenciales reales (BLOQUEADO_EXTERNO) |
| E14 — Correos transaccionales con plantillas | **`packages/mail` CERRADO; integración en `apps/api` sin auditar** | Auditoría de la integración (#115, en curso); handler `mail_retry` de `apps/worker` (#116, sin commitear); test estático de REQ-182; credenciales de proveedor + `RESEND_WEBHOOK_SECRET` (BLOQUEADO_EXTERNO) |
| E15 — Onboarding de producto | **Construida, sin auditar** | Los 2 pasos que faltan del criterio de REQ-191 (verificación de correo, primera convocatoria); REQ-193 sin implementar; auditoría de la ronda 7 |
| E16 — Páginas públicas y legales | **Construida, sin auditar, con huecos** | Cablear el formulario de contacto al `POST /public/contact` que ya existe; `sitemap.xml`; analítica (REQ-198); validación por abogado (BLOQUEADO_EXTERNO); auditoría de la ronda 7 |
| E17 — Preparación de despliegue | **Escrita y validada estáticamente** | `docker build` y `docker compose up` reales (Docker no disponible); healthcheck de `apps/worker` y consumo de healthchecks en el compose; auditoría de infra (no existe) |
| E18 — Restos de mail (BAJA) | ML-06, ML-08, ML-09 abiertos, documentados | Decisión de si se abre una vuelta más; hoy no bloquean |
| E19 — Google: desvinculación (GO-09, BAJA) | No construido | Ningún REQ vigente lo exige; nota de diseño |
| E20 — Índice de `correlation_id` en `agent_runs` | En curso (#116, migración 0088 sin commitear) | Commit + test |
| E21 — API: perfil y sesiones | No construido | Brecha de paridad detectada en la ronda 8a de `apps/web` (`/configuracion` declara honestamente que la API no expone desactivar 2FA, códigos de respaldo ni sesiones) |

---

## 2. Conteo por épica E0–E12 (`docs/BACKLOG.md`) — **ámbito: las 186 filas de REQ-001..171 + A1–A15**

> **Alcance de las secciones 2 y 3.** Ambas tablas se calcularon en el cierre de la ronda 5 sobre las 186 filas originales y **no incluyen las 51 filas de la Ampliación 2** (REQ-172..210, S1–S12), cuyos conteos por paquete y por épica están en las secciones 1.2 y 1.3 de arriba. Se conservan aquí sin recalcular porque las épicas E0–E12 no cambiaron de contenido en las rondas 6–8a; **sí cambiaron dos de sus filas de estado**, ya reflejadas en `docs/ACEPTACION.md` y no en estas dos tablas: REQ-051..055 (E11) pasan de PENDIENTE a EN_EVIDENCIA con la ronda 6 de `apps/api`, y REQ-169 (E10) pasa de PENDIENTE a EN_EVIDENCIA con el panel real de la ronda 7. Recalcular las tablas 2 y 3 completas exige un pase de mapeo REQ→épica que este pase no ejecutó; se declara como deuda en vez de inventarse.


Las épicas se solapan por diseño (dependencia técnica, no partición) — un REQ puede pertenecer a más de una épica; por eso las filas no sumarán 171 (suman 184: 13 REQ contados en 2 épicas).

| Épica | PENDIENTE | EN_EVIDENCIA | CUMPLIDO | LÍMITE_ACEPTADO | BLOQUEADO_EXTERNO | NO_APLICA | Total REQ | Estado |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| E0 — Gobierno del ciclo | 5 | 4 | 3 | 0 | 0 | 0 | 12 | EN CURSO (permanente) — REQ-131 (aviso de privacidad versionado) pasa a EN_EVIDENCIA en ronda 5 |
| E1 — Fundamentos de plataforma | 6 | 5 | 7 | 3 | 0 | 0 | 21 | **CERRADO con reverificación** (límites AG-05/AG-12 documentados) |
| E2 — Perfil de empresa y datos reales | 4 | 1 | 3 | 0 | 0 | 1 | 9 | EN CURSO — REQ-142 (procedencia vinculante, ya aplicada) CUMPLIDO en ronda 5; sigue sin tests dedicados de rol/firmante (REQ-144/145) |
| E3 — Ingesta oficial y frescura | 2 | 10 | 3 | 0 | 0 | 0 | 15 | **CERRADO con reverificación** (mecanismo); real vs. ComprasMX BLOQUEADO_EXTERNO (B-02) |
| E4 — Detección de cambios y versiones | 1 | 2 | 4 | 0 | 0 | 0 | 7 | **CERRADO con reverificación** |
| E5 — Matching (relevancia y elegibilidad) | 8 | 3 | 3 | 0 | 0 | 0 | 14 | EN CURSO (pgvector REQ-061 no construido) |
| E6 — Análisis de bases y matriz de requisitos | 6 | 4 | 0 | 0 | 1 | 0 | 11 | PENDIENTE (OCR/gold set no construidos); UI de Análisis de bases ya conectada en ronda 5 (no cambia el estado de los REQ de motor/OCR) |
| E7 — Expediente de participación | 9 | 3 | 12 | 0 | 0 | 1 | 25 | **CERRADO con reverificación** (biblioteca+API+UI) — ronda 5 conecta el resto de `apps/web` (Expediente, Revisión, Paquete descargable); sin cambio de conteo REQ (A13 pasa a CUMPLIDO en la tabla de pruebas mínimas, no en esta tabla de REQ) |
| E8 — Auditoría, aprobación y entrega | 5 | 3 | 7 | 1 | 0 | 1 | 17 | EN CURSO → **2FA/step-up TOTP CERRADO en ronda 5** (REQ-044/064, incl. `tool_calls` vía R5-11); **2026-09-10: "sala de guerra" (REQ-040) construida** (EN_EVIDENCIA, falta reverificación adversarial); sigue faltando passkey/WebAuthn y el juez LLM (bloqueado por OpenAI) |
| E9 — Reglas duras de seguridad (transversal) | 2 | 1 | 3 | 4 | 0 | 1 | 11 | **CERRADO con reverificación** (límites AG-05/AG-12 documentados); sin cambio en ronda 5 |
| E10 — Back office / observabilidad | 5 | 1 | 5 | 0 | 0 | 0 | 11 | EN CURSO → **casi cerrado**: ronda 5 conecta Usuarios/roles, Auditoría (con traza por `correlationId`) y Aprobaciones cross-org (REQ-170/171 CUMPLIDO); queda REQ-169 (dashboard de métricas, `PanelPage.tsx` sigue `EmptyState`) |
| E11 — Seguimiento post-adjudicación | 5 | 0 | 1 | 0 | 1 | 0 | 7 | EN CURSO (corregido: post-award existe desde ronda 3 — `post-award.routes.ts`, migración 0032, tests; ronda 5 añadió estructura por tipo, alertas y calendario oficial real; REQ-050 CUMPLIDO; REQ-056 BLOQUEADO_EXTERNO parcial por calendario SABG vacío sin fuente en línea; REQ-051..055 confirmados PENDIENTE, no despachados) |
| E12 — Marco legal mexicano | 10 | 13 | 0 | 1 | 0 | 0 | 24 | EN CURSO / bloqueado en puntos VERIFICAR y validación por abogado — REQ-119 (aviso de privacidad) pasa a EN_EVIDENCIA en ronda 5 |

**Lectura**: E1, E3, E4, E7 y E9 ya cerraban con reverificación independiente desde ronda 4. La ronda 5 no cierra épicas nuevas por completo, pero corrige la fila más inexacta del tablero anterior (**E11**, que decía "0% construido" pese a tener código real desde ronda 3) y hace avances reales en **E8** (2FA/step-up TOTP, incl. `tool_calls`) y **E10** (back office completo salvo el dashboard de métricas). E6 (análisis de bases/OCR, motor) y E5 (pgvector) siguen sin trabajo de código nuevo: dependen de decisiones de alcance (gold sets, embeddings reales) no tomadas.

## 3. Conteo por paquete responsable primario — **ámbito: los 171 REQ de REQ-001..171**

Cada REQ se asignó a **un solo paquete primario** (el primero listado en su columna "Paquete(s)" de `docs/ACEPTACION.md`) para que las columnas sumen 171; esto es distinto del conteo por épica (que sí solapa). Nota de transparencia: REQ-165 es un caso compuesto real (CUMPLIDO para `packages/expediente`, LÍMITE_ACEPTADO para `packages/agents` por AG-05) — aquí se cuenta una sola vez bajo `packages/expediente`, por lo que la fila de `packages/agents` (LÍMITE_ACEPTADO=4) no incluye ese REQ; el conteo total de LÍMITE_ACEPTADO de la sección 1 (5) sigue siendo la cifra autoritativa.

| Paquete | PENDIENTE | EN_EVIDENCIA | CUMPLIDO | LÍMITE_ACEPTADO | BLOQUEADO_EXTERNO | NO_APLICA | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| packages/sources | 4 | 12 | 7 | 0 | 0 | 0 | 23 |
| packages/expediente | 12 | 8 | 11 | 0 | 1 | 1 | 33 |
| packages/agents | 13 | 5 | 8 | 4 | 0 | 0 | 30 |
| packages/db | 3 | 4 | 8 | 0 | 0 | 0 | 15 |
| apps/api | 3 | 2 | 4 | 0 | 0 | 0 | 9 |
| apps/web | 7 | 3 | 4 | 0 | 0 | 0 | 14 |
| apps/worker | 0 | 3 | 1 | 0 | 0 | 0 | 4 |
| docs/legal | 3 | 11 | 0 | 0 | 0 | 0 | 14 |
| transversal / gobierno | 8 | 1 | 1 | 0 | 1 | 0 | 11 |
| fundador (decisión reservada) | 2 | 0 | 0 | 0 | 0 | 0 | 2 |
| sin paquete (WhatsApp, voz, OCR, ML, post-adjudicación, comprador, KYC) | 14 | 0 | 0 | 0 | 0 | 2 | 16 |
| **Total** | **69** | **49** | **43** | **4** | **2** | **3** | **170*** |

`*` 171 REQ reales; ver la nota de REQ-165 (compuesto, contado una sola vez) ya documentada más abajo — la cifra autoritativa de `LÍMITE_ACEPTADO` es 5 (sección 1), no 4.

**Cambios de ronda 5** (deltas sobre el snapshot `e61156e`): `apps/web` (REQ-044, REQ-170: PENDIENTE→CUMPLIDO), `apps/api` (REQ-064, REQ-142, REQ-171: PENDIENTE→CUMPLIDO), `packages/expediente` (REQ-050: EN_EVIDENCIA→CUMPLIDO; REQ-056 se reclasifica de "sin paquete" a `packages/expediente` porque ya tiene código real — tabla `calendar_holidays` + endpoints — aunque quede BLOQUEADO_EXTERNO parcial por el calendario oficial vacío), `docs/legal` (REQ-119, REQ-131: PENDIENTE→EN_EVIDENCIA).

**Lectura**: `apps/web` deja de ser el paquete con más deuda relativa — ronda 5 conecta el resto de módulos de dominio y todo el back office (ver E7/E10 en la sección 2); su PENDIENTE remanente (7) es sobre todo dashboard de métricas (REQ-169, PanelPage) y detalles de rol/firmante en Empresa (REQ-144/145). `apps/worker` sigue siendo el único paquete sin filas en PENDIENTE. `packages/agents` sigue siendo el paquete con más filas de `LÍMITE_ACEPTADO` (AG-05 y AG-12, sin cambio en ronda 5).

## 4. Defectos abiertos por severidad (estado real a `9a12173`)

### 4.1 ALTAS y MEDIAS abiertas o reparadas sin reverificar

| ID | Paquete | Severidad | Estado real | Resumen y evidencia |
|---|---|---|---|---|
| R6-11 | apps/api | **ALTA** | **REPARADO, sin reverificación independiente** | Los límites anti «PDF bomb» se evaluaban DESPUÉS de extraer todo el texto: 263 KB de entrada = 42 s de CPU en el handler HTTP, y el límite de 500 páginas ni se disparaba. Corregido en `260a4df`: `extractPdfPages` comprueba `pdf.numPages` inmediatamente tras `getDocument`, acumula caracteres y tiempo página a página, aborta al cruzar cualquier límite y cede el bucle de eventos cada 20 páginas. Reproducción real del ataque del auditor (20.000 páginas en blanco, ~260 KB, generadas con `pdf-lib`): código viejo en rojo (52,8 s), nuevo en verde (<2 s), `apps/api/test/expediente-text-extraction.test.ts` caso «R6-11». Levantado en `docs/auditoria-2/api-ronda6-reverificacion.md`. **Falta la vuelta de reverificación independiente del arreglo.** |
| GO-10 | apps/api | **ALTA** | **REPARADO, sin reverificación independiente** | El login repetido con Google (identidad ya vinculada) no fijaba `app.current_user_id`, de modo que `app.my_organizations()` y la política RLS de `user_totp_secrets` no veían nada: la sesión caía en `sin_acceso` indebido y **el segundo factor no se exigía** (bypass de REQ-176). Corregido en `0e130ae`; 2 tests nuevos en `apps/api/test/google-oidc-login.test.ts`, verificados en rojo antes del arreglo (`sin_acceso` en vez de `ok`/`requires_2fa`). Documentado en `docs/auditoria-2/api-google.md`. |
| R6-12 | apps/api | MEDIA | **REPARADO, sin reverificación independiente** | `GET /expediente/renewals/alerts` no paginaba: 60.000 alertas / 32,4 MB medidos en una sola respuesta. Corregido en `527eba7` con el mismo patrón keyset de `GET /organizations/:orgId/memberships` (`limit` 100 por defecto, máximo 1000, `nextCursor`, columnas explícitas). Test nuevo con 1.000 alertas sembradas. |
| WK6-04 | apps/worker | MEDIA | **ABIERTO — en cola** | El `correlationId` de negocio **no se valida ni se sanea en ningún punto de `apps/worker`**: 10 KB se propagan íntegros a cada línea de log (21 KB por un job de 2 líneas) y a la base; RTL/ANSI/saltos de línea sobreviven verbatim; un byte NUL rompe el encolado (`unsupported Unicode escape sequence`). **No es alcanzable desde fuera hoy** porque `apps/api` filtra el encabezado a UUID en su frontera, pero el worker no tiene defensa propia ni lo declara en su README. Levantado en `docs/auditoria-2/worker-agentes-reverificacion.md`. |
| R6-10 | apps/api | MEDIA | **ABIERTO — en cola (#117)** | El test del `UPDATE` condicionado de R6-04 pasa igual **sin** la corrección (mutación VERDE): el 409 lo produce `checkTransition`, no el `UPDATE`. El código de R6-04 es correcto; el test no mide lo que dice medir. |
| R6-13 | apps/api | MEDIA | **ABIERTO — en cola (#117)** | Suite de `apps/api` intermitente (342/343 → 343/343) por un flake de ventana TOTP en `apps/api/test/helpers.ts`. |
| R6-09 (criterio) | apps/api | — | **ABIERTO — en cola (#117)** | El criterio estructural de rendimiento del radar se satisface trivialmente con una consulta sin límite; lo salva el test vecino de paginación. Reformularlo con `LIMIT` explícito. |
| R6-14 | apps/api | BAJA | **ABIERTO — en cola (#117)** | Test/criterio que no mide lo que declara. |
| ML-08 | packages/mail | BAJA | **ABIERTO, documentado** | La ventana de espera del perdedor de la reserva de idempotencia (~200 ms) es más corta que el timeout documentado del proveedor (5 s): bajo latencia real el resultado es un `already_sent` ambiguo sin id. **No llega a duplicar el envío** (la garantía de ML-01 se sostiene con 50 llamadas concurrentes). `docs/auditoria-2/mail-reverificacion.md`. |
| ML-09 | packages/mail | BAJA | **ABIERTO, documentado** | Sin respaldo `@media (prefers-color-scheme: dark)`: la única defensa contra el oscurecimiento automático de algunos clientes son las etiquetas `light only`, sin redundancia. No confirmado en cliente real. |
| ML-06 | packages/mail | BAJA | **ABIERTO, deliberadamente no corregido** | 7 vulnerabilidades de `npm audit`, todas en dependencias de desarrollo; `npm audit --omit=dev` = **0**. Reconfirmado en la reverificación. |
| GO-01 | gobierno | MODERADA | **PARCIALMENTE CERRADO por este pase** | El texto de REQ-174 no coincidía con el comportamiento real (`sin_acceso`, sin organización automática). La decisión **D-09** ya lo reconcilió y `docs/ACEPTACION.md` queda alineado con este pase. **Residual**: el criterio verificable de `docs/REQUISITOS.md:361` todavía dice «usuario y organización creados en una sola operación» — corregirlo exige reformular el texto del requisito, fuera del ámbito de este pase. |
| GO-09 | apps/api | INFORMATIVA | ABIERTO por diseño | No existe endpoint de desvinculación de la cuenta de Google; ningún REQ vigente lo exige (E19). |
| R5-12 | apps/web | BAJA | **ABIERTO desde la ronda 5** | Comentario desactualizado en `apps/web/src/lib/api/twofa.ts:33-35` sobre el alcance de `/2fa/verify-enrollment`. Sin código ejecutable ni impacto funcional. |

**GO-02 queda obsoleto**: decía que el botón de Google no existía en `apps/web`; existe desde `11d48e0`/`fbe9614`. El texto de `docs/auditoria-2/api-google.md` es anterior a esos commits.

### 4.2 Hallazgos CERRADOS desde el tablero anterior (con cadena completa)

| Bloque | Hallazgos | Cierre |
|---|---|---|
| `packages/mail` | ML-01 (ALTA, idempotencia bajo concurrencia), ML-02 (ALTA, `List-Unsubscribe`), ML-03 (MEDIA, `safeUrl`/SSRF), ML-04 (MEDIA, contraste WCAG), ML-05 (MEDIA, replay de webhooks Svix) | **CERRADOS con reverificación independiente** (`mail-reverificacion.md`): 50 envíos concurrentes → 1; 12 vectores SSRF, 0 bypass; 6 escenarios de replay, 0 bypass; cabeceras correctas en las 16 plantillas; `faint` a 4.92:1/4.67:1 |
| `apps/worker` ronda K | WK6-01 (ALTA, evals de aislamiento que no detectaban fuga real), WK6-02 (ALTA, `correlationId` de negocio sin persistir), WK6-03 (BAJA, timeout) | **CONFIRMADOS REPARADOS** (`worker-agentes-reverificacion.md`): 383/383 en dos pasadas, 22/22 archivos, 0 timeouts; dos mutaciones propias del reverificador (incluida una fuga camuflada en un resultado «no evaluable») **detectadas** |
| `apps/api` ronda 6 | R6-01/R6-02 (ALTA, `pdf-parse` no leía xref-stream), R6-03 (ALTA, radar N+1 de 17–28 s), R6-04..R6-08 | **8 de 9 CONFIRMADOS por mutación inversa** (`api-ronda6-reverificacion.md`); R6-04 es la excepción (test vacuo → R6-10) |
| Google | GO-03 (BAJA, `OIDC_ISSUER_URL` sin exigir https), GO-07 (MODERADA, `23505` sin capturar → 500) | REPARADOS (`c4a0cf9`, `da18559`) con tests rojos verificados antes del arreglo; **sin reverificación independiente** |

### 4.3 Límites aceptados (regla de 3 vueltas)

Sin cambios respecto al tablero anterior: **AG-05** y **AG-12** (`packages/agents`), **SR-25** y el reporte cooperativo de descartes (`packages/sources`), **EX-EXP-08** y **EX-EXP-10** (`packages/expediente`), **DB-07** y **DB-09** (`packages/db`), **WK-04 / WK-08** (`apps/worker`, concurrencia real de `jobs` no reproducible en PGlite). Informes citados en `docs/auditoria-1/*-cierre*.md` y `db-api-seguridad-reverificacion.md`.

### 4.4 Bloqueos externos y decisiones del usuario pendientes

| ID | Estado | Qué bloquea | Qué desbloquea al resolverse |
|---|---|---|---|
| B-01 | ABIERTO — decisión del usuario | Ruta definitiva de la carpeta "empresas agénticas" no verificada | Solo la ubicación del repositorio final; ningún REQ. Ligado a INC-10 (el repo vive bajo iCloud Drive) |
| B-02 | ABIERTO — externo | ComprasMX (401 + reCAPTCHA), OCDS-SHCP inalcanzable, PDN-S6 con bot-detection, portales estatales sin API localizable | REQ-001/132/133/135/150 pasarían de fixture a integración real |
| B-03 | CERRADO (remoto) | Repositorio privado creado y subido; GitHub y Vercel autorizados por el usuario el 2026-09-06 12:4x | — |
| B-04 | ABIERTO — decisión del usuario | Modelo comercial no definido (B2B directo vs self-serve con planes/checkout) | Determina si se construyen precios, trial y checkout; hoy la landing dice «Solicitar demo» |
| B-05 | EN CURSO | 479 commits con autoría de correo no verificado no cuentan como contribuciones en GitHub | Reescritura única de autoría en una ventana sin agentes escribiendo |
| B-06 | ABIERTO — decisión del usuario | **GitHub Actions no ejecuta ningún job**: «recent account payments have failed or your spending limit needs to be increased». Es facturación, no el workflow (`actionlint` limpio) | REQ-045/087/095/097/138 (gates de CI real) y el job `db-postgres` (migraciones + 622 ataques RLS sobre Postgres 16 real); WK-04/WK-08 podrían cerrarse |
| B-07 | ABIERTO — decisión del usuario | **Vercel Deployment Protection**: el despliegue está Ready en `https://atiende-licitaciones.vercel.app` pero responde con la pantalla de login de Vercel; el sitio no es público | Verificación real de la landing y las páginas públicas en producción |
| INC-10 | ABIERTO — decisión del usuario | El repositorio está dentro de iCloud Drive (`~/Documents`): carga de CPU de `bird`/`fileproviderd`/`cloudd`, copias «archivo 2.ts» (INC-07) y parte de los timeouts bajo coverage | Estabilidad de las suites largas; ligado a B-01 |
| — | ABIERTO — externo | Sin Docker en el entorno; sin credenciales de Google Cloud; sin proveedor de correo con dominio SPF/DKIM ni `RESEND_WEBHOOK_SECRET`; sin OpenAI real; sin validación por abogado mexicano | REQ-178/199/200 y S11; el juez LLM y el componente semántico de matching; las 21 filas legales |

### 4.5 Incidentes de gobierno

INC-01 a INC-09 permanecen como en el tablero anterior (todos CERRADOS salvo INC-08, en observación, e INC-10, decisión del usuario). Nuevos desde entonces: **INC-11** (dos descendientes despachados como investigación de solo lectura escribieron código en paralelo sobre el mismo árbol, migraciones 0065 duplicadas; corregido y renumerado por el agente principal — regla reforzada: descendientes solo leen o trabajan en worktree), **INC-12** y **INC-13** (límite de sesión y limitación del servidor de Anthropic cortaron 5 agentes Sonnet en curso; reanudados por `SendMessage` con contexto intacto y, tras **D-10**, relanzados con `model="opus"` como respaldo autorizado por el usuario). Detalle en `docs/BLOQUEOS.md`.

## 5. Conteo de tests por workspace (corridas reales citadas, no estimaciones)

| Paquete/app | Archivos | Tests | Corrida citada |
|---|---:|---:|---|
| apps/api | 74 | **350** | `npm run -w apps/api test`, **dos pasadas idénticas** `EXIT=0` — `docs/logs/api-mail.log` |
| apps/worker | 22 | **383** | `npm run -w apps/worker test`, **dos pasadas** sin un solo timeout — `docs/logs/reverify-r6-wk6.log` (worktree aislado del reverificador) |
| packages/mail | 26 | **252** | `npm run -w packages/mail test`, dos pasadas — `docs/logs/reverify-mail.log`; cobertura 96.26 / 85.17 |
| packages/db | 27 | **205** | `npm run -w packages/db test` `EXIT=0` — `docs/logs/api-mail.log` |
| apps/web (unit/componente) | 39 | **162** | `npm run -w apps/web test`, **cuatro pasadas idénticas** — `docs/logs/web-ronda8.log` |
| apps/web (`test:e2e:full`) | — | **137** | Navegador real + `apps/api` real (PGlite) + proveedor OIDC falso en loopback — `docs/logs/web-ronda8.log`, `exit code: 0` |
| packages/agents | 13 | **263** | `docs/logs/ci-local-5.log` (sin cambios de código desde entonces) |
| packages/expediente | 16 | **413** | `docs/logs/ci-local-5.log` |
| packages/sources | 20 | **204** | `docs/logs/ci-local-5.log` |
| **Total unit/integración** | **237 archivos** | **2.232 tests** | suma de las 9 filas |
| **Total incl. E2E de navegador** | — | **2.369 tests** | 2.232 + 137 |

**Honestidad sobre el gate agregado.** No existe hoy una corrida de `ci-local` completa y verde posterior a las rondas 6–8a: `docs/logs/ci-local.log` está **modificado en el árbol de trabajo por otro agente** y la última corrida agregada cerrada (`ci-local-5.log`) es anterior a `packages/mail`, a la integración de correos y a las rondas 7/8a. Las cifras de arriba proceden de **corridas aisladas por workspace**, cada una con su log citado, que es la fuente de verdad mientras no se repita `ci-local` completo sin otra carga concurrente en la máquina (INC-10). El job `db-postgres` (migraciones + ataques RLS sobre Postgres 16 real) sigue sin ejecutarse nunca: solo corre en GitHub Actions, hoy bloqueado por **B-06** (facturación), no por B-03.

**Trabajo sin commitear en el árbol al momento de este pase** (de los despachos #116 y #117, en curso): `apps/worker/src/handlers/mail-retry.ts`, `apps/worker/src/mail/`, `apps/worker/test/mail-retry-handler.test.ts`, `packages/db/migrations/0087_req188_mail_retry_audit.sql`, `0088_e20_agent_runs_correlation_id.sql` y modificaciones en `apps/worker/src/index.ts` y `apps/api/src/modules/expediente/contract.routes.ts`. **Nada de eso cuenta en este tablero**: los estados de arriba se calcularon contra HEAD `9a12173`.

## 6. Qué falta para poder promocionar, en orden de bloqueo

**Bloquea la promoción hoy (decisión o credencial del usuario):**
- **B-07 — Deployment Protection de Vercel**: el sitio desplegado no es público. Sin esto no hay nada que promocionar, por bueno que sea el código.
- **B-06 — facturación de GitHub Actions**: ningún job de CI ha llegado a arrancar. Sin esto, los gates formales de CI (REQ-045/087/095/097/138) siguen estructuralmente PENDIENTE y el job con Postgres real nunca se ejecuta.
- **Proveedor de correo real** (Resend/Postmark/SMTP con dominio verificado SPF/DKIM + `RESEND_WEBHOOK_SECRET`): hoy todo el correo se prueba contra la bandeja de captura. Sin proveedor, ni la verificación de correo ni la recuperación de contraseña funcionan para un usuario real.
- **Credenciales de Google Cloud** (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` + dominio autorizado): el botón de Google existe y funciona contra un proveedor OIDC falso, nunca contra Google.
- **Host de API/worker y Postgres gestionado**: `apps/web` está en Vercel; `apps/api`, `apps/worker` y la base no tienen destino decidido.
- **B-04 — modelo comercial**: determina si la landing lleva precios y checkout o se queda en «Solicitar demo».
- **Validación por abogado mexicano** de los términos y el aviso de privacidad, ambos publicados hoy como `borrador_pendiente_validacion_juridica`.

**Bloquea el cierre formal de la Ampliación 2 (trabajo interno, sin dependencias externas):**
- **Auditoría adversarial + reverificación de `apps/web` rondas 7/8a** — no existe ningún informe (REQ-210).
- **Auditoría de `infra/`** — no existe ningún informe; toda la validación fue estática.
- **Reverificación independiente de las correcciones de Google** (GO-03/GO-07 y sobre todo **GO-10, ALTA**) y de **R6-11 (ALTA)** y R6-12.
- **Cierre de la auditoría de la integración de correos en `apps/api`** (#115, en curso).
- **Handler `mail_retry` de `apps/worker`** (#116): hoy `apps/api` encola el job y nadie lo consume, así que S7 no está realmente verde.
- **WK6-04**: sanear el `correlationId` en `apps/worker`.
- **R6-09/R6-10/R6-13/R6-14** (#117): tests y criterios que no miden lo que dicen medir.

**Huecos funcionales concretos de la Ampliación 2, medidos contra la letra de su propio criterio:**
- **REQ-193**: ninguna página pasa `actionLabel`/`onAction` a `EmptyState` — ningún estado vacío ofrece la siguiente acción.
- **REQ-198**: no hay analítica de ningún tipo.
- **REQ-196 / S10**: el `POST /public/contact` existe y está probado, pero el formulario de la landing tiene el botón deshabilitado y un `onSubmit` que solo hace `preventDefault()`.
- **REQ-191 / S8**: el onboarding tiene 5 pasos, no los 6 del criterio (faltan verificación de correo y primera convocatoria).
- **REQ-197**: no existe `sitemap.xml`; `robots.txt` es `Disallow: /` y `index.html` fija `noindex, nofollow` — correcto antes del lanzamiento, contrario a la letra del criterio.
- **REQ-202**: `apps/worker` no expone healthcheck y el compose de producción solo declara `healthcheck:` para postgres — ningún servicio de aplicación está condicionado a salud.
- **REQ-175**: sin prueba de contrato de paridad de tokens ni de rotación de un refresh emitido por Google.
- **REQ-177**: `audit_log.correlation_id` queda NULL en todo evento de autenticación (con paridad exacta respecto a email+contraseña, que tampoco lo llena).
- **REQ-182**: falta el test estático que el propio requisito exige.
- **REQ-185**: 0 menciones a Likida en la salida renderizada (grep registrado en log), pero sin test que lo guarde y con 11 menciones vivas en comentarios de `packages/mail/src/**` y su README.

**Funcionalidad de fondo que sigue en 0% (sin cambios respecto al tablero anterior):** OCR real; firma electrónica del lado del cliente; envío real a portal oficial (**nunca se construirá, REQ-046**); integraciones reales de fuentes oficiales (B-02); OpenAI real; WhatsApp y voz; pgvector; capa LLM del guardrail anticolusión (AG-12); calendario oficial de días inhábiles cargado con fechas reales (REQ-056).
