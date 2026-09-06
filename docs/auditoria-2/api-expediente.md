# Auditoría adversarial ronda 3 — `apps/api` (integración real de `@atiende/expediente`, E6-E11)

Fecha: 2026-09-06. Agente: auditor adversarial independiente, contexto separado
del proyecto. Rol: **SOLO encuentra/verifica** — ningún código de `apps/api`,
`packages/db` ni `packages/expediente` fue modificado por este agente ni por
los 3 sub-agentes que repartieron rubros.

**Metodología**: `git worktree add <scratchpad>/audit-api3 HEAD` (HEAD real al
iniciar: `2dff88f`) + `npm install` real, nunca se tocó el árbol principal con
comandos destructivos. Para repartir rubros se lanzaron **3 sub-agentes
Sonnet** en **3 worktrees adicionales** (`audit-api3-sub1/2/3`, mismo HEAD,
`npm install` propio de cada uno), cada uno con instrucciones auto-contenidas,
que escribieron tests adversariales temporales (`apps/api/test/zz-adversarial-*.test.ts`),
los ejecutaron con `fastify.inject` + PGlite (mismo patrón que la suite
oficial) y los **borraron** al terminar — `git status --short` confirmado
limpio en los 4 worktrees salvo `package-lock.json` (modificación preexistente
del propio `npm install`, no de este agente). Los 4 worktrees se eliminan al
cierre de esta auditoría. Evidencia de comandos reales en
`docs/logs/audit-api-ronda3.log`.

Documentos base leídos: `apps/api/README.md`, migraciones `0029`-`0035` de
`packages/db`, `docs/logs/api-ronda3.log`, `docs/AMPLIACION-BACKOFFICE.md`
(ítems 5-8), `docs/REQUISITOS.md` secciones 4-9 y 32-33, `docs/ACEPTACION.md`
(A6-A15), `docs/auditoria-1/expediente-cierre.md`,
`docs/auditoria-1/db-api-reverificacion.md` (API-09..12, DB-09).

---

## Resumen ejecutivo

La integración real de `@atiende/expediente` en `apps/api` (26 rutas bajo
`/expediente/tenders/:tenderId/...`) es **sustancialmente sólida** en
aislamiento multi-tenant y control de roles (46/46 ataques cross-org/rol
bloqueados, 0 fugas) y en varios invariantes centrales (A6, A9 —mecanismo—,
A10, A11 —por cambio de bases—, A12, A14, A15, `conditionEvaluations`,
`HashedInputs` siempre recalculado). Sin embargo, esta ronda encuentra **dos
hallazgos ALTA** que rompen invariantes de "tolerancia cero" declarados en
`docs/REQUISITOS.md`/`docs/ACEPTACION.md`:

- **AE-01**: la vigencia de una tarifa se evalúa contra una fecha
  (`asOfIso`) que el propio cliente controla, no contra
  `tenders.submission_deadline` — y el flujo de expediente nunca inserta en
  `proposal_pricing_lines`, así que el trigger de Postgres que ya corrige
  este mismo patrón a nivel DB (DB-02/DB-10, migración `0042`) **nunca se
  ejecuta** para el expediente. Reabre DB-02/DB-10 sin protección en esta capa.
- **AE-02**: editar el CONTENIDO de una sección de la propuesta
  (`PATCH /proposal/sections/:sectionKey`) después de una aprobación vigente
  de alcance `"expediente"` **no la invalida** — `ExpedienteInputs` no
  incluye el contenido de `proposal_sections`, y a diferencia de
  `conditionEvaluations` (que sí invoca `workflow.recordChange`
  explícitamente), el handler de este PATCH no lo hace, contradiciendo su
  propio comentario en código. Un expediente puede quedar "ready" con
  contenido reescrito después de la revisión y nunca vuelto a aprobar.

Además, 4 hallazgos MEDIA (magic bytes evadibles con offset ≠ 0, HTML/script
sin sanitizar en texto extraído, sin protección anti zip-bomb, límites del
motor de plazo de pago no advertidos en la respuesta ni versionados por
régimen legal) y varios BAJA (manifiesto con sha256 de JSON en vez de bytes
reales, Zip Slip latente no explotable hoy, caché sin TTL dormida,
autoaprobación de contenido propio en un caso límite). **Ningún hallazgo
CRÍTICO ni de fuga cross-tenant.**

**Conteo de ataques ejecutados**: 46 (sub-agente 1, aislamiento/roles, 0
fugas) + 18 archivos de test temporales con decenas de aserciones (sub-agente
2, subida/flujo, 2 FALLA + varios PARCIAL) + 10 (sub-agente 3, TOCTOU/magic
bytes/caché, 1 hallazgo confirmado) + verificación directa de código por este
agente en `inputs.ts`, `approval-workflow.ts`, `proposal.routes.ts`,
`package-assembler.ts`, `storage.ts`, `business-days.ts`,
`agent-stores.pg.ts`. **Reproducibilidad**: 95/95 tests de `apps/api` + 144/144
de `packages/db`, `typecheck`/`lint` limpios en ambos paquetes (HEAD `2dff88f`,
corrida directa de este agente).

---

## 1. Reproducibilidad

| Comando | Resultado |
|---|---|
| `npm run -w apps/api typecheck` | exit 0, sin salida |
| `npm run -w apps/api lint` | exit 0, sin salida |
| `npm run -w apps/api test` | **95/95 tests, 29/29 archivos** |
| `npm run -w packages/db typecheck` | exit 0, sin salida |
| `npm run -w packages/db lint` | exit 0, sin salida |
| `npm run -w packages/db test` | **144/144 tests, 19/19 archivos** |

**Veredicto: CUMPLE.** Ver `docs/logs/audit-api-ronda3.log` para la salida
completa capturada por este agente (corrida propia, no solo lectura del log
previo de otro agente).

---

## 2. Aislamiento y roles en las 26 rutas de `/expediente/...`

(El README declara "24"; el conteo real por `grep` es **26**: documents 7,
proposal 5, checklist 2, approval 4, package 3, submission 2, post-award 3 —
ver AE-12.)

Sub-agente 1 construyó un ataque dinámico cubriendo las 26 rutas: recurso de
Org A accedido desde Org B con token válido (GET/POST/PATCH sobre
`tenderId`/`documentId`/`requirementId`/`conflictId`/`followupId`/`sectionKey`
ajenos, incluida la combinación fina "tenderId propio + sub-recurso ajeno"),
documento subido en A y paquete ZIP ensamblado en A intentados desde B,
`viewer` intentando escribir en las 15 rutas de escritura de su propia org,
`writer` intentando aprobar, y autoaprobación (mismo `actorId` que pidió
revisión, con `admin`, único rol que está tanto en `SUBMITTER_ROLES` como en
`APPROVER_ROLES`).

**Resultado: 46/46 ataques bloqueados, 0 fugas.** Aislamiento cross-org vía
`requireTender`/`requireProposal` (`apps/api/src/lib/expediente/context.ts:22-26`,
filtro `where id = $1 and org_id = $2`) + filtro `org_id`/`tender_id`
explícito en cada sub-recurso; ninguna ruta de `package.routes.ts` acepta un
identificador de manifiesto/storage_ref como parámetro (solo `:tenderId`),
así que "adivinar" el ZIP de otra org no es un vector aplicable — confirmado
leyendo el código.

**Hallazgo BAJA (AE-11)**: un `admin`/`reviewer` que redacta una sección
técnica y LUEGO (otra persona pidió revisión) aprueba el expediente completo
— permitido, porque `ApprovalWorkflow.approve()` solo compara el `actorId` de
quien pidió revisión contra quien aprueba, no quién redactó cada sección.
Límite de diseño ya documentado como EX-EXP-08 en
`apps/api/src/modules/expediente/approval.routes.ts:110-114` — no se eleva de
severidad por ser un límite reconocido, no un descuido oculto.

**Veredicto: CUMPLE** (aislamiento/roles duros); **AE-11 BAJA** como matiz
documentado.

---

## 3. Flujo del expediente (bases → matriz → propuesta → checklist → aprobación → paquete)

| Punto | Veredicto | Evidencia |
|---|---|---|
| (a) precio no aprobado bloquea | CUMPLE | `EconomicProposalBuilder`/`CompanyDataResolver.resolveApprovedRate` rechaza `status != 'aprobado'` de punta a punta (`expediente-proposal.test.ts` oficial + reconfirmado) |
| (a) precio vigente HOY pero vencido antes de `submission_deadline` | **FALLA — AE-01** | Ver hallazgo abajo |
| (b) documento de empresa vencido bloquea | CUMPLE | `CompanyDataResolver.resolveDocumentByType` compara `expiresAt` contra `asOfIso` (mismo mecanismo, mismo matiz de AE-01 si `asOfIso` se manipula, pero el caso base con `asOfIso` real está probado) |
| (c) anexo obligatorio faltante → nunca "ready" | CUMPLE | Test real vía HTTP: anexo sin `topicKey` en `presentAnnexRefs` → dimensión `anexos_obligatorios` = `rojo`, checklist nunca verde, paquete nunca "ready" (`draftReason: checklist_no_verde:...`) |
| (d) edición de sección tras aprobación → invalidación | **FALLA — AE-02** | Ver hallazgo abajo |
| (e) nueva versión de bases → matriz recalculada con historial + aprobaciones invalidadas | CUMPLE | Items viejos quedan `invalidated_at` no nulo (nunca borrados); aprobación de alcance `expediente` pasa a `invalidada` vía cambio de `tenderVersionHash` |
| (f) cambio de `conditionEvaluations` → invalidación explícita | CUMPLE | `proposal.routes.ts:206-231`: `diffConditionEvaluations` + `workflow.recordChange({scope:'documento', scopeRef:'documento:tecnica'})`, propagado a `expediente` vía `ancestorsOf()` (`packages/expediente/src/approval-workflow.ts:72-84`) — confirmado con hash idéntico antes/después (el hash NO cambia, la invalidación es explícita, tal como documenta `expediente-cierre.md` §5) |
| (g) `HashedInputs` siempre recalculado, nunca reutilizado | CUMPLE | `apps/api/src/lib/expediente/inputs.ts:127-130` (`getCurrentSealedInputs` reconstruye desde DB en cada llamada); `approveSchema` no acepta ningún campo de hash del cliente (zod descarta claves desconocidas) — probado enviando un hash falso de 64 caracteres: ignorado, el servidor recalcula igual |
| (h) paquete ZIP: descarga real, manifiesto, hashes, draft/ready | PARCIAL | Descarga real y draft/ready CUMPLEN (ver rubro 2 y AE-05/AE-13 en package.routes.ts); AVISO.txt y BORRADOR watermark presentes; pero ver **AE-06** (sha256 de JSON, no de bytes reales) y **AE-07** (Zip Slip latente en la librería, no explotable hoy vía la integración actual) |
| (h) ZIP de otra org / path traversal en nombres | CUMPLE (hoy) | Descarga cross-org bloqueada (rubro 2); nombres de entrada del ZIP son `${section_key}.txt` fijos por el servidor en la integración actual — AE-07 es un defecto latente de la librería, no alcanzable hoy por ningún input de cliente |
| (i) submission/declare sin cliente HTTP saliente | CUMPLE | `grep -rn "fetch(\|axios\|undici\|http.request\|https.request"` sobre `submission.routes.ts` y `lib/expediente/*` → 0 coincidencias reales (solo un comentario) |
| (i) acuse subido: tipo/tamaño/magic bytes | CUMPLE | Mismo `assertSafeFileContent`/límite de 22MB que documentos; ejecutable/PEM y archivo grande rechazados sin persistir nada |

---

## 4. Subida y extracción de documentos

| Punto | Veredicto | Evidencia |
|---|---|---|
| PDF sin texto → `requires_ocr` explícito | CUMPLE | `text-extraction.ts:60-66`; `extracted_text` es `NULL` en DB, nunca `""` |
| PDF malicioso — extensión falsa (mimeType mentido) | CUMPLE | `pdf-parse` lanza sobre contenido no-PDF real con `mimeType:"application/pdf"` declarado → `"failed"`, sin inventar texto |
| PDF/documento con HTML/script embebido | **FALLA — AE-04** | Ver hallazgo abajo |
| Zip bomb / ZIP genérico como documento | **FALLA — AE-05** | Ver hallazgo abajo |
| Límite de tamaño (~22MB) | CUMPLE | Rechazo 4xx antes de `storeFile`, nada se escribe a disco |
| Path traversal en `filename`/rutas de almacenamiento | CUMPLE | `storage_ref` siempre `<orgId>/<sha256>.bin`, nunca deriva de `filename` de cliente; reconfirmado con `../../../etc/passwd` como `filename` |
| Symlinks / rutas absolutas de storage | CUMPLE (por diseño) | `resolveStoragePath` solo concatena `STORAGE_DIR` + ruta 100% server-derivada; ningún input de cliente llega a `join()` sin pasar antes por sha256 |
| Magic bytes: bypass polyglot | **FALLA — AE-03** | Ver hallazgo abajo (confirmado independientemente por 2 sub-agentes con 2 PoC distintos) |

---

## 5. Post-adjudicación

| Punto | Veredicto | Evidencia |
|---|---|---|
| Plazo de pago 17 días hábiles (LAASSP Art. 73) calculado correctamente | CUMPLE | `business-days.ts` — lógica de suma de días hábiles correcta, con `legalReference` citada |
| ¿El cálculo advierte EXPLÍCITAMENTE en la RESPUESTA la limitación del calendario? | **FALLA — AE-09** | Ver hallazgo abajo |
| REQ-050 (versionar régimen legal 2000 vs. 2025 según fecha de la convocatoria) | **FALLA — AE-09** | No implementado: `computePaymentDeadline` siempre aplica la regla nueva (17 días hábiles), sin mirar la fecha de la convocatoria ni exponer `ley_aplicable` |
| Recordatorios como `jobs` sin envío externo | CUMPLE | `post-award.routes.ts:79-92` solo inserta en `jobs`, ningún worker de esta ronda consume la cola para enviar nada |

---

## 6. Seguridad heredada (API-09..12, DB-09)

| ID | Veredicto | Evidencia |
|---|---|---|
| API-09 (doble aprobación concurrente) | CUMPLE | `UPDATE ... WHERE id=$2 AND org_id=$3 AND authorization_status='pending'` — una sola sentencia atómica (`modules/agents/routes.ts:104-108,147-151`); test ampliado a 8 llamadas concurrentes reales: 1×200 + 7×409, 1 sola fila en `audit_log` |
| API-11 (magic bytes) | **PARCIAL — AE-03** | Lista negra correcta en concepto, pero solo revisa offset 0 |
| API-12 (comparación no constante) | CUMPLE | `constantTimeEquals` (`auth.plugin.ts:83-88`) iguala longitudes antes de `timingSafeEqual` |
| DB-09 (`agent_run_context` oráculo, mitigado con caché) | **CUMPLE hoy / MEDIA latente — AE-10** | Ver hallazgo abajo |

---

## 7. Trazabilidad A6-A15

| Criterio | ¿Test nombrado en `apps/api/test/*`? | ¿Solo en `packages/expediente` puro? | Pendiente declarado |
|---|---|---|---|
| A6 | Sí — `expediente-documents-and-matrix.test.ts` | No | Extracción por página real: NO |
| A7 | Sí — `company-profile.test.ts`, `matching-and-go-no-go.test.ts` | No | Bóveda documental con semáforo de 4 estados: parcial |
| A8 | Sí — `company-profile.test.ts`, `expediente-proposal.test.ts` | No | Ver AE-01 (caso vigente-hoy-vencido-antes-del-acto no cubierto) |
| A9 | Mecanismo sí probado vía HTTP (checklist rojo si falta anexo, confirmado por sub-agente 2), pero **ningún test de `apps/api` cita literalmente "A9"** | El escenario nombrado "A9" explícito solo vive en `packages/expediente/test/integrity-checklist.test.ts` | — |
| A10 | Cubierto dentro de `expediente-e2e-flow.test.ts` (sin `it()` propio nombrado "A10") | Reducido (antes solo unitario, ahora también HTTP real) | Banda de precio (REQ-030) sigue PENDIENTE |
| A11 | Sí — `expediente-checklist-and-approval.test.ts`, `expediente-e2e-flow.test.ts` (para el caso "cambio de bases") | No | **Pero ver AE-02**: el caso "edición manual de sección" NO está cubierto por ningún test oficial y SÍ falla en la práctica |
| A12 | Sí — `expediente-checklist-and-approval.test.ts` | No | Sin UI, sin passkey/OTP (declarado) |
| A13 | Sí — `expediente-package-and-submission.test.ts`, `expediente-e2e-flow.test.ts` | No | — |
| A14 | Sí — `expediente-package-and-submission.test.ts` | No | — |
| A15 | Sí — `expediente-package-and-submission.test.ts` (incluye verificación estática de imports) | No | Sin envío real, sin firma real (ambos declarados) |

**Ningún pendiente declarado (OCR, firma, envío, página real, calendario)
está marcado como "hecho"/CUMPLE en ningún README/doc** — grep dirigido sin
coincidencias de sobre-reclamo.

**Nota de gobierno (no es hallazgo de seguridad)**: `docs/ACEPTACION.md`
(tabla A6-A15, líneas ~202-211) sigue reflejando el estado PRE-integración
(mayormente "PENDIENTE"), desactualizado respecto al HEAD actual, que ya
tiene evidencia HTTP real para A6/A7/A8/A10/A11/A12/A13/A14/A15. Esto
**subestima** el progreso real (dirección seguramente inofensiva, pero
inconsistente) y ya está señalado en `docs/auditoria-1/expediente-cierre.md`
(EX-EXP-22) como pendiente de que el orquestador actualice `ACEPTACION.md` —
reiterado aquí porque sigue sin corregirse.

---

## Tabla de hallazgos

| ID | Severidad | Rubro | Hallazgo | Evidencia | Reparación sugerida (NO implementada) |
|---|---|---|---|---|---|
| **AE-01** | **ALTA** | 3(a)/6 | La vigencia de una tarifa en `POST /proposal/economic/generate` (y de documentos/firmantes en la técnica) se evalúa contra `asOfIso`, un campo **controlado por el cliente** (`economicGenerateSchema`/`technicalGenerateSchema`/`checklistRunSchema`, `schemas.ts`), sin validarlo contra `tenders.submission_deadline` ni acotarlo de ningún modo (`request.body.asOfIso ?? nowIso()` en `proposal.routes.ts:140,254`, sin más chequeo). Además, este flujo **nunca inserta en `proposal_pricing_lines`**, así que el trigger `app.enforce_approved_rate` (ya corregido a nivel DB en `packages/db/migrations/0042_fix_db02_db10_rate_validity_submission_deadline.sql` para mirar `submission_deadline`, no `current_date`) **nunca se ejecuta** para el expediente — reabre el patrón DB-02/DB-10 sin ninguna protección en esta capa. Un `writer` de la propia organización puede generar una propuesta económica con una tarifa que ESTARÁ vencida el día del acto, usando un `asOfIso` de un momento en que sí era válida. | Código: `apps/api/src/modules/expediente/schemas.ts` (`economicGenerateSchema`/`technicalGenerateSchema`/`checklistRunSchema`, campo `asOfIso` opcional sin límites); `proposal.routes.ts:140,254`; `packages/expediente/src/company-data.ts:178-199` (`resolveApprovedRate` compara solo contra `asOfIso`). Confirmado independientemente por este agente (lectura de código) y por el sub-agente 2 (test real: tarifa vigente hoy pero `validUntil` anterior a `submission_deadline` del tender, generada sin bloqueo con `asOfIso` de "hoy"). | Ignorar/validar `asOfIso` del cliente contra `tender.submissionDeadline` (usar ese valor como default y como techo permitido, no un valor libre); y/o insertar en `proposal_pricing_lines` para que el trigger `0042` también proteja este flujo. |
| **AE-02** | **ALTA** | 3(d)/7 (A11) | `PATCH /tenders/:tenderId/proposal/sections/:sectionKey` permite editar el CONTENIDO de una sección ya aprobada (alcance `"expediente"`, vigente) **sin invalidar la aprobación**: `fullyApproved` sigue `true` después de la edición. Causa raíz: `ExpedienteInputs` (`inputs.ts:110-116`) = `tenderVersionHash + companyProfileHash + companyDocuments[] + rates[] + templates` — el contenido de `proposal_sections` NUNCA forma parte del hash de insumos sellado, y a diferencia del mecanismo usado para `conditionEvaluations` (que sí llama `workflow.recordChange(...)` explícitamente cuando detecta un cambio), el handler de este PATCH **no invoca `recordChange` en ningún punto** — el propio comentario del código (`proposal.routes.ts:114-119`) afirma que "la invalidación automática de aprobaciones ocurre en la próxima evaluación vía `isFullyApprovedForCurrentHash`", pero esto es objetivamente falso dado que el hash no incluye el contenido editado. Un expediente puede quedar "ready" (paquete ensamblado) con contenido de sección reescrito DESPUÉS de la revisión humana, sin que nadie lo vuelva a aprobar. | `apps/api/src/lib/expediente/inputs.ts:102-117` (definición de `ExpedienteInputs`, sin `proposal_sections`); `apps/api/src/modules/expediente/proposal.routes.ts:90-120` (handler PATCH, comentario en líneas 114-119, sin llamada a `recordChange`); confirmado con test real por el sub-agente 2: aprobación vigente antes del PATCH, `fullyApproved:true` sigue después del PATCH. | Invocar `workflow.recordChange({scope:'seccion', scopeRef:'seccion:<sectionKey>'})` explícitamente en este handler (mismo mecanismo usado para `conditionEvaluations`), o incluir un hash del contenido de `proposal_sections` dentro de `ExpedienteInputs`. |
| **AE-03** | MEDIA | 4/6 (API-11) | `assertSafeFileContent` (`apps/api/src/lib/storage.ts:57-94`) solo compara la firma de ejecutables/PEM/DER contra el **offset 0** del buffer (`startsWithSignature`). Trivialmente evadible: (a) un ejecutable `MZ` con unos pocos bytes de padding cero al inicio pasa sin lanzar; (b) un PDF válido (header `%PDF-`) con un stub `MZ` completo anexado al final, o incrustado en medio del buffer, se acepta íntegro (201) vía `POST /documents`, conservando el payload ejecutable completo dentro del "documento". | `apps/api/src/lib/storage.ts:67-70` (`startsWithSignature`, sin ventana deslizante); confirmado independientemente por sub-agente 2 (PoC: MZ+padding, PDF+MZ-al-final) y sub-agente 3 (PoC: PDF+MZ-embebido-en-medio) — 3 variantes de PoC coincidentes en la misma causa raíz. | Escanear el buffer completo (o al menos una ventana amplia, no solo offset 0) buscando las firmas; considerar además rechazar cualquier documento cuyo contenido posterior al `%%EOF` de un PDF declarado no esté vacío. |
| **AE-04** | MEDIA | 4 | Un documento cuyo contenido extraído contiene HTML/script (`<script>alert(document.cookie)</script>`) sin ningún indicio de ser PDF pasa la heurística `looksLikePlainText` (`text-extraction.ts:36-44`), queda `"extracted"`, y ese contenido se persiste y se devuelve **tal cual, sin escapar**, en `description`/`sourceExcerpt` de `GET /tenders/:id/matrix` (`documents.routes.ts:44-59`, originado en `RequirementMatrixBuilder`/`requirement-matrix.ts:131`). La API en sí es JSON (no ejecuta nada), pero es un vector de XSS almacenado para cualquier frontend que renderice esos campos sin escapar. | `apps/api/src/lib/expediente/text-extraction.ts:36-44`; `apps/api/src/modules/expediente/documents.routes.ts:44-59`; confirmado con test real por sub-agente 2. | Sanitizar/escapar el texto extraído de documentos de tipo "texto plano" antes de persistirlo, o al menos marcar los campos derivados como texto no confiable para que el frontend los trate como tal. |
| **AE-05** | BAJA-MEDIA | 4 | No hay ninguna protección anti zip-bomb / control de ratio de compresión: un archivo con magic bytes `PK\x03\x04` (ZIP) se acepta igual que cualquier "documento" de bases/anexo (201), sin ninguna advertencia. La lista negra de `storage.ts` solo cubre ejecutables y llaves/certificados, no formatos comprimidos genéricos. | `apps/api/src/lib/storage.ts` (`EXECUTABLE_SIGNATURES` no incluye `PK\x03\x04`); confirmado con test real por sub-agente 2. | Rechazar o limitar formatos comprimidos genéricos fuera del alcance documental esperado, o validar el ratio de compresión/tamaño descomprimido antes de aceptar. |
| **AE-06** | BAJA-MEDIA | 3(h) | El `sha256` por documento que aparece en el manifiesto del paquete (`PackageAssembler`) es el hash de `JSON.stringify(contenido)` (`packages/expediente/src/types.ts:200-202`, función `sha256Hex`), **no** el sha256 de los bytes reales del archivo — no coincide con lo que un usuario obtendría corriendo `sha256sum` sobre el archivo extraído del ZIP. Rompe la verificabilidad independiente que el manifiesto pretende ofrecer (REQ-035/REQ-161). | `packages/expediente/src/types.ts:200-202`; `packages/expediente/src/package-assembler.ts` (uso de `sha256Hex` sobre el objeto, no sobre bytes); confirmado con test real por sub-agente 2 (hash del manifiesto ≠ `sha256sum` del archivo extraído). | Hashear los bytes crudos del contenido (`Buffer`) directamente, no su representación JSON. |
| **AE-07** | BAJA (latente, no explotable hoy) | 3(h) | `PackageAssembler.assemble()` escribe `zip.file(`${prefix}${doc.filename}`, doc.content)` sin sanear `filename` (`package-assembler.ts:181-183` aprox.) — un `filename` con `../` o rutas absolutas sobrevive literal como nombre de entrada en el ZIP (Zip Slip clásico), confirmado con test unitario directo sobre la librería. **No explotable hoy vía `apps/api`**: `package.routes.ts` únicamente pasa `filename: `${s.section_key}.txt`` (valor fijo, generado por el servidor, nunca `originalFilename` de un documento subido por el usuario). | `packages/expediente/src/package-assembler.ts` (sin sanitización de `filename`); `apps/api/src/modules/expediente/package.routes.ts:52-56` (mitiga en la práctica, filename fijo); confirmado con test unitario por sub-agente 2. | Sanitizar `filename` dentro del propio `PackageAssembler` (basename, sin `..`/`/`/`\`) para que la librería sea segura también ante futuros llamadores que sí pasen nombres de usuario. |
| **AE-08** | MEDIA | 3(g)/(d) | `ExpedienteInputs.companyProfileHash` (`inputs.ts:75-78`) solo cubre columnas de `company_profiles` (legal_name/trade_name/tax_id/description/sector/updated_at) — **no** incluye `capabilities`, `experience_records` ni `authorized_signatories`, que sí alimentan el contenido de la propuesta técnica generada (vía `CompanyDataResolver`/`TechnicalProposalBuilder`). Un cambio posterior a la aprobación en el estado de verificación (`is_verified`) o evidencia de una capacidad/experiencia/firmante ya usado en una propuesta aprobada **no dispara ninguna invalidación** (ni por hash, ni por `recordChange` explícito como sí ocurre con `conditionEvaluations`). Mismo patrón de fondo que AE-02 (el "conjunto cerrado" de insumos no cubre todo lo que realmente alimenta el contenido). | `apps/api/src/lib/expediente/inputs.ts:75-78,102-117`; `apps/api/src/lib/expediente/company-data-resolver.pg.ts` (capabilities/experience/signatories cargados y usados, pero nunca hasheados); comentario propio del código en `context.ts:44-49` que reconoce explícitamente que las referencias de capacidad/experiencia "no necesariamente son un id de `company_documents`" y por eso quedan fuera del hash. | Extender `ExpedienteInputs` (cambio de contrato en `packages/expediente`) para incluir un hash de las capacidades/experiencia/firmantes efectivamente usados, con el mismo patrón de "subconjunto usado" que ya existe para documentos/tarifas. |
| **AE-09** | MEDIA | 5 | El cálculo de plazo de pago (17 días hábiles, LAASSP Art. 73) **nunca advierte en la RESPUESTA de la API** (campo `legalReference` u otro) que el calendario de días inhábiles usado es incompleto (solo excluye sábado/domingo) — la advertencia solo existe en comentarios de código y en el README, invisibles para cualquier cliente/UI que consuma el JSON. Tampoco expone un parámetro `holidays` en el body de `POST /post-award` (`followupCreateSchema`, `schemas.ts:242-251`) pese a que `computePaymentDeadline`/`addBusinessDays` sí lo aceptan como parámetro de función. Además, REQ-050 (versionar el régimen legal aplicable — 2000 vs. 2025 — según la fecha de la convocatoria) **no está implementado**: `computePaymentDeadline` siempre aplica la regla nueva (17 días hábiles) sin mirar la fecha de publicación de la convocatoria ni exponer un atributo `ley_aplicable`. | `apps/api/src/lib/expediente/business-days.ts` (advertencia solo en comentarios); `apps/api/src/modules/expediente/schemas.ts:242-251` (`followupCreateSchema` sin campo `holidays`); `apps/api/src/modules/expediente/post-award.routes.ts:59-66` (`legalReference` devuelto solo cita la fuente legal, no la limitación del calendario); `docs/REQUISITOS.md` REQ-050/REQ-056. | Incluir un campo explícito (p. ej. `calendarLimitation` o similar) en la respuesta de `POST/GET /post-award` citando que solo se excluyen sábado/domingo salvo `holidays` explícitos; exponer `holidays` como parámetro de la API; evaluar si implementar el versionado de régimen legal por fecha de convocatoria (REQ-050) entra en el alcance de una ronda futura. |
| **AE-10** | BAJA (efectiva hoy: nula/teórica; latente: MEDIA) | 6 (DB-09) | `runContextCache` (`Map<string, RunContext>` en `PgRunStore`/`PgToolCallStore`, `apps/api/src/lib/agent-stores.pg.ts`) no tiene TTL, límite de tamaño ni mecanismo de expiración — crece sin límite mientras el proceso vive. **Hoy no es alcanzable por ninguna ruta HTTP real**: ningún módulo de `apps/api/src/modules/` instancia `PgRunStore`/`PgToolCallStore` (`agentRoutes` en `modules/agents/routes.ts` consulta `tool_calls`/`agent_runs` con SQL directo, sin pasar por estos adaptadores); solo los tests de persistencia (`agent-persistence.test.ts`, `security-db09-agent-run-context-cache.test.ts`) los instancian, con instancias efímeras por proceso de test. El riesgo es real pero dormido: se activaría si una ronda futura cablea `AgentRunner` a rutas HTTP sin resolver antes el límite del caché. | `apps/api/src/lib/agent-stores.pg.ts` (sin `delete()`/`clear()`/TTL en todo el archivo); confirmado con `grep -rn "PgRunStore\|PgToolCallStore" apps/api/src` (solo definiciones + comentario, sin `new` fuera de tests) por sub-agente 3. | Si se cablea `AgentRunner` a producción: usar un caché con TTL/LRU acotado (p. ej. tamaño máximo + expiración por antigüedad) en vez de un `Map` sin límite. |
| **AE-11** | BAJA (límite de diseño ya documentado) | 2 | Un `admin`/`reviewer` que redacta el contenido de una sección técnica puede, si OTRA persona pidió la revisión, aprobar el expediente completo — `ApprovalWorkflow.approve()` solo compara el `actorId` de quien llamó `requestReview` contra quien llama `approve()`, nunca contra quién editó cada sección. | `packages/expediente/src/approval-workflow.ts:153-155`; comentario explícito en `apps/api/src/modules/expediente/approval.routes.ts:110-114` (referencia a EX-EXP-08); confirmado con test real por sub-agente 1 (con `admin`, único rol en ambos conjuntos `SUBMITTER_ROLES`/`APPROVER_ROLES`). | Registrar qué `actorId` editó cada `scopeRef` (sección) y comparar ese conjunto de autores contra quien aprueba, no solo contra quien pidió revisión — cambio de alcance de `packages/expediente`. |
| **AE-12** | BAJA (documentación) | 1/2 | `apps/api/README.md` declara "24 rutas" bajo `/expediente/tenders/:tenderId/...`; el conteo real por `grep` de las 7 archivos de rutas es **26** (documents 7, proposal 5, checklist 2, approval 4, package 3, submission 2, post-award 3). | Conteo propio por `grep -n "server\.\(get\|post\|patch\|delete\|put\)("` sobre `apps/api/src/modules/expediente/*.routes.ts`. | Corregir el número en el README (no afecta funcionalidad ni seguridad). |
| **AE-13** | Informational (gobierno, no seguridad) | 7 | `docs/ACEPTACION.md` (tabla A6-A15) sigue reflejando el estado anterior a la integración real de `apps/api` en esta ronda — mayormente "PENDIENTE" pese a que hoy existe evidencia HTTP real nombrada para A6/A7/A8/A10/A11/A12/A13/A14/A15. Ya señalado en `docs/auditoria-1/expediente-cierre.md` (EX-EXP-22) como pendiente de actualización por el orquestador, sin resolver todavía. | `docs/ACEPTACION.md:202-211` vs. `apps/api/test/expediente-*.test.ts` (posteriores en el tiempo al último commit que tocó `ACEPTACION.md`). | Actualizar `docs/ACEPTACION.md` reflejando la integración real (tarea del orquestador, no de este agente). |

---

## Comprobado correcto

- **Reproducibilidad**: 95/95 (`apps/api`) + 144/144 (`packages/db`), typecheck/lint limpios en ambos, corrida directa de este agente sobre HEAD `2dff88f`.
- **Aislamiento cross-org en las 26 rutas nuevas**: 46/46 ataques bloqueados (0 fugas) — documento subido en A no legible/descargable desde B, paquete ZIP de A no descargable desde B, sub-recursos (`requirementId`/`conflictId`/`followupId`/`sectionKey`) de A no accesibles con `tenderId` propio de B.
- **Roles duros**: `viewer` bloqueado en 15/15 rutas de escritura; `writer` bloqueado al intentar aprobar; autoaprobación (mismo `actorId`, rol `admin`) bloqueada con 403 y razón explícita.
- **A6** (conflicto de plazos entre versiones de bases, historial preservado), **A9** (mecanismo: anexo obligatorio faltante → checklist rojo → nunca "ready", confirmado vía HTTP real aunque sin test nombrado "A9" en `apps/api`), **A10** (nueva versión de bases invalida matriz/aprobación), **A12** (rol indebido nunca aprueba), **A13/A14** (paquete real: ready coherente con checklist, draft con motivos explícitos, ZIP releído con `jszip`), **A15** (sin cliente HTTP saliente, confirmado por grep estático repetido en 2 sub-agentes independientes).
- **`conditionEvaluations`**: invalidación explícita confirmada con hash idéntico antes/después (el mecanismo no depende del hash, es un evento persistido dedicado).
- **`HashedInputs` siempre fresco**: el servidor nunca confía en un hash enviado por el cliente ni en `proposals.inputs_hash` (solo de visualización); recalculado en cada `approve`.
- **Path traversal en subida de documentos**: descartado, `storage_ref` siempre `<orgId>/<sha256>.bin`, nunca derivado de input de cliente.
- **Límite de tamaño (~22MB)**: rechazo antes de escribir a disco.
- **PDF sin capa de texto**: `requires_ocr` explícito, nunca `""` silencioso.
- **API-09** (TOCTOU en aprobación de tool_calls): confirmado atómico a nivel SQL, 8 llamadas concurrentes reales → exactamente 1×200 + 7×409.
- **API-12** (comparación de `X-Platform-Api-Key`): `timingSafeEqual` con longitudes igualadas antes.
- **Ningún pendiente declarado** (OCR real, firma real, envío real a portal, extracción por página real, calendario oficial de inhábiles) está marcado como "hecho" en ningún README/doc.

---

## Conteos finales

- Tests oficiales verdes: **95 (`apps/api`) + 144 (`packages/db`) = 239**.
- Ataques adversariales dinámicos ejecutados: **46 (aislamiento/roles) + ~30 (subida/flujo, sub-agente 2, 18 archivos de test) + 10 (TOCTOU/magic bytes, sub-agente 3) ≈ 86**, más verificación estática directa de este agente sobre 7 módulos de código fuente.
- Hallazgos nuevos de esta ronda: **13** (2 ALTA, 4 MEDIA, 5 BAJA, 2 informational/documentación).
- Hallazgos heredados reverificados: **API-09 CUMPLE, API-11 PARCIAL (AE-03 extiende el hallazgo original), API-12 CUMPLE, DB-09 CUMPLE-hoy/latente (AE-10)**.
