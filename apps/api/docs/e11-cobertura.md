# E11 — Cobertura real contra REQ-050..056 (ronda 5)

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
| REQ-051 | Agente de cobranza: máquina de estados del contrato (adjudicado→firmado→garantía→entrega→aceptado→factura→pagado→liberado) | — | — | **PENDIENTE** — no construido. `post_award_followups` es una lista de eventos tipados (hito/garantía/facturación/pago/penalización/convenio), no una máquina de estados con transiciones validadas. Fuera de alcance de esta ronda (ver tarea despachada, ítem 1: se pidió "hitos/garantías/facturación/penalizaciones/recordatorios/alertas/calendario", no la máquina de estados completa). |
| REQ-052 | Extraer del contrato al firmarse: penas, deductivas, fechas de entrega, forma de pago, administrador del contrato, cesión de cobro | — | — | **PENDIENTE** — no construido. Requeriría un pipeline de extracción estructurada sobre el documento firmado (similar al de matriz de requisitos de bases, E6), no despachado en esta ronda. |
| REQ-053 | Redactor de inconformidades con detector de agravios determinista + guardrail anti-frivolidad | — | — | **PENDIENTE** — no construido, no despachado en esta ronda. |
| REQ-054 | Autopsia del fallo: extracción estructurada + taxonomía cerrada de motivo de pérdida | — | — | **PENDIENTE** — no construido, no despachado en esta ronda. |
| REQ-055 | Radar de renovaciones/consolidadas/acuerdos marco (alertas 90/60/30 días) | `GET /expediente/post-award-alerts` (nuevo, ronda 5) | `apps/api/test/expediente-post-award.test.ts` | **PARCIAL** — se construyó un endpoint de alertas de vencimiento genérico (`alertLevel: 'vencido'|'proximo'`, umbral configurable por `reminderLeadDays`), reutilizable para cualquier seguimiento incluyendo renovaciones si se registran como `kind='hito'`. NO es el radar específico de renovaciones/consolidadas/acuerdos marco con los tres umbrales fijos 90/60/30 días simultáneos que pide el requisito — sería un cliente concreto de este mecanismo genérico, no construido en esta ronda. |
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
