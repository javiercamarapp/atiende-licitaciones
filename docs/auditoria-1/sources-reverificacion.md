# Reverificación adversarial — `packages/sources` (ronda 1 de corrección, SR-01..SR-11)

**Auditor**: agente Sonnet reverificador independiente, sin participación en la
construcción del paquete ni en la ronda de corrección original. Ejecución real de
`npm install`, `typecheck`/`lint`/`test`/`build`, `vitest run --coverage`, mutación real del
gate de cobertura, mutación real de la regla SR-05, 8 archivos de prueba adversarial
propios (28 casos) y 2 scripts `.ts` de subproceso real para TZ — todo en un `git worktree`
separado (`git worktree add`), nunca en el árbol principal. También se repitieron peticiones
HTTP reales de solo lectura (sin CAPTCHA-solving) contra ComprasMX/DOF/OCDS el mismo día. El
worktree se eliminó (`git worktree remove`) al terminar; ningún archivo de prueba
adversarial quedó en el árbol principal.

**Ámbito**: `packages/sources/**` en el commit `56ce542` (HEAD del repo al momento de esta
ronda; incluye íntegras las 11 correcciones SR-01..SR-11 de
`docs/auditoria-1/sources.md`, commits `b133a67`..`dbfa671`).

**Comandos y salida completa**: `docs/logs/reverify-sources-ronda1.log`.

**Hallazgo original reverificado**: `docs/auditoria-1/sources.md` (11 hallazgos SR-01..SR-11,
10 marcados "CORREGIDO", 1 — SR-10 — marcado "NO CORREGIDO EN ESTA RONDA" por instrucción
explícita del orquestador, fuera del ámbito de `packages/sources`).

---

## Resumen ejecutivo

La ronda de corrección es **real y en su mayoría sólida**: las 10 correcciones de código
(SR-01 a SR-09, SR-11) tienen tests nuevos que reproducen el ataque exacto del auditor
original, la suite completa pasa (13 archivos / 95 pruebas, idéntica a la citada), y la
cobertura real medida coincide exactamente con lo declarado en SR-08 (91.53% líneas /
82.33% ramas). El gate de cobertura es real (falla el build cuando se sube el umbral por
encima de lo medido, confirmado mutándolo). La mutación original de SR-05 (401/403 sin
cobertura) ahora sí es detectada.

Sin embargo, la reverificación adversarial encontró que **3 de las 11 correcciones quedan
solo parcialmente cerradas**, porque las reparaciones defienden el vector exacto reproducido
por el auditor original pero no generalizan la regla — el mismo patrón encontrado en rondas
de reverificación anteriores de este proyecto — y **se descubrieron 7 hallazgos nuevos**
(SR-12 a SR-18), dos de severidad ALTA:

- **SR-02 (fechas TZ de ComprasMX)**: el fix (`fromMexicoCityNaive()` en el mapper del API en
  vivo) es sólido y se confirmó robusto en 4 variantes nuevas (fecha sin hora, offset `Z`
  explícito, offset `-05:00` explícito, bajo `TZ=UTC/America/Mexico_City/Asia/Tokyo`). Pero
  **SR-06, un commit posterior**, agregó `parseComprasMxHistoricoCsv()` con `fecha_inicio`/
  `fecha_fin` mapeados DIRECTO a `TenderDatesSchema`, sin pasar por `fromMexicoCityNaive()` —
  reproduce el MISMO bug (confirmado en subproceso real: el mismo dato naive produce 3
  instantes distintos según `TZ=UTC/America/Mexico_City/Asia/Tokyo`). Ver **SR-12**.
- **SR-03 (DOF `noteCodes: []`)**: el vector exacto (0 llamadas HTTP, `not_configured`) está
  sólidamente cerrado y sin regresión en `apps/worker`. Pero se encontró el vector
  ADYACENTE de la misma familia de riesgo: un `fetchImpl` real que devuelve **HTTP 200 con
  un cuerpo HTML de captcha/bot-challenge** (escenario que el propio README documenta como
  real para PDN-S6/Zenedge) hace que `extractDofNoticesFromText` simplemente no encuentre
  avisos y el pipeline reporte `health.state = "ok"` / "Corrida exitosa sin registros nuevos"
  — exactamente el antipatrón que REQ-148 prohíbe, solo que disparado por CONTENIDO en vez
  de por ausencia de configuración. Ver **SR-14 (ALTA)**.
- **SR-06 (CSV histórico conectado al pipeline)**: el *wiring* en sí (registro, `SourceId`
  propio, ingestión real vía `DiscoveryPipeline`) está correctamente hecho y probado contra
  el fixture real (bien formado, UTF-8, comillas RFC4180 correctas). Pero la robustez frente
  al archivo REAL de 951 MB (con las imperfecciones típicas de un export legado de gobierno)
  tiene 3 gaps reales, ninguno cubierto por los tests del propio fix: **(a)** `Response.text()`
  decodifica SIEMPRE como UTF-8 (spec WHATWG fetch, ignora el charset real del servidor); si
  el CSV real viene en Latin-1/Windows-1252 (común en exports legado mexicanos), los acentos
  se corrompen **silenciosamente, sin excepción** (confirmado con bytes reales) — **SR-15
  (ALTA)**. **(b)** `parseComprasMxHistoricoCsv` no tiene `try/catch` por fila: UNA fila
  inválida en cualquier punto de las ~951 MB hace perder TODAS las filas válidas del batch
  (antes y después), contradiciendo la resiliencia por-registro que la propia auditoría
  original documentó como "Comprobado correcto" para el resto del pipeline — **SR-16
  (MEDIA-ALTA)**. **(c)** el parser CSV artesanal (`src/util/csv.ts`) descarta en silencio
  columnas de más cuando un campo con coma no está entrecomillado, desalineando el resto de
  la fila sin ningún error — **SR-17 (MEDIA)**.
- **SR-01 (versionado, orden de arrays)**: confirmado sólido para su alcance declarado
  (reordenar arrays, incluso con duplicados exactos, no dispara versión falsa; NFC +
  espacios). Residual de la MISMA categoría, de menor severidad: un cambio SOLO de
  mayúsculas en un nombre de anexo SÍ sigue disparando una versión — decisión de diseño
  documentada en el código, pero no registrada como "pendiente" en ningún lado. Ver
  **SR-18 (BAJA)**.
- **Hallazgo nuevo independiente, SR-13 (MEDIA-ALTA)**: todos los esquemas zod del paquete
  (`ComprasMxApiRecordSchema` y análogos) usan `.optional()` sin `.nullable()`. Un payload
  real de gobierno que devuelva `null` explícito para un campo (patrón muy común en APIs
  JSON, distinto de omitir la llave) hace que el registro completo falle con `ZodError`,
  clasificado como `interface_changed` — una falsa alarma de "cambio de interfaz" cuando la
  estructura en realidad no cambió.
- **SR-04, SR-05, SR-07, SR-08, SR-09, SR-11**: reverificados sólidamente **CERRADOS** para
  sus vectores originales y variantes adversariales nuevas (puerto distinto, bucle real
  entre dos hosts, redirect relativo, mutación real del gate de cobertura, re-verificación en
  vivo el mismo día, y — el más escrutado — ausencia real de fuga entre `score`/`eligibility`
  en `MatchingEngine`).

**Conteo de veredictos**: CERRADO: 7 (SR-04, 05, 07, 08, 09, 11, y el núcleo técnico de
SR-01\*) · PARCIAL: 3 (SR-02, SR-03, SR-06) · fuera de ámbito: 1 (SR-10, sin cambios, por
instrucción explícita ya documentada del orquestador). \*SR-01 cerrado para su vector
original; ver hallazgo nuevo asociado (SR-18, severidad BAJA).

**Hallazgos nuevos**: 7 — SR-12 (MEDIA), SR-13 (MEDIA-ALTA), SR-14 (ALTA), SR-15 (ALTA),
SR-16 (MEDIA-ALTA), SR-17 (MEDIA), SR-18 (BAJA).

**Regresión en consumidores**: ninguna. `npm run -w apps/worker typecheck` y
`npm run -w apps/worker test` (8 archivos / 55 pruebas, 5 skipped) pasan limpios en el mismo
worktree, incluyendo los tests que ejercitan directamente el estado `not_configured` (SR-03)
y el scheduler REQ-146/REQ-150. La falla preexistente de `run-agent.ts` mencionada en
SR-03/SR-06 ya no se reproduce (fue corregida por trabajo posterior de otro agente en
`packages/agents`, ajeno a este paquete).

---

## 1. Reproducibilidad

Reproducido en worktree limpio (`npm install`, 677 paquetes):

```
typecheck: OK (tsc --noEmit, sin salida)
lint:      OK (eslint src test --ext .ts, sin salida)
test:      13 archivos / 95 pruebas — TODAS en verde
build:     OK (tsc -p tsconfig.build.json)
coverage:  91.53% líneas / 82.33% ramas / 90.64% funciones (IDÉNTICO a SR-08)
```

**Mutación del gate de cobertura**: se subieron los umbrales de `vitest.config.ts`
(`lines: 85→95`, `branches: 80→90`, por encima de lo medido) y `test:coverage` **falló
explícitamente** (`ERROR: Coverage for lines (91.53%) does not meet global threshold (95%)`).
Archivo restaurado tras la prueba. El gate de SR-08 es real, no decorativo.

**Veredicto: CUMPLE.**

## 2. Reverificación por hallazgo (SR-01..SR-11)

### SR-01 — Reordenar arrays sin cambiar contenido no debe versionar falsamente (ALTA)

**Reintento del ataque original**: reordenar `classifiers[]`/`attachments[]` → mismo
`versionHash`, sin `ChangeDetected` (test oficial `test/dedupe.test.ts` describe "SR-01",
4 casos, verde).

**Variantes nuevas** (`test/_reverify-sr01.test.ts`, temporal):
- Arrays con **duplicados exactos**, incluso reordenados → mismo hash (correcto).
- Quitar **un** duplicado real (cambio de cardinalidad) → SÍ produce hash distinto
  (correcto: es un cambio de contenido real).
- Campo opcional **presente-pero-vacío** (`description: ""`) vs **ausente** (`undefined`)
  en un `Classifier` → SÍ producen hashes distintos (correcto, son valores distintos).
- Campo opcional **`null` explícito** → `parseTenderRecord` **lanza** `ZodError`
  (`z.optional()` no acepta `null`) — ver relación con **SR-13** (§4, nuevo).
- **Cambio SOLO de mayúsculas** en un nombre de anexo (`"Anexo Tecnico"` →
  `"ANEXO TECNICO"`) → **SÍ dispara** `"anexos"`/hash distinto. Criterio aplicado para
  juzgar esto: un cambio es "real" (debe versionar) si y solo si altera el contenido
  semántico/legal del campo; una diferencia PURA de mayúsculas en un nombre de archivo
  normalmente NO lo hace. El código actual es deliberadamente case-sensitive (documentado
  en el comentario de `canonicalizeWhitespaceAndUnicode`), una decisión de diseño
  defendible pero no libre de falsos positivos residuales — ver **SR-18** (nuevo, BAJA).
- **Cambio SOLO de acentos**, sin ambigüedad de forma unicode (`"Especificación técnica"` →
  `"Especificacion tecnica"`, NO es NFC vs NFD de la misma letra, son letras distintas) →
  SÍ dispara cambio. Esto es razonable (no es el mismo bug que SR-01 cerró, que era
  específicamente sobre DOS representaciones unicode de la MISMA letra).

**Veredicto: CERRADO** para el alcance declarado (orden de arrays, duplicados, NFC +
espacios). Ver SR-18 para el residual de mayúsculas.

### SR-02 — Fechas de ComprasMX sin pasar por zona horaria de México (ALTA)

**Reintento del ataque original + variantes** (`test/tz-harness/tz-edge.ts`, llamadas
directas a `fromMexicoCityNaive()`, sin necesidad de subproceso porque la función misma
construye el offset antes de invocar `new Date()`):

| Entrada | Resultado (bajo `TZ=Asia/Tokyo`) | Correcto |
|---|---|---|
| `"2026-09-05"` (solo fecha) | `2026-09-05T06:00:00.000Z` | Sí (00:00 CDMX) |
| `"2026-09-05T00:00:00Z"` (offset explícito) | `2026-09-05T00:00:00.000Z` | Sí, NO se reinterpreta |
| `"2026-09-05T00:00:00-05:00"` (offset explícito) | `2026-09-05T05:00:00.000Z` | Sí |
| `"2026-09-05T00:00:00"` (naive) | `2026-09-05T06:00:00.000Z` | Sí (00:00 CDMX) |

Test oficial (`test/timezone-independence.test.ts`, subproceso real, 3 TZ) también verde.

**HALLAZGO NUEVO (SR-12, MEDIA)**: `parseComprasMxHistoricoCsv()` — agregado por **SR-06**,
en un commit POSTERIOR a este fix (`fa68ad8` después de `3738f9a`) — mapea
`fecha_inicio`/`fecha_fin` (`src/connectors/compras-mx/comprasmx-mapper.ts`, función
`parseComprasMxHistoricoCsv`) DIRECTO a `dates.published`/`dates.award`, sin pasar por
`parseComprasMxDate()`/`fromMexicoCityNaive()`. Confirmado en subproceso real
(`test/tz-harness/print-csv-historico-deadline.ts`, dato naive `"2026-09-10 14:00:00"`):

```
TZ=UTC                -> published: 2026-09-10T14:00:00.000Z
TZ=America/Mexico_City -> published: 2026-09-10T20:00:00.000Z
TZ=Asia/Tokyo          -> published: 2026-09-10T05:00:00.000Z
```

Riesgo real HOY es medio, no alto: el dataset real verificado en vivo siempre trae offset
explícito (`+00:00`, confirmado en `test/fixtures/compras-mx/compranet-historico-real-sample.csv`),
así que `fromMexicoCityNaive` habría sido un no-op idéntico en la práctica actual. Pero el
esquema (`ComprasMxHistoricoCsvRowSchema.fecha_inicio: z.string().optional()`) no exige
offset, y ningún test de SR-06 cubre una fila naive — el bug reaparecería en silencio si
SABG cambia el formato del export, exactamente el riesgo que SR-02 fue creado para cerrar.

**Veredicto: PARCIAL** (el vector original, código y tests citados, está sólidamente
cerrado; el mismo bug fue reintroducido por un commit posterior en una ruta distinta del
mismo paquete).

### SR-03 — DOF sin `noteCodes` reporta "ok" sin tocar la red (ALTA)

**Reintento del ataque original**: `createDofConnector()` sin `noteCodes` → 0 llamadas
HTTP, `SourceNotConfiguredError`, `health.state = "not_configured"` (test oficial verde).
Regresión en `apps/worker`: `discover-tenders-handler.test.ts` ejercita explícitamente
`not_configured` y pasa (§Regresión).

**Variante nueva** (`test/_reverify-sr03-captcha200.test.ts`): `DiscoveryPipeline` real +
`createDofConnector({ noteCodes: ["5797937"] })` + `fetchImpl` que devuelve **200** con un
cuerpo HTML de reCAPTCHA/captcha real (sin lanzar excepción). Resultado:

```json
{ "state": "ok", "evidence": { "message": "Corrida exitosa sin registros nuevos de la fuente." } }
```
`nuevos: 0, errores: []`.

**HALLAZGO NUEVO (SR-14, ALTA)**: un 200 real con cuerpo de captcha/bot-challenge
(escenario documentado como real por el propio README para
`plataformadigitalnacional.org`/Zenedge) hace que `extractDofNoticesFromText` no encuentre
avisos y el pipeline reporte `"ok"`/"0 nuevas" — **indistinguible de una corrida real sin
novedades**, la MISMA violación de REQ-148 que SR-03 cerró, disparada por CONTENIDO en vez
de por configuración ausente. Los conectores basados en JSON (ComprasMX, OCDS-SHCP, PDN-S6,
portales estatales) quedan protegidos INDIRECTAMENTE: un cuerpo HTML en vez de JSON hace
que `response.json()` lance un `SyntaxError` no reconocido por ninguna rama de
`classifySourceFailure`, cayendo en el catch-all `"down"` (honesto, aunque menos preciso
que `"captcha_detected"`). El gap es específico de conectores de scraping de texto de mejor
esfuerzo (hoy, solo DOF).

**Veredicto: PARCIAL** (el vector original, `noteCodes: []`, cerrado y sin regresión; el
vector adyacente de la misma familia de riesgo permanece abierto).

### SR-04 — Redirecciones cross-host no pasan por el throttle del destino (MEDIA)

**Reintento del ataque original**: confirmado por la suite oficial (`test/http-client.test.ts`
describe "SR-04", 5 casos: throttle del destino tras redirect cross-host con 5 orígenes,
no reenvío de `Authorization`/`Cookie` cross-host, rechazo de esquema no-https, límite de
saltos, redirect same-host normal).

**Variantes nuevas** (`test/_reverify-sr04-redirects.test.ts`, 4 tests):
- Redirección a **otro puerto** del MISMO hostname (https): tratado como host de destino
  distinto (`new URL().host` incluye puerto) → `concurrencyPerHost` del destino se respeta
  (`maxInFlightTarget = 1` con 5 peticiones concurrentes).
- **Bucle de redirecciones** real entre dos hosts https (A↔B, `maxRedirects: 4`): falla
  explícitamente (`/redirec/i`) tras 5 llamadas `fetch`, no cuelga ni reintenta
  indefinidamente.
- **Redirect relativo** (`Location: "/final"`) contra un servidor `http` real
  (`node:http`, puerto efímero): se resuelve correctamente vía `new URL(location, url)`; el
  guard https-only aplica IGUAL a relativos same-host (rechaza porque el servidor es
  `http`, consistente con REQ-079).
- **Redirect relativo cross-path mismo-host** (https, mock): resuelve y responde 200
  reentrando por `request()`.

**Veredicto: CERRADO** — sin hallazgos nuevos.

### SR-05 — `HttpError(401|403)` sin cobertura de test (MEDIA)

**Reintento de la mutación original**: se desactivó de nuevo la rama
`if (error.status === 401 || error.status === 403) return {...}` (`if (false)`) en el
worktree y se re-ejecutó la suite completa:

```
FAIL discovery-pipeline.test.ts
  × clasifica un HttpError(401) como permission_missing (SR-05) — expected 'down' to be 'permission_missing'
  × clasifica un HttpError(403) como permission_missing (SR-05) — expected 'down' to be 'permission_missing'
Tests  2 failed | 121 passed (123)
```

La mutación ahora SÍ es detectada por los 2 tests dedicados agregados por el fix. Archivo
restaurado tras la prueba.

**Veredicto: CERRADO.**

### SR-06 — CSV histórico de ComprasMX nunca se ingería vía el pipeline (MEDIA)

**Reintento del ataque original**: `createComprasMxHistoricalCsvConnector()` registrado con
`SourceId` propio (`compras-mx-historico`), ingestión real vía `DiscoveryPipeline` sobre el
fixture real (test oficial verde, 6 casos).

**Variantes adversariales nuevas** (`test/_reverify-sr06-csv.test.ts`, 6 tests):
- Fila con **menos** columnas que el encabezado → columnas faltantes quedan `""`
  (silencioso, sin error — comportamiento tolerable, documentado).
- Fila con **más** columnas (coma sin escapar en un campo NO entrecomillado, p. ej. razón
  social con coma) → el excedente se **descarta silenciosamente**, desalineando el resto:
  `importe` termina con el valor de la columna anterior en vez de "1000" — **SR-17** (nuevo).
- Campo con coma **dentro de comillas** (RFC4180 correcto) → se preserva íntegro (correcto).
- Valor no numérico en `importe` → zod **sí** rechaza `NaN` (`ZodError`, comportamiento
  correcto de validación); pero `parseComprasMxHistoricoCsv` no tiene `try/catch` por fila:
  una fila inválida **en medio** de 2 filas válidas hace perder las 3 (0 registros, la
  excepción se propaga y aborta todo el batch) — **SR-16** (nuevo).
- **Encoding**: bytes Latin-1 con acentos reales (`cañería, año, señalización`) decodificados
  como UTF-8 (comportamiento obligatorio y real de `Response.text()` del WHATWG fetch spec,
  que SIEMPRE usa UTF-8 sin importar el charset del servidor) → mojibake **sin excepción**
  (`ca?er?a, a?o, se?alizaci?n`) — **SR-15** (nuevo).

**Veredicto: PARCIAL** — el *wiring* al pipeline (la promesa explícita del hallazgo
original) está correctamente hecho y probado; la robustez frente al archivo REAL de 951 MB
tiene 3 gaps reales no cubiertos por los tests del propio fix.

### SR-07 — Fingerprint cruzado colisiona entre procedimientos distintos (MEDIA)

**Reintento del ataque original**: confirmado por la suite oficial (`test/dedupe.test.ts`,
4 casos SR-07: no colisiona entre PROC-A/PROC-B de la misma entidad con fecha de
presentación distinta; sigue reconociendo el mismo procedimiento cruzado entre fuentes;
número de procedimiento embebido distingue títulos casi idénticos).

**Variante pedida** (`test/_reverify-sr07-fingerprint.test.ts`): dos registros con el
**MISMO número de procedimiento** embebido en el título (`LA-012NAY001-E15-2026`) pero
**entidades DISTINTAS** (SEP vs Salud) → fingerprints **DISTINTOS** (correcto, sin falso
positivo — la entidad normalizada sigue siendo parte de la huella).

Variante informativa adicional (no es un hallazgo nuevo, ya documentado explícitamente por
el propio JSDoc de la función): la MISMA convocatoria real republicada con el nombre de la
entidad escrito de forma distinta entre fuentes ("SEP" vs nombre completo) no colisiona
(falso negativo conocido y ya reconocido como limitación de la heurística).

**Veredicto: CERRADO.**

### SR-08 — Sin `vitest --coverage`/umbrales configurados (BAJA)

Ver §1 (mutación real del gate: subir umbrales por encima de lo medido rompe el build).
Cobertura real medida (91.53%/82.33%) coincide EXACTAMENTE con lo declarado en el hallazgo.

**Veredicto: CERRADO.**

### SR-09 — Código de bloqueo de ComprasMX inestable (401 vs 403) (BAJA)

**Re-verificación en vivo el mismo día de esta reverificación** (2026-09-05, lectura
mínima, sin CAPTCHA-solving):

```
POST .../whitney/sitiopublico/expedientes?rows=5&page=1  -> 403 {"error":"Acceso no permitido.",...}
GET  https://dof.gob.mx/                                  -> 200
GET  https://api.datos.gob.mx/v2/contratacionesabiertas   -> timeout
```

Consistente con lo que el README ya anota (403 "Acceso no permitido" reproducido de forma
independiente, distinto del 401 "Unauthorized" original documentado, ambos clasificados
igual por `classifySourceFailure`). La nota de variación sigue siendo precisa hoy, sin
necesidad de actualización.

**Veredicto: CERRADO.**

### SR-10 — Trazabilidad de REQ-146 en `docs/PROGRESO.md` (BAJA)

Fuera del ámbito exclusivo de esta reverificación (`packages/sources/**`,
`docs/logs/reverify-sources-*.log` y esta columna de `sources-reverificacion.md`), por la
misma instrucción explícita del orquestador ya documentada en la columna "Estado
reparación" del hallazgo original: la trazabilidad de `docs/PROGRESO.md` la corrige el
propio orquestador. Confirmado independientemente (fuera de mi ámbito de escritura, solo
lectura) que `docs/ACEPTACION.md` REQ-146 sí tiene evidencia real
(`apps/worker/src/scheduler/scheduler.ts`, 5 tests verdes reproducidos en el worktree, ver
§Regresión).

**Veredicto: sin cambios / fuera de ámbito** (no aplica CERRADO/PARCIAL/NO CERRADO a este
paquete).

### SR-11 — MatchingEngine sin concepto de elegibilidad separado de relevancia (MEDIA)

**Reintento del ataque original + variantes pedidas**
(`test/_reverify-sr11-matching.test.ts`, 5 tests):

- **Perfil sin ningún criterio de elegibilidad configurado** (aunque tenga
  `classifierCodes`/`keywords`, que son señales de RELEVANCIA, no de elegibilidad) →
  `eligibility.status = "no_evaluable"` (`criteria: []`), `score = 100` (el score sí usa
  esas señales). Confirma que "elegibilidad" cubre un universo de criterios distinto de
  "relevancia" por diseño (CPV/keywords no son "requisitos duros" de elegibilidad en este
  motor, algo consistente con el README).
- **Presupuesto fuera de rango** (`eligibility = "no_cumple"`) con classifiers/keywords que
  sí matchean fuerte → `score = 81.25` (NO se anula a 0): confirma que `eligibility` no
  contamina `score`, salvo la excepción documentada.
- **Dato ausente** (`budgetAmount: undefined`) → `eligibility = "no_evaluable"` para ese
  criterio (nunca "cumple" implícito); el criterio de score correspondiente usa 0.5 neutro
  documentado en la explicación.
- **Dato presente pero no cumple** vs **ausente** → estados distintos y consistentes
  (`"no_cumple"` vs `"no_evaluable"`), nunca confundidos.
- **¿Eligibility influye indebidamente en score?** Solo en el caso YA documentado
  explícitamente como excepción: `excludedKeywords` afecta **ambos** valores a la vez
  (`score = 0` veto duro, `eligibility = "no_cumple"`) — es la única señal compartida, y es
  consistente por diseño (ambos deben reflejar una exclusión dura), no una fuga general.

**Veredicto: CERRADO** — separación real y robusta entre relevancia y elegibilidad.

---

## 3. Regresión en el consumidor (`apps/worker`)

Ejecutado en el mismo worktree, sin cambios de código:

```
npm run -w apps/worker typecheck   -> OK, sin salida
npm run -w apps/worker test        -> 8 archivos / 55 pruebas (5 skipped) — TODAS en verde
```

Incluye `test/scheduler.test.ts` (REQ-146/REQ-150, unicidad por ventana) y
`test/discover-tenders-handler.test.ts` (ejercita explícitamente el estado
`not_configured` de SR-03 y la honestidad de `coverage` de WK-03/05/06). La falla
preexistente de `apps/worker/src/handlers/run-agent.ts` (`ToolDefinition.declaredEffects`)
mencionada como "no relacionada" en los commits de SR-03/SR-06 **ya no se reproduce** —
fue corregida por trabajo posterior de otro agente en `packages/agents`, ajeno a este
paquete.

**Sin regresión.**

---

## 4. Tabla de hallazgos nuevos (SR-12 a SR-18)

| ID | Severidad | Relacionado con | Hallazgo (evidencia) | Reparación sugerida (separada, no aplicada) |
|---|---|---|---|---|
| SR-12 | **MEDIA** | SR-02 | `parseComprasMxHistoricoCsv()` (`src/connectors/compras-mx/comprasmx-mapper.ts`, agregado por SR-06 DESPUÉS de que SR-02 se cerrara) mapea `fecha_inicio`/`fecha_fin` DIRECTO a `TenderDatesSchema` (`z.coerce.date()`) sin pasar por `fromMexicoCityNaive()`, a diferencia de `parseComprasMxDate()` que sí lo hace en el mapper del API en vivo. Confirmado en subproceso real (`test/tz-harness/print-csv-historico-deadline.ts`): el mismo dato naive `"2026-09-10 14:00:00"` produce 3 instantes distintos según `TZ=UTC/America/Mexico_City/Asia/Tokyo`. Riesgo hoy es MEDIO (no alto) porque el dataset real verificado en vivo siempre trae offset explícito (`+00:00`); el riesgo es que el esquema (`z.string().optional()`) no lo exige y ningún test de SR-06 cubre una fila naive. | Enrutar `fecha_inicio`/`fecha_fin`/`ff_fecha_inicio`/`ff_fecha_fin` en `parseComprasMxHistoricoCsv` a través de `fromMexicoCityNaive()` (o su equivalente), igual que ya se hace para el API en vivo; agregar un test con una fila naive (sin offset) que reproduzca la dependencia del TZ del proceso antes del fix. |
| SR-13 | **MEDIA-ALTA** | (nuevo, sin SR previo directo) | Todos los esquemas zod de este paquete (`ComprasMxApiRecordSchema` y análogos en otros conectores) usan `.optional()` sin `.nullable()`. Confirmado: `ComprasMxApiRecordSchema.parse({ tipo_contratacion: null, ... })` lanza `ZodError` ("Expected string, received null"); el mismo payload con el campo simplemente AUSENTE se acepta con normalidad. `mapComprasMxApiRecordToTenderRecord(...)` propaga el mismo throw. Es un patrón MUY común en APIs JSON reales de gobierno devolver `null` explícito en vez de omitir la llave; cuando eso ocurra, el registro completo (no solo el campo) fallará y `classifySourceFailure` lo clasificará como `interface_changed` — una falsa alarma de "cambio de interfaz" cuando la estructura real no cambió, solo el valor es null. Es la misma familia de riesgo que REQ-148 busca prevenir (un estado de fuente que no refleja la realidad), vía "null" en vez de "silencio". | Cambiar los campos opcionales de estos esquemas a `.nullable().optional()` (o `.nullish()`) y normalizar `null -> undefined` antes de construir el `TenderRecord`, para que un `null` explícito se trate igual que un campo ausente en vez de tumbar el registro completo. |
| SR-14 | **ALTA** | SR-03 | Un `fetchImpl` real que devuelve HTTP 200 con un cuerpo HTML de captcha/bot-challenge (sin lanzar excepción) hace que `createDofConnector().discover()` (con `noteCodes` configurado) llegue a `extractDofNoticesFromText`, que simplemente no encuentra avisos — 0 registros, sin error — y `DiscoveryPipeline` reporta `health.state = "ok"` / `"Corrida exitosa sin registros nuevos de la fuente."`. Confirmado con `DiscoveryPipeline` real (`test/_reverify-sr03-captcha200.test.ts`). Es la MISMA violación de REQ-148 que SR-03 cerró (silencio == "cero oportunidades" indistinguible de una fuente caída/bloqueada), disparada por CONTENIDO de la respuesta en vez de por `noteCodes` vacío. El propio README documenta este escenario como real (Zenedge en `plataformadigitalnacional.org`). Los conectores JSON (ComprasMX, OCDS-SHCP, PDN-S6, portales estatales) están protegidos INDIRECTAMENTE porque `response.json()` sobre un cuerpo HTML lanza `SyntaxError`, clasificado por el catch-all `"down"` (honesto aunque menos preciso que `"captcha_detected"`). | Para conectores de scraping de texto/HTML (hoy solo DOF): validar una señal mínima de "esto parece la página esperada" antes de aceptar "0 avisos" como éxito (p. ej. exigir que el HTML contenga al menos el marcador estructural esperado de `nota_detalle.php`, o detectar heurísticamente palabras como "captcha"/"recaptcha"/"verifica que no eres un robot" en el cuerpo y lanzar un error explícito con esas palabras para que `classifySourceFailure` lo clasifique como `captcha_detected` en vez de "ok"). |
| SR-15 | **ALTA** | SR-06 | `ComprasMxHistoricalCsvConnector.discover()` usa `response.text()` para leer el CSV, que decodifica SIEMPRE como UTF-8 (comportamiento obligatorio del WHATWG fetch spec, ignora el charset real declarado/usado por el servidor). Confirmado con bytes Latin-1 reales que contienen acentos típicos de texto en español ("cañería, año, señalización"): decodificados como UTF-8 producen mojibake (`ca?er?a, a?o, se?alizaci?n`) **sin ninguna excepción** — corrupción SILENCIOSA de datos, no un crash. Si el CSV real de SABG (951 MB, export de un sistema legado) viene en Latin-1/Windows-1252 (muy común en datasets gubernamentales mexicanos antiguos) en vez de UTF-8, todos los campos de texto con acentos (`proveedor`, `titulo_contrato`, `descripcion_contrato`) quedarían corruptos en el "raw lake" (REQ-005) sin que nada lo detecte. No se verificó el encoding real declarado por el servidor SABG en esta ronda (solo se hizo `HEAD`, no se inspeccionó `Content-Type: charset=...` del `GET` completo). | Antes de decodificar, leer el `Content-Type`/`charset` real de la respuesta (`response.headers.get("content-type")`) y, si declara un charset distinto de UTF-8 (o no declara ninguno y hay evidencia de mojibake, p. ej. presencia de `�`), decodificar los bytes crudos (`response.arrayBuffer()` + `TextDecoder(charset)`) en vez de `response.text()`. Como mínimo, documentar en el README que el encoding del CSV real de SABG no fue verificado explícitamente. |
| SR-16 | **MEDIA-ALTA** | SR-06 | `parseComprasMxHistoricoCsv()` (`src/connectors/compras-mx/comprasmx-mapper.ts`) parsea TODAS las filas del CSV en un array antes de devolver nada, sin `try/catch` por fila. Confirmado: un CSV de 3 filas con 1 fila inválida (importe no numérico, correctamente rechazada por zod) en medio de 2 filas válidas hace que la función completa lance y **pierda las 3 filas**, no solo la inválida. Esto contradice la propiedad de resiliencia que la propia auditoría original documentó como "Comprobado correcto" para el resto del pipeline (§6: "un conector que lanza a mitad de su `AsyncIterable` ... conserva los registros ya emitidos ANTES del throw") — esa propiedad NO se sostiene para este conector porque no hace streaming: construye el array completo de `TenderRecord` antes de que `discover()` yield-ee el primero. Con un archivo real de ~951 MB y probablemente cientos de miles de filas, UNA sola fila malformada en cualquier parte del archivo tira TODO el batch a cero. | Envolver el `ComprasMxHistoricoCsvRowSchema.parse(rawRow)`/`parseTenderRecord(raw)` de cada fila en su propio `try/catch` dentro de `parseComprasMxHistoricoCsv`, acumulando filas inválidas como advertencias/errores separados (visibles en `stats.errores` vía el mecanismo que ya usa `DiscoveryPipeline.processRecord`) en vez de abortar la función completa; idealmente, además, migrar a un parser CSV en streaming (ya reconocido como limitación pendiente en el JSDoc del conector) para no acumular las ~951 MB en memoria. |
| SR-17 | **MEDIA** | SR-06 | El parser CSV artesanal (`src/util/csv.ts`, `parseCsv`) mapea columnas por POSICIÓN (`header.forEach((key, i) => record[key] = row[i] ?? "")`); si una fila real trae una columna de MÁS porque un campo con coma no viene correctamente entrecomillado (p. ej. una razón social "Fulano, S.A. de C.V." sin comillas en el CSV de origen), el valor esperado en la columna siguiente se descarta silenciosamente y todos los campos después de la coma extra quedan desalineados, sin ningún error ni advertencia. Confirmado: `"codigo,proveedor,importe\nE1,Fulano, S.A. de C.V.,1000\n"` produce `{codigo:"E1", proveedor:"Fulano", importe:" S.A. de C.V."}` — el valor real de `importe` ("1000") se pierde sin rastro. El dataset real usa comillas correctamente para el campo `descripcion_contrato` en la muestra verificada, pero no hay garantía de que las ~951 MB completas mantengan esa disciplina de forma consistente (dataset histórico, exportado por sistemas antiguos). | Detectar el caso de fila con MÁS columnas que el encabezado y tratarlo como fila malformada explícita (rechazar con un error visible, en vez de silenciosamente truncar/desalinear), en vez de solo defenderse de filas con MENOS columnas (que sí se rellenan con `""` de forma razonable). Alternativamente, migrar a una librería CSV madura (p. ej. `csv-parse`) que ya maneja estos casos de forma configurable (modo estricto que rechaza filas con conteo de columnas incorrecto). |
| SR-18 | BAJA | SR-01 | Un cambio SOLO de mayúsculas en un nombre de anexo o `classifier.code` (ej. `"Anexo Tecnico"` → `"ANEXO TECNICO"`, sin ninguna diferencia de acentos/forma unicode/espacios) SÍ dispara `"anexos"`/`versionHash` distinto, porque `canonicalizeWhitespaceAndUnicode()` (`src/util/hash.ts`) solo normaliza forma NFC y espacios, deliberadamente NO baja a minúsculas (decisión de diseño documentada explícitamente en el comentario del código: "el hash de versión debe seguir siendo sensible a cambios reales de contenido"). Es un residual de la MISMA categoría de "falsa versión" que SR-01 cerró (formato incidental, no contenido real), de menor probabilidad práctica que el reordenamiento de arrays, y no está registrado como decisión pendiente en ningún documento. | Decidir explícitamente (y documentar la decisión, no solo el código) si un cambio de mayúsculas en `attachments[].name`/`classifiers[].code` debe o no disparar versión; si la respuesta es "no debería" (razonable para nombres de archivo, donde el mismo documento puede resubirse con distinto casing sin cambiar su contenido), aplicar `.toLowerCase()` dentro de `canonicalizeWhitespaceAndUnicode()` solo para esos dos campos (no para `title`/`contractingEntity`, donde el casing sí puede ser significativo). |

---

## 5. Comprobado correcto (verificado independientemente en esta ronda)

- **Reproducibilidad exacta**: 13 archivos / 95 pruebas en verde, typecheck/lint/build
  limpios, cobertura real 91.53%/82.33% idéntica a lo declarado en SR-08 (§1).
- **Gate de cobertura real, no decorativo**: subir los umbrales de `vitest.config.ts` por
  encima de la cobertura medida hace fallar `test:coverage` explícitamente (§1).
- **Mutación SR-05 ahora detectada**: desactivar la rama `HttpError(401|403) ->
  permission_missing` hace fallar 2 tests dedicados (antes, 0) (§2, SR-05).
- **`fromMexicoCityNaive()` robusta** en las 4 variantes pedidas (sin hora, offset `Z`,
  offset `-05:00`, naive) bajo 3 TZ de proceso distintas — el núcleo de SR-02 es sólido
  (§2, SR-02).
- **`HttpClient` — redirecciones**: cross-host por puerto distinto (no solo por hostname),
  bucle real entre dos hosts (falla explícito, no cuelga), redirect relativo same-host y
  cross-path, todos correctos además de las 5 protecciones ya confirmadas por la suite
  oficial (§2, SR-04).
- **`MatchingEngine` — separación real de score/eligibility**: perfil sin criterios de
  elegibilidad → `no_evaluable` aunque el score use otras señales; presupuesto fuera de
  rango no anula el score léxico; dato ausente vs presente-no-cumple producen estados
  distintos y consistentes; la única señal compartida (`excludedKeywords`) es la excepción
  ya documentada, no una fuga general (§2, SR-11).
- **Fingerprint cruzado sin falso positivo** entre dos procedimientos reales con el MISMO
  número de procedimiento embebido pero entidades distintas (§2, SR-07).
- **Sin regresión en `apps/worker`**: typecheck limpio, 55/60 tests verdes (5 skipped por
  diseño, no por fallo) en el mismo worktree, incluyendo los tests que ejercitan
  directamente `not_configured` (SR-03) y el scheduler REQ-146/REQ-150 (§3).
- **SR-09 sigue siendo preciso**: re-verificación en vivo el mismo día reproduce
  exactamente el 403 "Acceso no permitido" documentado como variante, no el 401 original
  (§2, SR-09).
- **Validación zod correcta ante `NaN`**: un valor no numérico en `importe` del CSV
  histórico SÍ es rechazado por `z.number()` (no pasa silenciosamente como `NaN`) — el gap
  real está en la ausencia de manejo por-fila (SR-16), no en la validación en sí (§4, SR-16).
- **Sin fuga de credenciales en redirect** (confirmado también por la suite oficial,
  re-observado en las variantes nuevas): `Authorization`/`Cookie` nunca llegan a un host de
  destino distinto.

---

## Nota metodológica

Todas las pruebas adversariales, la mutación del gate de cobertura y la mutación de SR-05
se ejecutaron en `git worktree add <scratchpad>/reverify-src 56ce542`, nunca en el árbol
principal; el worktree fue eliminado (`git worktree remove`) al finalizar y no se modificó
ningún archivo de `packages/sources/src`/`packages/sources/test` de forma persistente. Los
8 archivos de prueba adversarial temporales
(`test/_reverify-sr01.test.ts`, `test/_reverify-null-vs-absent.test.ts`,
`test/_reverify-sr03-captcha200.test.ts`, `test/_reverify-sr04-redirects.test.ts`,
`test/_reverify-sr06-csv.test.ts`, `test/_reverify-sr07-fingerprint.test.ts`,
`test/_reverify-sr11-matching.test.ts`, más 2 scripts de subproceso en
`test/tz-harness/`) nunca se commitearon y se eliminaron junto con el worktree. Las
peticiones HTTP de re-verificación (§SR-09) fueron de solo lectura (`GET`/`POST` sin
cuerpo útil contra el endpoint ya documentado como bloqueado), sin CAPTCHA-solving ni
acceso a áreas autenticadas, consistente con REQ-079. Este documento y
`docs/logs/reverify-sources-ronda1.log` son los únicos artefactos persistentes de esta
reverificación.
