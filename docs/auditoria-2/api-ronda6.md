# Auditoría adversarial ronda 6 — `apps/api` + `packages/db` (REQ-051..055, post-adjudicación avanzada)

Fecha: 2026-09-06. Agente: auditor adversarial independiente, contexto
separado del proyecto. Rol: **SOLO encuentra** — ningún código de
`apps/api`, `packages/db`, `apps/web` ni `apps/worker` fue modificado por
este agente.

**Metodología**: `git worktree add <scratchpad>/audit-api6 HEAD` (HEAD real
al iniciar: `4a42996`) + `npm install` real; el árbol principal nunca se
tocó con comandos destructivos. Se reprodujo de forma independiente la
suite completa de `apps/api` (dos veces) y `packages/db` (una vez) en el
worktree. Para verificar comportamiento real (no solo lectura de código) se
escribieron pruebas y scripts adversariales temporales (`zz-audit-*.test.ts`,
`repro*.mjs`, `debug-repro*.mjs`), ejecutados y **borrados** al terminar.
Evidencia de comandos/salidas reales en `docs/logs/audit-api-ronda6.log`.
Dos subagentes lanzados para paralelizar ataques adversariales (REQ-051 por
un lado, REQ-052/053/054 por otro) fueron cortados por un 429 masivo de la
plataforma a mitad de ejecución; no se relanzaron — el trabajo restante se
completó directamente por este agente, reutilizando 3 de sus scripts
temporales que quedaron completos en el worktree (verificados y ejecutados
por este agente antes de descartarlos) y completando el resto (rendimiento
del radar) de cero. Esto deja algunos puntos del checklist original
verificados solo por revisión de código en vez de ejecución en vivo — se
declara explícitamente en cada rubro, sin inflar la cobertura real.

Documentos base leídos: `apps/api/docs/e11-cobertura.md` (incluida la nota
de transparencia sobre subagentes concurrentes/migraciones 0065
duplicadas/bugs corregidos), migraciones `0065`-`0070`, los 7 módulos de
código de ronda 6 (`contract-lifecycle.ts`, `contract.routes.ts`,
`contract-extraction.ts`, `inconformidad.ts`, `inconformidad.routes.ts`,
`fallo-autopsy.routes.ts`, `renewal-radar.ts`, `renewal-radar.routes.ts`),
`business-days.ts`, `calendar-holidays.ts`, `step-up.ts`, los tests de
ronda 6, `docs/logs/api-ronda6.log`, `docs/REQUISITOS.md` (REQ-051..056),
`docs/legal/verificacion-legal.md`.

---

## Resumen ejecutivo

`packages/db` reproduce limpio (168/168). `apps/api` reproduce **262/263**,
de forma idéntica y reproducible al log de la ronda (1 fallo). Ese único
fallo, sin embargo, **NO es el flake de iCloud que el equipo documentó**:
es un defecto real, determinista, 100% reproducible incluso fuera de
iCloud Drive, y el propio código del proyecto ya documentaba en otro
archivo la incompatibilidad exacta que lo causa (R6-01). Su consecuencia
práctica es seria: el motor de extracción de texto que REQ-052 reutiliza
para contratos firmados reales nunca se prueba con éxito contra un PDF que
use el formato de referencia cruzada moderno (xref-stream, PDF 1.5+), muy
común en generadores reales de PDF (R6-02). Se encontró además un problema
de **rendimiento real y medido** en el radar de renovaciones a la escala de
5,000 contratos que pide esta ronda (R6-03, ALTA), y evidencia de código
(no confirmada en vivo por falta de tiempo tras el 429) de una posible
condición de carrera en la máquina de estados del contrato (R6-04, MEDIA).
El resto de la superficie auditada — máquina de estados (409 exhaustivo,
inmutabilidad del historial incluso para superadmin, step-up, aislamiento
cross-org), citas legales de inconformidad, guardrail anti-frivolidad,
ausencia de envío externo, "no disponible" en autopsia, dedupe del radar —
se comprobó **correcta**, con evidencia en vivo en la mayoría de los casos.

---

## Hallazgos

### R6-01 — CRÍTICA/ALTA. El fallo de `expediente-documents-and-matrix.test.ts` fue mal atribuido a "iCloud"; es un defecto real y reproducible

**Rubro**: Reproducibilidad.

**Evidencia**: `docs/logs/api-ronda6.log` y `apps/api/docs/e11-cobertura.md`
afirman: *"262/263 tests de apps/api pasan... falla de forma preexistente
y NO relacionada con esta ronda — INC-10 (docs/BLOQUEOS.md): repo bajo
iCloud Drive, corrupción intermitente de streams flate en archivos
sincronizados"*. Se reprodujo la suite completa **dos veces** y el archivo
aislado **tres veces más** (5/5) en un worktree bajo `/private/tmp`,
completamente fuera de iCloud Drive: el mismo test falla el 100% de las
veces con el mismo error (`expected 'failed' to be 'extracted'`).

Reproducción directa de la causa: el PDF del test se genera en memoria con
`pdf-lib` (no es un archivo en disco que iCloud pudiera corromper). Al
pasar ese mismo buffer a `pdf-parse/lib/pdf-parse.js` directamente (fuera
de vitest), pdf.js (versión `v1.10.100`, empaquetada dentro de
`pdf-parse@1.1.1`, ~2017) lanza `FormatError: Unknown compression method in
flate stream` y luego `InvalidPDFException` / `bad XRef entry`. Un PDF
generado con una herramienta que SÍ usa el formato clásico de xref-tabla
(`textutil`+`cupsfilter` de macOS, PDF 1.3) se parsea sin problema con la
misma librería. Es decir: `pdf-parse@1.1.1` no soporta el formato de
cross-reference **stream** (PDF 1.5+, que `pdf-lib` siempre emite), pero sí
el formato clásico.

Lo más relevante: **el propio proyecto ya documenta esta incompatibilidad
exacta**, en el comentario de cabecera de
`apps/api/test/expediente-text-extraction.test.ts`: *"la versión de pdf.js
que empaqueta pdf-parse@1.1.1 es incompatible, de forma dependiente del
contenido exacto, con el flujo de compresión de xref que genera
pdf-lib ('Unknown compression method in flate stream')"* — y por eso ese
test unitario **mockea** `pdf-parse` en vez de usar un PDF real. Es decir,
en un archivo el equipo diagnosticó correctamente el problema; en otro
(el log/doc de cierre de ronda) lo atribuyó a corrupción de iCloud. Ambos
archivos describen el MISMO síntoma exacto.

**Severidad**: ALTA (no crítica en el sentido de "rompe producción hoy
mismo", pero es una afirmación falsa en la documentación de cierre de
ronda sobre el estado real de la suite, y esconde un defecto con impacto
directo en REQ-052 — ver R6-02).

**Reparación (no aplicada por este agente)**: corregir la narrativa en
`docs/logs/api-ronda6.log`/`apps/api/docs/e11-cobertura.md` (no es INC-10);
evaluar migrar de `pdf-parse@1.1.1` a una versión mantenida o a
`pdfjs-dist` reciente, o generar los PDFs de prueba con
`useObjectStreams:false` **y** forzando xref clásico si `pdf-lib` lo
permite (se intentó `useObjectStreams:false` y NO fue suficiente — sigue
fallando con "bad XRef entry", así que el problema no se limita a los
object streams).

---

### R6-02 — ALTA. Consecuencia de R6-01: la extracción de un contrato firmado real (REQ-052) nunca se prueba con éxito contra un PDF con xref-stream, y probablemente falla en producción para ese formato

**Rubro**: Extracción de contrato (REQ-052).

**Evidencia**: `contract.routes.ts` reutiliza literalmente
`extractDocumentText` (E6), el mismo motor que falla en R6-01. En toda la
suite de ronda 6 **ningún test** ejercita con éxito la rama "PDF con texto
real" de este motor: `expediente-contract-extraction.test.ts` solo prueba
`text/plain`; el único test que sí sube un PDF de verdad
(`expediente-documents-and-matrix.test.ts`) es precisamente el que falla.
Muchos generadores de PDF reales y comunes (exportar desde Word/LibreOffice,
imprimir a PDF desde navegadores modernos, herramientas de firma
electrónica) usan PDF 1.5+ con cross-reference streams por defecto. Si el
contrato firmado que un usuario real sube fue producido por alguna de esas
herramientas, es plausible que caiga en la misma incompatibilidad y quede
clasificado como `"failed"` (nunca inventa contenido, eso está bien) en vez
de `"extracted"` — sin que la API lo señale como un caso conocido, dejando
al usuario sin ninguna pista de que el problema es del extractor y no del
documento.

**Severidad**: ALTA (afecta la promesa central de REQ-052 para una
categoría de archivos de entrada plausible en producción; no se pudo medir
qué fracción de PDFs reales cae en esta categoría, por eso no se marca
CRÍTICA).

**Reparación (no aplicada)**: la misma de R6-01 (dependencia de
extracción), más idealmente un mensaje de `detail` más específico
distinguiendo "no se pudo parsear el PDF" (posible bug del extractor) de
"convertido correctamente pero sin capa de texto" (`requires_ocr`).

---

### R6-03 — ALTA. Rendimiento del radar de renovaciones (REQ-055) no escala a 5,000 contratos: ~17-28 s en una sola petición/transacción bloqueante

**Rubro**: Radar (REQ-055).

**Evidencia** (en vivo, ver log): se sembraron 5,000 contratos con
`end_date` dentro de los 3 umbrales por defecto (90/60/30 días, generando
15,000 alertas candidatas) y se invocó `POST /expediente/renewals/scan`.
Primera corrida: **16.6-28 s** (dos corridas, variación por carga de
máquina) devolviendo `alertsCreated: 15000`. Un segundo escaneo (dedupe,
0 alertas nuevas) igual tardó **~2 s**. Todo esto contra PGlite **en
memoria** dentro del mismo proceso (sin latencia de red real).

Causa (`renewal-radar.routes.ts`): por cada alerta candidata se ejecutan,
**secuencialmente y dentro de una sola transacción**, un `SELECT` de
existencia (dedupe), un `SELECT` de convocatorias históricas, y 2 `INSERT`
(job + alerta) — un patrón N+1 sin batching, sin paginación, sin
procesamiento asíncrono/en background, y sin ningún límite de tiempo. Con
Postgres real sobre red (en vez de una llamada WASM in-process), cada uno
de esos ~60,000 round-trips (15,000 alertas × ~4 queries) tendría latencia
de red real, empeorando el tiempo total muy por encima de lo medido aquí.
Una sola petición HTTP síncrona de decenas de segundos sostiene una
transacción de base de datos abierta todo ese tiempo (riesgo de contención
de locks/conexiones) y es candidata a exceder timeouts típicos de
proxy/gateway (30-60s).

**Severidad**: ALTA — la propia ronda pidió explícitamente verificar esta
escala y el resultado es un cuello de botella claro, medido y reproducible.

**Reparación (no aplicada)**: agrupar el dedupe en una sola consulta
(`NOT EXISTS`/`ON CONFLICT DO NOTHING` aprovechando el índice único parcial
ya existente), batchear los `INSERT` de jobs/alertas, y mover el escaneo a
un job en background en vez de una respuesta HTTP síncrona para
organizaciones con muchos contratos.

---

### R6-04 — MEDIA (evidencia de código, no confirmada en vivo). Posible condición de carrera en la transición de estado del contrato: sin bloqueo pesimista ni UPDATE condicionado al estado esperado

**Rubro**: Máquina de estados (REQ-051), concurrencia.

**Evidencia**: en `contract.routes.ts`, el handler de transición lee el
contrato con un `SELECT` normal (`requireContract`, sin `FOR UPDATE`),
valida `checkTransition(fromStatus, toStatus)` en memoria, y luego ejecuta:

```sql
update contracts set status = $1 where id = $2 and org_id = $3 returning *
```

sin una cláusula `AND status = $fromStatus`. Si dos transiciones
simultáneas parten del mismo `fromStatus` (ambas leen el mismo estado antes
de que cualquiera confirme), **ambas pasan la validación en memoria** (cada
una contra un destino válido desde ese `fromStatus`), y ambos `UPDATE`
tienen éxito (Postgres los serializa en el tiempo pero ninguno falla,
porque no hay condición sobre el valor previo) — cada una inserta además
una fila en `contract_status_history` con el `from_status` que capturó
ANTES de que la otra transacción committeara, lo que podría dejar un
historial con una fila `from_status` que ya no coincide con el estado real
inmediatamente anterior en ese punto de la cadena. No se confirmó esto con
un `Promise.all` real en vivo (el intento de este agente para hacerlo fue
cortado por el 429 de la plataforma antes de poder ejecutarlo), así que se
reporta como **hallazgo basado en lectura de código**, no como bug
confirmado empíricamente — pendiente de una prueba de concurrencia real
para confirmar o descartar.

**Severidad**: MEDIA (impacto en integridad del historial de auditoría si
se confirma, pero requiere una ventana de carrera estrecha entre dos
actores legítimos operando el mismo contrato al mismo tiempo).

**Reparación (no aplicada)**: `SELECT ... FOR UPDATE` sobre el contrato
antes de validar la transición, o condicionar el `UPDATE` a
`AND status = $fromStatus` y tratar 0 filas afectadas como un 409
"el estado cambió mientras se procesaba, reintente".

---

### R6-05 — BAJA. Confirmación de campos de contrato no está realmente anidada por `tenderId` (gap tipo IDOR, no explotable hoy)

**Rubro**: Extracción de contrato (REQ-052).

**Evidencia**: `POST /tenders/:tenderId/contract/fields/:fieldId/confirm`
y `GET /tenders/:tenderId/contract/documents/:documentId/fields` validan
que el `tenderId` de la URL tenga un contrato en la organización, pero la
consulta del campo/documento en sí filtra únicamente por
`id = $fieldId/$documentId AND org_id = $orgId` — nunca se verifica que ese
`fieldId`/`documentId` pertenezca realmente al contrato de ESE `tenderId`.
Hoy esto no es explotable como escalación de privilegios (la autorización
de escritura ya es a nivel de organización completa, `WRITE_ROLES`), pero
la URL sugiere un anidamiento (`tenderId` → contrato → documento → campo)
que en realidad no se aplica, y se rompería silenciosamente si el producto
introdujera algún día permisos más finos por convocatoria/contrato.

**Severidad**: BAJA.

**Reparación (no aplicada)**: añadir `AND contract_document_id IN (SELECT
id FROM contract_documents WHERE contract_id = $contractId)` (o
equivalente) a ambas consultas.

---

### R6-06 — BAJA / cosmética. Restos de la renumeración de migraciones (0065→0066) en comentarios

**Rubro**: Reproducibilidad — restos de la colisión de subagentes.

**Evidencia**: el archivo `packages/db/migrations/
0066_r6_step_up_purposes_contract_inconformidad.sql` mantiene en su primera
línea el comentario `-- 0065_r6_step_up_purposes_contract_inconformidad.sql`
(nombre de archivo incorrecto, es la migración 0066), y
`apps/api/src/lib/step-up.ts` referencia `"migración 0065"` en el
comentario junto a los propósitos nuevos, cuando en realidad viven en la
migración 0066. No hay ningún archivo `.sql` duplicado ni ninguna ruta
registrada dos veces en `app.ts` (verificado): la reparación de la
colisión de subagentes descrita en `e11-cobertura.md` sí se completó a
nivel de código y esquema; solo quedaron estos dos comentarios
desactualizados como rastro cosmético.

**Severidad**: BAJA (sin impacto funcional).

**Reparación (no aplicada)**: corregir los dos comentarios.

---

### R6-07 — BAJA / gap de cobertura. El cómputo del plazo de inconformidad nunca se prueba con el calendario oficial de feriados cargado

**Rubro**: Inconformidad (REQ-053).

**Evidencia**: `expediente-inconformidad.test.ts` solo ejercita el cómputo
de 6/10 días hábiles excluyendo sábado/domingo; ningún test (ni de esta
ronda ni de rondas anteriores) inserta una fila en `calendar_holidays` y
luego genera un borrador de inconformidad para confirmar que
`loadOfficialHolidays` + `addBusinessDays` excluyen correctamente un
feriado entre semana dentro de la ventana de 6/10 días. Se intentó
verificar esto en vivo pero el intento fue cortado por el 429 de la
plataforma antes de completarse. El código (`calendar-holidays.ts`,
`business-days.ts`) se revisó y es correcto en su lógica (consulta por año
± 1, exclusión vía `Set`), pero **no está confirmado end-to-end** para
este flujo específico.

**Severidad**: BAJA (gap de cobertura, no un defecto confirmado).

---

### R6-08 — BAJA / gap de cobertura. El caso "viabilidad media" del guardrail anti-frivolidad no está cubierto por ningún test

**Rubro**: Inconformidad (REQ-053).

**Evidencia**: `assessViability` en `inconformidad.ts` tiene 3 ramas
(`baja`: 0 pruebas: `media`: pruebas < agravios; `alta`: pruebas ≥
agravios). Los tests existentes cubren `baja` (0 pruebas) y `alta` (1
agravio/1 prueba); ningún test ejercita `media` (p.ej. 2 agravios, 1
prueba). Por lectura de código la rama es correcta y trivial, pero no está
confirmada por ejecución.

**Severidad**: BAJA.

---

## Comprobado correcto (con evidencia)

- **Reproducibilidad `packages/db`**: 168/168 reproducido de forma
  independiente, incluyendo el test explícito de idempotencia de
  migraciones aplicadas dos veces.
- **Reproducibilidad `apps/api`**: 262/263 reproducido de forma idéntica
  dos veces en un worktree aislado (fuera de iCloud); los 23 tests nuevos
  de REQ-051..055 (5 archivos por REQ + E2E + adversarial cross-org) pasan
  en su totalidad, todas las veces.
- **Sin restos de la colisión de subagentes**: sin archivos de migración
  duplicados, sin rutas registradas dos veces en `app.ts` (verificado por
  grep), diff limpio de los 6 commits de ronda 6 (30 archivos, ninguno
  huérfano). Único rastro: comentarios cosméticos (R6-06).
- **REQ-051, 409 exhaustivo**: las **78** combinaciones inválidas
  (fromStatus,toStatus) sobre los 11 estados devuelven 409 con
  `allowedNextStates` exacto, y el contrato nunca cambia de estado
  parcialmente — verificado en vivo, exhaustivamente, no por muestreo.
- **REQ-051, historial inmutable**: `UPDATE`/`DELETE` directos contra
  `contract_status_history` son rechazados (rowCount 0, RLS sin política
  de escritura) tanto para un actor normal (owner) como para un actor con
  membresía en `platform_admins` (superadmin) — verificado en vivo para
  ambos roles. Consistente con que `app_role` se crea `NOBYPASSRLS` y la
  tabla no tiene ninguna política de UPDATE/DELETE (ni siquiera
  condicionada a `is_superadmin()`).
- **REQ-051, step-up**: verificado en vivo para `rescindido`/
  `penalizado`/`modificado`: sin step-up → 403 sin cambio de estado;
  step-up de propósito incorrecto → 403; step-up de propósito
  `expediente.contract_transition` → 200. Una transición normal
  (sin riesgo) no exige step-up (sin falso positivo). `en_inconformidad`
  no se pudo re-confirmar en vivo por un bug del script de prueba (no de
  la app, ver log), pero comparte el mismo código/lista que los tres casos
  sí confirmados.
- **REQ-051, aislamiento cross-org**: confirmado por
  `packages/db/test/rls-ronda6-post-award.test.ts` (re-ejecutado, pasa) —
  `contracts`, `contract_status_history`, `contract_documents`,
  `contract_extracted_fields`, `inconformidad_drafts`, `fallo_autopsies`,
  `company_lessons_learned`, `renewal_alerts` aisladas por organización,
  incluyendo un actor sin membresía alguna.
- **REQ-052, "sugerido" hasta confirmación explícita**: confirmado por
  `expediente-contract-extraction.test.ts` (todo campo entra `sugerido`;
  `confirm`/`correct` son la única vía a `confirmado`/`corregido`) y por
  revisión de código de la ruta de confirmación (exige `WRITE_ROLES`,
  igual que la de subida, ya probada con viewer → 403).
- **REQ-052, saneamiento de HTML/script**: `sanitizePlainText` se aplica
  incondicionalmente antes de marcar cualquier texto como `extracted`, en
  el mismo motor (`extractDocumentText`) reutilizado sin cambios por
  `contract.routes.ts` — mismo código ya probado con casos de HTML íntegro
  en `AE-04`.
- **REQ-053, citas legales**: Art. 49 y Art. 95 de la LAASSP nueva, ambos
  con jurisdicción "Federal" y fecha DOF `2025-04-16`, coinciden
  textualmente con `docs/legal/verificacion-legal.md` (filas REQ-103/
  REQ-104) — verificado cita por cita.
- **REQ-053, plazo 6/10 días hábiles sin feriados**: verificado (código +
  tests existentes) con fechas concretas: 2026-01-05 (lunes) + 6 días
  hábiles = 2026-01-13; + 10 días hábiles = 2026-01-19, ambas excluyendo
  correctamente sábado/domingo.
- **REQ-053, disclaimer**: presente ("BORRADOR" + "revisión de abogado")
  en la respuesta de creación; escrito de forma incondicional en cada
  `INSERT`, por lo que aplica a toda versión.
- **REQ-053, inmutabilidad del contenido**: confirmado por test existente
  (intento de `UPDATE` sobre `hechos` rechazado por el trigger) y por
  revisión del trigger (`app.protect_inconformidad_draft_content`, sin
  distinción de actor — aplica igual a cualquier rol incluido
  superadmin, por construcción). El cambio de `status`/`reviewed_by`/
  `reviewed_at` (vía `mark-reviewed`) SÍ está permitido, como debe ser.
- **REQ-053, guardrail anti-frivolidad**: nunca bloquea la generación
  (siempre 201); clasifica `baja` (0 pruebas) y `alta` (pruebas ≥
  agravios) confirmado en vivo; el caso vacuo "0 agravios ⇒ alta" está
  bloqueado de raíz por el schema (`agravios.min(1)`).
- **REQ-053/052/054/055, sin envío externo**: `grep` sin resultados para
  clientes HTTP salientes en los 5 módulos de ronda 6; adicionalmente
  ningún handler de `apps/worker` consume los jobs `contract_state_alert`/
  `renewal_radar_alert` (quedan inertes, consistente con la limitación
  documentada de "canal futuro fuera de alcance").
- **REQ-054, "no disponible" nunca inventado**: `disqualificationReason`/
  `winnerName` usan la constante literal `NO_DISPONIBLE` cuando el dato no
  se capturó (revisión de código; columnas `NOT NULL` sin default oculto
  fuerzan a la aplicación a decidir el valor).
- **REQ-054, lecciones org-wide + aislamiento cross-org**: `GET
  /lessons-learned` filtra solo por `org_id` (no por convocatoria) y está
  aislado por organización — confirmado por RLS test.
- **REQ-055, dedupe bajo carga**: confirmado en vivo a escala de 5,000
  contratos / 15,000 alertas — un segundo escaneo no crea ninguna alerta
  nueva (`alertsCreated: 0`), el índice único parcial + pre-chequeo
  funcionan correctamente incluso a este volumen.
- **REQ-055, aislamiento cross-org de alertas**: confirmado por RLS test.
- **Trazabilidad**: salvo R6-01 (la mischaracterización de iCloud), todas
  las demás limitaciones declaradas en `apps/api/docs/e11-cobertura.md`
  (nombres de estado distintos al REQ-051 original, taxonomía cerrada de
  REQ-054 no construida, `historical_pattern` de REQ-055 no implementado,
  REQ-056 parcial) se verificaron como declaraciones honestas y precisas,
  no como pendientes disfrazados de completos.

---

## Nota de honestidad sobre esta ronda de auditoría

Esta sesión fue interrumpida varias veces por un 429 masivo de la
plataforma que también cortó a los dos subagentes lanzados para paralelizar
el trabajo. Se reanudó sin relanzarlos, reutilizando 3 de sus scripts de
prueba temporales que habían quedado completos (ejecutados y verificados
por este agente antes de descartarlos: exhaustividad de 409, inmutabilidad
con superadmin, step-up) y completando de cero el resto (rendimiento del
radar). Como consecuencia, algunos puntos del checklist original de esta
auditoría (concurrencia real con `Promise.all`, calendario de feriados
cargado end-to-end para inconformidad, inyección/magic-bytes específicos en
la ruta de contrato, caso "viabilidad media") quedaron verificados **solo
por revisión de código**, no por ejecución en vivo — se declaran así
explícitamente arriba (R6-04, R6-07, R6-08) en vez de presentarlos como
confirmados.
