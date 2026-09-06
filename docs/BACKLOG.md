# Backlog de Épicas — Atiende Licitaciones

Derivado de `docs/REQUISITOS.md` (REQ-001 a REQ-171) y `docs/ACEPTACION.md`. Orden = dependencia técnica primero, prioridad después. Cada épica declara: REQ asociados, paquete/app responsable, estado y las pruebas de aceptación (REQ de ACEPTACION.md y/o pruebas mínimas A1-A15) que cierra.

**Actualizado 2026-09-06 (cierre formal de la ronda 5, HEAD `071263a`)** a partir de `docs/ACEPTACION.md` (versión final tras ronda 5, 186 filas), `docs/TABLERO.md`, `docs/PROGRESO.md` completo (rondas 0–5) y todos los informes de `docs/auditoria-1/*.md` y `docs/auditoria-2/*.md` (incl. `api-ronda5.md`, `api-ronda5-reverificacion.md`, `api-r5-09-10-reverificacion.md`, `ronda5-final.md`, `ronda5-final-reverificacion.md`) y `apps/api/docs/e11-cobertura.md`. Esta actualización **reemplaza** la de HEAD `b362e62`/commit `e61156e` (cierre de ronda 4, 2026-09-06 temprano), que a su vez reemplazó la de HEAD `b7ce950` (2026-09-05). Escala de estado usada aquí, alineada 1:1 con `docs/ACEPTACION.md`: **pendiente** (sin trabajo de código), **en curso** (implementación y/o corrección activa, hallazgos abiertos relevantes o funcionalidad parcial), **cerrado con reverificación** (reverificación adversarial independiente confirma cierre con veredicto CERRADO explícito; límites residuales ≤MEDIA documentados y aceptados tras 3 vueltas no impiden este estado), **bloqueado-externo** (requiere una acción fuera del control del equipo: credenciales, acceso de terceros, decisión del usuario).

## E1 — Fundamentos de plataforma (monorepo, esquema núcleo, runtime de agentes, conectores base)
**Estado: CERRADO CON REVERIFICACIÓN** — los 5 paquetes tienen implementación, corrección y reverificación adversarial independiente con veredicto CERRADO. Los hallazgos CRÍTICOS que estaban abiertos al cierre de `b7ce950` (DB-08 refresh_tokens SECURITY DEFINER, DB-12 `my_organizations`) fueron corregidos por el corrector de seguridad #49 y reverificados sin huecos en `docs/auditoria-1/db-api-seguridad-reverificacion.md` (commit `8edacdb`). Límites aceptados: AG-05, AG-12 (`packages/agents`, ver §"Hallazgos" abajo).

| Paquete/app | Alcance |
|---|---|
| apps/web | Base Vite+React+TS+Tailwind+shadcn, layout/navegación paritaria con Restaurantes |
| apps/api | Fastify+zod+JWT, roles vía claims, idempotencia, rate limit, `audit_log` |
| packages/db | Esquema núcleo OCDS+MxCnet, RLS por tenant, migraciones probadas en PGlite |
| packages/agents | Runtime de agentes (registro de conectores, orquestador determinista por código) |
| packages/sources | Registro de conectores (`Source.fetch`/`Mapper.to_ocds`), raw lake inmutable |

REQ: REQ-004, REQ-005, REQ-007, REQ-008, REQ-057, REQ-058, REQ-062, REQ-063, REQ-068 a REQ-076, REQ-082, REQ-083, REQ-095, REQ-096.
Cierra (parcial, base técnica): REQ-004, REQ-005, REQ-057, REQ-058, REQ-068, REQ-070, REQ-071, REQ-073, REQ-074, REQ-083, REQ-095, REQ-096 de ACEPTACION.md.
Sin dependencias previas.

**Evidencia por paquete (estado final):**
- apps/web: 20/20 hallazgos ronda 1 CERRADO (`web-reverificacion-2.md`, commit `eeeeaac`), axe 0 violaciones en 48 combinaciones ruta×tema; W-21/W-22/W-23 de esa ronda corregidos en ronda 3 (WI-01..06 de auditoría 2), reverificados sin residuo en `reverificacion-final-integrada.md`.
- apps/api + packages/db (núcleo): DB-08/DB-12 (CRÍTICA) y API-08 (ALTA) CERRADO por corrector de seguridad #49 y reverificado sin huecos (`db-api-seguridad-reverificacion.md`, commit `8edacdb`); DB-13/API-13/API-14 (nuevos en auditoría 2) CERRADO y reverificados en `api-expediente-reverificacion.md` (commit `2b0b028`) y `reverificacion-final-integrada.md` (commit `1ff99fb`). db 156/156, api 180/180 tests.
- packages/agents: cerrado con reverificación de cierre (`agents-cierre.md`, commit `f3e6a3b`) — 19/22 hallazgos CERRADO, AG-05/AG-12 límite aceptado; AG-23 corregido y **confirmado de forma independiente** en `docs/auditoria-1/verificacion-puntual-final.md` (commit `1270ea6`, 14 ataques sin bypass). 263/263 tests.
- packages/sources: cerrado con reverificación definitiva (`sources-cierre-definitivo.md`, commit `0bf72d3`) — 24/25 hallazgos CERRADO; único residual abierto SR-25 (BAJA-MEDIA, límite aceptado con causa) y el carácter cooperativo de `reportDropped` (límite estructural documentado). 204/204 tests.

**Hallazgos que quedan (todos ≤MEDIA, límites aceptados o micro-corrección en curso, ninguno ALTA/CRÍTICA abierto):**
- AG-05, AG-12 (`packages/agents`) — límites arquitectónicos aceptados, ver `docs/TABLERO.md` §4.2.
- SR-25 (`packages/sources`) — límite aceptado, ver `docs/TABLERO.md` §4.2.
- DB-07, DB-09 (`packages/db`) — límites de alcance documentados, mitigados, ver `docs/TABLERO.md` §4.2.
- API-15, WI-06 (BAJA, no explotables) — REPARADOS (commits `fbf5771`/`9bd8b55`, corrector #70) sin reverificación adversarial independiente adicional, fuera del alcance de esta épica en sentido estricto.

**Dependencias pendientes:** B-03 (CI con Postgres real) para validar RLS/migraciones fuera de PGlite en un entorno reproducible — no bloquea el cierre de esta épica (ya cerrada sobre PGlite con 198 ataques acumulados y 0 fugas abiertas), pero es la única vía para elevar la evidencia de PGlite a Postgres real de producción.

## E2 — Perfil de empresa y datos reales
**Estado: EN CURSO** — depende de E1 (cerrado). Avance real desde `b7ce950`: AE-08 (hash de perfil completo incl. capabilities/experience/signatories) CERRADO y reverificado; `apps/web` ronda 3 conecta el módulo "Empresa" a datos reales (ya no `EmptyState`). Ronda 5 cierra **REQ-142**: `field_provenance` ya no solo se registra, ahora se aplica de verdad — una capacidad sin procedencia bloquea el requisito en el expediente y un documento sin procedencia genera `no_evaluable` explícito en matching (`security-req142-provenance-binding.test.ts`, CERRADO y reverificado en `docs/auditoria-2/api-ronda5.md`, `api-ronda5-reverificacion.md`, `ronda5-final.md`). Sigue sin test dedicado de la regla "firma de no-firmante rechazada" (REQ-145 E2E) ni de "rol sin permiso de edición" (REQ-144).

| Paquete/app | Alcance |
|---|---|
| packages/db | Tablas de perfil (capacidades, experiencia, productos/servicios, ubicaciones, registros, documentos con vigencia, firmantes, restricciones) con columnas de procedencia (`owner`, `source`, `updated_at`) por campo |
| apps/api | Endpoints CRUD por categoría de perfil con autorización granular |
| apps/web | Pantallas de perfil de empresa (una por categoría) y edición de firmantes/restricciones |

REQ: REQ-141 a REQ-145 (sección 29), más REQ-022 a REQ-024, REQ-026 (bóveda documental aplicada al perfil).
Cierra: REQ-141 a REQ-145 de ACEPTACION.md; contribuye a A6 (dato ausente/contradictorio), A7 (documento/certificado vencido).

**Evidencia:** 8 tablas de perfil + `field_provenance`; AE-08 (companyProfileHash cubre capabilities/experience/authorized_signatories) CERRADO y reverificado sin huecos (`api-expediente-reverificacion.md`, `reverificacion-final-integrada.md`); flujo writer-propone/owner-admin-aprueba probado en API real; `apps/web` "Empresa" conectado real desde ronda 3 (`docs/logs/web-ronda3.log`). API-11 (magic bytes en subida de documentos) CERRADO y reverificado (ver E9).

**Hallazgos abiertos:** REQ-143 (`evidenceDocId` obligatorio solo a nivel de tipos TypeScript, sin aserción runtime, sin test de `resolveExperience`); REQ-144 (rol sin permiso de edición, sin test dedicado); REQ-145 (firmantes: regla de negocio correcta a nivel de librería `resolveAuthorizedSigner`, pero sin E2E de UI/API que la ejercite). REQ-142 CERRADO en ronda 5 (ver arriba).

**Dependencias pendientes:** ninguna externa; requiere trabajo de test dedicado en `apps/api`/`apps/web`, no bloqueado por ningún paquete ajeno.

## E3 — Ingesta oficial y frescura
**Estado: CERRADO CON REVERIFICACIÓN** (mecanismo) — depende de E1 (cerrado). `packages/sources` cerrado con reverificación definitiva (24/25 hallazgos CERRADO, SR-25 límite aceptado); `apps/worker` cerrado con reverificación (298/298, WK-19..23 CERRADO); `apps/web` ronda 3 conecta el panel de frescura a datos reales (confirmado "A4 UI real" en `docs/auditoria-2/web-integrado.md`). La integración **real** contra ComprasMX/OCDS-SHCP/PDN-S6/portales estatales permanece BLOQUEADO_EXTERNO por B-02 — límite aceptado documentado, no pendiente de ingeniería.

| Paquete/app | Alcance |
|---|---|
| packages/sources | Scheduler configurable por fuente, adaptador ComprasMX/DOF/OCDS-SHCP/PDN-S6/estatales con verificación puntual del portal oficial vigente, tabla `source_runs` |
| apps/api | Endpoints de estado/frescura por fuente |
| apps/web | Panel de fuentes y frescura en back office |

REQ: REQ-001, REQ-003, REQ-076, REQ-077, REQ-079, REQ-132 a REQ-136 (sección 27), REQ-146 a REQ-150 (sección 30).
Cierra: REQ-001, REQ-132 a REQ-135, REQ-146 a REQ-150 de ACEPTACION.md; A4 (fuente inaccesible y obsolescencia visible).

**Evidencia:** REQ-146/147/149/150 con evidencia real y reverificada (Scheduler sin duplicados en `apps/worker`; estados explícitos `not_configured`/`captcha_detected`/`interface_changed` vía `ResponseClassifier`; verificación puntual real por fuente en `docs/auditoria-1/sources-cierre-definitivo.md` — DOF 200 con tamaño exacto, CSV histórico SABG con streaming real). `apps/web` `FuentesFrescuraPage.tsx` conectado real a `app.source_freshness()` (ronda 3, confirmado en `docs/auditoria-2/web-integrado.md`, ya no demo estática).

**Hallazgos que quedan:** SR-25 (BAJA-MEDIA, límite aceptado — falso positivo por longitud en notas DOF breves) y el carácter cooperativo de `reportDropped` (límite estructural documentado) afectan REQ-148 con matiz, no lo invalidan. Ningún hallazgo ALTA/CRÍTICA abierto.

**Dependencias pendientes:** **B-02 (ComprasMX bloqueado por reCAPTCHA, 401/403)** — abierto, externo, requiere acceso/permisos oficiales o fuente alterna autorizada por el usuario; sin esto la ingesta real de la fuente principal permanece sobre fixtures (CSV histórico SABG), no sobre el flujo en vivo. OCDS-SHCP inalcanzable, PDN-S6 con bot-detection, portales estatales sin API localizable — mismo bloqueo de fondo. Esto es un **límite aceptado documentado**, no una tarea de ingeniería pendiente.

## E4 — Detección de cambios y versiones
**Estado: CERRADO CON REVERIFICACIÓN** — depende de E3 (cerrado).

| Paquete/app | Alcance |
|---|---|
| packages/db | `tender_versions`/historial, invalidación en cascada de dependientes |
| packages/sources | Diff de versiones, aclaraciones y anexos con dedupe por identidad+versión |
| packages/agents | Reglas de invalidación automática de tareas/matriz/propuestas dependientes |

REQ: REQ-017, REQ-041, REQ-151 a REQ-155 (sección 31).
Cierra: REQ-017, REQ-151 a REQ-155 de ACEPTACION.md; A1 (nueva publicación), A2 (duplicado/replay), A3 (modificación/aclaración y plazo adelantado).

**Evidencia:** REQ-151-154 CUMPLIDO — `apps/api/test/tenders-and-ingest.test.ts` cubre A1/A2/A3 con HTTP real (invalidación real de `proposals.invalidated_at`); DB-05 (invalidación por `change_events`) CERRADO y reverificado sin huecos (fail-closed por diseño). La cascada hasta el expediente también se cerró: EX-EXP-01/11/17 (hash de insumos vinculante) + AE-02/AE-14 (re-derivación de estado del paquete en `apps/api`) CERRADO y reverificado en `api-expediente-reverificacion.md` y `reverificacion-final-integrada.md` (A11/A14 CUMPLE).

**Hallazgos que quedan:** REQ-155 — la cascada de invalidación es real y cerrada, pero **la notificación explícita a los roles responsables del cambio** sigue sin implementar (no hay canal de notificación); es la única brecha que impide marcar REQ-155 CUMPLIDO.

**Dependencias pendientes:** ninguna externa; implementar el mecanismo de notificación es trabajo de producto/ingeniería puro, sin bloqueo de terceros.

## E5 — Matching por empresa (relevancia y elegibilidad)
**Estado: EN CURSO** — depende de E2 (en curso) y E4 (cerrado). El motor determinista (elegibilidad + relevancia léxica) está cerrado (SR-11, `packages/sources`, CUMPLIDO); ahora expuesto de forma real en `apps/api` (rutas `matching/go-no-go.routes.ts`) y `apps/web` (página Go/No-Go conectada, ronda 3). Bloqueado en su componente semántico por la falta de pgvector/embeddings reales.

| Paquete/app | Alcance |
|---|---|
| packages/agents | Motor de relevancia (semántico+léxico) y elegibilidad (reglas duras), score explicable separado |
| packages/db | `match_procedures` (pgvector+BM25), RLS |
| apps/api / apps/web | Exposición de ambos scores con evidencia y priorización |

REQ: REQ-002, REQ-006, REQ-009 a REQ-013, REQ-059 a REQ-061, REQ-111, REQ-166, REQ-167, REQ-168 (secciones 2, 3, 10, 24, 33).
Cierra: REQ-006, REQ-009 a REQ-013, REQ-059 a REQ-061, REQ-111, REQ-166 a REQ-168 de ACEPTACION.md; A5 (dos clientes, cero fuga), A6 (dato ausente/contradictorio, parcial).

**Evidencia:** REQ-059/167 CUMPLIDO (RLS 198 ataques acumulados, 0 fugas abiertas, reverificado 3 veces de forma independiente); REQ-166 CUMPLIDO (elegibilidad separada de score, SR-11 cerrado); A5 = CUMPLE en `reverificacion-final-integrada.md` (dos tenants con capacidades distintas, cero fuga, HTTP real). REQ-012/REQ-168 pasan a EN_EVIDENCIA (fuerte): la página Go/No-Go de `apps/web` ya está conectada a `apps/api` real desde la ronda 3.

**Hallazgos abiertos:** **REQ-061 (vector store, pgvector) sin implementación** — el motor semántico real (embeddings) no está construido; el matching actual es léxico/reglas duras; sin cambio desde el corte anterior. REQ-006/REQ-011 (gold set de precisión y de 30 convocatorias reales) tampoco tienen cambio.

**Dependencias pendientes:** **OpenAI sin credenciales verificadas** — bloquea tanto el componente semántico de este motor como cualquier score explicable que dependa de embeddings reales; hoy el `ProviderRouter`/`OpenAIResponsesProvider` de `packages/agents` no se ha ejercitado contra la red real. Decisión de producto pendiente: ¿se implementa REQ-061 con embeddings reales o se declara el matching léxico diseño definitivo?

## E6 — Análisis de bases y matriz de requisitos
**Estado: EN CURSO** — depende de E4 (cerrado). La matriz de requisitos y sus conflictos están cerrados a nivel de `packages/expediente` y conectados vía HTTP real en `apps/api`; la épica completa sigue "en curso" porque el pipeline de extracción real de PDF (OCR) y el simulador de puntaje/rúbrica (REQ-020/038/108) no están construidos.

| Paquete/app | Alcance |
|---|---|
| packages/agents | Pipeline de extracción (Docling/PyMuPDF + OCR por excepción), verificación de citas, simulador de puntaje |
| packages/db | Matriz de requisitos con campos de gestión (fuente/página/cláusula/obligatoriedad/responsable/fecha/evidencia/estado) |
| apps/web | Visor de bases con citas resaltadas |

REQ: REQ-014 a REQ-021, REQ-101, REQ-108, REQ-156 (secciones 4, 23, 32).
Cierra: REQ-014 a REQ-021, REQ-101, REQ-108, REQ-156 de ACEPTACION.md; contribuye a A9 (anexo obligatorio faltante, detección).

**Evidencia:** extractor de matriz de requisitos (regex + hook LLM `fake`) implementado desde ronda 1 de `packages/expediente` (commit `467be32`); columnas de gestión de la matriz (obligatoriedad/cláusula/plazo/responsable/estado/extractor/confianza) y tabla `requirement_conflicts` añadidas en el esquema de ronda 3 (`06286bf`, migraciones 0029–0032).

**Hallazgos abiertos:** condicionales que aplican y desaparecían en silencio (EX-EXP-03/12) **CERRADO** (corrector #31, test de propiedad con 200 casos) y reverificado sin residuo en `expediente-cierre.md` (0 críticos/altos abiertos en el paquete). `apps/api` ronda 3 conecta matriz+conflictos vía HTTP real (`expediente-documents-and-matrix.test.ts`, A6 CUMPLE). Sin OCR real: el pipeline sigue operando sobre texto ya extraído o marcando `requires_ocr`, nunca sobre documentos escaneados reales. Simulador de puntaje (REQ-020/038/108) sigue sin implementación en ningún paquete.

**Dependencias pendientes:** OpenAI sin credenciales (bloquea el hook LLM real de extracción y el simulador de puntaje); implementación real de OCR (Docling/PyMuPDF) sigue sin despachar — es la brecha de mayor impacto restante de esta épica.

## E7 — Expediente de participación (propuesta técnica+económica+anexos+checklist)
**Estado: CERRADO CON REVERIFICACIÓN** (biblioteca `packages/expediente` + API `apps/api` + UI `apps/web`) — depende de E2 (en curso), E5 (en curso), E6 (en curso). `packages/expediente` cerrado con reverificación de cierre (0 críticos/altos abiertos, `expediente-cierre.md` + micro-corrección, commit `1270ea6`); `apps/api` ronda 3 integra el paquete con 24+ rutas HTTP reales, reverificadas en `api-expediente-reverificacion.md` y `reverificacion-final-integrada.md` (A8/A9/A10/A11/A13/A14/A15 con test integrado real). **Ronda 5 conecta el resto de `apps/web`**: Análisis de bases, Cumplimiento documental, Redacción, Revisión, Expediente, Aprobaciones, Entregas y Paquete descargable — ya no queda ningún módulo de dominio del expediente sin conectar (`apps/web/README.md`); `expediente-flujo-completo.spec.ts` ejercita el flujo completo con dos actores reales, incl. A13 (descarga autenticada del `.zip` real), CERRADO y reverificado en `docs/auditoria-2/ronda5-final.md`/`ronda5-final-reverificacion.md`.
**Paquete**: `packages/expediente` (orquesta generación de propuesta, checklist y paquete a partir de packages/db + packages/agents).

| Paquete/app | Alcance |
|---|---|
| packages/expediente | Generación de propuesta técnica/económica desde datos APROBADOS, checklist de integridad, versionado con hashes de insumos, invalidación de aprobación por cambio |
| packages/db | `price_catalog` aprobado, `approvals` con invalidación, `package_manifests` |
| packages/agents | Redactor/Auditor reutilizados desde E1/E6, guardrail `no_unsourced_claims` |
| apps/web | Editor de expediente, checklist visual, borrador vs. listo |

REQ: REQ-022 a REQ-036, REQ-037, REQ-038, REQ-048, REQ-157 a REQ-163 (secciones 5, 6, 7, 8, 32).
Cierra: REQ-022 a REQ-036, REQ-048, REQ-157 a REQ-163 de ACEPTACION.md; A7 (documento vencido), A8 (precio no aprobado), A9 (anexo faltante), A10 (cálculo económico), A11 (edición invalida aprobación), A13 (expediente completo descargable), A14 (expediente incompleto nunca listo).

**Evidencia:** `packages/expediente` cerrado con 413/413 tests (0 críticos/altos abiertos). EX-EXP-01/11 (hash de insumos como string plano, sin vínculo runtime) **CERRADO** vía `InputsHash` branded + `HashedInputs` sellado (corrector #45, `14a35bb`) y reconfirmado sin bypass en `verificacion-puntual-final.md` (11 vectores de ataque al sellado, incl. `Object.create`/`structuredClone`/`Proxy`, sin éxito). AE-06/07/11 (sha256 de bytes reales, saneamiento de ZIP, bloqueo de autoaprobación) CERRADO en micro-corrección (`bfbd54e`, `50fb7ea`). `apps/api` ronda 3 integra el paquete con 24+ rutas reales; AE-01/02/08/09/10/14/15 y DB-13/API-13/API-14 CERRADO y reverificados sin huecos.

**Límites aceptados que quedan (ninguno bloquea el cierre de la épica):** EX-EXP-08 (autoaprobación entre cuentas de la misma persona física — requiere capa de identidad ajena a la librería, delegado a `apps/api`, no implementado); EX-EXP-10 (decisión de diseño correcta, no un defecto).

**Dependencias pendientes:** OpenAI sin credenciales (el Redactor/Auditor de `packages/agents` sigue sin cliente LLM real integrado a expediente) — es la única dependencia que queda; la conexión de `apps/web` (incl. descarga autenticada real) ya cerró en ronda 5.

## E8 — Auditoría, aprobación y entrega
**Estado: EN CURSO** — depende de E7 (cerrado). El ciclo de aprobación/invalidación/re-derivación de estado está cerrado y reverificado (A11/A14 CUMPLE). **Ronda 5 cierra REQ-044/064**: 2FA TOTP real con step-up de un solo uso atado a `(usuario, org, propósito)`, límite de tasa + bloqueo progresivo + auditoría de fallos con IP, extendido a la aprobación de `tool_calls` (org-scoped y cross-org de superadmin, R5-11) y conectado en `apps/web` con diálogos de step-up reales (RF-01) — cadena completa auditoría→corrección→reverificación independiente en `docs/auditoria-2/api-ronda5.md`, `api-ronda5-reverificacion.md`, `api-r5-09-10-reverificacion.md`, `ronda5-final.md`, `ronda5-final-reverificacion.md`. Sigue en curso porque passkey/WebAuthn (matiz de REQ-044/064, solo TOTP hoy), la "sala de guerra" (REQ-040) y el juez LLM distinto del redactor (REQ-039/127, bloqueado por OpenAI) no están construidos.

| Paquete/app | Alcance |
|---|---|
| packages/agents | Auditor con 5 puertas deterministas + juez LLM distinto del redactor |
| apps/api | Máquina de estados del paquete, `needs_approval`/HITL, doble confirmación económica con re-autenticación |
| apps/web | Flujos de aprobación 1/2-2/2, descarga autenticada, sala de guerra |

REQ: REQ-037 a REQ-047, REQ-062 a REQ-064, REQ-161, REQ-162, REQ-165 (secciones 7, 8, 11, 32, 33).
Cierra: REQ-037 a REQ-047, REQ-062 a REQ-064 de ACEPTACION.md; A11 (edición invalida aprobación), A12 (autorización desde rol indebido), A15 (firma/envío siempre del usuario).

**Evidencia:** `ApprovalWorkflow` con invalidación jerárquica de aprobaciones (packages/expediente, rondas 1–2); esquema de ronda 3 añade alcance jerárquico + log reproducible de eventos (`proposal_approval_events`) y comentarios (`proposal_comments`), con política RLS de aprobación corregida a `reviewer/admin/owner` (`06286bf`). A15: superficie sin envío/firma confirmada por `api-surface.test.ts` (packages/expediente) y por auditoría de agents (AG-05/no-fabrication).

**Hallazgos abiertos:** API-08 (bypass de autorización de rol vía invitación como owner) **CERRADO** y reverificado (ver E1/E9); A11/A12 = CUMPLE en `reverificacion-final-integrada.md`, reconfirmado desde UI real en ronda 5. El flujo de aprobación de tarifas y de expediente está conectado, probado y con step-up 2FA en `apps/web` (`TarifasAprobadasPage`/`RevisionPage`, WI-04 CERRADO, REQ-044/064 CERRADO), pero un flujo completo de "sala de guerra" no existe. Auditor con juez LLM distinto del redactor: sin evidencia de implementación (bloqueado por falta de credenciales OpenAI). R5-12 (BAJA, sin corregir): comentario desactualizado en `apps/web/src/lib/api/twofa.ts` sobre el alcance de `/2fa/verify-enrollment`, sin impacto funcional.

**Dependencias pendientes:** OpenAI sin credenciales (juez LLM, requerido para REQ-039/127); ninguna otra dependencia externa — el resto es trabajo de producto/ingeniería puro (sala de guerra, passkey/WebAuthn).

## E9 — Reglas duras de seguridad y no-actuación (transversal)
**Estado: CERRADO CON REVERIFICACIÓN** (límites AG-05/AG-12 aceptados) — depende de E1 (cerrado); se integra de forma cruzada en E2, E5, E7, E8.

| Paquete/app | Alcance |
|---|---|
| packages/agents | Guardrails de entrada/salida: no inventar datos/precios/certificaciones, no actuar sin autorización específica, ausencia=pendiente |
| apps/api | Enforcement server-side de las mismas reglas (no solo en el prompt) |

REQ: REQ-045 a REQ-047, REQ-068, REQ-072, REQ-097, REQ-114, REQ-164 a REQ-167 (secciones 8, 13, 22, 24, 33).
Cierra: REQ-072, REQ-097, REQ-114, REQ-164 a REQ-167 de ACEPTACION.md; A6, A8, A12, A15 (como capa de guardrail transversal a las épicas de dominio).

**Evidencia:** `packages/agents` con prohibiciones duras y tolerancia cero como invariantes de código (no configurables por constructor, cerrado en corrección 1, hash `114a2fb` + ronda 2 `971feea`/`861aea4` + ronda 3 `9cb38be`); reverificación de cierre `f3e6a3b` — **19/22 hallazgos cerrados**, límites aceptados documentados (AG-05: guardrail regex ~3% de detección real, capa LLM/juez pendiente; AG-12: alcance acotado). DB-03 (enforcement de tarifa aprobada) agnóstico de rol, ni un superadmin puede saltarlo — confirmado en reverificación db-api.

**Hallazgos abiertos que afectan la épica — todos CERRADO, salvo dos límites aceptados:**
- **DB-08/DB-12 CRÍTICA** — CERRADO por el corrector de seguridad #49 y reverificado sin huecos (ataques directos: acuñar refresh ajeno rechazado, revocar sesiones ajenas bloqueado salvo superadmin explícito).
- **API-08 ALTA** — CERRADO (solo el owner puede invitar como owner) y reverificado.
- API-09/API-10/API-11/API-12 (MEDIA-BAJA) — todos CERRADO y reverificados en `db-api-seguridad-reverificacion.md`.
- DB-13/API-13/API-14 (nuevos en auditoría 2) — CERRADO y reverificados sin huecos en `api-expediente-reverificacion.md` y `reverificacion-final-integrada.md`.
- AG-23 (agents) — CERRADO y **confirmado independientemente** en `verificacion-puntual-final.md`.
- **Únicos residuales:** DB-07/DB-09 (BAJA, límites de alcance documentados y mitigados) y AG-05/AG-12 (MEDIA, límites arquitectónicos documentados — capa LLM/juez pendiente para complementar el guardrail regex de anticolusión).

**Dependencias pendientes:** ninguna externa para el estado CERRADO actual. OpenAI sin credenciales bloquea la capa de juicio LLM que elevaría AG-12 más allá del límite aceptado.

## E10 — Back office / superadmin y observabilidad
**Estado: EN CURSO (casi cerrado)** — arrancó en paralelo con E1 (cerrado); implementación base de `apps/api` cerrada (endpoints de organizaciones, conectores, jobs, costos, incidentes, aprobaciones, memberships y audit-log, todos con ronda 4 reverificada). **Ronda 5 conecta los 3 paneles que quedaban**: Usuarios y roles (`UsuariosRolesPage.tsx` sobre `GET /organizations/:orgId/memberships`), Auditoría (`AuditoriaPage.tsx` sobre `GET /audit-log` con filtro y "Ver traza" por `correlationId`) y Aprobaciones cross-org (`AprobacionesBackofficePage.tsx` sobre `POST /admin/tool-calls/:id/approve|deny`, con step-up tras RF-01) — sumados a Fuentes/frescura, Conectores/Jobs/Costos/Incidentes ya conectados desde ronda 3/4. REQ-170 y REQ-171 CERRADOS. Solo queda REQ-169 (dashboard de métricas honestas, `PanelPage.tsx` sigue `EmptyState`), sin trabajo despachado.

| Paquete/app | Alcance |
|---|---|
| apps/web | Pantallas de conectores/frescura, jobs/reintentos, costos/límites IA, evals, incidentes, aprobaciones |
| apps/api | Endpoints de métricas honestas y trazas correlacionadas |
| packages/db | Vistas de auditoría, `correlation_id` extremo a extremo |

REQ: REQ-049, REQ-065 a REQ-067, REQ-086 a REQ-089, REQ-169 a REQ-171 (secciones 8, 12, 19, 20, 33).
Cierra: REQ-049, REQ-065 a REQ-067, REQ-086 a REQ-089, REQ-169 a REQ-171 de ACEPTACION.md.

**Evidencia:** back office/superadmin implementado en `apps/api` (organizaciones, conectores, jobs, costos, incidentes, aprobaciones); ronda 4 añade `GET /organizations/:orgId/memberships` y `GET /audit-log`/`GET /admin/audit-log`, ambos con test HTTP real. API-10 (audit_log de jobs sin organización) CERRADO y reverificado. `apps/web` ronda 3 conecta Fuentes/frescura a datos reales (A4 confirmada); ronda 5 conecta el resto (ver arriba), verificado en código, 238 tests de `apps/api` y en vivo con navegador real (`docs/auditoria-2/ronda5-final.md`, rubro 4). `correlation_id` nace en `POST /internal/tenders/ingest` y se hereda en `tenders`/`tender_versions`/`audit_log` (R5-04, CERRADO); `GET /audit-log?correlationId=` reconstruye perfil→tarifa→propuesta→checklist→aprobación→paquete completo.

**Hallazgos abiertos:** **REQ-169 (dashboard de métricas honestas) sin evidencia** — `PanelPage.tsx` sigue siendo `EmptyState`, sin trabajo despachado. **Residual documentado en REQ-171** (fuera del ámbito de ronda 5): `apps/worker/src/source-runs/source-runs-repository.ts` nunca incluye `correlation_id` en su INSERT a `source_runs` — el primer eslabón (descubrimiento automático) sigue sin id de correlación, aunque no bloquea el criterio observable desde `apps/api`.

**Dependencias pendientes:** ninguna externa; queda construir el dashboard de métricas (REQ-169) y, opcionalmente, extender `correlation_id` al paso de descubrimiento de `apps/worker`.

## E11 — Seguimiento post-adjudicación
**Estado: EN CURSO** (corregido — el snapshot `e61156e` decía "0% construido", lo cual ya era inexacto incluso antes de ronda 5: `apps/api/src/modules/expediente/post-award.routes.ts` existe desde ronda 3, con migración 0032 y `expediente-post-award.test.ts`). Depende de E7/E8 (ambos cerrados/en curso avanzado).

| Paquete/app | Alcance |
|---|---|
| apps/api | CRUD real de seguimientos (hitos/garantías/facturación/pago/penalización/convenio), cómputo del plazo de pago con motor legal versionado por fecha, calendario oficial de días inhábiles, alertas de vencimiento |
| packages/db | `post_award_followups` (columnas tipadas por `kind`), `calendar_holidays` (jurisdicción/año/fecha/fuente) |
| apps/web | `SeguimientoPage.tsx` conectado, con tarjeta de alertas |
| packages/agents (pendiente) | Cobranza (máquina de estados del contrato), autopsia del fallo, redactor de inconformidades, radar de renovaciones específico |

REQ: REQ-050 a REQ-056 (sección 9).
Cierra: REQ-050 de ACEPTACION.md (CUMPLIDO). REQ-056 BLOQUEADO_EXTERNO parcial. REQ-051 a REQ-055 siguen PENDIENTE.

**Evidencia (desde ronda 3, reconciliada y ampliada en ronda 5):** `post-award.routes.ts` (ronda 3) ya calculaba el plazo de pago real (17 días hábiles, LAASSP Art. 73, versionado por fecha de convocatoria) con recordatorios encolados en `jobs`. **Ronda 5 añade**: datos estructurados por `kind` (`hito` exige `responsibleParty`; `garantia` exige `guaranteeType`; `facturacion` exige `cfdiReference`+`acceptanceDate` y calcula el mismo plazo legal que `pago`; `penalizacion`/`convenio_modificatorio` exigen `modificationReference`); tabla real `calendar_holidays` (jurisdicción/año/fecha/fuente+fecha de consulta) + `GET/POST /admin/calendar-holidays` (RLS: lectura abierta, escritura solo superadmin); `alertLevel` (`vencido`/`proximo`) + `GET /expediente/post-award-alerts`; `apps/web` conecta `SeguimientoPage.tsx` con la tarjeta de alertas. Detalle completo en `apps/api/docs/e11-cobertura.md`. **R5-01 (CRÍTICO) CERRADO**: el calendario cargado no afectaba el cómputo real del plazo por un bug de conversión de fecha, y `calendarNote` mentía afirmando inclusión — reparado y reverificado dos veces sin bypass (`docs/auditoria-2/api-ronda5.md`, `api-ronda5-reverificacion.md`).

**Hallazgos abiertos:** **REQ-056 BLOQUEADO_EXTERNO parcial** — la tabla `calendar_holidays` se despliega y permanece **VACÍA**: la verificación legal de esta ronda no pudo confirmar en línea el calendario oficial de la SABG; sin feriados cargados, el cómputo real solo excluye sábado/domingo (declarado honestamente en `calendarNote`). Además, "alerta si la convocatoria fija menos plazo del mínimo legal" y los recordatorios T-72/24/6h del texto del requisito no están construidos. **REQ-051 a REQ-055 PENDIENTE, confirmados sin código**: máquina de estados del contrato (REQ-051), extracción del contrato firmado (REQ-052), matriz de agravios/redactor de inconformidades (REQ-053), autopsia del fallo (REQ-054), radar de renovaciones específico con umbrales 90/60/30 simultáneos (REQ-055) — el mecanismo genérico de alertas de ronda 5 (`post-award-alerts`) es reutilizable para renovaciones si se registran como `kind='hito'`, pero no es el cliente concreto que exige el requisito.

**Dependencias pendientes:** un administrador humano (o una ronda con acceso confirmado a la fuente oficial de la SABG) para cargar `calendar_holidays` con datos reales (REQ-056); trabajo de ingeniería puro y no bloqueado externamente para REQ-051 a REQ-055 (sin trabajo despachado a ningún agente implementador todavía).

## E12 — Verificación del marco legal mexicano (gate transversal, no bloquea desarrollo técnico)
**Estado: IMPLEMENTADO-EN-EVIDENCIA (con matices)** — verificación puntual real completada; corre en paralelo, condiciona qué se puede codificar como "cumplido" en E7/E8/E11.

| Paquete/app | Alcance |
|---|---|
| (sin paquete de código; gobierno/legal) | Verificación contra DOF de vigencias LAASSP, plazo de pago, garantías, topes de convenio, umbrales PEF |

REQ: REQ-100 a REQ-123 (secciones 23, 24, 25).
Cierra: REQ-100 a REQ-123 de ACEPTACION.md (varios permanecen "bloqueado hasta VERIFICAR" hasta evidencia oficial). No bloquea E1-E11 salvo el motor determinista de plazos/montos legales específicos que dependan de la cifra exacta en disputa.

**Evidencia:** agente #21 completó verificación puntual solo con fuentes oficiales — `docs/legal/verificacion-legal.md` y filas de secciones 23–25 de `docs/REQUISITOS.md` (commit `0698544`): **6 VERIFICADO, 11 VERIFICADO-CON-MATIZ, 4 NO-VERIFICABLE-EN-LÍNEA, 3 NO-APLICA**. Cambios normativos con fecha DOF registrados en `docs/DECISIONES.md` (D-07: LAASSP nueva 16-abr-2025, pago 17 días hábiles, LOPSRM reformada, Plataforma Digital de Contrataciones Públicas/SABG, nueva LFPDPPP 20-mar-2025).

**Hallazgos abiertos:** los 4 REQ marcados NO-VERIFICABLE-EN-LÍNEA y los 11 VERIFICADO-CON-MATIZ requieren validación por abogado antes de afirmarse como cumplimiento legal frente a clientes — no es un hallazgo de código, es una condición de aceptación explícita.

**Avance técnico relacionado (sin cambiar el veredicto legal):** `apps/api` ronda 3 expone `calendarNote`/`legalRegime` con la fecha DOF verificada (AE-09, CERRADO y reverificado sin huecos) en el cálculo de plazo de pago; ronda 5 cierra R5-01 (el calendario de días inhábiles cargado ya afecta el cómputo real, REQ-050 CUMPLIDO) y publica `GET /legal/privacy-notice` (REQ-119, contenido basado en la LFPDPPP DOF 20-mar-2025/SABG ya verificada, marcado explícitamente `borrador_pendiente_validacion_juridica`) — dos casos reales más de norma verificada llegando a código de producto, sin que ninguno constituya validación jurídica.

**Dependencias pendientes: BLOQUEADO-EXTERNO (parcial)** — validación por asesoría legal humana para las 11 filas VERIFICADO-CON-MATIZ y las 4 NO-VERIFICABLE-EN-LÍNEA; no depende de trabajo de ingeniería adicional. Pendiente propagar la nomenclatura legal vigente a `apps/web` (etiquetas de fuente) más allá de lo ya hecho en `packages/sources`/`apps/api`.

## E0 — Gobierno del ciclo de construcción (continuo, no secuencial)
**Estado: EN CURSO** — aplica a todas las épicas desde el inicio; esta misma actualización de BACKLOG.md es un artefacto de E0.

REQ: REQ-124 a REQ-131, REQ-137 a REQ-140 (secciones 26, 28).
Cierra: REQ-124 a REQ-131, REQ-137 a REQ-140 de ACEPTACION.md.

**Evidencia:** `docs/PROGRESO.md` (registro completo rondas 0–5), `docs/BLOQUEOS.md` (incidentes INC-01..09 todos CERRADOS salvo INC-08 en observación, con reglas reforzadas cada vez; bloqueos B-01/B-02/B-03 ABIERTOS y declarados como tales, nunca ocultados), `docs/TABLERO.md`/`docs/ACEPTACION.md` (**cierre formal de ronda 5, commit `071263a`: 186 criterios → 69 PENDIENTE, 53 EN_EVIDENCIA, 54 CUMPLIDO, 5 LÍMITE_ACEPTADO, 3 NO_APLICA, 2 BLOQUEADO_EXTERNO** — reemplaza el snapshot de ronda 4, commit `e61156e`: 77 · 53 · 47 · 5 · 3 · 1). REQ-131 (aviso de privacidad y reporte de transparencia) pasa de PENDIENTE a EN_EVIDENCIA en ronda 5: el aviso de REQ-119 ya existe y es versionado, aunque el reporte de transparencia y el enrutamiento alternativo que lo activaría no existen todavía (no es una regresión, es funcionalidad aún no necesaria). Disciplina de un solo escritor por archivo compartido y `git commit -- <rutas>` reforzada tras cada incidente de índice/historial compartido.

**Hallazgos abiertos:** ninguno de código propio de esta épica. Se corrigió en este cierre una inconsistencia de gobierno detectada por la propia auditoría de ronda 5 (R5-08, `docs/auditoria-2/api-ronda5.md`): `docs/TABLERO.md`/`docs/BACKLOG.md` seguían describiendo E11 como "0% construido" pese a que `apps/api/src/modules/expediente/post-award.routes.ts` existe desde ronda 3 — reconciliado en esta actualización (ver E11 arriba).

**Dependencias pendientes:** B-01 (ruta de "empresas agénticas" no verificada) — informativo, no bloquea el trabajo técnico en el staging actual; B-02 (ComprasMX/OCDS-SHCP/PDN-S6/portales estatales) — límite aceptado documentado, no pendiente de ingeniería; B-03 (CI con Postgres real) — requiere decisión del usuario sobre publicar un remoto GitHub privado.

---

## Orden de ejecución sugerido (dependencia → prioridad) — estado al cierre de ronda 5

1. **E1** — **CERRADO CON REVERIFICACIÓN**.
2. **E3** y **E2** — E3 **CERRADO CON REVERIFICACIÓN** (mecanismo); E2 EN CURSO (REQ-142 CERRADO en ronda 5).
3. **E4** — **CERRADO CON REVERIFICACIÓN**.
4. **E6** (en curso) y **E5** (en curso), en paralelo.
5. **E9** (transversal) — **CERRADO CON REVERIFICACIÓN** (límites AG-05/AG-12 aceptados).
6. **E7** — **CERRADO CON REVERIFICACIÓN** (biblioteca+API+UI, completo desde ronda 5).
7. **E8** — en curso (2FA/step-up TOTP CERRADO en ronda 5; falta passkey/WebAuthn y sala de guerra).
8. **E10** — en curso, casi cerrado (back office completo salvo dashboard de métricas, REQ-169).
9. **E11** — en curso (post-award real desde ronda 3, corregido de la descripción errónea "0% construido"; ronda 5 añade estructura/alertas/calendario; REQ-050 CUMPLIDO, REQ-056 bloqueado externo parcial, REQ-051..055 pendientes).
10. **E12** y **E0** — transversales; E12 en curso/bloqueado en validación por abogado (REQ-119 pasa a EN_EVIDENCIA en ronda 5); E0 en curso permanente (REQ-131 pasa a EN_EVIDENCIA).

Las 15 pruebas mínimas obligatorias de la ampliación (A1-A15, ver `docs/ACEPTACION.md`) alcanzan **11 de 15 en CUMPLIDO** tras ronda 5 (A1, A2, A5, A6, A7, A8, A11, A12, A13, A14, A15 — A13 se suma en ronda 5 con la descarga autenticada real desde `apps/web`, reverificado en `docs/auditoria-2/ronda5-final.md`/`ronda5-final-reverificacion.md`). Las 4 restantes (A3, A4, A9, A10) están en EN_EVIDENCIA (fuerte) — el mecanismo real existe y está probado, pero falta notificación a roles responsables (A3), un test E2E de obsolescencia de punta a punta (A4), nomenclatura de test explícita a nivel `apps/api` (A9), o el motor de banda de precio REQ-030 (A10).

## Orden de cierre restante

Lo que queda, por épica, para que `docs/ACEPTACION.md` pueda considerar CUMPLIDO cada REQ que sigue en EN_EVIDENCIA o PENDIENTE (las épicas ya CERRADAS CON REVERIFICACIÓN — E1, E3, E4, E7, E9 — no tienen orden de cierre pendiente salvo los límites aceptados ya documentados, que no requieren una cuarta vuelta):

- **E2**: escribir tests dedicados para "rol sin permiso de edición de perfil" (REQ-144) y "firma de no-firmante rechazada" en un flujo E2E real (REQ-145). REQ-142 ya CERRÓ en ronda 5.
- **E3**: ComprasMX/OCDS-SHCP/PDN-S6/portales estatales en vivo permanecen fuera de alcance mientras B-02 esté abierto — ya documentado como límite aceptado, no pendiente de ingeniería; sin acción de ingeniería adicional posible sin credenciales/acceso oficial.
- **E4**: implementar el canal de notificación a los roles responsables ante invalidación por cambio de bases (único punto pendiente de REQ-155); todo lo demás de la épica está cerrado.
- **E5**: decidir y documentar si REQ-061 (vector store) se implementa con embeddings reales (requiere OpenAI) o se declara fuera de alcance con matching léxico como diseño definitivo; construir el gold set de 30 convocatorias para REQ-011.
- **E6**: implementar el pipeline OCR real (Docling/PyMuPDF) para operar sobre documentos escaneados reales, no solo texto ya extraído (REQ-014/015/018/129); implementar el simulador de puntaje/rúbrica (REQ-020/038/108).
- **E7**: resolver EX-EXP-08 (autoaprobación multi-cuenta) si se decide que amerita una capa de identidad en `apps/api` — es el único punto abierto; la conexión de `apps/web` (incl. A13) ya cerró en ronda 5.
- **E8**: implementar passkey/WebAuthn como segundo factor adicional al TOTP ya cerrado (matiz de REQ-044/064); implementar la "sala de guerra" (REQ-040); construir el juez LLM distinto del redactor (bloqueado por falta de credenciales OpenAI).
- **E9**: decidir si se invierte en una capa LLM/juez para elevar la detección real del guardrail anticolusión más allá del ~3% actual (AG-12, límite aceptado) — es una decisión de producto/presupuesto, no un defecto pendiente de corrección.
- **E10**: construir el dashboard de métricas honestas (REQ-169, único módulo que queda en `EmptyState`); opcionalmente extender `correlation_id` al paso de descubrimiento de `apps/worker` (residual documentado de REQ-171, no bloqueante).
- **E11**: cargar `calendar_holidays` con datos reales de la SABG (requiere un administrador humano o acceso confirmado a la fuente oficial, REQ-056); despachar una ronda de implementación real para REQ-051 a REQ-055 (máquina de estados del contrato, extracción del contrato firmado, redactor de inconformidades, autopsia del fallo, radar de renovaciones específico) — trabajo no iniciado, no bloqueado externamente salvo REQ-056.
- **E12**: obtener validación por abogado humano de las 11 filas VERIFICADO-CON-MATIZ y las 4 NO-VERIFICABLE-EN-LÍNEA de `docs/legal/verificacion-legal.md` (incluido el aviso de privacidad nuevo de ronda 5, REQ-119) antes de afirmar cumplimiento legal a clientes; propagar la nomenclatura legal vigente al resto de `apps/web`.
- **E0**: mantener `BLOQUEOS.md`/`PROGRESO.md` al día en cada ronda futura; decidir si se adopta el patrón literal `tasks/evidence/<id>/` (REQ-126/137) o se declara formalmente que `docs/logs/`+`docs/auditoria-1/`+`docs/auditoria-2/`+commits es el patrón de evidencia oficial del proyecto (ya lo es de facto).

**Higiene de repo (menor, sin impacto en el orden de cierre de ninguna épica)**: R5-12 — comentario desactualizado en `apps/web/src/lib/api/twofa.ts:33-35` sobre el alcance de `/2fa/verify-enrollment` (BAJA, sin código ejecutable ni impacto funcional).

---

# Épicas de Ampliación 2 — Salida a promoción (E13-E17)

Derivadas de `docs/AMPLIACION-2-SALIDA.md` (D-08, `docs/DECISIONES.md`) y de la sección 34 de `docs/REQUISITOS.md` (REQ-172 a REQ-210). Añadidas 2026-09-06, sin tocar el contenido de E1-E12 ni el orden de ejecución ya vigente arriba. Todas parten de **pendiente** (sin trabajo de código a la fecha de esta adición); dependen de E1 (fundamentos de plataforma, autenticación, `audit_log`) y E9 (guardrails/no-actuación) ya CERRADOS CON REVERIFICACIÓN, por lo que no están bloqueadas técnicamente para arrancar.

## E13 — Autenticación con Google (OIDC)
**Estado: PENDIENTE** — depende de E1 (cerrado, reutiliza sesión/refresh/`audit_log`/2FA existentes).

| Paquete/app | Alcance |
|---|---|
| apps/api | Adaptador OIDC de Google, vinculación por email verificado, emisión de sesión/refresh idéntica al flujo existente, integración con 2FA/step-up, emisor de eventos a `audit_log`; proveedor OIDC falso para pruebas |
| apps/web | Botón "Continuar con Google" en login/registro |

REQ: REQ-172 a REQ-180 (sección 34.1).
Cierra: REQ-172 a REQ-180 de `docs/ACEPTACION.md`; pruebas mínimas S1, S2, S3.

**Dependencias pendientes:** BLOQUEADO_EXTERNO parcial — `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` reales (consola de Google Cloud) y dominio autorizado (REQ-178) para verificar el flujo contra Google real; el resto (adaptador, vinculación, 2FA, audit, rechazo de email no verificado) se construye y prueba completo con un proveedor OIDC falso, sin bloqueo.

## E14 — Correos transaccionales con plantillas
**Estado: PENDIENTE** — depende de E1 (cerrado) y del nuevo paquete `packages/mail`.

| Paquete/app | Alcance |
|---|---|
| packages/mail (nuevo) | Catálogo de 10 plantillas (asunto/disparador/variables), adaptador único de proveedor (Resend/Postmark/SMTP) por env, bandeja de captura en desarrollo/test, previsualización, enlaces firmados con expiración, registro de envíos, tono/estructura Likida con marca Atiende |
| apps/worker | Jobs de reintento de envío con backoff |
| apps/api | Preferencias de notificación/baja por usuario, endpoints de disparo de plantillas |

REQ: REQ-181 a REQ-190 (sección 34.2).
Cierra: REQ-181 a REQ-190 de `docs/ACEPTACION.md`; pruebas mínimas S4, S5, S6, S7, S12.

**Dependencias pendientes:** BLOQUEADO_EXTERNO parcial — credenciales de un proveedor de correo real (Resend/Postmark/SMTP) y dominio remitente con SPF/DKIM para el envío real (REQ-182, REQ-190); el catálogo, el renderizado, la firma de enlaces, las preferencias y el registro con reintentos se construyen y prueban completos con la bandeja de captura, sin bloqueo.

## E15 — Onboarding de producto
**Estado: PENDIENTE** — depende de E13 (login), E2 (perfil de empresa, en curso) y E1 (cerrado).

| Paquete/app | Alcance |
|---|---|
| apps/web | Flujo guiado registro→verificación→crear organización→perfil de empresa guiado→invitar equipo→primera convocatoria; checklist de activación; estados vacíos guiados en los módulos principales |
| apps/api | Endpoint(s) de estado de activación/checklist |

REQ: REQ-191 a REQ-193 (sección 34.3).
Cierra: REQ-191 a REQ-193 de `docs/ACEPTACION.md`; prueba mínima S8.

**Dependencias pendientes:** ninguna externa; trabajo de producto/ingeniería puro. Beneficia de que E13/E14 estén al menos parcialmente construidos (verificación de email e invitación a organización usan plantillas de E14), pero puede avanzar en paralelo con dobles de correo.

## E16 — Páginas públicas y legales
**Estado: PENDIENTE** — depende de E14 (correo interno de contacto) para el circuito completo del formulario; landing/SEO/analítica no dependen de ninguna otra épica.

| Paquete/app | Alcance |
|---|---|
| apps/web | Landing pública con identidad Atiende y estructura Likida, aviso de privacidad y términos (borrador jurídico marcado), página de contacto, SEO básico (metaetiquetas/sitemap/robots.txt), analítica sin datos personales |
| apps/api | Endpoint de registro de contacto + disparo de correo interno (reutiliza E14) |

REQ: REQ-194 a REQ-198 (sección 34.4).
Cierra: REQ-194 a REQ-198 de `docs/ACEPTACION.md`; pruebas mínimas S9, S10.

**Dependencias pendientes:** BLOQUEADO_EXTERNO parcial — validación final de los textos legales (aviso de privacidad y términos) por un abogado antes de afirmarlos "vigentes" a un cliente real (REQ-195, mismo patrón que REQ-119/E12); el borrador marcado, la landing, el contacto, el SEO y la analítica sin PII se construyen y prueban completos sin ese bloqueo.

## E17 — Preparación de despliegue
**Estado: PENDIENTE** — depende de E1 (cerrado, esquema y migraciones existentes de `packages/db`).

| Paquete/app | Alcance |
|---|---|
| infra/ (nuevo) | Dockerfiles de producción (api, worker, web), `docker-compose` de producción (api+worker+web+postgres), variables documentadas, ejecución de migraciones al arrancar, healthchecks por servicio, runbook de backup y de salida a producción |

REQ: REQ-199 a REQ-205 (sección 34.5).
Cierra: REQ-199 a REQ-205 de `docs/ACEPTACION.md`; prueba mínima S11.

**Dependencias pendientes:** BLOQUEADO_EXTERNO para la verificación real de S11 — **Docker no está disponible en el entorno de desarrollo actual** (`docker`/`docker-compose` no instalados), por lo que levantar el `docker-compose` y confirmar healthchecks en verde no puede ejecutarse en este entorno aunque el código esté completo; adicionalmente, dominio público, hosting y base de datos gestionada de producción los aporta el usuario (REQ-203/204/205 exigen explícitamente no desplegar ni gastar sin autorización). Los Dockerfiles, el compose, la documentación de variables, el hook de migraciones al arrancar y los runbooks se construyen completos sin ese bloqueo; solo su verificación end-to-end con contenedores reales queda pendiente del entorno/autorización.

## Pruebas que cierra la Ampliación 2 (resumen)

Las 12 pruebas mínimas obligatorias S1-S12 de `docs/ACEPTACION.md` se reparten así: S1-S3 → E13; S4-S7, S12 → E14; S8 → E15; S9-S10 → E16; S11 → E17 (bloqueada por falta de Docker en el entorno actual, no por diseño). Ninguna de las 12 tiene evidencia construida a la fecha de esta adición (2026-09-06); todas parten de PENDIENTE salvo S11 (BLOQUEADO_EXTERNO por Docker no disponible).

## E18 — Restos de mail (BAJA, tras reverificación #102)
- ML-08: alinear la ventana de espera del perdedor de `reserve()` con el timeout real del proveedor (+200 ms) para evitar resultado ambiguo (nunca duplica envío).
- ML-09: CSS de respaldo para modo oscuro en las plantillas (hoy solo meta `color-scheme: light`).
