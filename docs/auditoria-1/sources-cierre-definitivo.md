# Verificación puntual (cierre definitivo) — `packages/sources` SR-23/SR-24

**Auditor**: agente Sonnet verificador puntual, independiente de la
construcción del paquete y de todas las rondas de corrección/reverificación
anteriores (rondas 1-3, reverificación de cierre, micro-vuelta). Solo
verifica: no repara código. Ejecución real de `npm install`,
`typecheck`/`lint`/`build`/`test`/`test:coverage`, mutación real del gate de
cobertura, un archivo de prueba adversarial temporal (16 casos nuevos,
distintos de los ya existentes en la suite) y la regresión de los
consumidores reales (`apps/worker`, `apps/api`) — todo en
`git worktree add <scratchpad>/verify-src-micro HEAD` (HEAD=`ba9a294` al
arrancar). El worktree se eliminó al terminar; `git status --short` del
worktree confirmado limpio (salvo `package-lock.json`, una dependencia de
cobertura agregada por `npm install`, sin relación con el código bajo
prueba) antes de eliminarlo. Ningún archivo temporal quedó en el
repositorio principal. Ninguna petición de red real se realizó (todos los
ataques usan `fetchImpl`/`Response` sintéticas o llaman al conector/mapper
directamente); no aplica la restricción de CAPTCHA-solving.

**Ámbito**: los 3 commits de la micro-vuelta posterior a la reverificación
de cierre — `305e2fb` (SR-24), `a86a6eb` (SR-23), `19a2c5c` (docs) — sobre
`packages/sources/**`, tal como los describe
`docs/auditoria-1/sources-cierre-final.md` §4 y `packages/sources/README.md`.

**Comandos y salida completa**: `docs/logs/verify-sources-micro.log`.

---

## 1. Ancestría, `git show --stat`, suite y gate de cobertura

`git log --oneline 305e2fb~1..19a2c5c` confirma la cadena lineal real:

```
19a2c5c docs(sources): micro-vuelta -- README y columna "Estado reparación" (SR-23/SR-24) y log real
a86a6eb fix(sources): SR-23 -- marcadores semanticos de contenido real en vez de plantilla fija para expected:"text" (DOF)
305e2fb fix(sources): SR-24 -- ningun release/aviso se descarta en silencio en OCDS-SHCP/PDN-S6/portales estatales/DOF (generaliza SR-21)
```

`git merge-base --is-ancestor` confirma `305e2fb → a86a6eb → 19a2c5c → HEAD`
sin bifurcaciones. A diferencia del INC-06 documentado para `15bb31f`
(ronda 3, ver `sources-cierre-final.md` §1), aquí **el contenido de cada
`git show --stat` coincide exactamente con lo que su propio mensaje de
commit describe**: `305e2fb` toca únicamente `dof-connector.ts`,
`dof-mapper.ts`, `create-ocds-connector.ts`, `ocds-mapper.ts`,
`ocds-types.ts`, `state-portal-connector.ts` y sus tests/fixtures — el
patrón `{records, dropped}` + `ctx.reportDropped` descrito para SR-24;
`a86a6eb` toca únicamente `response-classifier.ts` y su test — el
reemplazo de `minimalContentMarkers` por `semanticContentMarkers` +
`detectInterstitialShellMarker` descrito para SR-23. Sin discrepancia
mensaje/contenido, sin amend prohibido, sin commit huérfano tipo
`TEMP-CHECK-*`.

Reproducido en worktree limpio:

```
typecheck: OK   lint: OK   build: OK
test:      20 archivos / 204 pruebas — TODAS en verde
coverage:  89.36% líneas / 83.68% ramas / 93.6% funciones / 89.36% líneas
```

Coincide exactamente con `docs/logs/fix-sources-micro.log` y con la tabla
"Estado reparación" de `sources-cierre-final.md` §4 — la bitácora de la
micro-vuelta es honesta, sin inflar el conteo de pruebas ni la cobertura.

**Mutación del gate real** (`lines: 85→95`, `branches: 80→90` en
`vitest.config.ts`, archivo restaurado inmediatamente después, `git status
--short` limpio confirmado): `test:coverage` falló explícitamente
(`ERROR: Coverage for lines (89.36%) does not meet global threshold (95%)`,
ídem branches). El gate es real, no decorativo.

**Veredicto §1: CUMPLE.**

## 2. Ataques de cierre — SR-24 (5 conectores + histórico, invariante estructural)

Archivo temporal `test/ADVERSARIAL-verify-src-micro.test.ts` (16 casos,
solo en el worktree, eliminado al terminar). Todos los ataques corren
contra el código REAL (`DiscoveryPipeline`, los mappers/conectores reales),
nunca contra un stub del comportamiento esperado.

### 2.1 Fixture propio por conector: 3 registros válidos + 2 inválidos (sin id, sin título/tender)

| Conector | Resultado |
|---|---|
| `compras-mx` | `dropped.length === 2` (índice+motivo+campos por entrada), `errores.length ≥ 2`, `health.state === "interface_changed"` (2/5 = 40% > 20%). |
| `ocds-shcp` | `dropped.length === 2` (1 release sin `tender`, 1 sin `ocid`), `health.state === "interface_changed"`. |
| `pdn-s6` | Mismo fixture, vía `create-ocds-connector.ts` compartido: `dropped.length === 2`, `interface_changed`. |
| `state-portal` | Ídem: `dropped.length === 2`, `interface_changed`. |
| `dof` | No se duplicó aquí (cobertura ya presente y suficiente en `test/connectors/dof.test.ts` §"SR-24", que fuerza un bloque inválido mockeando `dof-mapper.ts` — el propio README documenta que los fallbacks de regex de DOF hacen improbable en la práctica que un aviso derivado de HTML real llegue a ser inválido). Confirmado sin regresión en la corrida de 204 pruebas. |
| `compras-mx` histórico CSV | 3 filas válidas + 1 fila con **fecha corrupta** (`fecha_inicio: "no-es-una-fecha"`) + 1 fila con **importe corrupto** (`importe: "no-es-un-numero"`): **ambas se rechazan explícitamente** en `errors[]` — `{"code":"invalid_date","path":["dates","published"]}` y `{"code":"invalid_type","expected":"number","received":"nan","path":["budgetAmount"]}` — SR-16 (try/catch por fila) sigue absorbiendo el resto del lote sin abortar. |
| `compras-mx` API en vivo | Fecha corrupta directa en `fecha_publicacion` (`"no-es-una-fecha-en-absoluto"`) → lanza `ZodError` `invalid_date` dentro de `mapComprasMxApiRecordToTenderRecord`, capturado por el `try/catch` de `mapComprasMxApiRecords` → se reporta en `dropped[]`, **nunca** pasa como una `Date` inválida silenciosa. |

**Hallazgo positivo confirmado (no un residual)**: una fecha corrupta NO
produce corrupción silenciosa vía `new Date(cadena-basura)` → "Invalid
Date" indetectable. `TenderDatesSchema` usa `z.coerce.date()`, y zod SÍ
valida `Number.isNaN(date.getTime())` internamente (confirmado
empíricamente, no solo por lectura de tipos) — cualquier fecha que no
parsee termina en `ZodError` → `dropped[]`/`errors[]`, igual que cualquier
otro campo inválido. Del mismo modo, un `importe` no numérico
(`Number.parseFloat` → `NaN`) es rechazado por `z.number().nonnegative()`
de `TenderRecordSchema` (zod trata `NaN` como `invalid_type`, no como un
número válido). **Ninguno de los dos vectores de "fecha corrupta" abre una
vía nueva de corrupción silenciosa.**

### 2.2 Casos extremos de tasa de descarte

- **100% descartado** (5/5 releases inválidos en `ocds-shcp`, 3 sin
  `ocid`/`id` — esquema — y 2 sin `tender` — filtro): `records.length ===
  0`, `dropped.length === 5`, `health.state === "interface_changed"`,
  `nuevos === 0`. Confirmado end-to-end con `DiscoveryPipeline` real.
- **0 registros y 0 descartes con forma válida** (`{releases: []}`):
  `dropped.length === 0`, `nuevos === 0`, `health.state === "ok"`,
  `evidence.coverage.emptyResult === true`. Confirmado — SR-19 sigue
  cerrado, sin regresión por los cambios de SR-24.

### 2.3 Invariante ESTRUCTURAL — conector que produce `records` sin invocar jamás `ctx.reportDropped`

Pregunta del mandato: *¿el pipeline lo detecta o lo deja pasar?*

**Respuesta confirmada empíricamente: lo deja pasar.** Se construyó un
`SourceConnector` sintético (simulando un conector nuevo/de terceros que un
futuro mantenedor agregue al `ConnectorRegistry`) cuyo `discover()` filtra
4 de "5 registros intentados" **dentro de su propio código**, sin invocar
`ctx.reportDropped` ni una sola vez — simplemente no los `yield`-ea.
Resultado real, vía `DiscoveryPipeline`:

```
stats.dropped = []
stats.errores = []
stats.health.state = "ok"
stats.health.evidence.coverage.emptyResult = false   (sí se procesó 1 registro)
stats.nuevos = 1
```

**Esto es indistinguible de una corrida real con "solo 1 novedad".**
`ConnectorContext.reportDropped` es un campo **OPCIONAL** de la interfaz
(`src/connectors/types.ts` líneas 44-62) invocado **por convención** desde
dentro de cada `discover()` — el propio JSDoc ya lo advertía ("cada
conector DEBE invocarlo... nunca asumir que está presente"), pero eso
describe una obligación de *diseño*, no una garantía *estructural* que
`DiscoveryPipeline` o el sistema de tipos puedan hacer cumplir. El pipeline
no tiene ninguna forma de saber cuántos registros "debieron" producirse;
solo ve lo que el conector decide emitir y lo que decide reportar.

**Consecuencia para el veredicto de SR-21/SR-24**: la afirmación del README
("`dropRateThreshold` protege ahora a los 5 conectores registrados") es
**cierta hoy, para los 5 conectores que existen y que efectivamente invocan
`ctx.reportDropped`** (confirmado por `grep` en §2.1) — pero **no es una
propiedad estructural del pipeline**, sino una propiedad de que los 5
conectores actuales siguen la convención. `test/connectors/drop-
invariant.test.ts` (agregado en SR-24) es hoy la única red de seguridad
real contra una futura regresión de esto, y solo cubre los conectores que
alguien recuerde agregar a esa lista explícita — un conector nuevo
agregado a `ConnectorRegistry` sin agregarse también a
`drop-invariant.test.ts` no sería detectado por nada en el código, solo
por disciplina de revisión humana. No se cuenta como un hallazgo numerado
nuevo (el propio `types.ts` ya divulgaba el carácter opcional/convencional
del mecanismo antes de esta verificación), pero es una precisión relevante
y antes no confirmada empíricamente sobre el ALCANCE REAL del cierre de
SR-21/SR-24: cierra el vector reproducido por la reverificación anterior
(los 5 conectores concretos), no el problema estructural subyacente
(cualquier conector futuro que no coopere).

**Veredicto §2: CERRADO** para el vector exacto de SR-24 (los 5 conectores
+ histórico, tal como estaban definidos al momento del hallazgo), **con la
limitación estructural de arriba documentada por primera vez con evidencia
directa** (antes solo se podía inferir leyendo el tipo `reportDropped?`).

## 3. Ataques de cierre — SR-23 (DOF, `assertLegitimateResponseBody`)

Los 6 vectores exigidos por el mandato, atacados vía `createDofConnector`
real (mismo `discover()` que usa `DiscoveryPipeline` en producción):

| Vector | Resultado |
|---|---|
| Meta-refresh (`<meta http-equiv="refresh">`, sin vendor conocido, cuerpo con la palabra "convocatoria") | `InterfaceChangedError`. Correcto — `detectInterstitialShellMarker` lo detecta independientemente de si matchea algún marcador semántico. |
| `<script>` con `location.replace(...)` (interstitial de redirección genérico, cuerpo con número de expediente real) | `InterfaceChangedError`. Correcto. |
| Cuerpo de **119 vs. 121 bytes útiles** (frontera exacta de `minUsefulTextBytes`, default 120; construido y verificado byte a byte con el MISMO `stripTagsToPlainText` del clasificador) | 119 bytes (con marcador semántico presente) → `InterfaceChangedError`. 121 bytes (mismo marcador) → **no lanza**. Frontera confirmada exacta, sin off-by-one; confirma también que el diseño exige AMBAS condiciones (`interstitialLabel \|\| !hasSemanticMarker`) — un marcador semántico presente no basta si el cuerpo es demasiado corto. |
| **Página legítima corta** (nota DOF real y breve — "Se cancela la convocatoria LA-050GYN003-E1-2026.", 87 bytes útiles, contenido 100% genuino, sin ningún patrón de challenge) | `InterfaceChangedError`. **Falso positivo confirmado** (ver SR-25 abajo). |
| Texto legítimo **sin** "convocatoria"/"licitación pública" pero **con** un número de expediente (`LA-050GYN003-E1-2026`) y relleno >120 bytes | No lanza (ok). Correcto — el tercer marcador semántico (patrón de procedimiento) es suficiente por sí solo. |
| Captcha real (`g-recaptcha`) con `expected: "text"` | `CaptchaDetectedError`, nunca "ok". Correcto — `CHALLENGE_MARKERS` se evalúa antes que cualquier lógica de `semanticContentMarkers`/interstitial, sin importar `expected`. |

### SR-25 (nueva, BAJA-MEDIA) — falso positivo por longitud en notas DOF genuinas y breves

El mecanismo que SR-23 introdujo para cerrar el falso negativo del
"cascarón" (`detectInterstitialShellMarker`, condición (iii): texto útil
< `minUsefulTextBytes`, default 120) **no distingue un cascarón vacío de
una nota real genuinamente breve** (una cancelación, una fe de erratas, un
aviso corto de una sola línea con el expediente y la palabra
"convocatoria"). Confirmado con evidencia directa: una nota sintética de
87 bytes útiles, 100% contenido real y verificable (contiene el patrón de
expediente y la palabra "convocatoria"), se rechaza como
`interface_changed` únicamente por su longitud. Es la misma familia de
falla que el falso positivo original de SR-23 (plantilla) — contenido real
rechazado por una heurística estructural — pero por una causa distinta
(longitud, no plantilla), e introducida por el propio mecanismo que SR-23
agregó para cerrar el vector opuesto (falso negativo del interstitial). No
se verificó (ni se pudo verificar, dado que el formato exacto de una nota
DOF real con convocatorias sigue **PENDIENTE VERIFICACIÓN REAL** según el
propio README) si 120 bytes es un umbral realista para el body mínimo de
una nota real de DOF; el propio código no ofrece evidencia de haberse
calibrado contra una muestra real.

Reparación sugerida (no aplicada, fuera de mandato): considerar un umbral
más bajo, o exigir que el marcador semántico de "número de procedimiento"
(el más específico y menos propenso a texto de relleno accidental) por sí
solo baje el umbral mínimo requerido, dado que su sola presencia ya es
fuerte evidencia de contenido real independientemente de la longitud total
del cuerpo.

**Veredicto §3: PARCIAL** — los 2 vectores originales de SR-23 (falso
positivo de plantilla, falso negativo de cascarón) siguen sólidamente
cerrados, sin regresión; **residual nuevo SR-25 (BAJA-MEDIA)**, un falso
positivo de una familia distinta (longitud) sobre el mismo mecanismo.

## 4. Veredicto de cierre y balance definitivo SR-01–SR-25

### 4.1 Veredicto de esta verificación puntual

**PARCIAL.** Los 3 commits de la micro-vuelta (`305e2fb`, `a86a6eb`,
`19a2c5c`) están correctamente encadenados, con contenido fiel a sus
mensajes, suite verde (204/204), gate de cobertura real, y regresión limpia
en `apps/worker`/`apps/api`. SR-24 cierra sólidamente el vector exacto
reproducido por la reverificación de cierre (los 5 conectores + histórico
concretos, incluyendo fronteras de tasa de descarte y manejo de fechas/
importes corruptos) y documenta con precisión nueva (§2.3) el límite
estructural inherente del mecanismo (opt-in por conector, no forzado por
tipos ni por el pipeline). SR-23 cierra sólidamente sus 2 vectores
originales, pero **introduce un residual nuevo (SR-25, BAJA-MEDIA)**: un
falso positivo por longitud sobre notas DOF genuinas y breves — de menor
severidad que los hallazgos que sustituye (SR-23 era MEDIA; SR-25 es
BAJA-MEDIA y de alcance más angosto: solo afecta notas reales por debajo de
~120 bytes útiles, un caso de borde, no el flujo principal).

### 4.2 Balance DEFINITIVO SR-01 a SR-25

| Bloque | Veredicto |
|---|---|
| SR-01 a SR-18 (sin SR-10, fuera de ámbito de `packages/sources`) | **CERRADO**, confirmado sin regresión en esta ronda tampoco (fuera del ámbito de los 3 commits revisados, pero cubierto por la suite de 204 pruebas que sigue en verde) |
| SR-19 | **CERRADO** — confirmado sólido, incluyendo el caso 0/0 con forma válida (`emptyResult`) atacado de nuevo en esta ronda |
| SR-20 | **CERRADO** para su vector original (vendors/login sin marcador); su residual SR-23 se resuelve más abajo |
| SR-21 | **CERRADO** para su vector original (ComprasMX, fronteras exactas del umbral, manejo de fecha/importe corrupto); su residual SR-24 se resuelve más abajo |
| SR-22 | **CERRADO** — sin cambios ni regresión esta ronda |
| SR-23 | **CERRADO** para sus 2 vectores originales (falso positivo de plantilla, falso negativo de cascarón interstitial), confirmado sólido con 6 vectores adicionales de ataque; **abre SR-25 (BAJA-MEDIA)**, residual de menor severidad y alcance más angosto |
| SR-24 | **CERRADO** para su vector exacto (los 5 conectores registrados hoy + histórico CSV, incluyendo 100% de descarte, 0/0 legítimo, y datos corruptos de fecha/importe); **límite estructural documentado** (no numerado como hallazgo nuevo, ya parcialmente divulgado en el tipo `reportDropped?`): el mecanismo es cooperativo/por convención, no forzado por el pipeline ni por el sistema de tipos — un conector futuro que no invoque `ctx.reportDropped` reproduciría la MISMA clase de fuga invisible que SR-21/SR-24 corrigieron, sin que nada en el código (solo la disciplina de mantener `drop-invariant.test.ts` actualizado) lo detecte |
| **SR-25 (nuevo, BAJA-MEDIA)** | **ABIERTO** — falso positivo por longitud (`minUsefulTextBytes`) sobre notas DOF reales y breves; no bloqueante para el uso del paquete (afecta un caso de borde, es "ruidoso" — visible como `interface_changed`, nunca oculta un descarte), pero debe corregirse o recalibrarse cuando se obtenga la verificación real pendiente del formato de una nota DOF con convocatorias |

**Conteo total del paquete tras esta verificación**: CERRADO 24 de 25
hallazgos (SR-01–SR-24, sin SR-10 fuera de ámbito) · **1 hallazgo abierto
nuevo** (SR-25, BAJA-MEDIA) · 1 límite estructural documentado con
evidencia nueva pero no numerado como hallazgo (alcance real del mecanismo
`reportDropped`, §2.3).

El patrón de fondo que `sources-cierre-final.md` §5 señaló ("una corrección
cierra exactamente el vector reproducido, sin generalizar al resto de los
lugares estructuralmente equivalentes") **no se repite esta vez para
SR-24** (la generalización a los 5 conectores fue completa y se verificó
como tal) — pero SR-23 vuelve a mostrar la otra cara del mismo patrón de
fondo: una heurística de contenido, ajustada para cerrar el vector
reportado, abre un vector distinto sobre el mismo mecanismo (plantilla →
interstitial → longitud). Es la tercera vez que este ciclo ocurre sobre el
mismo `assertLegitimateResponseBody` (SR-14 → SR-19/20 → SR-23 → SR-25),
consistente con el límite ya aceptado de que es una heurística de
contenido con una lista/umbral finitos, nunca una prueba estructural del
contenido real.

### 4.3 Límites aceptados (sin cambios, confirmados vigentes)

Confirmados sin cambios respecto a `sources-cierre-final.md` §6:

- **ComprasMX (API en vivo)**: bloqueada por reCAPTCHA (B-02), REQ-079
  respetado, no se intenta eludir. Sin cambios esta ronda.
- **OCDS-SHCP / PDN Sistema 6 / portales estatales**: sin URL/API real
  confirmada, `PENDIENTE VERIFICACIÓN REAL`, sin cambios esta ronda —
  todo lo verificado en §2 de este documento es contra fixtures
  sintéticos, no contra las fuentes reales (que siguen inalcanzables/sin
  URL conocida, ver README).
- **DOF**: formato exacto de una nota real con convocatorias sigue
  `PENDIENTE VERIFICACIÓN REAL`; SR-23/SR-25 son, en ese sentido, ajustes
  sobre una heurística construida contra un fixture reconstruido, no
  contra una muestra real — el propio SR-25 es evidencia de que calibrar
  un umbral (120 bytes) sin una muestra real es intrínsecamente riesgoso.
- **Heurística de captcha/challenge (`ResponseClassifier`)**: lista finita
  de marcadores conocidos — límite estructural inherente a cualquier
  heurística de contenido, reafirmado una vez más por SR-25.
- **Mecanismo `reportDropped` (SR-21/SR-24)**: cooperativo/por convención
  entre cada conector y el pipeline, no forzado por tipos — límite
  estructural nuevo, documentado con evidencia directa en §2.3 de este
  documento (antes solo inferible por lectura del tipo).
- **CSV histórico de 951 MB**: streaming probado con ~50 MB simulados
  (heap acotado, >230x más estricto que el 46.38x del parser anterior),
  **no con el archivo real de 951 MB**. Límite aceptado sin cambios:
  decisión de encoding/captcha sobre el primer chunk (~64 KiB) de la ruta
  streaming; esta verificación agrega evidencia de que, además, una fecha
  u otro campo corrupto en cualquier fila (no solo en el primer chunk) SÍ
  se detecta y reporta correctamente (§2.1), lo que reduce (sin eliminar)
  el riesgo de que datos corruptos en el archivo completo pasen
  desapercibidos.

## 5. REQ-148 — ¿cumplido ahora?

**REQ-148**: *"Estados explícitos de fuente: activa, caída, CAPTCHA
detectado, cambio de interfaz detectado, permisos/autenticación faltante;
nunca se interpreta el silencio como 'cero oportunidades'"* — tolerancia
cero.

**Respuesta: CUMPLIDO para el conjunto de conectores y vectores conocidos
hoy, con dos matices que deben quedar explícitos y no se pueden cerrar sin
más código o sin datos reales:**

1. **SR-25** es en sí mismo un caso — acotado — de REQ-148 en su forma
   inversa: no es "silencio interpretado como cero" (eso sigue
   correctamente prohibido y probado), sino "contenido real interpretado
   como cambio de interfaz" (falso positivo). REQ-148 no prohíbe
   literalmente esto (exige estados explícitos y prohíbe el silencio, no
   prohíbe el ruido), pero un falso positivo persistente sobre datos reales
   erosiona la confianza operativa en el estado "interface_changed" tanto
   como un falso negativo erosiona la confianza en "ok" — mismo defecto de
   fondo, polaridad opuesta.
2. El mecanismo que sostiene la invariante para los descartes silenciosos
   (`ctx.reportDropped`, SR-21/SR-24) es **cooperativo por conector, no
   estructural del pipeline** (§2.3): REQ-148 está satisfecho hoy porque
   los 5 conectores que existen cooperan, verificado explícitamente en esta
   ronda — pero el requisito, leído en su forma más estricta ("nunca"), no
   está garantizado por el diseño para cualquier conector futuro sin
   depender de que un desarrollador humano recuerde extender
   `drop-invariant.test.ts` cada vez que se agregue un conector nuevo al
   registro.

### REQ candidatos para una futura ronda (no aplicados, fuera de mandato)

- **REQ-148** (recalibración/extensión): considerar exigir, a nivel de
  interfaz o de un test de conformidad obligatorio en CI, que **todo**
  `SourceConnector` nuevo agregado a `ConnectorRegistry` pase por el mismo
  fixture de "3 válidos + 2 inválidos" que esta verificación usó
  manualmente — hoy es opcional y depende de que alguien lo agregue a
  `drop-invariant.test.ts`.
  - **REQ-150** (verificación puntual documentada antes de declarar una
  integración activa): el umbral `minUsefulTextBytes=120` de DOF (SR-23) se
  fijó sin una muestra real verificada — REQ-150 exige evidencia real antes
  de declarar un conector "activo"; el umbral en sí no es una integración
  activa, pero condiciona directamente si una integración futura (cuando
  se obtenga acceso real a DOF) funcionará correctamente contra datos
  reales cuya forma exacta aún no se conoce.
  - **REQ-149** (frescura visible): sin cambios por esta ronda, no
  investigado — mencionado aquí solo porque comparte la familia
  "AMPLIACION §2" con REQ-148 y podría verse afectado si SR-25 causa que un
  `interface_changed` espurio oculte temporalmente datos frescos reales
  detrás de un estado de alarma.

## 6. Regresión de consumidores reales

```
$ npm run -w packages/sources test          -> 20 archivos / 204 pruebas, verde
$ npm run -w apps/worker typecheck          -> OK, sin errores
$ npm run -w apps/worker test               -> 11 archivos / 298 pruebas, verde
$ npm run -w apps/api typecheck             -> OK, sin errores
```

Confirma, además, que el incidente **INC-07** (3 copias huérfanas no
rastreadas `*2.ts` que rompían el typecheck del worker, documentado en
`docs/BLOQUEOS.md` como CERRADO) no está presente en este worktree: al
clonarse limpio desde HEAD=`ba9a294`, nunca tuvo esas copias huérfanas (eran
archivos no rastreados por git en el árbol de trabajo original, ajenos a
cualquier commit) — el typecheck de `apps/worker` corre limpio sin
necesidad de ninguna acción adicional.

**Veredicto §6: CUMPLE, sin regresión.**
