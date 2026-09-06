# TABLERO — Atiende Licitaciones

**Fecha**: 2026-09-06, ~11:2x CST. **Commit HEAD**: `071263a` (cierre de ronda 5). Último commit de evidencia técnica: `b99a72f` (reverificación adversarial de RF-01..04/R5-11/R5-12, ronda 5). Snapshot previo: `e61156e`/HEAD `b362e62` (cierre de ronda 4).

**Este es el cierre formal de la ronda 5**, que suma a lo ya cerrado en ronda 4: **2FA/step-up TOTP** de extremo a extremo (enrolamiento, verificación, límite de tasa + bloqueo progresivo + auditoría de fallos con IP, atado a `(usuario, org, propósito)` de un solo uso, extendido a la aprobación de `tool_calls` org-scoped y cross-org de superadmin, conectado en `apps/web` con diálogos de step-up reales — REQ-044/064); **E11 estructurado** (hitos/garantías/facturación/penalizaciones tipados, alertas de vencimiento, calendario oficial de días inhábiles con el bug de cómputo corregido — REQ-050 CUMPLIDO, REQ-056 bloqueado externo parcial por falta de fuente oficial en línea, REQ-051..055 confirmados pendientes); **procedencia vinculante** (REQ-142, ahora sí aplicada, no solo registrada); **`correlation_id` de extremo a extremo** desde la ingesta (REQ-171); **aviso de privacidad** publicado como borrador honesto (REQ-119/131); y **el resto de `apps/web`** conectado — expediente completo (seccs. 4-9: Análisis de bases, Cumplimiento, Redacción, Revisión, Expediente, Aprobaciones, Entregas, Paquete descargable, Seguimiento) y back office completo (Usuarios/roles, Auditoría, Aprobaciones cross-org — REQ-170). Cadena completa auditoría→corrección→reverificación independiente para cada hallazgo, ver sección 4.

**Regla de lectura**: ningún estado `CUMPLIDO` en este tablero corresponde a un mock, fixture, o integración simulada — cada uno cita un informe de reverificación independiente con veredicto CERRADO explícito. `LÍMITE_ACEPTADO` es distinto de un defecto abierto: es un hallazgo residual de severidad ≤MEDIA, documentado con causa, tras 3 vueltas de corrección (regla Likida), sin cuarta vuelta. Fuente primaria de cada fila: `docs/ACEPTACION.md` (186 filas: 171 REQ + 15 pruebas mínimas A1-A15), todos los `docs/auditoria-1/*.md` y `docs/auditoria-2/*.md` (incl. `api-ronda5.md`, `api-ronda5-reverificacion.md`, `api-r5-09-10-reverificacion.md`, `ronda5-final.md`, `ronda5-final-reverificacion.md`), `docs/PROGRESO.md`, `docs/BLOQUEOS.md`, `docs/DECISIONES.md`, `apps/api/docs/e11-cobertura.md`, y los logs de test más recientes (`docs/logs/api-ronda5.log`, `web-ronda5.log`, `fix-web-ci4.log`, `reverify-ronda5-final.log`, `ci-local-5.log` en curso al momento de escribir este tablero).

---

## 1. Conteo por estado (docs/ACEPTACION.md, 186 filas = 171 REQ + 15 A)

| Estado | Filas | % | Antes de ronda 5 (`e61156e`) | Antes de ronda 4 (`d8e6d29`) |
|---|---:|---:|---:|---:|
| CUMPLIDO | 54 | 29.0% | 47 | 7 |
| EN_EVIDENCIA | 53 | 28.5% | 53 | 82 |
| PENDIENTE | 69 | 37.1% | 77 | 92 |
| LÍMITE_ACEPTADO | 5 | 2.7% | 5 | 0 (categoría no existía) |
| NO_APLICA_A_PAQUETE | 3 | 1.6% | 3 | 4 |
| BLOQUEADO_EXTERNO | 2 | 1.1% | 1 | 1 |
| **Total** | **186** | **100%** | **186** | **186** |

Los 54 `CUMPLIDO` (43 REQ + 11 A1-A15) cubren, además de lo ya cerrado en ronda 4 (dinero/números en expediente REQ-029/031; reglas duras de seguridad de agentes REQ-027/043/046/062/073/085/086/124/125/140; el aparato multi-tenant RLS+idempotencia REQ-024/033/057/058/059/063/073/152/167; el ciclo de aprobación/invalidación/checklist/paquete del expediente REQ-048/157/159/160/162/163; el motor de detección de cambios/versiones REQ-151/152/153/154/166; la suite Playwright+axe del portal REQ-065/089; A1, A2, A5, A6, A7, A8, A11, A12, A14, A15), los 7 cierres nuevos de la ronda 5: **REQ-044/064** (2FA/step-up TOTP end-to-end, incl. `tool_calls`), **REQ-050** (motor de plazos con calendario oficial real, R5-01 cerrado), **REQ-142** (procedencia vinculante ya aplicada, no solo registrada), **REQ-170** (los 6 módulos de back office conectados), **REQ-171** (`correlation_id` extremo a extremo desde la ingesta), y **A13** (descarga autenticada real del paquete desde `apps/web`). Los 5 `LÍMITE_ACEPTADO` son AG-05, AG-12 (×2 REQ cada uno: 068/069 y 072/114) y REQ-165 (composite, ver nota) — sin cambio en ronda 5. Ninguno depende de una integración externa real ni de un mock disfrazado de integración.

## 2. Conteo por épica (E0-E12, `docs/BACKLOG.md`)

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
| E8 — Auditoría, aprobación y entrega | 5 | 3 | 7 | 1 | 0 | 1 | 17 | EN CURSO → **2FA/step-up TOTP CERRADO en ronda 5** (REQ-044/064, incl. `tool_calls` vía R5-11); sigue faltando "sala de guerra" (REQ-040), passkey/WebAuthn y el juez LLM (bloqueado por OpenAI) |
| E9 — Reglas duras de seguridad (transversal) | 2 | 1 | 3 | 4 | 0 | 1 | 11 | **CERRADO con reverificación** (límites AG-05/AG-12 documentados); sin cambio en ronda 5 |
| E10 — Back office / observabilidad | 5 | 1 | 5 | 0 | 0 | 0 | 11 | EN CURSO → **casi cerrado**: ronda 5 conecta Usuarios/roles, Auditoría (con traza por `correlationId`) y Aprobaciones cross-org (REQ-170/171 CUMPLIDO); queda REQ-169 (dashboard de métricas, `PanelPage.tsx` sigue `EmptyState`) |
| E11 — Seguimiento post-adjudicación | 5 | 0 | 1 | 0 | 1 | 0 | 7 | EN CURSO (corregido: post-award existe desde ronda 3 — `post-award.routes.ts`, migración 0032, tests; ronda 5 añadió estructura por tipo, alertas y calendario oficial real; REQ-050 CUMPLIDO; REQ-056 BLOQUEADO_EXTERNO parcial por calendario SABG vacío sin fuente en línea; REQ-051..055 confirmados PENDIENTE, no despachados) |
| E12 — Marco legal mexicano | 10 | 13 | 0 | 1 | 0 | 0 | 24 | EN CURSO / bloqueado en puntos VERIFICAR y validación por abogado — REQ-119 (aviso de privacidad) pasa a EN_EVIDENCIA en ronda 5 |

**Lectura**: E1, E3, E4, E7 y E9 ya cerraban con reverificación independiente desde ronda 4. La ronda 5 no cierra épicas nuevas por completo, pero corrige la fila más inexacta del tablero anterior (**E11**, que decía "0% construido" pese a tener código real desde ronda 3) y hace avances reales en **E8** (2FA/step-up TOTP, incl. `tool_calls`) y **E10** (back office completo salvo el dashboard de métricas). E6 (análisis de bases/OCR, motor) y E5 (pgvector) siguen sin trabajo de código nuevo: dependen de decisiones de alcance (gold sets, embeddings reales) no tomadas.

## 3. Conteo por paquete responsable (primario)

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

## 4. Defectos abiertos por severidad (estado real a este commit)

### 4.1 Genuinamente abiertos (sin veredicto de cierre)

| ID | Paquete | Severidad | Estado | Resumen |
|---|---|---|---|---|
| R5-12 | apps/web | BAJA | Sin corrección (fuera del alcance de la corrección de RF-01..04) | `apps/web/src/lib/api/twofa.ts:33-35` describe incorrectamente el comportamiento de `apps/api`: afirma que `/2fa/verify-enrollment` "no fue actualizada para EXIGIR orgId/purpose... como sí lo está `/2fa/step-up`", cuando ambas rutas los exigen por igual. Comentario, sin código ejecutable ni impacto funcional. Citado en `docs/auditoria-2/api-r5-09-10-reverificacion.md`, reconfirmado sin corregir en `ronda5-final.md` y `ronda5-final-reverificacion.md`. |

Los ítems que aparecían aquí en el snapshot anterior (`e61156e`) ya no están abiertos: **API-15**/**WI-06** fueron REPARADOS antes del cierre de ronda 4 (commits `fbf5771`/`9bd8b55`, corrector #70, `docs/PROGRESO.md`) — este tablero no lo reflejaba, corregido ahora (ver 4.1bis). **REQ-142** (procedencia vinculante) y **REQ-170** (back office) CERRARON en ronda 5 (ver sección 1/2 y `docs/ACEPTACION.md`). **REQ-049/065 (matiz del guard 404)** también se da por resuelto: `docs/auditoria-2/ronda5-final.md` (rubro 6) confirma en vivo que `GET /tenders/:id` de una convocatoria de otra organización devuelve **404 real** de `apps/api`, y `ResourceNotFoundPage.tsx` está unit-testeado (`ConvocatoriaDetallePage.test.tsx`) para pintarlo — el mecanismo real de aislamiento (0 fugas) más el 404 explícito ya cubren la letra del criterio.

### 4.1bis Ronda 5 — hallazgos y su cierre (todos con auditoría→corrección→reverificación independiente)

| ID | Severidad | Paquete | Resumen | Estado final |
|---|---|---|---|---|
| R5-01 | CRÍTICA | apps/api | `calendar_holidays` cargado nunca excluía el día real del plazo (bug de conversión de fecha); `calendarNote` mentía afirmando inclusión | **CERRADO** (`fccab53`, reverificado con bisiesto/TZ/mismo-día) |
| R5-02 | CRÍTICA | apps/api | Endpoints TOTP sin límite de tasa específico (40 intentos sin 429) | **CERRADO** (`7242298`, tier `twoFactor` 5/5min + bloqueo progresivo `twofa_lockouts`, reverificado con rotación de IP/usuario) |
| R5-03 | MEDIA | apps/api | Fallos de 2FA no quedaban en `audit_log` | **CERRADO** (`7242298`; ver R5-10 para la IP) |
| R5-04 | MEDIA | apps/api | `correlation_id` de REQ-171 nunca incluía la ingesta/descubrimiento | **CERRADO** en el ámbito de `apps/api` (`4db65e9`); residual en `apps/worker`/`source_runs` documentado, fuera de alcance |
| R5-05 | BAJA-MEDIA | apps/api | `step_up_sessions` no ligado a org/acción específica | **CERRADO** vía R5-09 (ver abajo) |
| R5-06 | BAJA | apps/api | `sourceUrl` de `calendar_holidays` aceptaba cualquier esquema | **CERRADO** (`c2deca5`) |
| R5-07 | BAJA | apps/api | Fecha calendario inexistente daba 500 en vez de 422 | **CERRADO** (`c2deca5`) |
| R5-09 | BAJA-MEDIA | apps/api | El scope opcional de R5-05 nunca se activaba desde `apps/web` (sesiones "genéricas" en producción) | **CERRADO** (`a7026ec`, `orgId`/`purpose` obligatorios + un solo uso, migraciones 0062/0063; reverificado con concurrencia real 200+403) |
| R5-10 | MEDIA-BAJA | apps/api | Fallos de 2FA auditados sin IP del cliente | **CERRADO** (`586e3cf`, paridad con `auth.login_failed`) |
| R5-11 | BAJA-MEDIA | apps/api | Aprobación de `tool_calls` (org y cross-org superadmin) sin step-up pese al enum reservado | **CERRADO** (`428797f`, reverificado con concurrencia real 200+409) |
| R5-12 | BAJA | apps/web | Comentario desactualizado en `twofa.ts` | **Sigue abierto** (ver 4.1) |
| RF-01 | MEDIA-ALTA | apps/web | `apps/web` nunca declaraba `X-Step-Up` al aprobar/denegar `tool_calls` (org ni cross-org) | **CERRADO** (`0d4f5cf`, reverificado en UI real con 4 actores) |
| RF-02 | MEDIA | apps/web | Carrera real entre dos `refreshSession()` (bootstrap sin mutex) podía invalidar un refresh token válido | **CERRADO** (`6282988`, reverificado con 30/30 recargas de producción sin 401) |
| RF-03 | BAJA | apps/web | Enrolamiento 2FA sin código QR visual real | **CERRADO** (`9dc6000`, reverificado decodificando el QR con `jsQR`, librería independiente) |
| RF-04 | MEDIA | apps/web | `test:e2e:full` fallaba determinísticamente por contraste del toast (causa real: timing de la animación de Sonner, no el color) | **CERRADO** (`40b3dfe`, reverificado 2/2 limpio, contraste real 14.88:1 oscuro / 17.13:1 claro) |

Fuente: `docs/auditoria-2/api-ronda5.md`, `api-ronda5-reverificacion.md`, `api-r5-09-10-reverificacion.md`, `ronda5-final.md`, `ronda5-final-reverificacion.md`.

### 4.2 Límites aceptados (regla de 3 vueltas — causa documentada, sin cuarta vuelta)

| ID(s) | Paquete | Severidad | Causa aceptada | Informe |
|---|---|---|---|---|
| AG-05 | packages/agents | MEDIA | Un handler que miente simultáneamente en `riskLevel`+`actionKind`+`declaredEffects` evade `AuthorizationPolicy`; no detectable dentro de una librería pura sin capa externa (checklist humano/sandbox en `apps/api`, no implementada). Afecta REQ-068/069/165. | `docs/auditoria-1/agents-cierre.md` |
| AG-12 | packages/agents | MEDIA | Guardrail regex anticolusión mide ~3% de detección real (vocabulario independiente) frente al ≥99% exigido; falta capa LLM/juez en `apps/api`, no implementada. Afecta REQ-072/114. | `docs/auditoria-1/agents-cierre.md` |
| SR-25 | packages/sources | BAJA-MEDIA | Falso positivo por longitud (`minUsefulTextBytes=120`) sobre notas DOF genuinas y breves; no bloqueante. Afecta REQ-148. | `docs/auditoria-1/sources-cierre-definitivo.md` |
| (sin ID) reportDropped cooperativo | packages/sources | BAJA (estructural) | El reporte de descartes de conectores es cooperativo por convención; un conector de terceros que no llame `reportDropped` no es detectado por el pipeline. | `docs/auditoria-1/sources-cierre-definitivo.md` |
| EX-EXP-08 | packages/expediente | MEDIA | Autoaprobación entre dos cuentas de la misma persona física no detectable dentro de una librería pura; requiere capa de identidad en `apps/api` (AE-08 ya cierra el hash de perfil, pero no esta variante de identidad). | `docs/auditoria-1/expediente-cierre.md` |
| EX-EXP-10 | packages/expediente | BAJA | Estado "ámbar" (no "rojo") con &lt;2 documentos es decisión de diseño correcta — "resolverlo" violaría REQ-164 (no inventar consistencia cruzada). | `docs/auditoria-1/expediente-cierre.md` |
| DB-07 | packages/db | BAJA | No se migró a `withTenantContext`/`applyTenantContext` como patrón único; mitigado con test estático que detecta el patrón alternativo. Decisión de alcance vigente, sin evidencia nueva pendiente. | `docs/auditoria-1/db-api-seguridad-reverificacion.md` |
| DB-09 | packages/db | BAJA | La función SQL de fondo conserva el gap original; mitigado con caché (`agent-stores.pg.ts`) que lo hace inalcanzable vía HTTP hoy. Cierre completo requeriría cambiar la interfaz externa de `packages/agents`. | `docs/auditoria-1/db-api-seguridad-reverificacion.md` |
| WK-04 / WK-08 | apps/worker | PARCIAL (no severidad de seguridad) | Concurrencia real del motor de `jobs` (múltiples conexiones físicas contra Postgres) no probable en PGlite (una sola conexión); ligada a **B-03**. | `docs/auditoria-1/worker-cierre.md` |

### 4.3 Bloqueos externos (B-01/B-02/B-03) y qué desbloquean

| ID | Estado | Bloqueo | Qué desbloquea al resolverse |
|---|---|---|---|
| B-01 | ABIERTO — requiere que el usuario indique la ruta definitiva | Ruta de la carpeta "empresas agénticas" no verificada; no bloquea desarrollo técnico en staging | Solo organización/ubicación del repositorio final, sin efecto en REQ. |
| B-02 | ABIERTO — externo, requiere acceso/permisos oficiales o fuente alterna | ComprasMX (401/reCAPTCHA), OCDS-SHCP inalcanzable, PDN-S6 con bot-detection, portales estatales sin API localizable | REQ-001/132/133/135/150 pasarían de EN_EVIDENCIA (fixture) a candidatos a CUMPLIDO con integración real; hoy la única fuente con dato real verificado es el CSV histórico SABG. |
| B-03 | ABIERTO — decisión del usuario (¿autorizar remoto GitHub privado?) | El job de CI `db-postgres` (migraciones + 622+ ataques RLS sobre Postgres 16 real) solo puede ejecutarse en GitHub Actions | REQ-045/087/095/097/138 (gates de CI real) dejarían de estar estructuralmente PENDIENTE; WK-04/WK-08 (concurrencia real de jobs) podrían cerrarse; DB-06 se validaría contra Postgres real, no solo PGlite. |

### 4.4 Incidentes de gobierno (proceso, no código) — INC-01 a INC-09

| ID | Estado | Resumen |
|---|---|---|
| INC-01 | CERRADO | Reescritura concurrente de `docs/REQUISITOS.md` por un agente con copia en memoria desactualizada; restaurado sin pérdida. |
| INC-02 | CERRADO | Commit de expediente arrastró archivos del agente legal por índice git compartido; sin pérdida de contenido. |
| INC-03 | CERRADO | Agentes concurrentes ejecutaron `git reset` sobre el repo compartido; todo recuperado (reflog/`git fsck`); regla dura reforzada (prohibido `git reset`/`checkout <commit>`/`stash`). |
| INC-04 | CERRADO | Un implementador usó `git add -A`, absorbiendo archivos de otra micro-corrección; contenido verificado íntegro; prohibido `git add -A`/`.`/`commit -a` reforzado. |
| INC-05 | CERRADO | Límite de sesión de la API de Anthropic (429) cortó 5 agentes simultáneos; todos reanudados con contexto intacto vía `SendMessage`; cron de respaldo dio 2 latidos durante la caída. |
| INC-06 | CERRADO | `git commit --amend` (prohibido) de un corrector reemplazó por carrera el commit de otro agente; contenido verificado íntegro por hash de árbol idéntico; sin pérdida. |
| INC-07 | CERRADO | Copias huérfanas de editor (« 2.ts») con contenido anterior rompían el typecheck del worker; eliminadas tras verificar que HEAD era más nuevo. |
| INC-08 | EN OBSERVACIÓN | Limitación intermitente del servidor de Anthropic (429 de servidor, no de uso) cortó repetidamente varios agentes; reanudaciones por `SendMessage`, sin pérdida de trabajo. |
| INC-09 | CERRADO | Un corrector usó una vez `git reset <paths>` (solo des-stagear, regla dura); sin pérdida; autorreportado. |

## 5. Conteo de tests por workspace (post-ronda-5; fuentes: corridas aisladas independientes citadas por fila, más `docs/logs/ci-local-5.log` para los paquetes sin cambios de ronda 5)

| Paquete/app | Archivos | Tests | Fuente (corrida aislada) |
|---|---:|---:|---|
| apps/api | 59 | **238** | `docs/logs/reverify-ronda5-final.log` (§1.2) y `docs/logs/ci-local-5.log:285-286`, coincidentes |
| packages/db | 24 | **161** | `docs/auditoria-2/api-r5-09-10-reverificacion.md` y `docs/logs/ci-local-5.log:818-819`, coincidentes |
| apps/web (unit, aislado) | 30 | **114** | `docs/logs/fix-web-ronda5.log`, reconfirmado en `docs/logs/reverify-ronda5-final.log` (§1.2, "corrida 2, aislada") |
| apps/web (`test:e2e:full`) | 9 specs | **116** (×2 corridas, 116/0 ambas — determinista) | `docs/logs/reverify-ronda5-final.log` (§1.2, corridas 1/2 y 2/2) |
| apps/worker | 11 | **298** | `docs/logs/ci-local-5.log:717-718` (sin cambios de código en ronda 5) |
| packages/agents | 13 | **263** | `docs/logs/ci-local-5.log:874-875` (sin cambios de código en ronda 5) |
| packages/expediente | 16 | **413** | `docs/logs/ci-local-5.log:960-961` (sin cambios de código en ronda 5) |
| packages/sources | 20 | **204** | `docs/logs/ci-local-5.log:1051-1052` (sin cambios de código en ronda 5) |
| **Total suites unitarias/integración** | **173 archivos** | **1,691 tests** | suma de las 7 filas de unit/integración |
| **Total incl. E2E full** | — | **1,807 tests** | 1,691 + 116 E2E |

**Nota de honestidad sobre `ci-local-5.log`**: la corrida agregada completa **NO terminó en verde** (`exit=1`) — `apps/web:test:coverage` tuvo **11 fallos en 8 de 30 archivos** (`AnalisisBasesPage`, `EntregasPage`, `PaqueteDescargablePage`×2, `SeguimientoPage`, `CumplimientoDocumentalPage`, `ExpedientePage`, `RedaccionPage`, `RevisionPage`×3), todos con el mismo patrón: `Error: Test timed out in 20000ms` (retry ×1). Es exactamente el patrón de **contención de CPU** ya diagnosticado y documentado en `docs/PROGRESO.md` ("Diagnóstico ci-local-4", commit `0a29c10`) — esta corrida de `ci-local-5` coincidió con otros procesos activos en la máquina — **no una regresión real**: las mismas suites, corridas aisladas (sin otras cargas pesadas en paralelo), dan 114/114 verdes de forma reproducible en `fix-web-ronda5.log` y `reverify-ronda5-final.log`. El resto de `ci-local-5.log` (apps/api, apps/worker, packages/db/agents/expediente/sources) sí terminó limpio. **Pendiente**: repetir `ci-local` completo sin otra carga concurrente en la máquina antes de considerarlo un gate verde formal; hasta entonces, la fuente de verdad de `apps/web` unit es la corrida aislada citada arriba. `db-postgres` (migraciones+RLS sobre Postgres 16 real) sigue sin reproducirse en `ci-local`; solo corre en GitHub Actions, bloqueado por B-03.

## 6. Qué falta para 10/10 (viñetas concretas y honestas, actualizado tras el cierre de ronda 5)

**Cerrado en ronda 5 (ya no aparece aquí)**: conexión completa de `apps/web` (expediente secc. 4-9 y back office); 2FA/step-up TOTP en aprobaciones económicas y en `tool_calls`; `field_provenance` vinculante (REQ-142); `correlation_id` de extremo a extremo desde la ingesta (REQ-171); aviso de privacidad propio publicado (REQ-119/131, como borrador honesto); guard de acceso cruzado de tenant (404 real confirmado en `apps/api` + `ResourceNotFoundPage` unit-testeado). Ver sección 4.1bis para el detalle de cada hallazgo cerrado.

**Funcionalidad no construida (0% de código, no un mock):**
- **OCR/extracción real de PDF** (Docling/PyMuPDF + Mistral/Azure por excepción): `apps/api` marca `requires_ocr` explícito pero no hay motor; bloquea REQ-014/015/018/129 y el recall real de la matriz de requisitos.
- **Firma electrónica real**: por diseño, la e.firma nunca toca el servidor (REQ-045); hoy solo existe `userConfirmedSigned` como declaración del usuario — falta el flujo WebCrypto/agente local del lado del cliente.
- **Envío real a portal oficial**: **nunca se construirá por diseño** (REQ-046, tolerancia cero); confirmado sin cliente HTTP saliente en `apps/api`. No es una carencia, es una regla dura cumplida.
- **Integraciones reales de fuentes oficiales**: ComprasMX/OCDS-SHCP/PDN-S6/portales estatales bloqueados por B-02 (reCAPTCHA/bot-detection/API no localizable); hoy la única fuente con dato real es el CSV histórico SABG.
- **OpenAI real**: sin credenciales de producción en ningún paquete; `ProviderRouter`/`OpenAIResponsesProvider` nunca ejercitados contra la red real. Bloquea el juez LLM (REQ-039/127), la cascada de modelos (REQ-078), Batch API/prompt caching (REQ-081/128), y el componente semántico de matching (REQ-061).
- **WhatsApp y voz**: 0% construido (REQ-074/080/090/091/092/093).
- **E11, resto de post-adjudicación** (REQ-051 a REQ-055): máquina de estados del contrato, extracción del contrato firmado, redactor de inconformidades, autopsia del fallo y radar de renovaciones específico (90/60/30 días simultáneos) — 0% construido; el seguimiento genérico (hitos/garantías/facturación/pago/penalizaciones/alertas) y el motor de plazos con calendario ya SÍ están construidos y cerrados en ronda 5 (REQ-050 CUMPLIDO), ver `apps/api/docs/e11-cobertura.md`.

**Gobierno / CI (bloquea gates formales, no funcionalidad):**
- **CI Postgres real**: el job `db-postgres` (migraciones+622+ ataques RLS reales) solo corre en GitHub Actions; requiere que el usuario autorice un remoto privado (B-03). Sin esto, REQ-045/087/095/097/138 quedan estructuralmente PENDIENTE y WK-04/WK-08 (concurrencia real de `jobs`) no pueden cerrarse.
- **Validación legal por abogado**: las 17 filas VERIFICADO/VERIFICADO-CON-MATIZ de `docs/legal/verificacion-legal.md` (más las 4 NO-VERIFICABLE-EN-LÍNEA) no han sido validadas por un abogado mexicano; ninguna cifra debe afirmarse a un cliente real sin esa validación — incluye el aviso de privacidad nuevo de ronda 5 (REQ-119), que se declara explícitamente `borrador_pendiente_validacion_juridica`.
- **Capa LLM del guardrail anticolusión**: AG-12 mide ~3% de detección real por regex; cerrar el REQ-072/114 (≥99%) requiere una capa de juicio LLM en `apps/api`, no solo el guardrail de `packages/agents`.

**Seguridad / arquitectura (mejoras concretas, no bloqueantes hoy):**
- **Passkey/WebAuthn en aprobaciones económicas** (REQ-044/064, matiz): el 2FA TOTP con step-up de un solo uso ya está CERRADO en ronda 5 (incl. `tool_calls`); falta el segundo factor passkey/WebAuthn específico que menciona el texto del requisito.
- **Refresh token en cookie httpOnly**: hoy vive en `localStorage` (mitigado parcialmente por CSP real, WI-01 CERRADO); migrar a cookie httpOnly sigue como TODO explícito del corrector de WI-01.
- **pgvector / vector store real** (REQ-061): el matching sigue siendo léxico/determinista; decidir si se implementa con embeddings reales (requiere OpenAI) o se declara diseño definitivo.
- **Calendario oficial de días inhábiles cargado** (REQ-056): la tabla `calendar_holidays` y el motor que la consume ya están construidos y el bug de cómputo está cerrado (R5-01); pero la tabla se despliega y permanece **VACÍA** — cargarla con fechas reales de la SABG, cada una con `sourceUrl`+fecha de consulta verificables, requiere a un administrador humano o una ronda con acceso confirmado a la fuente oficial (BLOQUEADO_EXTERNO parcial).

**Higiene de repo (menor):**
- R5-12: comentario desactualizado en `apps/web/src/lib/api/twofa.ts:33-35` sobre el alcance de `/2fa/verify-enrollment` (sin impacto funcional, ver sección 4.1).
