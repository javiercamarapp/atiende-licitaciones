# E11 — Cobertura real contra REQ-050..056 (ronda 5, actualizado ronda 6)

Reconciliación honesta al iniciar la ronda 5: `docs/TABLERO.md` (fila E11) y
`docs/BACKLOG.md` describían E11 como "0% construido" / "solo esquema base".
Eso ya no era del todo exacto: la ronda 3 había dejado un endpoint REAL
(`apps/api/src/modules/expediente/post-award.routes.ts`) con CRUD de
seguimientos post-adjudicación, cómputo real del plazo de pago (17 días
hábiles, LAASSP Art. 73, versionado por fecha de convocatoria) y
recordatorios encolados en `jobs` — pero sin datos estructurados por tipo
(garantías/facturación/hitos), sin calendario oficial de inhábiles, y sin
ninguna de las piezas de mayor alcance de REQ-051..055 (máquina de estados
del contrato, extracción del contrato firmado, redactor de inconformidades,
autopsia del fallo, radar de renovaciones). Esta tabla documenta el estado
REAL después de esta ronda, sin inflar ni esconder lo que sigue pendiente.

| REQ | Descripción (resumen) | Endpoint/código | Test | Estado |
|---|---|---|---|---|
| REQ-050 | Motor de plazos versiona la ley aplicable por fecha de convocatoria | `lib/expediente/business-days.ts` (`resolvePaymentLegalRegime`, ya existía ronda 3); calendario oficial: `calendar_holidays` + `GET/POST /admin/calendar-holidays` (nuevo, ronda 5) | `apps/api/test/expediente-post-award.test.ts`, `apps/api/test/admin-calendar-holidays.test.ts` | **PARCIAL** — el versionado legal por fecha ya estaba cubierto; lo nuevo es que el calendario de días inhábiles ahora es una tabla real cargable por un administrador (con fuente citada), no solo un parámetro `holidays` por request. La tabla se queda VACÍA por defecto (ver nota legal abajo): sin carga administrativa, el cómputo sigue excluyendo solo sábado/domingo, declarado explícitamente en `calendarNote`. |
| REQ-051 | Máquina de estados del contrato post-adjudicación (adjudicado→contrato_firmado_declarado→en_ejecución→entregado→facturado→pagado→cerrado, con ramas modificado/penalizado/rescindido/en_inconformidad) | `lib/expediente/contract-lifecycle.ts` (grafo `CONTRACT_TRANSITIONS`); `modules/expediente/contract.routes.ts` (`POST/GET /tenders/:id/contract`, `POST .../contract/transition`, `GET .../contract/history`, `PATCH .../contract`); tablas `contracts`/`contract_status_history` (migración 0065) | `apps/api/test/expediente-contract-lifecycle.test.ts`; `packages/db/test/rls-ronda6-post-award.test.ts` | **CONSTRUIDO (ronda 6)** — transiciones validadas contra una tabla cerrada en código (nunca en runtime), motivo obligatorio, actor y evidencia opcional en cada transición, historial `contract_status_history` INMUTABLE (RLS sin política de UPDATE/DELETE, ni el propio dueño puede editarlo), transición inválida → 409 con el detalle de estados permitidos, alertas por estado (`jobs`, kind=`contract_state_alert`, sin envío externo) para modificado/penalizado/rescindido/en_inconformidad/cerrado, y step-up (2FA, `purpose='expediente.contract_transition'`) exigido para rescindir/penalizar/modificar/marcar en inconformidad. NOTA: los nombres de estado difieren del texto original de REQ-051 en este mismo documento (que usaba "firmado→garantía→entrega→aceptado→...→liberado"); se implementó tal como los especificó la tarea despachada de ronda 6 ("adjudicado→contrato_firmado_declarado→en_ejecución→entregado→facturado→pagado→cerrado, con ramas: modificado, penalizado, rescindido, en_inconformidad"), documentado en `contract-lifecycle.ts`. |
| REQ-052 | Extraer del contrato al firmarse: número de contrato, montos, plazos, garantías, penas convencionales/deductivas, forma de pago, administrador del contrato, cesión de cobro | `lib/expediente/contract-extraction.ts` (extractor determinista por regex, sin LLM); `modules/expediente/contract.routes.ts` (`POST .../contract/documents`, `GET .../documents/:id/fields`, `POST .../fields/:id/confirm`); tablas `contract_documents`/`contract_extracted_fields` (migración 0067) | `apps/api/test/expediente-contract-extraction.test.ts` | **CONSTRUIDO (ronda 6)** — el usuario SUBE el contrato firmado (declarativo, el sistema nunca firma); extracción de texto con el MISMO motor que bases (`extractDocumentText`, E6: PDF con capa de texto o texto plano; sin OCR → `requires_ocr`, nunca se inventa contenido). Campos detectados (`numero_contrato`, `monto_total`, `plazo_entrega`, `garantia_cumplimiento`, `pena_convencional`, `deductiva`, `forma_pago`, `administrador_contrato`, `cesion_cobro`) con cláusula (si se detecta un marcador "CLÁUSULA N" antes de la coincidencia), página REAL (ronda de corrección R6-01/R6-02: el motor de extracción migró de `pdf-parse@1.1.1` — que no soportaba PDFs con cross-reference stream, PDF 1.5+, formato que `pdf-lib` y muchos generadores reales emiten — a `pdfjs-dist`, que extrae texto por página real; `sourcePage` ya no es una aproximación proporcional) y confianza explícita. TODO campo entra con `status='sugerido'`; solo `POST .../fields/:id/confirm` (confirmar o corregir) lo mueve a `confirmado`/`corregido` — nunca se da un campo por válido sin esa acción humana explícita. |
| REQ-053 | Redactor de inconformidades: borrador estructurado (hechos/agravios/fundamentos con jurisdicción y fecha DOF/pruebas/plazo), guardrail anti-frivolidad, versionado con hash, step-up para "marcar como revisado" | `lib/expediente/inconformidad.ts` (`buildInconformidadContent`); `lib/expediente/business-days.ts` (`computeInconformidadDeadline`, Art. 95 LAASSP); `modules/expediente/inconformidad.routes.ts`; tabla `inconformidad_drafts` (migración 0068) | `apps/api/test/expediente-inconformidad.test.ts` | **CONSTRUIDO (ronda 6)** — cada generación crea una VERSIÓN nueva (nunca edita una existente; trigger de base de datos hace el contenido INMUTABLE incluso para el dueño), con `contentHash` (sha256). Fundamentos citan LAASSP nueva Art. 49 (fallo, motivación del desechamiento) y Art. 95 (plazo: 6 días hábiles, o 10 bajo cobertura de tratados), ambos con jurisdicción "Federal" y fecha DOF 2025-04-16 (`docs/legal/verificacion-legal.md`, filas REQ-103/REQ-104). El plazo se calcula con el MISMO motor determinista de días hábiles que REQ-050 (nunca un LLM), combinando el calendario oficial (`calendar_holidays`) si está cargado. Todo borrador queda marcado con el disclaimer "BORRADOR — requiere revisión de abogado" y JAMÁS se envía a ninguna autoridad (sin cliente HTTP saliente en el módulo). Guardrail anti-frivolidad determinista (pruebas vs. agravios) clasifica `viability` (`alta`/`media`/`baja`) con una recomendación explícita — NUNCA bloquea la generación, solo advierte. "Marcar como revisado" exige step-up (2FA, `purpose='expediente.inconformidad_review'`) y rol reviewer/admin/owner; ya revisado → 409. |
| REQ-054 | Autopsia del fallo: comparación estructurada propuesta propia vs. fallo (motivo de desechamiento, puntos/criterios, precio vs. ganador), lecciones vinculadas al perfil de empresa, sin inventar datos ausentes | `modules/expediente/fallo-autopsy.routes.ts`; tablas `fallo_autopsies`/`company_lessons_learned` (migración 0069) | `apps/api/test/expediente-fallo-autopsy.test.ts` | **CONSTRUIDO (ronda 6)** — cualquier campo textual no capturado (motivo de desechamiento, nombre del ganador) se persiste literalmente como `"no disponible"` (constante `NO_DISPONIBLE`), nunca NULL/vacío ambiguo ni inventado; precio/puntos del ganador quedan `null` explícito si el fallo no es público. Comparación de criterios/puntos como lista estructurada libre (`criteriaComparison`). Lecciones registradas en `company_lessons_learned`, vinculadas a la autopsia Y consultables ORG-WIDE (no solo por convocatoria) vía `GET /expediente/lessons-learned` — "vinculadas al perfil de empresa" tal como pide el requisito. No se construyó una taxonomía CERRADA de motivo de pérdida (el texto original de REQ-054 en este documento la menciona); `disqualificationReason` es texto libre capturado por el usuario, límite documentado. |
| REQ-055 | Radar de renovaciones: a partir de contratos con fecha de fin y convocatorias históricas de la misma entidad, alertas de renovación probable con antelación configurable; jobs en tabla `jobs`, sin envío externo | `lib/expediente/renewal-radar.ts` (`computeRenewalAlertCandidates`, pura); `modules/expediente/renewal-radar.routes.ts` (`POST /renewals/scan`, `GET /renewals/alerts`); columnas `contracts.end_date`/`contract_number` + tabla `renewal_alerts` (migración 0070) | `apps/api/test/expediente-renewal-radar.test.ts` | **CONSTRUIDO (ronda 6)** — escaneo BAJO DEMANDA (sin cron real, ver README) sobre los contratos de la organización con `end_date` conocida; umbrales de antelación configurables (por defecto 90/60/30 días); cada umbral cruzado genera una alerta (`renewal_alerts`) + un job `renewal_radar_alert` (`jobs`, sin envío externo), con índice único parcial que evita duplicar el mismo umbral en escaneos repetidos. Cada alerta se enriquece con hasta 5 convocatorias PREVIAS de la MISMA organización y el MISMO `contracting_body` (si existen) como contexto de apoyo. LÍMITE DOCUMENTADO: no se implementó predicción de una licitación futura a partir SOLO de convocatorias históricas cuando no existe todavía un contrato propio con `end_date` (p. ej. una dependencia que nunca adjudicó antes a esta organización) — `sourceKind='historical_pattern'` está declarado en el esquema pero no se genera en esta ronda. |
| REQ-056 | Motor de calendario legal con días inhábiles + alerta si la convocatoria fija menos plazo del mínimo legal + recordatorios T-72/24/6h | `calendar_holidays` + `GET/POST /admin/calendar-holidays`; `alertLevel` en `followupSchema` | `apps/api/test/admin-calendar-holidays.test.ts`, `apps/api/test/expediente-post-award.test.ts` | **PARCIAL** — calendario de inhábiles cargable (nuevo) y alertas de vencimiento por día (nuevo) SÍ están construidos. "Alerta si la convocatoria fija menos plazo del legal mínimo" NO está construido (requeriría comparar el plazo mínimo legal de cada tipo de procedimiento contra la matriz de requisitos, fuera de alcance de esta ronda). Los recordatorios son granularidad DÍA (`reminderLeadDays`, job único a T-N días), no la triple ventana T-72h/24h/6h explícita del requisito — límite documentado, no resuelto. |

## Lo que SÍ se construyó en esta ronda (ítem 1 de la tarea despachada)

- **Hitos con fecha y responsable**: `kind='hito'` ahora exige
  `responsibleParty` (validación explícita en el handler, no solo zod
  opcional).
- **Garantías** (tipo, vigencia, monto, recordatorio): `kind='garantia'`
  exige `guaranteeType`; la vigencia reutiliza `dueDate` (documentado, no se
  duplica una segunda fecha); el monto reutiliza `amount`; el recordatorio
  ya existía (job `post_award_followup_reminder`, `reminder_lead_days`).
- **Facturación** (CFDI, aceptación, plazo de pago): `kind='facturacion'`
  exige `cfdiReference` + `acceptanceDate`; el plazo de pago se calcula con
  el MISMO motor legal que `kind='pago'` (17 días hábiles, LAASSP Art. 73,
  o 20 días naturales bajo el régimen abrogado, según la fecha de
  publicación de la convocatoria — REQ-050).
- **Penalizaciones/convenios modificatorios registrados**: kinds nuevos
  `penalizacion`/`convenio_modificatorio`, con `modificationReference`
  obligatorio (número/expediente registrado) y `amount` para el monto.
- **Recordatorios como jobs, sin envío externo**: sin cambios de fondo (ya
  existía); se propagó `correlation_id` al job encolado (REQ-171, ver
  `docs/api-ronda5.log`/README).
- **Alertas de vencimiento**: campo `alertLevel` (`'vencido'|'proximo'|null`)
  en cada seguimiento, más `GET /expediente/post-award-alerts` (todas las
  convocatorias de la organización, ordenado por vencimiento).
- **Calendario oficial de inhábiles**: tabla `calendar_holidays`
  (jurisdicción/año/fecha/fuente URL + fecha de consulta), endpoint
  `GET/POST /admin/calendar-holidays` (lectura abierta a cualquier usuario
  autenticado, escritura solo superadmin), y el motor de plazos combina los
  días cargados ahí con los que el llamador declare a mano en `holidays`.

## Ronda 6 — REQ-051..055 (post-adjudicación avanzada)

Todo lo listado en la tabla de arriba para REQ-051..055 se construyó en
esta ronda, sobre `apps/api` + `packages/db` (sin tocar `apps/web`, a
cargo de otro agente en paralelo). Resumen de piezas transversales:

- **Migraciones**: `0065_req051_contract_lifecycle.sql` (contratos +
  historial inmutable), `0066_r6_step_up_purposes_contract_inconformidad.sql`
  (dos propósitos nuevos de step-up), `0067_req052_contract_extraction.sql`,
  `0068_req053_inconformidad_drafts.sql`, `0069_req054_fallo_autopsy.sql`,
  `0070_req055_renewal_radar.sql`.
- **RLS/aislamiento**: todas las tablas nuevas tienen `org_id` + RLS por
  organización (`app.apply_org_rls` para las de lectura/escritura normal;
  políticas a mano, SIN UPDATE/DELETE, para los dos historiales inmutables
  — `contract_status_history` e `inconformidad_drafts`, este último además
  con un trigger que bloquea editar el contenido). Prueba negativa
  dedicada: `packages/db/test/rls-ronda6-post-award.test.ts` (7 casos,
  incluye un actor sin membresía alguna y viewer de solo lectura).
- **Step-up (2FA)**: dos propósitos nuevos y cerrados en
  `STEP_UP_PURPOSES` (`lib/step-up.ts`, reforzado en CHECK de esquema,
  migración 0066): `expediente.contract_transition` (rescindir/penalizar/
  modificar/marcar en inconformidad un contrato) y
  `expediente.inconformidad_review` (marcar un borrador como revisado por
  abogado).
- **Auditoría/correlación**: toda mutación pasa por `recordAudit` con
  `requestId`/`correlationId`; los jobs encolados (`contract_state_alert`,
  `renewal_radar_alert`) también propagan `correlationId`.
- **Sin envío externo en ningún módulo nuevo**: ni el redactor de
  inconformidades, ni la extracción de contrato, ni el radar de
  renovaciones hacen ninguna llamada HTTP saliente hacia un tercero — todo
  lo que se "envía" es una fila insertada en `jobs`, consumible por un
  futuro canal de notificación fuera de alcance de esta ronda.
- **Tests**: 5 archivos nuevos por REQ (`expediente-contract-lifecycle`,
  `expediente-contract-extraction`, `expediente-inconformidad`,
  `expediente-fallo-autopsy`, `expediente-renewal-radar`), más
  `expediente-post-award-e2e-ronda6.test.ts` (flujo completo adjudicado →
  contrato subido → estados → inconformidad borrador → autopsia → radar,
  y un caso adversarial de aislamiento cruzado entre organizaciones a
  nivel de API). Salida completa en `docs/logs/api-ronda6.log`.
- **Colaboración multi-agente (transparencia)**: durante la investigación
  inicial de esta ronda, dos subagentes de research (lanzados para
  recopilar patrones legales/de código de solo lectura) excedieron su
  directiva y comenzaron a implementar código de forma independiente y
  concurrente sobre el mismo árbol de trabajo, generando migraciones
  `0065_*` duplicadas/en conflicto. Se detuvo esa deriva, se revisó línea
  por línea todo lo que habían escrito, se conservó lo que era correcto
  (parte del diseño de `contract-lifecycle.ts`, gran parte de
  `contract.routes.ts`/`schemas.ts`, y las adiciones a `step-up.ts`/
  `test/helpers.ts`), se corrigieron varios bugs reales encontrados en esa
  revisión (parámetros de INSERT desalineados, nombres de campo
  inconsistentes entre la ruta y el esquema de respuesta, columnas `date`
  devueltas como `Date` sin el helper de serialización correcto — el mismo
  bug de fondo ya documentado en `lib/schema-helpers.ts`), se completó lo
  que faltaba (step-up realmente conectado a las transiciones sensibles,
  motor de extracción de campos del contrato, tablas/migraciones
  faltantes, endpoints de REQ-053/054/055 completos), y se re-numeraron
  las migraciones para que no colisionaran. Se documenta aquí en vez de
  esconderlo.

## Nota legal (sin inventar)

La tabla `calendar_holidays` se despliega **VACÍA**. `docs/legal/verificacion-legal.md`
(fila REQ-106/REQ-108) documenta que esta ronda de verificación legal NO
pudo confirmar en línea el lineamiento vigente de la Secretaría
Anticorrupción y Buen Gobierno (SABG, sucesora de la SFP) con el calendario
oficial completo de días inhábiles para contrataciones públicas — cargar
esa tabla con fechas reales, cada una con `sourceUrl` + `sourceConsultedOn`
verificables, es tarea explícita de un administrador humano (o de una
ronda futura con acceso confirmado a la fuente oficial), nunca una lista
codificada de memoria. Mientras la tabla esté vacía, `calendarNote` en la
respuesta de la API sigue advirtiendo explícitamente que el cómputo solo
excluye sábados y domingos.
