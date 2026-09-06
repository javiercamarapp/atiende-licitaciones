# Backlog de Épicas — Atiende Licitaciones

Derivado de `docs/REQUISITOS.md` (REQ-001 a REQ-171) y `docs/ACEPTACION.md`. Orden = dependencia técnica primero, prioridad después. Cada épica declara: REQ asociados, paquete/app responsable, estado y las pruebas de aceptación (REQ de ACEPTACION.md y/o pruebas mínimas A1-A15) que cierra.

**Actualizado 2026-09-05 (turno de gobierno, HEAD `b7ce950`)** a partir de `docs/PROGRESO.md` (rondas 1–3), `docs/auditoria-1/*.md` (auditorías, correcciones y reverificaciones) y `docs/BLOQUEOS.md`. Escala de estado usada en esta actualización (no numérica, no es autoevaluación de cumplimiento): **pendiente** (sin trabajo de código), **en curso** (implementación y/o corrección activa, hallazgos abiertos relevantes), **implementado-en-evidencia** (funcionalidad real y probada, sin hallazgos ALTA/CRÍTICA abiertos que la invaliden, pero sin reverificación de cierre completa), **cerrado-con-reverificación** (reverificación independiente confirma cierre, límites residuales documentados y aceptados), **bloqueado-externo** (requiere una acción fuera del control del equipo: credenciales, acceso de terceros, decisión del usuario). El paso a CUMPLIDO en `docs/ACEPTACION.md` solo se hace al cierre formal y no se adelanta aquí.

## E1 — Fundamentos de plataforma (monorepo, esquema núcleo, runtime de agentes, conectores base)
**Estado: EN CURSO** — todos los paquetes tienen implementación, corrección y al menos una reverificación adversarial; queda abierto un hallazgo CRÍTICO de seguridad server-side y dos cierres de reverificación en curso.

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

**Evidencia por paquete:**
- apps/web: ronda 1 `a43efd7` (89 archivos, 29 tests); corrección ronda 2 (`946914a`, `ad26360`, `81e64b1`, `c043f7a`); reverificación 2 `eeeeaac` — **20/20 hallazgos CERRADO** (W-01..W-20), axe 0 violaciones en 48 combinaciones ruta×tema, 71 E2E. Nuevos W-21 ALTA / W-22 BAJA / W-23 infra, asignados a ronda 3 web (`c91300c`).
- apps/api + packages/db (núcleo): ronda 1 `8052ff4` (db 90/90, api 12/12); ronda 2 ~20 commits (`0ef79f4`…`9bf7a93`, incl. DB-01..07/API-01..07) → db 128/128, api 51/51; ronda 3 esquema `06286bf`+`048ae47` (migraciones 0029–0033 para expediente real).
- packages/agents: ronda 1 `c56e20f` (127 tests); correcciones rondas 1–3 (`114a2fb`…`9cb38be`) → 263/263 tests, cobertura 94.1/90.9%; reverificación de cierre `f3e6a3b` — 19/22 hallazgos cerrados, AG-23 corregido en `048ae47` (mezclado por incidente INC-04, contenido verificado) **pendiente de confirmación independiente**.
- packages/sources: ronda 1 `3dc9ce7` (64 tests); correcciones rondas 1–2 (`b133a67`…`81c8aa6`) → 145 tests, cobertura 91.5/84.5%; **reverificación de cierre despachada en `be64f70`, aún sin commit de resultado**.

**Hallazgos abiertos que afectan la épica:**
- **DB-08 CRÍTICA** (en curso, corrector de seguridad #49 despachado en `b7ce950`): funciones `SECURITY DEFINER` de `refresh_tokens` (migración 0017) permiten a cualquier usuario autenticado acuñar/revocar sesiones ajenas (account takeover). Mismo patrón que DB-01 (ya cerrado) reaparecido sin revisar.
- **API-08 ALTA** (mismo despacho): `POST /organizations/invitations` permite a un `admin` no-owner invitar directamente con `role:'owner'`, rodeando el cierre de API-02.
- DB-09 BAJA, DB-10 MEDIA, DB-11 BAJA, API-01/API-03 PARCIAL, API-09/API-10/API-11 MEDIA, API-12 BAJA — ver `docs/auditoria-1/db-api-reverificacion.md`.
- AG-23 (agents) cerrado por su corrector, sin reverificación independiente aún.
- Worker y sources: hallazgos de ronda 2 corregidos pero sin reverificación de cierre confirmada (ver E3/E4).

**Dependencias pendientes:** B-03 (CI con Postgres real) para validar RLS/migraciones fuera de PGlite en un entorno reproducible.

## E2 — Perfil de empresa y datos reales
**Estado: IMPLEMENTADO-EN-EVIDENCIA** — depende de E1 (esquema y roles base, disponible).

| Paquete/app | Alcance |
|---|---|
| packages/db | Tablas de perfil (capacidades, experiencia, productos/servicios, ubicaciones, registros, documentos con vigencia, firmantes, restricciones) con columnas de procedencia (`owner`, `source`, `updated_at`) por campo |
| apps/api | Endpoints CRUD por categoría de perfil con autorización granular |
| apps/web | Pantallas de perfil de empresa (una por categoría) y edición de firmantes/restricciones |

REQ: REQ-141 a REQ-145 (sección 29), más REQ-022 a REQ-024, REQ-026 (bóveda documental aplicada al perfil).
Cierra: REQ-141 a REQ-145 de ACEPTACION.md; contribuye a A6 (dato ausente/contradictorio), A7 (documento/certificado vencido).

**Evidencia:** 8 tablas de perfil + `field_provenance` con evidencia real (`company-profile.test.ts`, verificado en `docs/auditoria-1/db-api-reverificacion.md` §6, REQ-141/142/143 CON_EVIDENCIA); flujo writer-propone/owner-admin-aprueba probado en API real (`company-profile.test.ts:135`, no solo unitario como registraba `ACEPTACION.md` antes de esta reverificación).

**Hallazgos abiertos:** REQ-145 (firmantes): tabla y CRUD genérico existen pero **ningún test ejercita la regla de negocio** "firma de no-firmante rechazada" (gap señalado en la reverificación db-api, sin ID de hallazgo propio aún). API-11 MEDIA (subida de documentos sin validación de magic bytes, aplica a documentos de perfil) — ver E1/E9.

**Dependencias pendientes:** ninguna externa; depende de que E9 (guardrails) cierre API-11 para el vector de subida de documentos.

## E3 — Ingesta oficial y frescura
**Estado: IMPLEMENTADO-EN-EVIDENCIA** — depende de E1 (registro de conectores, raw lake, disponible).

| Paquete/app | Alcance |
|---|---|
| packages/sources | Scheduler configurable por fuente, adaptador ComprasMX/DOF/OCDS-SHCP/PDN-S6/estatales con verificación puntual del portal oficial vigente, tabla `source_runs` |
| apps/api | Endpoints de estado/frescura por fuente |
| apps/web | Panel de fuentes y frescura en back office |

REQ: REQ-001, REQ-003, REQ-076, REQ-077, REQ-079, REQ-132 a REQ-136 (sección 27), REQ-146 a REQ-150 (sección 30).
Cierra: REQ-001, REQ-132 a REQ-135, REQ-146 a REQ-150 de ACEPTACION.md; A4 (fuente inaccesible y obsolescencia visible).

**Evidencia:** REQ-146/148/149/150 con evidencia real (Scheduler sin duplicados por (tipo,fuente,ventana) en `apps/worker`, commit `069f690`; estados explícitos `not_configured`/`captcha_detected`/`interface_changed` vía `ResponseClassifier`, commits `0a0b9df`/`bf6f5c8`; verificación puntual real por fuente en `docs/auditoria-1/sources.md` y `sources-reverificacion.md` — DOF 200 con tamaño exacto, CSV histórico SABG 951 MB confirmado). Corrección ronda 2 de sources (`0a0b9df`…`81c8aa6`, 18 archivos/145 tests) cierra SR-12..18.

**Hallazgos abiertos:** REQ-132/133 en `apps/web` **sin evidencia** — el panel de frescura es una demo estática hardcodeada, no conectada a `apps/api` (pendiente de la ronda 3 web↔api, #42, en curso). Reverificación de cierre de sources despachada (`be64f70`) sin resultado aún — hallazgos SR-12..18 corregidos pero no reconfirmados de forma independiente.

**Dependencias pendientes:** **B-02 (ComprasMX bloqueado por reCAPTCHA, 401/403)** — abierto, externo, requiere acceso/permisos oficiales o fuente alterna autorizada por el usuario; sin esto la ingesta real de la fuente principal permanece sobre fixtures (CSV histórico SABG), no sobre el flujo en vivo. OCDS-SHCP inalcanzable, PDN-S6 con bot-detection, portales estatales sin API localizable — mismo bloqueo de fondo.

## E4 — Detección de cambios y versiones
**Estado: IMPLEMENTADO-EN-EVIDENCIA** — depende de E3 (fuentes con `source_runs` operando, disponible).

| Paquete/app | Alcance |
|---|---|
| packages/db | `tender_versions`/historial, invalidación en cascada de dependientes |
| packages/sources | Diff de versiones, aclaraciones y anexos con dedupe por identidad+versión |
| packages/agents | Reglas de invalidación automática de tareas/matriz/propuestas dependientes |

REQ: REQ-017, REQ-041, REQ-151 a REQ-155 (sección 31).
Cierra: REQ-017, REQ-151 a REQ-155 de ACEPTACION.md; A1 (nueva publicación), A2 (duplicado/replay), A3 (modificación/aclaración y plazo adelantado).

**Evidencia:** REQ-151–155 con evidencia real de integración vía API+BD, no solo unitaria — `tenders-and-ingest.test.ts:109-172` prueba invalidación real de `proposals.invalidated_at` (la reverificación db-api señala que `ACEPTACION.md` **subestimaba** A3 con solo evidencia unitaria). DB-05 (invalidación por `change_events`) **CONFIRMADO_CERRADO** en reverificación (migración `0022`, hash `0698544`, fail-closed por diseño). Trigger de invalidación por versión de bases (E6/E7) queda soportado por el mismo mecanismo.

**Hallazgos abiertos:** cascada hacia matriz de requisitos y expediente, y notificación al rol responsable del cambio, sin evidencia de extremo a extremo (señalado en `db-api-reverificacion.md` §6, sin ID propio). DB-05 invalida por `tender_id` sin distinguir si el evento corresponde a la versión más reciente (diseño fail-closed aceptado, no un defecto bloqueante).

**Dependencias pendientes:** ninguna externa directa; la cobertura completa de la cascada depende de que E6/E7 terminen su integración con `apps/api` (ronda 3, en curso).

## E5 — Matching por empresa (relevancia y elegibilidad)
**Estado: IMPLEMENTADO-EN-EVIDENCIA** — depende de E2 (perfil real, disponible) y E4 (convocatorias versionadas y frescas, disponible).

| Paquete/app | Alcance |
|---|---|
| packages/agents | Motor de relevancia (semántico+léxico) y elegibilidad (reglas duras), score explicable separado |
| packages/db | `match_procedures` (pgvector+BM25), RLS |
| apps/api / apps/web | Exposición de ambos scores con evidencia y priorización |

REQ: REQ-002, REQ-006, REQ-009 a REQ-013, REQ-059 a REQ-061, REQ-111, REQ-166, REQ-167, REQ-168 (secciones 2, 3, 10, 24, 33).
Cierra: REQ-006, REQ-009 a REQ-013, REQ-059 a REQ-061, REQ-111, REQ-166 a REQ-168 de ACEPTACION.md; A5 (dos clientes, cero fuga), A6 (dato ausente/contradictorio, parcial).

**Evidencia:** REQ-059–061/167 con aislamiento probado (`matching-and-go-no-go.test.ts`, RLS 0 fugas cross-org sobre matching); motor de elegibilidad separado de relevancia confirmado en `packages/sources` (REQ-168, cierre SR ronda 2) y en `apps/api` (commit `cb2bc3f`). A5 CON_EVIDENCIA a nivel backend (RLS + matching aislado).

**Hallazgos abiertos:** **REQ-061 (vector store, pgvector) sin implementación** — el motor semántico real (embeddings) no está construido; el matching actual es léxico/reglas duras. Sin ID de hallazgo propio, señalado explícitamente como brecha en `db-api-reverificacion.md`.

**Dependencias pendientes:** **OpenAI sin credenciales verificadas** — bloquea tanto el componente semántico de este motor como cualquier score explicable que dependa de embeddings reales; hoy el `ProviderRouter`/`OpenAIResponsesProvider` de `packages/agents` no se ha ejercitado contra la red real.

## E6 — Análisis de bases y matriz de requisitos
**Estado: EN CURSO** — depende de E4 (versión de bases estable a analizar, disponible).

| Paquete/app | Alcance |
|---|---|
| packages/agents | Pipeline de extracción (Docling/PyMuPDF + OCR por excepción), verificación de citas, simulador de puntaje |
| packages/db | Matriz de requisitos con campos de gestión (fuente/página/cláusula/obligatoriedad/responsable/fecha/evidencia/estado) |
| apps/web | Visor de bases con citas resaltadas |

REQ: REQ-014 a REQ-021, REQ-101, REQ-108, REQ-156 (secciones 4, 23, 32).
Cierra: REQ-014 a REQ-021, REQ-101, REQ-108, REQ-156 de ACEPTACION.md; contribuye a A9 (anexo obligatorio faltante, detección).

**Evidencia:** extractor de matriz de requisitos (regex + hook LLM `fake`) implementado desde ronda 1 de `packages/expediente` (commit `467be32`); columnas de gestión de la matriz (obligatoriedad/cláusula/plazo/responsable/estado/extractor/confianza) y tabla `requirement_conflicts` añadidas en el esquema de ronda 3 (`06286bf`, migraciones 0029–0032).

**Hallazgos abiertos:** condicionales que aplican podían desaparecer en silencio (EX-EXP-03, cerrado en ronda 2, `1dc9026`) pero la reverificación 2 de expediente registró EX-19 (variante de "condicional no aplica desaparece" aún sin cerrar del todo, severidad menor). Verificación de citas contra el PDF real y simulador de puntaje: sin evidencia de prueba adversarial dedicada localizada en esta revisión — pipeline Docling/PyMuPDF/OCR no confirmado como ejercitado con documentos reales (solo regex + fake LLM).

**Dependencias pendientes:** OpenAI sin credenciales (bloquea el hook LLM real de extracción y el simulador de puntaje); integración con `apps/api` ronda 3 (E6–E9/E11, #43) despachada en `80fb455`, **en curso, sin commit de cierre todavía**.

## E7 — Expediente de participación (propuesta técnica+económica+anexos+checklist)
**Estado: EN CURSO** — depende de E2 (datos/tarifas aprobados, disponible), E5 (elegibilidad confirmada, disponible), E6 (matriz de requisitos, en curso).
**Paquete**: `packages/expediente` (orquesta generación de propuesta, checklist y paquete a partir de packages/db + packages/agents).

| Paquete/app | Alcance |
|---|---|
| packages/expediente | Generación de propuesta técnica/económica desde datos APROBADOS, checklist de integridad, versionado con hashes de insumos, invalidación de aprobación por cambio |
| packages/db | `price_catalog` aprobado, `approvals` con invalidación, `package_manifests` |
| packages/agents | Redactor/Auditor reutilizados desde E1/E6, guardrail `no_unsourced_claims` |
| apps/web | Editor de expediente, checklist visual, borrador vs. listo |

REQ: REQ-022 a REQ-036, REQ-037, REQ-038, REQ-048, REQ-157 a REQ-163 (secciones 5, 6, 7, 8, 32).
Cierra: REQ-022 a REQ-036, REQ-048, REQ-157 a REQ-163 de ACEPTACION.md; A7 (documento vencido), A8 (precio no aprobado), A9 (anexo faltante), A10 (cálculo económico), A11 (edición invalida aprobación), A13 (expediente completo descargable), A14 (expediente incompleto nunca listo).

**Evidencia:** ronda 1 `467be32` (30 archivos, 84 tests); corrección ronda 1 (11 commits, `5db06bc`…`49141fb`, 118 tests) y ronda 2 (6 commits, `f5991f5`/`1dc9026`/`284db62`/`5dfae17`+`9845ecf`/`fdf17e4`/`b19ced8`, 364 tests, cobertura 93.2/90.1%); reverificación 1 (`0c308a8`: 5 CERRADO/3 PARCIAL/2 NO CERRADO) y reverificación 2 (`8d67af9`: **14/16 CERRADO**, apócope numérico y scope/scopeRef confirmados sólidos con 35 ataques propios adicionales, 399/399 en verde). Esquema de soporte real (matriz, checklist, aprobaciones jerárquicas, paquete, post-adjudicación) añadido en ronda 3 de `packages/db` (`06286bf`, `048ae47`).

**Hallazgos abiertos que afectan la épica:**
- **EX-EXP-01/EX-EXP-11 (crítico funcional, PARCIAL tras 2 rondas):** `computeInputsHash()` es correcta y probada, pero **nada obliga a usarla** — `ApprovalWorkflow.approve()` y `PackageAssembler.buildManifest()` aceptan `inputsHash` como string plano sin tipo marcado (branded) ni verificación runtime; un hash calculado a mano aprueba un expediente completo como `ready`. Bloquea el cierre real de A8/A11/A14.
- **EX-EXP-17 ALTA** (nuevo en reverificación 2, ver `expediente-reverificacion-2.md`).
- EX-18..22 (menores: colisión de hash en `stableStringify` con `Date`, condicional que desaparece en variante no cubierta, rueda de hora 24:00, sin gate de cobertura, `ACEPTACION.md` desfasado).
- **Corrección final en curso ahora mismo**: corrector #45 (vuelta 3, tipo branded + verificación runtime del hash), despachado en `07c5ea1`, **coordinado con el implementador de apps/api ronda 3** que integra el paquete — sin commit de cierre todavía.

**Dependencias pendientes:** OpenAI sin credenciales (el Redactor/Auditor de `packages/agents` sigue sin cliente LLM real integrado a expediente); integración de endpoints/descarga en `apps/api` (sin evidencia de endpoint de descarga autenticada, señalado también en A13 de la reverificación db-api).

## E8 — Auditoría, aprobación y entrega
**Estado: EN CURSO** — depende de E7 (expediente generado y checklist en verde/ámbar, en curso).

| Paquete/app | Alcance |
|---|---|
| packages/agents | Auditor con 5 puertas deterministas + juez LLM distinto del redactor |
| apps/api | Máquina de estados del paquete, `needs_approval`/HITL, doble confirmación económica con re-autenticación |
| apps/web | Flujos de aprobación 1/2-2/2, descarga autenticada, sala de guerra |

REQ: REQ-037 a REQ-047, REQ-062 a REQ-064, REQ-161, REQ-162, REQ-165 (secciones 7, 8, 11, 32, 33).
Cierra: REQ-037 a REQ-047, REQ-062 a REQ-064 de ACEPTACION.md; A11 (edición invalida aprobación), A12 (autorización desde rol indebido), A15 (firma/envío siempre del usuario).

**Evidencia:** `ApprovalWorkflow` con invalidación jerárquica de aprobaciones (packages/expediente, rondas 1–2); esquema de ronda 3 añade alcance jerárquico + log reproducible de eventos (`proposal_approval_events`) y comentarios (`proposal_comments`), con política RLS de aprobación corregida a `reviewer/admin/owner` (`06286bf`). A15: superficie sin envío/firma confirmada por `api-surface.test.ts` (packages/expediente) y por auditoría de agents (AG-05/no-fabrication).

**Hallazgos abiertos:** **A11 PARCIALMENTE REABIERTO por API-08** (bypass de autorización de rol vía invitación como owner, ver E1/E9) — el mismo tipo de vector que A12 busca cubrir. `AprobacionesPage` en `apps/web` sigue siendo un `EmptyState` genérico sin flujo real de aprobación 1/2-2/2 (señalado en A11 de `db-api-reverificacion.md`). Auditor con juez LLM distinto del redactor y doble confirmación económica con re-autenticación: sin evidencia de implementación localizada en esta revisión.

**Dependencias pendientes:** cierre de EX-EXP-01/11 en E7 (una aprobación con hash no verificado invalida la garantía de este flujo); cierre de API-08/DB-08 en E9; OpenAI sin credenciales (juez LLM).

## E9 — Reglas duras de seguridad y no-actuación (transversal)
**Estado: EN CURSO** — depende de E1 (integrado desde el inicio en agents/db/api); se integra de forma cruzada en E2, E5, E7, E8.

| Paquete/app | Alcance |
|---|---|
| packages/agents | Guardrails de entrada/salida: no inventar datos/precios/certificaciones, no actuar sin autorización específica, ausencia=pendiente |
| apps/api | Enforcement server-side de las mismas reglas (no solo en el prompt) |

REQ: REQ-045 a REQ-047, REQ-068, REQ-072, REQ-097, REQ-114, REQ-164 a REQ-167 (secciones 8, 13, 22, 24, 33).
Cierra: REQ-072, REQ-097, REQ-114, REQ-164 a REQ-167 de ACEPTACION.md; A6, A8, A12, A15 (como capa de guardrail transversal a las épicas de dominio).

**Evidencia:** `packages/agents` con prohibiciones duras y tolerancia cero como invariantes de código (no configurables por constructor, cerrado en corrección 1, hash `114a2fb` + ronda 2 `971feea`/`861aea4` + ronda 3 `9cb38be`); reverificación de cierre `f3e6a3b` — **19/22 hallazgos cerrados**, límites aceptados documentados (AG-05: guardrail regex ~3% de detección real, capa LLM/juez pendiente; AG-12: alcance acotado). DB-03 (enforcement de tarifa aprobada) agnóstico de rol, ni un superadmin puede saltarlo — confirmado en reverificación db-api.

**Hallazgos abiertos que afectan la épica (server-side, `apps/api`/`packages/db`):**
- **DB-08 CRÍTICA** — ver E1: rompe la garantía "no actuar sin autorización específica" a nivel de sesión (account takeover vía `refresh_tokens`). **En corrección ahora mismo** (corrector de seguridad #49, prioridad máxima, migraciones 0040–0049 reservadas).
- **API-08 ALTA** — bypass de autorización de rol (invitación como owner), mismo patrón que API-02 (ya cerrado) reaparecido en ruta distinta.
- API-09 MEDIA (TOCTOU en refresh y aprobación de tool_calls, no reproducible en PGlite pero real contra `pg.Pool` de producción), API-11 MEDIA (subida de documentos sin validar magic bytes, REQ-024), DB-09/DB-10/DB-11/API-10/API-12 (BAJA-MEDIA).
- AG-23 (agents): cerrado por su corrector, pendiente confirmación independiente.

**Dependencias pendientes:** ninguna externa; es trabajo de corrección interno en curso (corrector #49). OpenAI sin credenciales bloquea la capa de juicio LLM que complementaría el guardrail regex (límite AG-05 documentado).

## E10 — Back office / superadmin y observabilidad
**Estado: EN CURSO** — arrancó en paralelo con E1; implementación base cerrada, conexión real con `apps/web` y trazabilidad extremo a extremo pendientes.

| Paquete/app | Alcance |
|---|---|
| apps/web | Pantallas de conectores/frescura, jobs/reintentos, costos/límites IA, evals, incidentes, aprobaciones |
| apps/api | Endpoints de métricas honestas y trazas correlacionadas |
| packages/db | Vistas de auditoría, `correlation_id` extremo a extremo |

REQ: REQ-049, REQ-065 a REQ-067, REQ-086 a REQ-089, REQ-169 a REQ-171 (secciones 8, 12, 19, 20, 33).
Cierra: REQ-049, REQ-065 a REQ-067, REQ-086 a REQ-089, REQ-169 a REQ-171 de ACEPTACION.md.

**Evidencia:** back office/superadmin implementado en `apps/api` (organizaciones, conectores, jobs, costos, incidentes, aprobaciones — commit `b00efeb`); REQ-169 (métricas honestas, estimados marcados explícitamente) CON_EVIDENCIA según reverificación db-api; `/metrics` sin datos de tenant confirmado.

**Hallazgos abiertos:** **REQ-170 sin evidencia** — el panel de `apps/web` (fuentes/frescura, jobs) sigue siendo demo estática no conectada a los endpoints reales de `apps/api` (en trabajo ahora: ronda 3 web↔api, #42, despachada en `80fb455`, sin commit de cierre). **REQ-171 (`correlation_id` extremo a extremo) sin implementación.** API-10 MEDIA: `POST /admin/jobs/:id/retry` omite `audit_log` para jobs con `org_id` nulo (jobs de plataforma), contradiciendo el propio comentario del código sobre una "organización de sistema" inexistente.

**Dependencias pendientes:** ninguna externa directa; depende de que la ronda 3 web↔api (#42) conecte los paneles reales, y de que E9 cierre API-10 para que la trazabilidad de auditoría sea completa.

## E11 — Seguimiento post-adjudicación
**Estado: PENDIENTE** — depende de E7/E8 (expediente entregado y adjudicado, ambos en curso).

| Paquete/app | Alcance |
|---|---|
| packages/agents | Cobranza, autopsia del fallo, inconformidades, radar de renovaciones |
| packages/db | Máquina de estados del contrato, extracción estructurada del contrato firmado |
| apps/web | Seguimiento de contrato, calendario legal |

REQ: REQ-050 a REQ-056 (sección 9).
Cierra: REQ-050 a REQ-056 de ACEPTACION.md.

**Evidencia:** solo esquema base — `post_award_followups` recibió columnas de fuente legal/recordatorio en la migración de ronda 3 de `packages/db` (`06286bf`); `apps/web` tiene un stub de navegación/página (`SeguimientoPage.tsx`) y `apps/api` referencias de esquema en el módulo de expediente, sin lógica de negocio de cobranza/autopsia/inconformidades/radar de renovaciones localizada en `packages/agents`. No hay agente, endpoint funcional ni prueba dedicada a esta épica más allá del esqueleto de columnas.

**Hallazgos abiertos:** ninguno registrado — no hay auditoría porque no hay implementación funcional que auditar todavía.

**Dependencias pendientes:** bloqueada por el cierre de E7/E8 (expediente y aprobación deben cerrar primero); sin trabajo despachado a ningún agente implementador en esta ronda.

## E12 — Verificación del marco legal mexicano (gate transversal, no bloquea desarrollo técnico)
**Estado: IMPLEMENTADO-EN-EVIDENCIA (con matices)** — verificación puntual real completada; corre en paralelo, condiciona qué se puede codificar como "cumplido" en E7/E8/E11.

| Paquete/app | Alcance |
|---|---|
| (sin paquete de código; gobierno/legal) | Verificación contra DOF de vigencias LAASSP, plazo de pago, garantías, topes de convenio, umbrales PEF |

REQ: REQ-100 a REQ-123 (secciones 23, 24, 25).
Cierra: REQ-100 a REQ-123 de ACEPTACION.md (varios permanecen "bloqueado hasta VERIFICAR" hasta evidencia oficial). No bloquea E1-E11 salvo el motor determinista de plazos/montos legales específicos que dependan de la cifra exacta en disputa.

**Evidencia:** agente #21 completó verificación puntual solo con fuentes oficiales — `docs/legal/verificacion-legal.md` y filas de secciones 23–25 de `docs/REQUISITOS.md` (commit `0698544`): **6 VERIFICADO, 11 VERIFICADO-CON-MATIZ, 4 NO-VERIFICABLE-EN-LÍNEA, 3 NO-APLICA**. Cambios normativos con fecha DOF registrados en `docs/DECISIONES.md` (D-07: LAASSP nueva 16-abr-2025, pago 17 días hábiles, LOPSRM reformada, Plataforma Digital de Contrataciones Públicas/SABG, nueva LFPDPPP 20-mar-2025).

**Hallazgos abiertos:** los 4 REQ marcados NO-VERIFICABLE-EN-LÍNEA y los 11 VERIFICADO-CON-MATIZ requieren validación por abogado antes de afirmarse como cumplimiento legal frente a clientes — no es un hallazgo de código, es una condición de aceptación explícita.

**Dependencias pendientes: BLOQUEADO-EXTERNO (parcial)** — validación por asesoría legal humana para las citas no verificables en línea; no depende de trabajo de ingeniería adicional. Pendiente propagar la nomenclatura legal vigente a `apps/web` (etiquetas de fuente) más allá de lo ya hecho en `packages/sources`.

## E0 — Gobierno del ciclo de construcción (continuo, no secuencial)
**Estado: EN CURSO** — aplica a todas las épicas desde el inicio; esta misma actualización de BACKLOG.md es un artefacto de E0.

REQ: REQ-124 a REQ-131, REQ-137 a REQ-140 (secciones 26, 28).
Cierra: REQ-124 a REQ-131, REQ-137 a REQ-140 de ACEPTACION.md.

**Evidencia:** `docs/PROGRESO.md` (registro completo rondas 0–3), `docs/BLOQUEOS.md` (incidentes INC-01..04 todos CERRADOS con regla reforzada; bloqueos B-01/B-02/B-03 ABIERTOS y declarados como tales, nunca ocultados), `docs/TABLERO.md`/`docs/ACEPTACION.md` (snapshot del último corte formal, commit `d8e6d29`: 186 criterios → 92 PENDIENTE, 82 EN_EVIDENCIA, 7 CUMPLIDO, 4 NO_APLICA, 1 BLOQUEADO_EXTERNO — snapshot desactualizado frente al progreso real de rondas 2–3 según la propia reverificación db-api, a re-tabular en el cierre formal, no en esta actualización). Disciplina de un solo escritor por archivo compartido y `git commit -- <rutas>` reforzada tras INC-01..04.

**Hallazgos abiertos:** ninguno de código; el hallazgo de gobierno vigente es que `docs/BACKLOG.md` marcaba las 5 épicas E2–E5/E10 como 100% PENDIENTE pese a progreso real ya implementado y probado — **corregido por esta misma actualización**.

**Dependencias pendientes:** B-01 (ruta de "empresas agénticas" no verificada) — informativo, no bloquea el trabajo técnico en el staging actual; B-03 (CI con Postgres real) — requiere decisión del usuario sobre publicar un remoto GitHub.

---

## Orden de ejecución sugerido (dependencia → prioridad)

1. **E1** (en curso) — fundamentos
2. **E3** y **E2** (implementado-en-evidencia, en paralelo, ambas dependen solo de E1)
3. **E4** (implementado-en-evidencia, depende de E3)
4. **E6** (en curso, depende de E4) y **E5** (implementado-en-evidencia, depende de E2+E4), en paralelo
5. **E9** (transversal, en curso desde que existe algo que guardar — integrado en E2/E5/E7/E8)
6. **E7** (en curso, depende de E2+E5+E6)
7. **E8** (en curso, depende de E7)
8. **E10** (en curso, arrancó en paralelo con E1, se completa según avanzan E3/E7/E8)
9. **E11** (pendiente, depende de E7/E8)
10. **E12** y **E0** — transversales, corren durante todo el ciclo (E12 implementado-en-evidencia con matices; E0 en curso permanente)

Las 15 pruebas mínimas obligatorias de la ampliación (A1-A15, ver `docs/ACEPTACION.md`) quedan cubiertas, en conjunto, por el cierre de E3, E4, E5, E7, E8 y E9; a la fecha de esta actualización, la mayoría están en estado PARCIAL o CON_EVIDENCIA según `docs/auditoria-1/db-api-reverificacion.md` §6, ninguna en estado final de cierre.

## Trabajo en curso ahora mismo (no despachar de nuevo, solo dar seguimiento)

- **web↔api ronda 3** (#42, único escritor de `apps/web`): conectar paneles reales (fuentes/frescura E3/E10, header) a `apps/api`; corrige también W-21 ALTA (ThemeSelector invisible <466px) y W-22 BAJA pendientes de la reverificación 2 de web.
- **api ronda 3 E6–E9/E11** (#43, despachada en `80fb455`): integrar `packages/expediente` y matriz de requisitos con endpoints reales de `apps/api`; sin commit de cierre todavía.
- **Corrector de seguridad #49** (prioridad máxima, despachado en `b7ce950`, migraciones 0040–0049 reservadas): DB-08 CRÍTICA, API-08 ALTA, y el resto de hallazgos DB-09/10/11, API-01/03/09/10/11/12 de `db-api-reverificacion.md`.
- **Reverificación de cierre de apps/worker** (despachada en `c96484a` tras corrección vuelta 2): confirmar WK-14..18 y las propuestas de esquema (0026b/0027/0028) ya aplicadas.
- **Reverificación de cierre de packages/sources** (despachada en `be64f70` tras corrección vuelta 2): confirmar SR-12..18.
- **Corrección final de packages/expediente** (#45, vuelta 3, despachada en `07c5ea1`): tipo branded + verificación runtime del hash de insumos (EX-EXP-01/11), coordinada con #43.

## Orden de cierre restante

Lo que falta, por épica, para que `docs/ACEPTACION.md` pueda considerar CUMPLIDO cada REQ asociado (sin autoevaluación numérica — cada paso requiere su propia reverificación independiente):

- **E1**: cerrar DB-08/API-08 (corrector #49) → reverificación independiente de esa corrección → confirmar AG-23 de forma independiente → recibir los commits de cierre de worker y sources (ver abajo).
- **E2**: añadir prueba de la regla de negocio "firma de no-firmante rechazada" (REQ-145) y cerrar API-11 (magic bytes) desde E9.
- **E3**: conectar el panel de frescura de `apps/web` a `apps/api` real (ronda 3 web↔api) y obtener el commit de reverificación de cierre de sources; ComprasMX en vivo permanece fuera de alcance mientras B-02 esté abierto (documentar explícitamente como límite aceptado, no como pendiente de ingeniería).
- **E4**: extender la prueba de cascada de invalidación hasta matriz/expediente y confirmar notificación al rol responsable con un test de integración dedicado.
- **E5**: decidir y documentar si REQ-061 (vector store) se implementa con embeddings reales (requiere OpenAI) o se declara fuera de alcance con matching léxico como diseño definitivo.
- **E6**: recibir el commit de integración de api ronda 3 (#43) que conecta la matriz de requisitos a `apps/api`/`apps/web`; verificar el pipeline de extracción contra al menos un documento de bases real (no solo fixtures) y cerrar el residuo EX-19 de condicionales.
- **E7**: recibir y reverificar el commit de corrección vuelta 3 (#45, branded type del hash) — sin esto EX-EXP-01/11 sigue abierto y bloquea A8/A11/A14; cerrar EX-EXP-17 y los residuos EX-18/20/21.
- **E8**: implementar el flujo real de `AprobacionesPage` en `apps/web` (hoy `EmptyState`); implementar y probar la doble confirmación económica con re-autenticación y el juez LLM distinto del redactor; depende de que E7 y E9 cierren primero.
- **E9**: cierre y reverificación independiente de DB-08/API-08 (crítico para toda la plataforma); decidir si se añade una capa LLM/juez para el guardrail de no-fabricación (hoy ~3% de detección por regex, límite aceptado documentado) o se declara diseño definitivo.
- **E10**: recibir el commit de la ronda 3 web↔api que conecta los paneles reales; implementar `correlation_id` extremo a extremo (REQ-171); cerrar API-10 (audit_log de jobs sin organización).
- **E11**: no hay orden de cierre aplicable todavía — requiere que se despache una ronda de implementación real (agente + auditoría + corrección + reverificación) una vez que E7/E8 cierren; hoy es trabajo no iniciado, no trabajo bloqueado.
- **E12**: obtener validación por abogado humano de los 11 REQ VERIFICADO-CON-MATIZ y los 4 NO-VERIFICABLE-EN-LÍNEA antes de afirmar cumplimiento legal a clientes; propagar nomenclatura legal vigente a `apps/web`.
- **E0**: mantener `BLOQUEOS.md`/`PROGRESO.md` al día en cada ronda; re-tabular `ACEPTACION.md`/`TABLERO.md` en el cierre formal (fuera del alcance de esta actualización, que solo toca `BACKLOG.md`) usando la evidencia real ya identificada por `db-api-reverificacion.md` §6 en vez de la más débil citada hoy.
