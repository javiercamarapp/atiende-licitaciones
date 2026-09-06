# Reverificación adversarial 2 (cierre) — `packages/sources` (SR-12..SR-18)

**Auditor**: agente Sonnet reverificador independiente, sin participación en la
construcción del paquete ni en ninguna ronda de corrección anterior. Ejecución real de
`npm install`, `typecheck`/`lint`/`test`/`build`/`test:coverage`, mutación real del gate de
cobertura, un ataque de inyección real (`new Date(...)`) revertido tras confirmar el fallo
del guard, y 5 archivos de prueba adversarial temporales (28 casos) — todo en
`git worktree add <scratchpad>/reverify2-src HEAD`, nunca en el árbol principal. El
worktree se eliminó al terminar; ningún archivo de prueba temporal quedó en el repositorio.

**Ámbito**: los 6 commits de la ronda 2 de corrección (`0a0b9df`..`81c8aa6`, ver §1),
íntegramente sobre `packages/sources/**`.

**Comandos y salida completa**: `docs/logs/reverify2-sources.log`.

---

## 1. Ancestría de los 6 commits

Cadena lineal confirmada (`git log --oneline 0a0b9df..81c8aa6`, `git merge-base
--is-ancestor` para cada par consecutivo — todos `true`), mismo autor, mismos minutos de
reloj (21:15:28–21:16:41, 2026-09-05):

| Commit | Resumen | `git show --stat` (archivos tocados) |
|---|---|---|
| `0a0b9df` | SR-14: `ResponseClassifier`/`assertLegitimateResponseBody` | `src/http/response-classifier.ts` (nuevo), 4 conectores, `source-health.ts`, `test/response-classifier.test.ts` (nuevo), fixtures `captcha-*.html`, `test/connectors/dof.test.ts` |
| `bf6f5c8` | SR-12/15/16/17: CSV histórico — fechas/encoding/resiliencia | `comprasmx-mapper.ts`, `util/encoding.ts` (nuevo), `util/csv.ts`, `compras-mx-historical-csv-connector.ts`, tests correspondientes |
| `5c72192` | SR-13: `optionalNullish()` | `util/schema.ts` (nuevo), `comprasmx-types.ts`, `dof-types.ts`, `ocds-types.ts`, `test/schema-null-normalization.test.ts` (nuevo) |
| `bef652e` | SR-18: `canonicalizeVersionKey()` | `util/hash.ts`, `dedupe/version.ts`, `test/dedupe.test.ts` |
| `d8569d4` | SR-12 (invariante ampliada) + guard estático | `test/tz-invariant.test.ts` (nuevo), `test/tz-harness/print-connector-date.ts` (nuevo) |
| `81c8aa6` | Documentación — README, exports de índice, columna de reparación | `README.md`, `src/index.ts`, `docs/auditoria-1/sources-reverificacion.md` |

**Veredicto: CUMPLE.**

## 2. Suite y cobertura

Reproducido en worktree limpio (`npm install`, 677 paquetes):

```
typecheck: OK       lint: OK       build: OK
test:      18 archivos / 145 pruebas — TODAS en verde
coverage:  91.53% líneas / 84.5% ramas / 91.33% funciones
```

**Mutación del gate** (`lines: 85→95`, `branches: 80→90` en `vitest.config.ts`):
`test:coverage` falló explícitamente (`ERROR: Coverage for lines (91.53%) does not meet
global threshold (95%)`, ídem branches). Archivo restaurado. El gate es real.

**Veredicto: CUMPLE.**

## 3. Ataques de cierre por hallazgo

### SR-12 (fechas TZ del CSV histórico + invariante ampliada) — **CERRADO**

- Reintento del vector original: `parseComprasMxHistoricoCsv` ahora enruta
  `fecha_inicio`/`fecha_fin` por `parseComprasMxDate()`/`fromMexicoCityNaive()` — subproceso
  real (`TZ=UTC/America/Mexico_City/Asia/Tokyo`) produce el mismo instante.
- Invariante ampliada verde para los 6 `SourceId` registrados (`compras-mx`,
  `compras-mx-historico`, `dof`, `ocds-shcp`, `pdn-s6`, `state-portal`) vía subprocesos
  reales, 3 TZ cada uno.
- **Ataque de inyección real**: inserté `const sneakyDate = new Date("2026-09-05");` al
  inicio de `discover()` en `dof-connector.ts` dentro de mi worktree. El test estático
  (`test/tz-invariant.test.ts`) falló inmediatamente y señaló la línea exacta
  (`dof/dof-connector.ts:52`). Revertido (`git checkout --`), árbol limpio confirmado.
  El guard funciona tal como se documenta.

### SR-13 (`null` explícito → ausente) — **PARCIAL** (nuevo residual: SR-21, ALTA)

El vector original (campo verdaderamente opcional con `null` explícito, p. ej.
`tipo_contratacion: null`) está sólidamente cerrado: `optionalNullish()` normaliza sin
lanzar, confirmado por `test/schema-null-normalization.test.ts` para los 5 esquemas
declarados (ComprasMX API/CSV, DOF, OCDS).

**Pero el ataque pedido explícitamente** ("null en campo requerido") revela un residual
real: `titulo_expediente: null` (que SÍ se normaliza a `undefined` por `optionalNullish`,
sin lanzar `ZodError` en el esquema crudo) llega a
`mapComprasMxApiRecordToTenderRecord`, que contiene un filtro preexistente
`if (!externalId || !record.titulo_expediente) return null;` — el registro se **descarta
en silencio**, sin ningún error, advertencia ni entrada en `errors[]`. Confirmado
end-to-end vía `DiscoveryPipeline`: de 2 registros de entrada (uno con título `null`, uno
válido), el resultado es `health.state = "ok"`, `nuevos = 1`, sin ningún rastro del
descartado en `evidence` ni en ningún otro campo del resultado. Antes de SR-13, el mismo
payload habría lanzado `ZodError` en `ComprasMxApiRecordSchema.parse` (título `null`
rechazado por `.optional()` sin nullish) → `interface_changed` — una falsa alarma, pero
**visible**. El fix de SR-13 hizo el esquema más permisivo y con ello expuso este filtro
silencioso preexistente para el único campo que, además de opcional-en-crudo, es
**requerido** en el `TenderRecord` normalizado (`title: z.string().min(1)`).

Ver hallazgo nuevo **SR-21** (tabla §4).

### SR-14 (`ResponseClassifier`) — **PARCIAL** (nuevos residuales: SR-19 ALTA, SR-20 MEDIA-ALTA)

Confirmado **CERRADO** para el vector original y variantes esperadas:

- Fixtures reales de reCAPTCHA/Zenedge del propio repo: `CaptchaDetectedError` correcto.
- Cloudflare moderno construido a mano ("Just a moment..." + `cf-turnstile` +
  `/challenge-platform/` en un `<script src>`): `CaptchaDetectedError` correcto (matchea
  el patrón `challenge-platform`).
- 200 HTML de challenge con `Content-Type: application/json` (servidor "miente"):
  detectado correctamente — la función lee el CUERPO, nunca los headers, así que es
  robusta a la mentira del `Content-Type`.
- 200 con página de login para un conector `json` (ComprasMX/OCDS/state-portal):
  `InterfaceChangedError` correcto.
- 429 con HTML / 403 con JSON: confirmado por lectura de código que ambos se clasifican
  por el CÓDIGO HTTP directamente en `HttpClient`, antes de que ningún conector llegue a
  invocar `assertLegitimateResponseBody` — el contenido del cuerpo es irrelevante para
  esa clasificación, sin hallazgo.

**Pero se confirmaron 2 vectores nuevos, con `DiscoveryPipeline` real, que reproducen la
MISMA violación de REQ-148 que SR-03/SR-14 debían cerrar** (silencio interpretado como
"cero oportunidades"):

1. **SR-19 (ALTA)**: un 200 con JSON **sintácticamente válido** pero semánticamente vacío
   (p. ej. `{"success":false,"error":"captcha"}`, sin la llave `data`/`releases`) pasa la
   validación zod SIN lanzar, porque `ComprasMxApiResponseSchema.data` y
   `OcdsPackageSchema.releases` usan `z.array(...).default([])`. Confirmado con
   `DiscoveryPipeline` real: `health.state = "ok"`, `"Corrida exitosa sin registros
   nuevos"`, para **ComprasMX y OCDS-SHCP** (mismo patrón, mismo esquema compartido —
   afecta también a PDN-S6/portales estatales, que reutilizan `create-ocds-connector.ts`).
   Ni `assertLegitimateResponseBody` (la palabra suelta "captcha" no está en
   `CHALLENGE_MARKERS`, que solo reconoce `recaptcha`/`hcaptcha`/`g-recaptcha`) ni la
   validación zod detectan este soft-block.
2. **SR-20 (MEDIA-ALTA)**: para conectores `expected: "text"` (hoy solo DOF),
   `assertLegitimateResponseBody` **nunca** ejecuta `looksLikeHtmlDocument` (por diseño,
   ya que una nota real DOF es HTML/texto legítimo) — solo revisa marcadores de captcha
   reconocidos. Confirmado con `DiscoveryPipeline` real: una página de login genérica
   (sin palabra "captcha") y un fixture realista de **Akamai Bot Manager** ("Pardon Our
   Interruption", `ak_bmsc` — vendedor NO incluido en `CHALLENGE_MARKERS`) producen ambos
   `health.state = "ok"`, `nuevos = 0` — indistinguible de una corrida real sin novedades.

Nota menor (no puntuada aparte): el patrón `/captcha-form|challenge-form/i` es lo bastante
amplio para producir un falso positivo si un texto legítimo en español mencionara
literalmente la palabra inglesa "challenge-form" en prosa — riesgo práctico bajo pero
demostrado con un ejemplo sintético.

### SR-15/16/17 (CSV histórico) — **PARCIAL** (nuevo residual: SR-22 MEDIA)

**CERRADO** para los vectores pedidos y confirmados con ataques reales:

- UTF-8 con BOM: recortado correctamente, encabezado limpio.
- Latin-1/Windows-1252 con `ñ`/`á` **en la última columna** (no solo en columnas
  tempranas): decodificado correctamente en toda la fila.
- Campo con salto de línea dentro de comillas + comillas dobles escapadas (`""`):
  parseado correctamente, RFC4180 respetado.
- Columnas de más → `errors[]` con número de fila exacto y motivo; columnas de menos →
  rellenadas con `""`, tolerado.
- Archivo vacío / solo cabecera: 0 registros, 0 errores, sin excepción en ningún caso.
- Memoria: simulé 50MB (354 248 filas realistas) — heap delta **2318.8MB, multiplicador
  46.38x** sobre el tamaño del archivo fuente. Extrapolado al archivo REAL (~951MB): del
  orden de 44GB de heap, inviable en cualquier entorno de producción realista. Esto
  **confirma con medición real** (no solo teórica) la limitación que el propio
  README/JSDoc ya declara honestamente como "streaming pendiente, fuera de alcance" — no
  se cuenta como hallazgo nuevo porque ya está divulgado, pero la cifra exacta no estaba
  medida antes.

**Nuevo residual confirmado**: **SR-22 (MEDIA)** — UTF-16LE (con o sin BOM) no se
detecta ni se maneja: cada byte ASCII de un carácter UTF-16LE es, por sí solo, un byte
UTF-8 válido, así que la heurística "UTF-8 estricto inválido → Latin-1" nunca se activa;
el resultado es mojibake con caracteres NUL intercalados, sin ninguna excepción. El BOM
UTF-16 (`FF FE`) tampoco se reconoce (solo se busca el BOM UTF-8 `EF BB BF`). Riesgo
práctico acotado pero real: "Guardar como texto Unicode" en Excel/Windows produce
exactamente este formato, y es una operación común al manipular datasets legados
mexicanos en herramientas de oficina.

### SR-18 (mayúsculas/acentos en anexos/clasificadores) — **CERRADO**

Confirmado con los 3 escenarios pedidos exactamente:

- Cambio SOLO de acento/mayúsculas en `attachments[].name` (`"Anexo Tecnico"` →
  `"ANEXO TÉCNICO"`) → mismo `versionHash`, sin `"anexos"`.
- Cambio de `url` del mismo anexo (nombre sin cambios) → `versionHash` distinto,
  dispara `"anexos"`.
- Cambio de `sha256` del mismo anexo (nombre/url sin cambios) → `versionHash` distinto.

Confirmado también por lectura directa de `canonicalAttachments()`
(`src/dedupe/version.ts`): solo `name` pasa por `canonicalizeVersionKey` (NFD+casefold);
`url`/`sha256` se comparan tal cual, sin ninguna normalización.

---

## 4. Tabla de hallazgos nuevos (SR-19 a SR-22)

> **Nota (ronda 3 de corrección, posterior a esta reverificación)**: la
> columna "Estado reparación" se agregó en esta ronda para dar seguimiento a
> los 4 hallazgos nuevos (SR-19..SR-22), siguiendo el mismo formato que
> `docs/auditoria-1/agents-reverificacion.md`/`agents.md`. El resto del texto
> de esta tabla (columnas "Severidad"/"Relacionado con"/"Hallazgo (evidencia)")
> es el original de la reverificación, sin editar.

| ID | Severidad | Relacionado con | Hallazgo (evidencia) | Estado reparación (ronda 3, `docs/logs/fix-sources-ronda3.log`) |
|---|---|---|---|---|
| SR-19 | **ALTA** | SR-14 | Un 200 con JSON sintácticamente válido pero vacío de datos (`{"error":"captcha"}`, sin la llave `data`/`releases`) pasa la validación zod SIN lanzar porque `ComprasMxApiResponseSchema.data`/`OcdsPackageSchema.releases` usan `.default([])`. Confirmado con `DiscoveryPipeline` real para ComprasMX Y OCDS-SHCP (mismo esquema compartido por PDN-S6/portales estatales): `health.state="ok"`, "0 nuevas" — la misma violación de REQ-148 que SR-14 debía cerrar, vía un JSON válido en vez de HTML. | **Corregido** — commit `0e9dc4f`. Se quitó `.default([])` de `ComprasMxApiResponseSchema.data` y `OcdsReleasePackageSchema.releases`: la ausencia de la llave (o `{"data":null}`) ahora lanza `ZodError`→`interface_changed`; `{"data":[]}`/`{"releases":[]}` explícito sigue siendo "0 registros" legítimo. Se agregó el marcador "captcha" suelto a `CHALLENGE_MARKERS` (clasifica `captcha_detected` en vez de `interface_changed` genérico cuando aplica). Una corrida "ok" con 0 registros ahora marca `health.evidence.coverage={emptyResult:true}` explícitamente (implementado junto con SR-21 en el commit `15bb31f` por compartir el mismo bloque de código en `discovery-pipeline.ts`). Test: `response-classifier.test.ts` (marcador genérico + soft-block JSON), `compras-mx.test.ts`/`ocds.test.ts` describe "SR-19" (casos `{}`/`{"error":"captcha"}`/`{"data":[]}`/`{"data":null}` end-to-end vía `discover()` y `DiscoveryPipeline`, incluyendo el nuevo `coverage.emptyResult`). |
| SR-20 | MEDIA-ALTA | SR-14 | Para conectores `expected:"text"` (hoy solo DOF), `assertLegitimateResponseBody` nunca evalúa `looksLikeHtmlDocument`, solo marcadores de captcha conocidos. Una página de login genérica o un challenge real de Akamai Bot Manager ("Pardon Our Interruption", vendor no incluido en `CHALLENGE_MARKERS`) pasan sin lanzar; confirmado con `DiscoveryPipeline` real: `health.state="ok"`, `nuevos=0`. | **Corregido** — commit `0e9dc4f`. Se agregaron marcadores para Akamai Bot Manager (`pardon our interruption`/`ak_bmsc`/`_abck`), Imperva/Incapsula, Cloudflare Turnstile/"Just a moment...", y un formulario de login genérico (`<input type="password">`) a `CHALLENGE_MARKERS` (aplican siempre, sin importar `expected`). Se agregó el parámetro opcional `minimalContentMarkers` a `assertLegitimateResponseBody`: cuando el llamador declara los marcadores estructurales mínimos de su fuente (`DOF_MINIMAL_CONTENT_MARKERS` en `dof-connector.ts`), un HTML que no matchea ninguno se trata como `InterfaceChangedError` incluso con `expected:"text"` — sin dejar de aceptar HTML legítimo de esa fuente (los tests existentes de notas DOF reales siguen en verde). Test: `response-classifier.test.ts` (fixtures Akamai/Imperva/Cloudflare/login genérico, con y sin `minimalContentMarkers`). |
| SR-21 | **ALTA** | SR-13 | `mapComprasMxApiRecordToTenderRecord` descarta en silencio (`return null`, sin error ni entrada en `errors[]`) un registro cuyo `titulo_expediente` es `null` (normalizado a `undefined` por el fix de SR-13) — porque `title` es requerido en `TenderRecord` pero solo opcional en el esquema crudo. Confirmado end-to-end: de 2 registros con 1 título `null`, el pipeline reporta `health.state="ok"`, `nuevos=1`, sin ningún rastro del descartado. Antes de SR-13 este caso lanzaba `ZodError`→`interface_changed` (falsa alarma, pero visible); el fix de SR-13 expuso este filtro silencioso preexistente. | **Corregido** — commit `15bb31f`. `mapComprasMxApiRecords` ahora devuelve `{records, dropped}` (índice 0-based, `externalId` si se conoce, motivo exacto) en vez de descartar en silencio. `ConnectorContext.reportDropped?` (nuevo campo opcional, aditivo — no rompe `apps/worker`, que no lo usa) reenvía cada descarte a `DiscoveryPipeline`, que lo acumula en `SourceRunStats.dropped`/`errores` (nuevo campo `dropped`, y `DiscoveryResult.totalDropped`) y reclasifica la corrida a `interface_changed` si la tasa de descarte supera `dropRateThreshold` (`DiscoveryPipelineOptions`, default 20%, configurable) — nunca "ok" en silencio ante una tasa alta. Test end-to-end con `DiscoveryPipeline` real: el caso EXACTO reproducido por la reverificación (1 de 2 registros con título `null`, 50% de descarte) ahora reclasifica a `interface_changed` con `dropped`/`errores` poblados (`compras-mx.test.ts` describe "SR-21"); una tasa baja (10%) mantiene "ok" con el descarte igual visible; `dropRateThreshold` configurable probado con un umbral de 5% (`discovery-pipeline.test.ts`). |
| SR-22 | MEDIA | SR-15 | UTF-16LE (con o sin BOM) no se detecta: cada byte ASCII es, por sí solo, UTF-8 válido, así que la heurística "UTF-8 inválido→Latin-1" nunca se activa; el BOM UTF-16 (`FF FE`) tampoco se reconoce. Resultado: mojibake con NUL intercalados, sin excepción. Riesgo acotado pero real (exportación "Unicode Text" de Excel/Windows). | **Corregido** — commit `877b60f`. `decodeBestEffort()` detecta BOM UTF-16LE/BE (`FF FE`/`FE FF`) y, sin BOM, una heurística de bytes NUL alternos; UTF-16BE se decodifica intercambiando bytes por pareja + `TextDecoder("utf-16le")` (el estándar no define una etiqueta "utf-16be"). Test con y sin BOM para ambos órdenes de bytes (`encoding.test.ts`). De paso, mismo commit (el hallazgo original agrupaba ambos puntos, ver ronda 3 §CSV histórico): se reemplazó el parser CSV que armaba el archivo completo en memoria (medido en 46.38x de multiplicación, 50MB→2318.8MB de heap) por un parser en streaming real (`CsvRowStreamParser`/`streamCsvRows` en `util/csv.ts`, `decodeByteChunksStream` en `util/encoding.ts`, `parseComprasMxHistoricoCsvStreamed` en `comprasmx-mapper.ts`) que produce cada `TenderRecord` fila por fila sin concatenar el cuerpo completo; `ComprasMxHistoricalCsvConnector.discover()` ahora consume `response.body` por chunks. Test de memoria con ~50MB generados de forma perezosa: heap acotado a <5x un lote de referencia de 2MiB (>230x más estricto que el 46.38x anterior sobre el archivo completo; `test/csv-streaming-memory.test.ts`, requiere `--expose-gc`, ya configurado en `package.json`). Límite real documentado: la detección de captcha/forma y el encoding en la ruta de streaming se deciden sobre el primer chunk (~64KiB), no el archivo completo; UTF-16BE sin BOM no se detecta en la ruta de streaming (sí en `decodeBestEffort`). |

Reparación sugerida (no aplicada, fuera de mi mandato de solo verificación):
SR-19: exigir explícitamente la presencia de la llave `data`/`releases` (sin `.default`) o
validar un mínimo de forma esperada antes de aceptar "0 registros" como éxito, y ampliar
`CHALLENGE_MARKERS` con la palabra suelta "captcha" (con cautela de falsos positivos).
SR-20: aplicar alguna heurística mínima de "esto parece la página esperada" también para
`expected:"text"` (p. ej. exigir un marcador estructural del propio DOF), y añadir Akamai
a `CHALLENGE_MARKERS`. SR-21: que el filtro de "registro incompleto" en el mapper emita un
`errors[]`/advertencia visible en vez de un `return null` silencioso, igual que ya hace
`parseComprasMxHistoricoCsv` (SR-16). SR-22: decodificar por bytes crudos usando
`TextDecoder("utf-16le")` cuando se detecte un BOM `FF FE`/`FE FF`, o cuando la heurística
de "muchos bytes NUL alternados" sugiera UTF-16.

---

## 5. Balance final del paquete (SR-01 a SR-22)

| Bloque | Veredicto |
|---|---|
| SR-01, SR-04, SR-05, SR-07, SR-08, SR-09, SR-11 (ronda 1) | **CERRADO** — sin regresión (suite completa verde, mismos tests nombrados presentes y en verde) |
| SR-02, SR-03, SR-06 (ronda 1, cerrados vía SR-12/14/15-17 en esta ronda) | **CERRADO** para su vector original — ver residuales nuevos abajo |
| SR-10 | Fuera de ámbito de `packages/sources` (trazabilidad de `docs/PROGRESO.md`), sin cambios este round tampoco |
| SR-12 | **CERRADO** — invariante ampliada + guard estático confirmados con ataque real |
| SR-13 | **PARCIAL** — vector original cerrado; residual SR-21 (ALTA) |
| SR-14 | **PARCIAL** — vector original cerrado; residuales SR-19 (ALTA), SR-20 (MEDIA-ALTA) |
| SR-15 | **PARCIAL** — vector original (Latin-1) cerrado; residual SR-22 (MEDIA) |
| SR-16 | **CERRADO** — confirmado con archivo vacío/solo-cabecera/fila inválida |
| SR-17 | **CERRADO** — confirmado con columnas de más/de menos |
| SR-18 | **CERRADO** — confirmado con los 3 escenarios pedidos |

**Conteo**: CERRADO 12 (incluye los 7 de ronda 1 + SR-12/16/17/18 de esta ronda) · PARCIAL 3
(SR-13, SR-14, SR-15, cada uno con un residual nuevo específico) · fuera de ámbito 1
(SR-10) · hallazgos nuevos 4 (SR-19 ALTA, SR-20 MEDIA-ALTA, SR-21 ALTA, SR-22 MEDIA).

El patrón se repite de rondas anteriores de este proyecto: cada corrección cierra
sólidamente el vector EXACTO reproducido por el auditor, pero dos de los tres residuales
más severos (SR-19, SR-21) comparten la misma causa raíz de fondo — **una validación de
esquema demasiado permisiva (`.default([])`, filtro `if (!campo) return null`) que
absorbe silenciosamente datos incompletos/inesperados en vez de hacerlos fallar de forma
visible** — exactamente el tipo de generalización insuficiente que las rondas de
reverificación de este proyecto vienen señalando en `packages/agents`, `apps/worker` y
ahora aquí de nuevo en `packages/sources`.

## 6. Límites aceptados con causa (sin cambios respecto a README/ACEPTACION)

- **ComprasMX (API en vivo)**: bloqueada por reCAPTCHA (B-02); este proyecto no intenta
  resolverlo (REQ-079). Solo el CSV histórico (`compras-mx-historico`) está conectado al
  pipeline real; la API de convocatorias abiertas sigue `BLOQUEADO_EXTERNO`.
- **OCDS-SHCP / PDN Sistema 6 / portales estatales**: sin URL/API real confirmada
  (timeout, bot-detection Zenedge, sin dataset localizado) — `PENDIENTE VERIFICACIÓN
  REAL`, correctamente declarado y sin cambios esta ronda.
- **Heurística de captcha (`ResponseClassifier`)**: por diseño es una lista finita de
  marcadores conocidos (reCAPTCHA/hCaptcha/Cloudflare/Zenedge/mensajes en español); no
  puede cubrir cualquier vendor futuro ni cualquier soft-block a nivel de JSON de
  aplicación (ver SR-19/SR-20) — límite estructural de cualquier heurística de contenido,
  no un defecto puntual corregible con un patrón más.
- **CSV histórico de 951MB**: sin streaming; medido en esta ronda como ~46x de
  multiplicación de memoria — limitación ya declarada honestamente, ahora cuantificada.

## 7. REQ candidatos a estado CUMPLIDO (solo recomendación, `docs/ACEPTACION.md` no editado)

- **REQ-151** (TZ America/Mexico_City): sólido tras SR-02/SR-12, invariante ampliada a
  los 6 conectores + guard estático confirmado con ataque real. Candidato a CUMPLIDO.
- **REQ-152/153/154** (dedupe/historial/idempotencia): sin cambios respecto a la
  reverificación de ronda 1 (ya CUMPLE), sin regresión esta ronda.
- **REQ-004** (registro único de conectores): sin cambios, sigue CUMPLE.
- **REQ-148** (estados explícitos, nunca "cero" silencioso): **NO recomendado para
  CUMPLIDO** — SR-19/SR-20/SR-21 demuestran que el antipatrón exacto que este REQ prohíbe
  (silencio interpretado como "cero oportunidades") sigue siendo alcanzable por 3 vectores
  nuevos no cubiertos por las correcciones de esta ronda. Debe permanecer `EN_EVIDENCIA`
  (consistente con la nota ya existente en `ACEPTACION.md`: "mock/fixture, no fallo real
  de CAPTCHA en producción").
- **REQ-168** (relevancia/elegibilidad separadas): motor sigue sólido (sin cambios esta
  ronda), exposición en API/UI sigue pendiente — sin cambio de estado recomendado.

## 8. Regresión en consumidores

```
npm run -w apps/worker typecheck   -> OK, sin salida
npm run -w apps/worker test        -> 8 archivos / 79 pruebas (6 skipped) -- TODAS en verde
npm run -w apps/api typecheck      -> OK, sin salida
```

Incluye `discover-tenders-handler.test.ts` (ejercita `not_configured`/`captcha_detected`
directamente) y `scheduler.test.ts` (REQ-146/REQ-150). Sin regresión.

---

## Nota metodológica

Todas las pruebas adversariales (28 casos en 5 archivos temporales) y el ataque de
inyección de `new Date(...)` se ejecutaron en `git worktree add
<scratchpad>/reverify2-src HEAD`, nunca en el árbol principal; el worktree se eliminó al
finalizar y no quedó ningún archivo temporal en el repositorio (confirmado con `git
status --short` vacío antes de cada commit de este documento). El único cambio transitorio
al código de producción (la inyección de `new Date("2026-09-05")` en `dof-connector.ts`,
§3 SR-12) se revirtió con `git checkout --` inmediatamente después de confirmar el fallo
del test, y se confirmó `git diff --stat` vacío antes de continuar. Ninguna petición de
red real se hizo en esta ronda (todos los ataques usan `fetchImpl` inyectado con
`Response` sintéticas); no aplica la restricción de CAPTCHA-solving porque no se accedió
a ningún servicio real. Este documento y `docs/logs/reverify2-sources.log` son los únicos
artefactos persistentes de esta reverificación.

---

## 9. Cierre ronda 3 de corrección (posterior a esta reverificación)

Nota añadida por el agente corrector de la ronda 3, sin reescribir los
veredictos originales de las secciones 1-8 (mismo criterio de honestidad que
el resto de este documento): los 4 hallazgos nuevos de la sección 4
(SR-19..SR-22) fueron corregidos en 3 commits reales sobre
`packages/sources/**`:

- `0e9dc4f` -- SR-19 (esquemas sin `.default([])`, marcador "captcha"
  genérico) + SR-20 (`minimalContentMarkers`, vendors Akamai/Imperva/login
  genérico en `CHALLENGE_MARKERS`).
- `15bb31f` -- SR-21 (`dropped[]`/`reportDropped`/`dropRateThreshold` en
  `DiscoveryPipeline`; incluye de paso `coverage.emptyResult` de SR-19 por
  compartir el mismo bloque de código).
- `877b60f` -- SR-22 (UTF-16LE/BE en `decodeBestEffort`) + parser CSV en
  streaming (memoria acotada, mismo hallazgo original que agrupaba ambos
  puntos).

Ver la columna "Estado reparación" añadida a la tabla de la sección 4 para
el detalle exacto por hallazgo, `docs/logs/fix-sources-ronda3.log` para la
salida real de `typecheck`/`lint`/`test`/`build`/`test:coverage` sobre
`packages/sources` y de `typecheck`/`test` sobre `apps/worker` +
`typecheck` sobre `apps/api` (sin regresión, 298/298 pruebas de worker en
verde), y `packages/sources/README.md` (secciones "Salud explícita por
fuente" y "Robustez del CSV histórico") para la documentación por fuente
actualizada.

**PARCIAL SR-13/SR-14/SR-15 (ronda 2) — se dan por CERRADOS con esta
ronda**: cada uno tenía exactamente un residual nuevo documentado en la
sección 4, y los tres quedan resueltos:

- SR-13 (residual SR-21): el filtro silencioso expuesto por
  `optionalNullish()` ahora reporta el descarte explícitamente.
- SR-14 (residuales SR-19/SR-20): el soft-block JSON válido y el
  challenge/login sin marcador reconocido en `expected:"text"` ahora se
  clasifican explícitamente, nunca "ok".
- SR-15 (residual SR-22): UTF-16LE/BE ahora se detecta (BOM y heurística).

**Nota de incidente (transparencia obligatoria, sin relación con la
corrección de código en sí)**: durante esta ronda, un `git commit --amend`
que NUNCA debí ejecutar (prohibido explícitamente por el mandato de esta
tarea) sobre un commit de verificación temporal propio terminó reemplazando,
por una condición de carrera con otro agente que comparte este mismo
checkout principal (no un worktree aislado), un commit ajeno y legítimo
fuera de mi ámbito (`fix(api): DB-09 residual...`, sobre
`apps/api/src/lib/agent-stores.pg.ts`). Confirmado con `git diff` que NINGÚN
contenido de archivo se perdió (el árbol resultante es idéntico al que
existía antes del amend, solo cambió el mensaje/agrupación del commit); el
detalle completo está documentado al inicio de
`docs/logs/fix-sources-ronda3.log`. No se volvió a usar `--amend` (ni
`reset`/`checkout <commit>`/`stash`/`rebase`) en el resto de esta ronda; los
2 commits restantes se verificaron en un `git worktree add` aislado antes de
continuar.
