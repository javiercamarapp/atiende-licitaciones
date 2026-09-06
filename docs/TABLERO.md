# TABLERO — Atiende Licitaciones

**Fecha**: 2026-09-06, ~05:4x CST. **Commit HEAD**: `b362e6247756e5e61e2678bf5d61d58478b3d5c9` (336 commits). Último commit de evidencia técnica: `1ff99fb` (reverificación final integrada apps/api+apps/web, ronda 4). El commit `b362e62` en sí es solo un registro de despacho de gobierno (docs/AGENTES.md, docs/PROGRESO.md).

**Este es el cierre formal del snapshot anterior** (`d8e6d29`, 2026-09-05 21:5x: 92 PENDIENTE / 82 EN_EVIDENCIA / 7 CUMPLIDO / 4 NO_APLICA / 1 BLOQUEADO_EXTERNO, sin categoría de límite aceptado). Desde entonces se cerraron con reverificación adversarial independiente: `packages/agents` (4 rondas), `packages/expediente` (4 rondas + micro-corrección), `apps/worker` (3 rondas), `packages/sources` (4 rondas + micro-corrección), `packages/db`+`apps/api` (reverificación de seguridad + auditoría 2 + reverificación integrada final), y `apps/web` (2 rondas + auditoría 2 integrada). El resultado es un salto real (no cosmético) en `CUMPLIDO`, sustentado en las tablas de `docs/ACEPTACION.md`.

**Regla de lectura**: ningún estado `CUMPLIDO` en este tablero corresponde a un mock, fixture, o integración simulada — cada uno cita un informe de reverificación independiente con veredicto CERRADO explícito. `LÍMITE_ACEPTADO` es distinto de un defecto abierto: es un hallazgo residual de severidad ≤MEDIA, documentado con causa, tras 3 vueltas de corrección (regla Likida), sin cuarta vuelta. Fuente primaria de cada fila: `docs/ACEPTACION.md` (186 filas: 171 REQ + 15 pruebas mínimas A1-A15), todos los `docs/auditoria-1/*.md` y `docs/auditoria-2/*.md`, `docs/PROGRESO.md`, `docs/BLOQUEOS.md`, `docs/DECISIONES.md`, `docs/logs/ci-local-3.log` y `docs/logs/reverify-final-integrada.log`.

---

## 1. Conteo por estado (docs/ACEPTACION.md, 186 filas = 171 REQ + 15 A)

| Estado | Filas | % | Antes (`d8e6d29`) |
|---|---:|---:|---:|
| CUMPLIDO | 47 | 25.3% | 7 |
| EN_EVIDENCIA | 53 | 28.5% | 82 |
| PENDIENTE | 77 | 41.4% | 92 |
| LÍMITE_ACEPTADO | 5 | 2.7% | 0 (categoría no existía) |
| NO_APLICA_A_PAQUETE | 3 | 1.6% | 4 |
| BLOQUEADO_EXTERNO | 1 | 0.5% | 1 |
| **Total** | **186** | **100%** | **186** |

Los 47 `CUMPLIDO` (37 REQ + 10 A1-A15) cubren: dinero/números en expediente (REQ-029/031), reglas duras de seguridad de agentes (REQ-027/043/046/062/073/085/086/124/125/140), casi todo el aparato multi-tenant RLS+idempotencia (REQ-024/033/057/058/059/063/073/152/167), el ciclo completo de aprobación/invalidación/checklist/paquete del expediente (REQ-048/157/159/160/162/163), el motor de detección de cambios/versiones (REQ-151/152/153/154/166), la suite Playwright+axe completa del portal (REQ-065/089), y 10 de las 15 pruebas mínimas integradas (A1, A2, A5, A6, A7, A8, A11, A12, A14, A15) con test HTTP/E2E real, no mock. Los 5 `LÍMITE_ACEPTADO` son AG-05, AG-12 (×2 REQ cada uno: 068/069 y 072/114) y REQ-165 (composite, ver nota). Ninguno depende de una integración externa real ni de un mock disfrazado de integración.

## 2. Conteo por épica (E0-E12, `docs/BACKLOG.md`)

Las épicas se solapan por diseño (dependencia técnica, no partición) — un REQ puede pertenecer a más de una épica; por eso las filas no sumarán 171 (suman 184: 13 REQ contados en 2 épicas).

| Épica | PENDIENTE | EN_EVIDENCIA | CUMPLIDO | LÍMITE_ACEPTADO | BLOQUEADO_EXTERNO | NO_APLICA | Total REQ | Estado |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| E0 — Gobierno del ciclo | 6 | 3 | 3 | 0 | 0 | 0 | 12 | EN CURSO (permanente) |
| E1 — Fundamentos de plataforma | 6 | 5 | 7 | 3 | 0 | 0 | 21 | **CERRADO con reverificación** (límites AG-05/AG-12/AG-12 documentados) |
| E2 — Perfil de empresa y datos reales | 5 | 1 | 2 | 0 | 0 | 1 | 9 | EN CURSO (UI conectada parcial, sin tests dedicados de rol/firmante) |
| E3 — Ingesta oficial y frescura | 2 | 10 | 3 | 0 | 0 | 0 | 15 | **CERRADO con reverificación** (mecanismo); real vs. ComprasMX BLOQUEADO_EXTERNO (B-02) |
| E4 — Detección de cambios y versiones | 1 | 2 | 4 | 0 | 0 | 0 | 7 | **CERRADO con reverificación** |
| E5 — Matching (relevancia y elegibilidad) | 8 | 3 | 3 | 0 | 0 | 0 | 14 | EN CURSO (pgvector REQ-061 no construido) |
| E6 — Análisis de bases y matriz de requisitos | 6 | 4 | 0 | 0 | 1 | 0 | 11 | PENDIENTE (OCR/gold set no construidos) |
| E7 — Expediente de participación | 9 | 3 | 12 | 0 | 0 | 1 | 25 | **CERRADO con reverificación** (biblioteca+API); UI apps/web pendiente |
| E8 — Auditoría, aprobación y entrega | 7 | 3 | 5 | 1 | 0 | 1 | 17 | EN CURSO (2FA/passkey y sala de guerra no construidos) |
| E9 — Reglas duras de seguridad (transversal) | 2 | 1 | 3 | 4 | 0 | 1 | 11 | **CERRADO con reverificación** (límites AG-05/AG-12 documentados) |
| E10 — Back office / observabilidad | 7 | 1 | 3 | 0 | 0 | 0 | 11 | EN CURSO (1 de ~6 paneles conectado real) |
| E11 — Seguimiento post-adjudicación | 7 | 0 | 0 | 0 | 0 | 0 | 7 | PENDIENTE (0% construido, sin cambio) |
| E12 — Marco legal mexicano | 11 | 12 | 0 | 1 | 0 | 0 | 24 | EN CURSO / bloqueado en puntos VERIFICAR y validación por abogado |

**Lectura**: E1, E3, E4, E7 y E9 pasan de "mayormente en evidencia" a **cerradas con reverificación independiente** — es el cambio más significativo desde `d8e6d29`. E11 sigue en 0% (sin trabajo despachado). E6 (análisis de bases/OCR) y E5 (pgvector) no tuvieron trabajo nuevo de código: siguen dependiendo de decisiones de alcance (gold sets, embeddings reales) no tomadas.

## 3. Conteo por paquete responsable (primario)

Cada REQ se asignó a **un solo paquete primario** (el primero listado en su columna "Paquete(s)" de `docs/ACEPTACION.md`) para que las columnas sumen 171; esto es distinto del conteo por épica (que sí solapa). Nota de transparencia: REQ-165 es un caso compuesto real (CUMPLIDO para `packages/expediente`, LÍMITE_ACEPTADO para `packages/agents` por AG-05) — aquí se cuenta una sola vez bajo `packages/expediente`, por lo que la fila de `packages/agents` (LÍMITE_ACEPTADO=4) no incluye ese REQ; el conteo total de LÍMITE_ACEPTADO de la sección 1 (5) sigue siendo la cifra autoritativa.

| Paquete | PENDIENTE | EN_EVIDENCIA | CUMPLIDO | LÍMITE_ACEPTADO | BLOQUEADO_EXTERNO | NO_APLICA | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| packages/sources | 4 | 12 | 7 | 0 | 0 | 0 | 23 |
| packages/expediente | 12 | 9 | 10 | 0 | 0 | 1 | 32 |
| packages/agents | 13 | 5 | 8 | 4 | 0 | 0 | 30 |
| packages/db | 3 | 4 | 8 | 0 | 0 | 0 | 15 |
| apps/api | 6 | 2 | 1 | 0 | 0 | 0 | 9 |
| apps/web | 9 | 3 | 2 | 0 | 0 | 0 | 14 |
| apps/worker | 0 | 3 | 1 | 0 | 0 | 0 | 4 |
| docs/legal | 5 | 9 | 0 | 0 | 0 | 0 | 14 |
| transversal / gobierno | 8 | 1 | 1 | 0 | 1 | 0 | 11 |
| fundador (decisión reservada) | 2 | 0 | 0 | 0 | 0 | 0 | 2 |
| sin paquete (WhatsApp, voz, OCR, ML, post-adjudicación, comprador, KYC) | 15 | 0 | 0 | 0 | 0 | 2 | 17 |
| **Total** | **77** | **48** | **37** | **4** | **1** | **3** | **171** |

**Lectura**: `apps/web` sigue siendo el paquete con más deuda relativa a lo ya construido en el resto (portal 100% cerrado y reverificado en accesibilidad/E2E, pero solo 4 de ~11 módulos de dominio conectados a datos reales: Empresa, Convocatorias, Go/No-Go, Fuentes/frescura). `apps/worker` es el único paquete sin filas en PENDIENTE y ahora tiene 1 CUMPLIDO (visibility timeout/fencing). `packages/agents` es el paquete con más filas de `LÍMITE_ACEPTADO` (los dos únicos límites arquitectónicos reales del proyecto: AG-05 y AG-12).

## 4. Defectos abiertos por severidad (estado real a este commit)

### 4.1 Genuinamente abiertos (micro-corrección en curso, sin veredicto de cierre aún)

| ID | Paquete | Severidad | Estado | Resumen |
|---|---|---|---|---|
| API-15 | apps/api | BAJA | Micro-corrección en curso (#70) | `POST /company/rates/:id/approve\|reject` no está en la lista `withOptionalEmptyJsonBody`; un cuerpo vacío con `Content-Type: application/json` devuelve 400 en vez de ejecutar la acción. Fail-closed, no explotable. |
| WI-06 | apps/web | BAJA | Micro-corrección en curso (#70) | Doble clic físico simultáneo dispara 2 peticiones `POST /rates/:id/approve`; el guard de UI depende del re-render tras el primer `mutate()`. El servidor sigue siendo la barrera real (`[200,409]` en 2 repeticiones), sin impacto de seguridad. |
| REQ-142 (sin ID de auditoría) | apps/api | Equivalente ALTA funcional | Sin corrección | `field_provenance` se registra (`owner`/`source`/`updated_at`) pero **ningún consumidor de matching/expediente rechaza o excluye datos sin procedencia**; el criterio no se cumple aunque el esquema exista. |
| REQ-170 (parcial) | apps/web | Equivalente ALTA funcional (bloquea E10) | Sin corrección | Solo 1 de ~6 módulos de back office (Fuentes/frescura) está confirmado conectado a datos reales; jobs/reintentos, costos IA, evals, incidentes, aprobaciones sin confirmar; "Usuarios y roles" y "Auditoría" ya tienen endpoint (ronda 4) pero sin UI. |
| REQ-049/065 (matiz) | apps/web | Equivalente MEDIA | Sin corrección | El criterio exige que el acceso cruzado de tenant devuelva **404**; el diseño real bloquea por RLS/403 a nivel API (0 fugas de datos confirmadas), pero no existe un guard de ruta que devuelva 404 literal (W-12, documentado como ausente por diseño desde ronda 1). |

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

## 5. Conteo de tests por workspace (fuente: `docs/logs/ci-local-3.log` + `docs/logs/reverify-final-integrada.log`, ambos del commit `1ff99fb`/posteriores)

| Paquete/app | Archivos | Tests | Cobertura (stmts/branch/funcs/lines) | Fuente |
|---|---:|---:|---|---|
| apps/api | 48 | **180** | (sin `test:coverage` en ci-local, solo `test`) | `ci-local-3.log:218-219` |
| packages/db | 22 | **156** | (sin `test:coverage` en ci-local) | `ci-local-3.log:656-657` |
| apps/web (unit) | 15 | **79** | 43.54 / 25.22 / 30.1 / 45.61 | `ci-local-3.log:281-290` |
| apps/web (`test:e2e:full`) | 9 specs | **98** (×2 corridas, 98/0/0 ambas — determinista) | — | `reverify-final-integrada.log:416-428` |
| apps/worker | 11 | **298** | 91.17 / 82.65 / 83.78 / 91.17 | `ci-local-3.log:560-569` |
| packages/agents | 13 | **263** | 94.12 / 90.93 / 94.25 / 94.12 | `ci-local-3.log:712-721` |
| packages/expediente | 16 | **413** | 92.99 / 89.69 / 92.91 / 92.99 | `ci-local-3.log:799-808` |
| packages/sources | 20 | **204** | 89.36 / 83.68 / 93.6 / 89.36 | `ci-local-3.log:890-899` |
| **Total suites unitarias/integración** | **145 archivos** | **1,593 tests** | — | suma de las 7 filas anteriores |
| **Total incl. E2E full** | — | **~1,691 tests** | — | 1,593 + 98 E2E |

`ci-local-3.log` reporta 28 combinaciones workspace×paso (build/lint/test(:coverage)/typecheck × 7 workspaces) todas `OK`, más `npm audit --omit=dev --audit-level=high` OK y `check-secrets` OK (marcador `check-secrets:allow-fixture` solo en archivos de test, commit `c210db4`). El job `db-postgres` (migraciones+RLS sobre Postgres 16 real) **no se reproduce en ci-local**; solo corre en GitHub Actions, bloqueado por B-03. Ningún workspace tiene una suite roja.

## 6. Qué falta para 10/10 (viñetas concretas y honestas)

**Funcionalidad no construida (0% de código, no un mock):**
- **OCR/extracción real de PDF** (Docling/PyMuPDF + Mistral/Azure por excepción): `apps/api` marca `requires_ocr` explícito pero no hay motor; bloquea REQ-014/015/018/129 y el recall real de la matriz de requisitos.
- **Firma electrónica real**: por diseño, la e.firma nunca toca el servidor (REQ-045); hoy solo existe `userConfirmedSigned` como declaración del usuario — falta el flujo WebCrypto/agente local del lado del cliente.
- **Envío real a portal oficial**: **nunca se construirá por diseño** (REQ-046, tolerancia cero); confirmado sin cliente HTTP saliente en `apps/api`. No es una carencia, es una regla dura cumplida.
- **Integraciones reales de fuentes oficiales**: ComprasMX/OCDS-SHCP/PDN-S6/portales estatales bloqueados por B-02 (reCAPTCHA/bot-detection/API no localizable); hoy la única fuente con dato real es el CSV histórico SABG.
- **OpenAI real**: sin credenciales de producción en ningún paquete; `ProviderRouter`/`OpenAIResponsesProvider` nunca ejercitados contra la red real. Bloquea el juez LLM (REQ-039/127), la cascada de modelos (REQ-078), Batch API/prompt caching (REQ-081/128), y el componente semántico de matching (REQ-061).
- **WhatsApp y voz**: 0% construido (REQ-074/080/090/091/092/093).
- **Módulo post-adjudicación completo** (E11, REQ-050 a REQ-056): 0% construido, sin trabajo despachado.

**Gobierno / CI (bloquea gates formales, no funcionalidad):**
- **CI Postgres real**: el job `db-postgres` (migraciones+622+ ataques RLS reales) solo corre en GitHub Actions; requiere que el usuario autorice un remoto privado (B-03). Sin esto, REQ-045/087/095/097/138 quedan estructuralmente PENDIENTE y WK-04/WK-08 (concurrencia real de `jobs`) no pueden cerrarse.
- **Validación legal por abogado**: las 17 filas VERIFICADO/VERIFICADO-CON-MATIZ de `docs/legal/verificacion-legal.md` (más las 4 NO-VERIFICABLE-EN-LÍNEA) no han sido validadas por un abogado mexicano; ninguna cifra debe afirmarse a un cliente real sin esa validación.
- **Capa LLM del guardrail anticolusión**: AG-12 mide ~3% de detección real por regex; cerrar el REQ-072/114 (≥99%) requiere una capa de juicio LLM en `apps/api`, no solo el guardrail de `packages/agents`.

**Seguridad / arquitectura (mejoras concretas, no bloqueantes hoy):**
- **2FA en aprobaciones económicas** (REQ-044/064): sin passkey/OTP; la aprobación 2/2 con re-autenticación no existe.
- **Refresh token en cookie httpOnly**: hoy vive en `localStorage` (mitigado parcialmente por CSP real, WI-01 CERRADO); migrar a cookie httpOnly sigue como TODO explícito del corrector de WI-01.
- **pgvector / vector store real** (REQ-061): el matching sigue siendo léxico/determinista; decidir si se implementa con embeddings reales (requiere OpenAI) o se declara diseño definitivo.
- **Calendario oficial de días inhábiles**: hoy solo excluye sábado/domingo; falta el calendario oficial (SABG) para el motor de plazos legales (REQ-050/056).

**Producto / integración (conectar lo ya construido):**
- **Conectar el resto de `apps/web`**: solo 4 de ~11 módulos de dominio están conectados a datos reales (Empresa, Convocatorias, Go/No-Go, Fuentes/frescura); Análisis de bases, Cumplimiento documental, Redacción, Revisión, Expediente, Aprobaciones (preparación), Entregas, Paquete descargable y Seguimiento post-adjudicación siguen en `EmptyState`.
- **`field_provenance` vinculante** (REQ-142): hoy se registra pero ningún consumidor de matching/expediente rechaza datos sin procedencia.
- **Aviso de privacidad propio** (REQ-119/131): la verificación legal del marco normativo existe; el entregable de cara al usuario no.
- **`correlation_id` de extremo a extremo** (REQ-171): `packages/expediente` declara explícitamente que no lo genera; solo existe en memoria en `packages/agents`.

**Higiene de repo (menor):**
- Guard de ruta con 404 literal para acceso cruzado de tenant en `apps/web` (hoy el aislamiento real es 100% correcto vía RLS/403 de API, pero no hay una página 404 dedicada).
- Micro-corrección de API-15/WI-06 (en curso, ronda #70).
