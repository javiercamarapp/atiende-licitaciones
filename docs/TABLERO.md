# TABLERO — Atiende Licitaciones

**Fecha**: 2026-09-05, ~20:31 CST. **Commit HEAD al momento de este corte**: `d94b228022cf064eaa5fcc9c3eb36917910509f0`.

**Advertencia de gobierno (léase antes de usar este tablero)**: este repositorio recibe commits concurrentes de múltiples agentes en tiempo real (varias rondas de corrección — `apps/api` ronda 2, `apps/worker` WK-01..13, `packages/agents` AG-17..20, `packages/expediente` ronda 2, `packages/sources` reverificación — estaban activas mientras se construía este documento). El HEAD citado arriba es el commit exacto usado para los conteos de esta versión; un `git log` posterior mostrará más commits. Este tablero es un snapshot, no un dashboard en vivo. Fuente primaria de cada fila: `docs/ACEPTACION.md` (186 filas: 171 REQ + 15 pruebas mínimas A1-A15), `docs/auditoria-1/*.md`, `docs/PROGRESO.md`, `docs/BLOQUEOS.md`, `docs/DECISIONES.md`, y ejecución directa de `npm test` por workspace en este corte.

**Regla de lectura**: ningún estado `CUMPLIDO` en este tablero corresponde a un mock, fixture, o integración simulada. `EN_EVIDENCIA` es, en este momento del proyecto, el estado modal esperado: código + test en verde, muchas veces ya corregido tras auditoría adversarial, pero **sin una reverificación independiente que certifique el cierre** — ese es, con diferencia, el cuello de botella de gobierno más grande del proyecto ahora mismo (ver sección final).

---

## 1. Conteo por estado (docs/ACEPTACION.md, 186 filas = 171 REQ + 15 A)

| Estado | Filas | % |
|---|---:|---:|
| PENDIENTE | 92 | 49.5% |
| EN_EVIDENCIA | 82 | 44.1% |
| CUMPLIDO | 7 | 3.8% |
| NO_APLICA_A_PAQUETE | 4 | 2.2% |
| BLOQUEADO_EXTERNO | 1 | 0.5% |
| **Total** | **186** | **100%** |

Los 7 `CUMPLIDO`: REQ-029 (casos borde de dinero), REQ-046 (sin envío automático a ComprasMX), REQ-086 (redacción de trazas), REQ-125 (tolerancia cero, 5 componentes), REQ-126 (5 gates de cambio de modelo — lógica de código, no el artefacto documental en `tasks/evidence/`), REQ-140 (proceso de revisión de bloqueos), REQ-157 (rechazo de tarifas no aprobadas) y REQ-165 (superficie sin envío/firma en `packages/expediente`). Ninguno depende de una integración externa real ni de un mock.

## 2. Conteo por épica (E0-E12, `docs/BACKLOG.md`)

Las épicas se solapan por diseño (dependencia técnica, no partición) — un REQ puede pertenecer a más de una épica; por eso las filas no sumarán 171.

| Épica | PENDIENTE | EN_EVIDENCIA | CUMPLIDO | BLOQUEADO_EXTERNO | NO_APLICA | Total REQ | Estado BACKLOG.md |
|---|---:|---:|---:|---:|---:|---:|---|
| E0 — Gobierno del ciclo | 6 | 4 | 2 | 0 | 0 | 12 | EN CURSO |
| E1 — Fundamentos de plataforma | 6 | 14 | 0 | 0 | 1 | 21 | EN CURSO (ronda 1) |
| E2 — Perfil de empresa y datos reales | 6 | 2 | 0 | 0 | 1 | 9 | PENDIENTE |
| E3 — Ingesta oficial y frescura | 2 | 13 | 0 | 0 | 0 | 15 | PENDIENTE (mayormente en evidencia) |
| E4 — Detección de cambios y versiones | 1 | 6 | 0 | 0 | 0 | 7 | PENDIENTE (mayormente en evidencia) |
| E5 — Matching (relevancia y elegibilidad) | 10 | 4 | 0 | 0 | 0 | 14 | PENDIENTE |
| E6 — Análisis de bases y matriz de requisitos | 7 | 3 | 0 | 1 | 0 | 11 | PENDIENTE |
| E7 — Expediente de participación | 9 | 13 | 2 | 0 | 1 | 25 | PENDIENTE (mayormente en evidencia) |
| E8 — Auditoría, aprobación y entrega | 7 | 7 | 2 | 0 | 1 | 17 | PENDIENTE |
| E9 — Reglas duras de seguridad (transversal) | 2 | 6 | 2 | 0 | 1 | 11 | PENDIENTE |
| E10 — Back office / observabilidad | 7 | 3 | 1 | 0 | 0 | 11 | PENDIENTE |
| E11 — Seguimiento post-adjudicación | 7 | 0 | 0 | 0 | 0 | 7 | PENDIENTE (0% construido) |
| E12 — Marco legal mexicano | 12 | 12 | 0 | 0 | 0 | 24 | PENDIENTE / bloqueado en puntos VERIFICAR |

**Lectura**: E11 (seguimiento post-adjudicación) tiene 0% de código — ningún REQ-050 a REQ-056 tiene evidencia. E5 (matching) está mayormente PENDIENTE porque el motor de relevancia/elegibilidad léxico existe en `packages/sources` pero la exposición vía `apps/api`/`apps/web` no. E3/E4 (ingesta y versionado) son, junto con E7, las épicas con más evidencia real construida — pero ninguna tiene un solo REQ `CUMPLIDO` porque ninguna tiene reverificación independiente cerrada.

## 3. Conteo por paquete responsable

Una fila de ACEPTACION.md puede listar más de un paquete responsable (trabajo cruzado); las columnas no suman 186.

| Paquete | PENDIENTE | EN_EVIDENCIA | CUMPLIDO | BLOQUEADO_EXTERNO | NO_APLICA |
|---|---:|---:|---:|---:|---:|
| packages/agents | 17 | 16 | 4 | 0 | 0 |
| packages/expediente | 23 | 26 | 4 | 0 | 1 |
| packages/sources | 5 | 23 | 1 | 0 | 0 |
| packages/db | 10 | 15 | 1 | 0 | 1 |
| apps/api | 13 | 6 | 0 | 0 | 0 |
| apps/web | 17 | 10 | 0 | 0 | 0 |
| apps/worker | 0 | 9 | 0 | 0 | 0 |
| docs/legal | 5 | 9 | 0 | 0 | 0 |
| transversal / gobierno | 10 | 3 | 1 | 0 | 0 |
| fundador (decisión reservada) | 2 | 0 | 0 | 0 | 0 |
| sin paquete (funcionalidad no construida: WhatsApp, voz, OCR, ML, post-adjudicación, back-office comprador) | 18 | 0 | 0 | 1 | 2 |

**Lectura**: `apps/web` es el paquete con más deuda relativa a lo ya construido en otros lados — tiene código (shell, sidebar, 24 rutas, a11y probada) pero **cero conexión a datos reales de `apps/api`** (ver §6). `apps/worker` es el único paquete con 0 filas en PENDIENTE (todo lo que le corresponde tiene al menos código+test), pero tampoco tiene ningún CUMPLIDO por falta de reverificación independiente.

## 4. Defectos abiertos por severidad (todas las auditorías, estado real a este commit)

### 4.1 Genuinamente abiertos (sin corrección, o corrección con veredicto explícito PARCIAL/NO CERRADO)

| ID | Paquete | Severidad | Estado | Resumen |
|---|---|---|---|---|
| EX-EXP-03 | packages/expediente | **CRÍTICA** | **NO CERRADO** (reverificación) | Un requisito `obligatoriedad:"condicional"` que aplica y no tiene evidencia mapeable sigue desapareciendo en silencio (0 secciones, 0 bloqueos) en `technical-proposal.ts` — el defecto original persiste bajo otra variante. |
| EX-EXP-04 | packages/expediente | **CRÍTICA** | PARCIAL | `assertExplicitOffset` no valida rango numérico del offset; un offset imposible (`"+99:00"`) produce `NaN`. |
| EX-EXP-13 | packages/expediente | **ALTA** (nuevo) | Abierto | Consecuencia directa de EX-EXP-04: `isPast()` con offset imposible evalúa `NaN` como `false` ("nunca vencido") — *fail-open* sobre la garantía de vigencias documentales, más grave que el bug original. |
| EX-EXP-05 | packages/expediente | ALTA | **NO CERRADO** (para esa familia de valores) | "Veintiuno" fusionado en centenas/millares/millones (121, 1121, 21121, 121000, 121000000, etc.) sigue imprimiéndose mal en `number-to-words.ts`. |
| EX-EXP-06 | packages/expediente | ALTA | PARCIAL | DD/MM/AAAA y "del AAAA" reconocidos; una fecha numérica ambigua (día y mes ambos ≤12, ej. 05/09) nunca se marca como ambigua ni con menor confianza. |
| EX-EXP-12 | packages/expediente | **ALTA** (nuevo) | Abierto | Mismo patrón que EX-EXP-03/05: la corrección original cubrió el ejemplo citado por el auditor, no la regla general. |
| EX-EXP-14 | packages/expediente | MEDIA (nuevo) | Abierto | `scope:"expediente"` con `scopeRef` inconsistente no se valida; cuenta igual como aprobación total. |
| EX-EXP-15 | packages/expediente | MEDIA (nuevo) | Abierto | Fecha numérica ambigua nunca marcada con menor confianza (mismo origen que EX-EXP-06). |
| EX-EXP-16 | packages/expediente | BAJA (nuevo) | Abierto | Docstring de `expediente-flow.test.ts` sobrevende cobertura de A6-A15, riesgo de inducir a error a un lector futuro. |
| REQ-143 (sin ID de auditoría) | packages/expediente | (equivalente a ALTA) | Detectado en esta ronda, sin auditoría formal | `CompanyExperienceRecord.evidenceDocId` requerido solo por tipos TypeScript, sin aserción runtime; 0 tests para `resolveExperience`. |
| API-07 | apps/api | BAJA | Abierto, sin corrección conocida | Token de invitación en claro se genera y descarta en la misma línea; irrecuperable para el flujo de aceptar invitación. |
| W-03 | apps/web | ALTA | Abierto, "bloqueado, fuera de ámbito" | No hay `package-lock.json` versionado en el monorepo (ni raíz ni `apps/web`) — requiere coordinación a nivel de todo el repo, no solo de `apps/web`. |
| AG-05 | packages/agents | MEDIA (límite de diseño reconocido) | No resoluble en este paquete | Un handler que miente simultáneamente en `riskLevel`+`actionKind`+`declaredEffects` evade `AuthorizationPolicy`; mitigación (checklist humano / sandbox) delegada a `apps/api`, no implementada. |
| WK-07 | apps/worker | MEDIA | **PENDIENTE ESQUEMA** | `toDbStatus()` colapsa `not_configured`/`rate_limited` a `failed`; requiere ampliar el enum `source_run_status` en `packages/db` (propuesta `db-proposals/PROPOSAL-01-widen-source-run-status.sql` sin aplicar); mitigación parcial ya en código. |
| REQ-142 | apps/api | (equivalente a ALTA funcional) | Sin corrección | `field_provenance` se registra pero **ningún consumidor rechaza/excluye datos sin procedencia** de matching/expediente — el criterio no se cumple aunque el esquema exista. |
| REQ-170 | apps/web | (bloqueante de épica E10 completa) | Sin corrección | Las 4 páginas de back office (`createModulePage()`) no hacen ningún fetch — ni mock ni real. Confirmado por el propio `apps/web/README.md`. |

### 4.2 Corregidos con commit+test, pendientes únicamente de reverificación adversarial independiente

Estos **no son defectos activos** en el sentido de "vulnerabilidad explotable hoy", pero **ningún REQ asociado puede marcarse CUMPLIDO** hasta que exista esa reverificación — es la brecha de gobierno más grande del proyecto (ver §6).

| Paquete | Hallazgos corregidos sin reverificación independiente | Reverificación independiente existe? |
|---|---|---|
| packages/db + apps/api | DB-01, DB-02, DB-03, DB-05 (ALTA); DB-04, DB-06, API-03, API-05 (MEDIA); DB-07, API-04, API-06 (BAJA) — 11 de 14 hallazgos | **NO existe** `db-api-reverificacion.md` ni equivalente |
| apps/worker | WK-01, WK-02, WK-03, WK-04, WK-13 (ALTA); WK-05, WK-06, WK-08 (MEDIA); WK-09, WK-10, WK-11, WK-12 (BAJA) — 12 de 13 hallazgos (WK-07 sigue pendiente de esquema, ver §4.1) | **NO existe** `worker-reverificacion.md` ni equivalente |
| packages/sources | SR-01 a SR-09, SR-11 (10 de 11 hallazgos; SR-10 era solo una nota documental de trazabilidad, ya resuelta) | **Reverificación DESPACHADA y en curso** (commit `46b5b26`), sin veredicto documental todavía |
| packages/agents | AG-17 (ALTA), AG-18, AG-19, AG-20 (MEDIA) — corregidos en esta misma ronda de reverificación, pero por el mismo reverificador que los descubrió, no por una "reverificación 2" independiente posterior | Reverificación ronda 1 SÍ existe y tiene veredicto (11 CERRADO/3 PARCIAL/0 NO CERRADO sobre los 14 hallazgos con código); los 4 nuevos (AG-17-20) están documentados como corregidos en el mismo archivo, no en una reverificación 2 separada |
| apps/web | W-01, W-02, W-04 a W-16 excepto W-03 (14 de 16 hallazgos) | Reverificación **en curso** (`docs/logs/reverify-web-ronda1.log`, 44/44 Playwright+axe verdes, capturas comparativas de login); **sin informe `.md` de veredicto todavía** |
| packages/expediente | EX-EXP-01, EX-EXP-02 (para su vector original), EX-EXP-07, EX-EXP-08, EX-EXP-09, EX-EXP-10, EX-EXP-11 — 7 de 16 hallazgos (originales + nuevos) | Reverificación ronda 1 SÍ existe con veredicto explícito (5 CERRADO / 4 PARCIAL / 1 NO CERRADO + 6 nuevos); corrección ronda 2 en curso, solo EX-EXP-01/11 cerrados hasta este commit |

### 4.3 Incidentes de gobierno (proceso, no código)

| ID | Estado | Resumen |
|---|---|---|
| B-01 | ABIERTO (externo) | Ruta definitiva de "empresas agénticas" no confirmada por el usuario; no bloquea el desarrollo técnico en staging. |
| B-02 | ABIERTO (externo) | ComprasMX protegido por reCAPTCHA (401/403); OCDS-SHCP inalcanzable; PDN-S6 con bot-detection; portales estatales sin API localizable. Bloquea toda integración real de `packages/sources` con fuentes oficiales. |
| B-03 | ABIERTO (decisión del usuario) | El job de CI `db-postgres` (migraciones + ataques RLS sobre Postgres 16 real) solo puede correr en GitHub Actions; requiere que el usuario autorice un remoto GitHub privado. Sin esto, CI real (REQ-045/087/095/097/138) no puede completarse. |
| INC-01 | CERRADO | Reescritura concurrente de `docs/REQUISITOS.md` por un agente con copia en memoria desactualizada; restaurado sin pérdida. |
| INC-02 | CERRADO | Commit de expediente arrastró archivos del agente legal por índice git compartido; sin pérdida de contenido. |
| INC-03 | CERRADO | Agentes concurrentes ejecutaron `git reset` sobre el repo compartido, descartando temporalmente commits ajenos; todo recuperado (verificado por reflog/`git fsck`); regla dura reforzada (prohibido `git reset`/`checkout <commit>`/`stash`/reescritura de historial, solo `git add <rutas>` + `git commit -- <rutas>`). |

## 5. Conteo de tests por paquete (ejecución directa en este commit, `npm run -w <paquete> test`)

| Paquete | Archivos | Tests | Resultado | Nota |
|---|---:|---:|---|---|
| packages/agents | 13 | 215 | 215/215 verde | Sube de 182 (reverificación ronda 1) a 215 tras AG-17..20 (commits `971feea`, `861aea4`). Cobertura previa reportada: 94.44%/91.28% líneas/ramas (gate en `vitest.config.ts`), no re-medida en este corte. |
| packages/db | 13 | 117 | 117/117 verde | Sube de 90 (ronda 1) a 117 tras las correcciones DB-01..07. Sin log dedicado en `docs/logs/` que documente este conteo — solo verificado por ejecución directa en este corte. |
| apps/api | 14 | 45 | 45/45 verde | Sube de 12 (ronda 1) a 45; incluye trabajo de ronda 2 (`company/routes.ts`, `matching/go-no-go.routes.ts`) sin log dedicado en `docs/logs/`. |
| apps/worker | 8 (+3 archivos `db-proposals/*.pending.test.ts` deliberadamente `skip`) | 55 (+5 skip) | 55/55 verde, 5 skip explícitos | Los 3 archivos/5 tests skip están a la espera de la propuesta de esquema WK-07 (`PROPOSAL-01-widen-source-run-status.sql`), no son fallos ocultos. |
| packages/sources | 13 | 95 | 95/95 verde | Coincide con `docs/logs/dbfa671`-referenced (log final ronda 1); cobertura reportada 91.53%/82.33% líneas/ramas. |
| packages/expediente | 15 | 330 | 330/330 verde | Sube de 118 (ronda 1) a 330 tras EX-EXP-01/11 (agrega `technical-proposal-property.test.ts` con 200 casos property-based). |
| apps/web (unit) | 10 | 38 | 38/38 verde | Vitest + Testing Library. |
| apps/web (E2E) | 9 specs | 44 | 44/44 verde | Playwright + axe, Chromium real, 24 rutas del sidebar; reproducido también en la reverificación en curso. |
| **Total aproximado** | **~85 archivos** | **~939 tests** | Todos verdes en este corte | Ningún paquete tiene una suite roja en el commit HEAD citado arriba. Las suites de `apps/api`/`apps/worker` incluyen trabajo de ronda 2 en curso; su composición puede cambiar en el siguiente commit. |

## 6. Qué falta para 10/10 (viñetas concretas, no autoevaluación numérica)

**Gobierno / proceso (bloquea el mayor número de "EN_EVIDENCIA → CUMPLIDO" del tablero):**
- Reverificación adversarial independiente de `packages/db` + `apps/api` (nunca se hizo; 13 hallazgos corregidos sin reverificar, ver §4.2). Sin esto, REQ-024, REQ-057 a REQ-064, REQ-073, REQ-083, REQ-141 a REQ-167 (multi-tenant, auditoría, perfil de empresa) no pueden pasar de EN_EVIDENCIA.
- Reverificación adversarial independiente de `apps/worker` (nunca se hizo; 12 de 13 hallazgos corregidos sin reverificar).
- Cerrar la reverificación 2 (adversarial, por alguien distinto de quien corrigió) de `packages/agents` sobre AG-17/18/19/20 — hoy solo está documentada por el mismo reverificador que los encontró.
- Cerrar y publicar el veredicto de la reverificación en curso de `apps/web` (44/44 verde, pero sin informe `.md` de cierre) y de `packages/sources` (recién despachada).
- Corrección ronda 2 completa de `packages/expediente`: EX-EXP-03 (NO CERRADO), EX-EXP-04/05/06 (PARCIAL/NO CERRADO), y los nuevos EX-EXP-12/13/14/15/16 siguen abiertos; solo EX-EXP-01/11 se cerraron en esta ronda.
- Decidir B-03: autorizar (o no) un remoto GitHub privado para que el job de CI real (`db-postgres`, migraciones+RLS sobre Postgres 16) pueda ejecutarse — sin esto, REQ-045/087/095/097/138 (gates de CI) quedan estructuralmente PENDIENTE.
- Adoptar el patrón `tasks/evidence/<id>/` literal (REQ-126/137) o documentar formalmente que `docs/logs/`+`docs/auditoria-1/`+commits es el patrón de evidencia oficial del proyecto (ya lo es de facto, pero no está declarado como tal en ningún documento de gobierno).

**Producto / integración (bloquea la mayor parte de "PENDIENTE"):**
- Conectar `apps/web` a `apps/api` real: hoy ninguna de las ~25 páginas de módulo hace fetch, ni siquiera con mock — es la causa raíz de que REQ-036, REQ-064, REQ-090/091/093, REQ-141/144/145/156/159/162/169/170 y las pruebas mínimas A3/A6-A9/A11-A13 estén en PENDIENTE.
- Implementar el pipeline OCR/extracción real (Docling/PyMuPDF, REQ-014/015/018/129) — hoy `packages/expediente` opera sobre texto ya extraído, no hay ingestión de PDF real.
- Implementar los canales de WhatsApp y voz (REQ-074/080/090/091/092/093) — actualmente 0% construidos, no son un mock sino ausencia total.
- Implementar el módulo post-adjudicación completo (E11: REQ-050 a REQ-056) — 0% construido.
- Cerrar B-02 (ComprasMX/OCDS-SHCP/PDN-S6/portales estatales): mientras la única fuente con dato real verificado sea el CSV histórico SABG, REQ-001/132/133/135/150 quedan en EN_EVIDENCIA (fixture) o BLOQUEADO_EXTERNO, nunca CUMPLIDO.
- Resolver gold sets/ML pendientes (REQ-002/009/014/015/018/021/038): sin gold sets anotados ni modelos, estos REQ seguirán PENDIENTE/BLOQUEADO_EXTERNO indefinidamente — requiere decisión de producto sobre si se construyen en este ciclo o se difieren.
- REQ-142: hacer que `field_provenance` sea vinculante (rechazar/excluir datos sin procedencia en matching/expediente), no solo registrarlo.
- REQ-119/131: redactar y publicar un aviso de privacidad propio — la verificación legal del marco normativo existe, pero el entregable de cara al usuario no.

**Legal (gate transversal, no bloquea desarrollo técnico salvo cifras en disputa):**
- Validación por abogado externo de las 17 filas VERIFICADO/VERIFICADO-CON-MATIZ de `docs/legal/verificacion-legal.md` antes de afirmar cumplimiento a un cliente real (ninguna se ha validado profesionalmente todavía).
- REQ-121 sigue NO-VERIFICABLE-EN-LÍNEA (LFDA art. 12) — requiere consulta directa a la fuente o a un despacho legal.
- Decisiones reservadas al fundador sin tomar: REQ-123 (forma jurídica), REQ-130 (alcance de cuenta LLM).

**Higiene de repo (menor, pero bloquea REQ-095/098 formalmente):**
- Versionar `package-lock.json` en el monorepo (W-03, ALTA, abierto — bloquea reproducibilidad de build en clon limpio).
- Aplicar la propuesta de esquema WK-07 (`db-proposals/PROPOSAL-01-widen-source-run-status.sql`) para no perder granularidad de estado en `source_runs`.
