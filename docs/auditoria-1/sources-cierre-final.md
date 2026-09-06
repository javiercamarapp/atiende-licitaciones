# Reverificación adversarial 3 (cierre final) — `packages/sources` (SR-19..SR-22)

**Auditor**: agente Sonnet reverificador independiente (vuelta 3, cierre), sin
participación en la construcción del paquete ni en ninguna ronda de corrección
anterior. Solo verifica: no repara código. Ejecución real de `npm install`,
`typecheck`/`lint`/`build`/`test`/`test:coverage`, mutación real del gate de
cobertura, y 7 archivos de prueba adversarial temporales (34 casos) — todo en
`git worktree add <scratchpad>/reverify3-src HEAD` (HEAD=`ebaa7ba` al arrancar),
nunca en el árbol principal. El worktree se eliminó al terminar
(`git worktree remove ... --force`); confirmado `git status --short` vacío en
el worktree antes de eliminarlo. Ningún archivo temporal quedó en el repositorio.
No se hizo ninguna petición de red real (todos los ataques usan `fetchImpl`/
`Response` sintéticas o llaman funciones puras directamente); no aplica la
restricción de CAPTCHA-solving.

**Ámbito**: los 4 commits de la ronda 3 de corrección (`0e9dc4f`, `15bb31f`,
`877b60f`, `2dff88f`, ver `docs/auditoria-1/sources-cierre.md` §9), sobre
`packages/sources/**`, y el incidente INC-06 (`git commit --amend` prohibido)
documentado en esa misma sección.

**Comandos y salida completa**: `docs/logs/reverify3-sources.log`.

---

## 1. Ancestría de los 4 commits e integridad tras el amend (INC-06)

`git log --oneline 0e9dc4f~1..2dff88f` confirma la cadena real:

```
2dff88f docs(sources): ronda 3 -- README/columna de reparación (SR-19..22) y log real
...
877b60f fix(sources): SR-22 -- UTF-16LE/BE (BOM y heuristica) y parser CSV en streaming
f743989 docs: actualiza Estado reparación de API-09/10/11/12 y DB-09 (ronda 3)
15bb31f fix(sources): SR-21 -- ningun registro se descarta en silencio (...)
d8a3da7 TEMP-CHECK-SR21
0e9dc4f fix(sources): SR-19/SR-20 -- soft-block JSON valido y challenge en expected:"text" nunca pasan como "ok"
```

`git merge-base --is-ancestor` confirma cadena lineal 0e9dc4f→d8a3da7→15bb31f→877b60f→2dff88f.

**Hallazgo confirmado de forma independiente (ya reportado como INC-06 en
`docs/BLOQUEOS.md`, cerrado por Fable — esta reverificación lo reproduce con
evidencia propia, no toma la palabra del corrector)**: `git show --stat 15bb31f`
**NO contiene ningún archivo de `packages/sources`** — su diff completo es
`apps/api/src/lib/agent-stores.pg.ts` (97 líneas) +
`test/security-db09-agent-run-context-cache.test.ts` (113 líneas, nuevo). El
mensaje del commit ("fix(sources): SR-21...") no corresponde a su contenido
real.

Reconstrucción exacta vía `git reflog`:

```
f537486 00:55:07  commit: fix(api): DB-09 residual — cachea contexto real de agent_run/tool_call...
15bb31f 00:55:28  commit (amend): fix(sources): SR-21 -- ningun registro se descarta en silencio...
```

`git diff f537486 15bb31f` → vacío; `git rev-parse f537486^{tree}` ==
`git rev-parse 15bb31f^{tree}` (`60ce8ebd...`, idéntico). **Confirmado con
evidencia propia (no solo la palabra del corrector): NINGÚN contenido de
archivo se perdió** — el `--amend` prohibido (ejecutado 21 segundos después de
crear `f537486`, por una carrera con un agente concurrente de seguridad
db+api que compartía el mismo checkout) solo sobrescribió el MENSAJE de un
commit ajeno y legítimo (`f537486`, DB-09) con el mensaje del propio commit de
SR-21 del corrector de sources, dejando el árbol de archivos intacto.
`f537486` quedó colgante (solo en reflog, recolectable por GC eventualmente).

**Consecuencia real para la trazabilidad (no señalada aún con esta precisión
en `sources-cierre.md` §9, que solo habla de "reemplazo de mensaje")**: el
diff REAL de SR-21 sobre `packages/sources` (`discovery-pipeline.ts`,
`comprasmx-mapper.ts`, `compras-mx-connector.ts`, `types.ts` —
confirmado por `git log --oneline -- packages/sources/src/pipeline/
discovery-pipeline.ts`) **nunca llegó a un commit final con mensaje
descriptivo**: vive permanentemente en `d8a3da7`, cuyo único mensaje es el
literal `TEMP-CHECK-SR21` — un commit que, por su propio nombre, estaba
pensado como temporal/a ser aplastado (`squash`) y terminó siendo parte
permanente del historial. Quien busque "¿dónde se corrigió SR-21?" mirando
`15bb31f` (la referencia que da la propia tabla de `sources-cierre.md` §4) NO
encontrará el diff correspondiente; tiene que saber buscar en `d8a3da7`. Esto
es un defecto de higiene de historial (mensajes/commits mal etiquetados), NO
una pérdida de contenido ni una regresión funcional — el código de SR-21 SÍ
está íntegro en HEAD, confirmado en §2-3 abajo.

**Coherencia del contenido real de `15bb31f` (DB-09) con
`docs/auditoria-1/db-api-reverificacion.md`**: confirmada. La fila DB-09 de
ese documento describe exactamente el mecanismo implementado
(`runContextCache` en memoria de proceso poblado por `createRun`/
`recordToolCall`, consultado antes que el oráculo `app.agent_run_context`) y
cita el mismo test (`security-db09-agent-run-context-cache.test.ts`) presente
en el diff de `15bb31f`. `packages/db/migrations/0044_fix_db09_agent_run_
context_bootstrap_guard.sql` está presente y es ancestro de HEAD
(`21b6a8c`, anterior y complementario — mitigación a nivel de función SQL,
distinta de la mitigación en el store TS de `15bb31f`). Sin incoherencias.

**Veredicto §1: CUMPLE con nota** — ancestría lineal confirmada, ningún
contenido perdido (confirmado con hash de árbol, no solo lectura del diff),
pero el historial de `packages/sources` para SR-21 queda permanentemente
mal etiquetado (mensaje real en un commit `TEMP-*`, mensaje de sources en un
commit 100% ajeno). Recomendación (fuera de mandato: solo se documenta, no se
corrige) para una futura limpieza: nunca sería seguro reescribir esto ahora
(`rebase`/`filter-branch` sobre historial ya compartido/citado por otros
documentos) — se deja como nota permanente, igual que ya hace §9 de
`sources-cierre.md`.

## 2. Suite y cobertura

Reproducido en worktree limpio (`npm install`, 730 paquetes):

```
typecheck: OK       lint: OK       build: OK
test:      19 archivos / 186 pruebas — TODAS en verde
coverage:  89.43% líneas / 84.21% ramas / 92.26% funciones
```

Coincide exactamente con lo declarado en `docs/PROGRESO.md` ("186 tests;
cobertura 89.4/84.2") — la bitácora del corrector es honesta.

**Mutación del gate real** (`lines: 85→95`, `branches: 80→90` en
`vitest.config.ts`, archivo restaurado inmediatamente después,
`git diff --stat` vacío confirmado): `test:coverage` falló explícitamente
(`ERROR: Coverage for lines (89.43%) does not meet global threshold (95%)`,
ídem branches, `npm error code 1`). El gate es real, no decorativo.

**Veredicto §2: CUMPLE.**

## 3. Ataques de cierre por hallazgo

### SR-19 — **CERRADO, confirmado sólido**

Vectores nuevos atacados (además de los ya cubiertos por
`compras-mx.test.ts`/`ocds.test.ts` describe "SR-19": `{}`, `{"data":null}`,
`{"data":[]}`, `{"success":false,"error":"captcha"}`):

| Ataque | Resultado |
|---|---|
| `{"data":{}}` (objeto en vez de array) | `ZodError` → `interface_changed`. Sin bypass. |
| `{"data":[{}]}` (elemento vacío en el array) | Pasa el esquema (`registros` interno tiene `.default([])`), 0 registros → `health.state="ok"`, `coverage.emptyResult=true`. **No es un bypass**: es un caso legítimo de "colección presente, un elemento sin datos propios" — indistinguible en la práctica de `{"data":[]}`, y queda igualmente marcado como resultado vacío explícito. |
| JSON como string raíz (`"hola"`) | `ZodError` (`expected object, received string`) → `interface_changed`. |
| Array como raíz (`[]`, `[{"data":[]}]`) | `ZodError` (`expected object, received array`) → `interface_changed`. |
| OCDS `{"releases":[],"error":"x"}` (colección vacía explícita + campo `error` adicional sospechoso) | NO lanza — `releases:[]` es válido por diseño (colección presente), el campo `error` extra se ignora (zod no-estricto). Resultado: 0 registros, `emptyResult:true`. Comportamiento consistente con el diseño documentado (SR-19 solo exige la LLAVE de colección, no valida la ausencia de campos de error sibling) — **no se cuenta como bypass nuevo**, es la extensión natural y esperada de una decisión de diseño ya tomada, pero vale la pena señalar que un backend que reporte error Y colección vacía a la vez sigue leyéndose como "0 legítimo". |
| OCDS `{"error":"algo salio mal"}` (sin `releases`) | `ZodError` → `interface_changed`. Correcto. |

Ningún vector nuevo abre una vía de "silencio interpretado como cero" para
SR-19. **Veredicto: CERRADO, sin residual nuevo.**

### SR-20 — **PARCIAL, residual nuevo confirmado (ver SR-23 en §4)**

Fixtures realistas atacados vía `assertLegitimateResponseBody` directamente:

- **Turnstile real** (`cf-turnstile` + `challenge-platform` en `<script src>`, título "Just a moment...") → `CaptchaDetectedError` (`cf-challenge`). Correcto.
- **Akamai Bot Manager real** ("Pardon Our Interruption", cookie `ak_bmsc`) → `CaptchaDetectedError` (`akamai-bot-manager`). Correcto.
- **Imperva/Incapsula real** ("Incapsula incident ID", `_Incapsula_Resource`) → `CaptchaDetectedError` (`imperva-incapsula`). Correcto.
- **Content-Type `application/json` con cuerpo HTML de challenge**: confirmado por lectura de código y por prueba directa que `assertLegitimateResponseBody` solo recibe el `body` como string — el header nunca se le pasa — la clasificación es 100% sobre contenido, robusta a que el servidor "mienta" en el header. Correcto, sin hallazgo (coincide con lo ya confirmado en la ronda de reverificación 2 para SR-14).

**Dos residuales nuevos confirmados con evidencia directa (no hipotética)**,
ambos alrededor de `minimalContentMarkers` (el mecanismo específico que SR-20
introdujo):

1. **Falso positivo confirmado**: un HTML con contenido de negocio 100%
   legítimo para una convocatoria real del DOF (`SECRETARÍA DE HACIENDA Y
   CRÉDITO PÚBLICO`, `CONVOCATORIA PÚBLICA No. 001`, fecha de publicación),
   pero con una variante de plantilla que no coincide EXACTAMENTE con los 2
   regex hardcodeados (`<title>D.O.F. - Diario Oficial</title>` en vez de
   `"DOF - Diario Oficial de la Federación"`, `id="contenedorNota"` en vez de
   `DivDetalleNota`) → `InterfaceChangedError`. El propio README/JSDoc del
   conector DOF admite que el formato exacto de una nota con convocatorias
   reales **nunca fue confirmado en vivo** ("PENDIENTE VERIFICACIÓN REAL");
   los 2 marcadores usados como "forma mínima esperada" son una suposición
   sobre una plantilla que el equipo nunca vio con datos reales. Riesgo
   real: una nota DOF genuina cuya plantilla varíe mínimamente (año distinto
   de rediseño del sitio, sub-plantilla distinta para cierto tipo de aviso)
   se rechazaría como "cambio de interfaz" de forma permanente hasta que
   alguien actualice los marcadores a mano. Es una falla "ruidosa" (visible,
   no oculta) — no viola la letra de REQ-148 — pero sí genera falsas
   alarmas operativas contra datos reales.
2. **Falso negativo confirmado, END-TO-END con `DiscoveryPipeline` real
   (el más severo de los dos)**: un interstitial JS genérico ("Verificando
   su navegador, por favor espere unos segundos...", con un `<script>` de
   redirección y sin ninguna palabra de vendor conocido) que conserva
   intacto el `<title>` y el `id="DivDetalleNota"` del sitio real de DOF (un
   patrón común en JS-challenges que reenvían la MISMA plantilla/shell antes
   de redirigir) **pasa `assertLegitimateResponseBody` sin lanzar** (no
   matchea ningún `CHALLENGE_MARKERS`, y SÍ matchea `minimalContentMarkers`).
   Confirmado con `DiscoveryPipeline` real:
   `health.state="ok"`, `evidence={"message":"Corrida exitosa sin registros
   nuevos de la fuente.","coverage":{"emptyResult":true}}` — **exactamente
   la violación de REQ-148 que SR-20 debía cerrar**, vía un vector que SR-20
   no contempló: un bloqueo que preserva el "cascarón" HTML del sitio en vez
   de reemplazarlo por completo. `minimalContentMarkers` verifica presencia
   de texto estático de plantilla, no la FORMA real del contenido (sí hay
   avisos de licitación parseables), así que cualquier interstitial que
   reutilice el layout del sitio (común cuando el bloqueo ocurre a nivel de
   JS en el propio cliente/CDN, no reemplazando la página servida) lo
   evade.

Nota adicional (no un hallazgo nuevo, limitación de consumo aguas abajo): se
confirmó por `grep` exhaustivo en `apps/worker`/`apps/api` que **nada fuera
de `packages/sources` lee `SourceHealth.evidence.coverage.emptyResult`
hoy** — el campo que SR-19/SR-20 usan para distinguir "ok real" de "ok con 0
resultados" existe y se calcula correctamente, pero ningún consumidor
downstream lo expone ni actúa sobre él todavía; en la práctica, mientras
eso no cambie, un "ok" con `emptyResult:true` es indistinguible de cualquier
otro "ok" para quien mire solo `health.state` (que es lo que hoy se
persiste/consulta). Esto reduce el valor práctico inmediato del cierre de
SR-19/20, aunque el dato ya esté disponible para cuando se conecte.

**Veredicto: PARCIAL** — vector original (vendors sin marcador, login
genérico) sólidamente cerrado; **nuevo residual SR-23** (ver §4).

### SR-21 — **PARCIAL, residual nuevo GRAVE confirmado (ver SR-24 en §4)**

**Fronteras exactas del umbral (`dropRateThreshold`, default 20%, código usa
`dropRate > threshold`, estrictamente mayor)**, sobre ComprasMX (el único
conector con `reportDropped` conectado):

| Tasa de descarte | `health.state` | Coincide con diseño |
|---|---|---|
| 19.9% (199/1000) | `ok` | sí |
| 20.0% exacto (200/1000) | `ok` (frontera es `>`, no `>=`) | sí, documentado por el propio código/comentario |
| 20.1% (201/1000) | `interface_changed` | sí |
| 1/1 = 100% | `interface_changed` (a pesar de `processedAny=false`) | sí — la reclasificación no depende de que haya al menos un registro procesado |
| 1/1 = 0% | `ok`, `coverage.emptyResult=false` | sí |

Sin bypass en las fronteras: el umbral funciona exactamente como está
documentado, incluyendo el caso extremo de descarte total con un solo
registro intentado.

**Residual GRAVE confirmado, END-TO-END con `DiscoveryPipeline` real**: la
invariante "ningún registro se pierde en silencio" que SR-21 estableció
**solo está conectada para ComprasMX** (`compras-mx-connector.ts` y
`compras-mx-historical-csv-connector.ts` son los ÚNICOS dos lugares del
código que invocan `ctx.reportDropped` — confirmado por `grep` exhaustivo
sobre `src/connectors/`). `create-ocds-connector.ts` — compartido por
`OcdsShcpConnector`, `PdnS6Connector` y `StatePortalConnector`, es decir
**3 de los 4 `SourceId` no-ComprasMX registrados** — **nunca** invoca
`ctx.reportDropped`; internamente, `ocds-mapper.ts`
(`mapOcdsReleaseToTenderRecord`) descarta en silencio, con un simple
`if (!release.tender) return null;`, cualquier release sin bloque `tender`.

Confirmado con un ataque real: un release package OCDS con 5 releases, 4 de
ellos (80%) sin bloque `tender` (simulando exactamente el escenario que
SR-21 debía prevenir: un cambio de interfaz real donde el campo se movió o
renombró) →

```
state: ok   nuevos: 1   dropped: []   errores: []
evidence: {"message":"Corrida exitosa con registros procesados.","coverage":{"emptyResult":false}}
```

**Un descarte del 80% de los datos de una corrida es completamente invisible
para OCDS-SHCP/PDN-S6/portales estatales**: no hay entrada en `dropped[]`,
no hay entrada en `errores[]`, `health.state` sigue `"ok"`, y como sí se
procesó 1 registro, ni siquiera el paraguas de `coverage.emptyResult` (que
al menos cubriría el caso de descarte del 100%, confirmado también en la
misma prueba) se activa. Esta es la MISMA clase de violación de REQ-148 que
motivó SR-21 originalmente, reproducida con evidencia real fuera del único
conector que se corrigió. (Nota de alcance: `mapOcdsReleaseToTenderRecord`
filtrar releases sin `tender` es, en SÍ MISMO, una decisión de diseño
razonable — un release de solo adjudicación/contrato no es una convocatoria
— el defecto no es filtrar, es hacerlo sin ningún reporte cuando la tasa es
alta y podría señalar un cambio de interfaz real en vez de una mezcla
normal de tipos de release.)

**Veredicto: PARCIAL** — vector original (ComprasMX) sólidamente cerrado con
umbral configurable y fronteras exactas verificadas; **nuevo residual grave
SR-24**, invariante rota para 3 de 4 fuentes no-ComprasMX (ver §4).

### SR-22 — **CERRADO para el vector original; 1 nota menor sin numerar**

- **Archivos de 1 byte** (ASCII `'A'`, byte inválido `0xFF`, `NUL` `0x00`) y
  archivo vacío (0 bytes): ninguno lanza; todos decodifican a una cadena de
  longitud correcta (`0xFF`→Latin-1 `'ÿ'`, `NUL`→`' '`). Sin crash.
  Confirma que la guarda `sampleLen < 8` de `detectUtf16Endianness` evita
  falsos positivos/excepciones en archivos degenerados.
- **UTF-16LE/BE con y sin BOM, solo ASCII**: ya cubiertos exhaustivamente por
  `test/encoding.test.ts` existente (líneas dedicadas específicamente a
  "UTF-16LE SIN BOM por heurística" y "UTF-16BE CON/SIN BOM") — reproducidos
  en la corrida normal de la suite (19/19 verdes), sin necesidad de ataque
  adicional.
- **Solo BOM UTF-16LE sin datos** (2 bytes exactos): decodifica a cadena
  vacía, sin lanzar.
- **"Mezcla" real, ruta de streaming** (primer chunk 100% ASCII limpio →
  decide `utf-8`; chunk posterior con un byte alto Latin-1 real, `0xD1`
  `Ñ`): **NO lanza** (el decoder de streaming usa `fatal: false` siempre,
  a diferencia de `decodeBestEffort` que usa `fatal: true` para la
  detección inicial) — el byte inválido se reemplaza en silencio por el
  carácter de reemplazo Unicode (`U+FFFD`, `"�"`), confirmado en la salida
  (`"aaaaaaaN�A"`). **Esto coincide exactamente con la limitación ya
  aceptada y documentada explícitamente en el propio README** ("el encoding
  real no cambia a mitad de un mismo archivo/respuesta" — límite aceptado
  de la ruta streaming, que decide una sola vez sobre el primer chunk). Esta
  reverificación **confirma por primera vez, empíricamente, el mecanismo
  exacto de la falla cuando esa premisa se viola**: corrupción silenciosa
  por reemplazo de carácter, NO una excepción — información nueva que
  refina, pero no contradice, el límite ya divulgado. No se cuenta como
  hallazgo nuevo (ya estaba disclosed), solo se documenta el mecanismo.

**Parser CSV en streaming (`streamCsvRows`/`CsvRowStreamParser`)**:

- Campo entrecomillado con coma Y salto de línea real embebidos, **partido
  exactamente a la mitad entre dos chunks** (dentro del campo, no en un
  límite de fila): reconstruido byte a byte, sin pérdida
  (`"Empresa, S.A.\nde C.V."` íntegro).
- Comilla doble escapada (`""`), **partida justo entre los dos caracteres
  de comilla del par escapado** (el peor caso posible de fragmentación):
  reconstruida correctamente (`'El "Mejor" Proveedor'`).
- Fila final sin salto de línea de cierre, tanto en el mismo chunk que el
  resto del archivo como en un chunk separado final: ambas variantes
  emiten la fila correctamente vía `parser.finish()`. Sin pérdida de la
  última fila de un archivo real (un caso muy común: el exportador legado
  no siempre añade el `\n` final).

**Nota menor sin numerar (severidad BAJA, edge case de red, no de
encoding/CSV en sí)**: un campo entrecomillado que **nunca se cierra** antes
de que termine el stream (simulación de una descarga interrumpida a media
transferencia sobre un archivo de 951 MB, escenario realista en una
conexión inestable) no produce ningún error — el parser simplemente entrega
una fila con el contenido truncado absorbido como si fuera válido, sin
ninguna entrada en `errors[]`. A diferencia de una fila con demasiadas
columnas (SR-17, si detecta explícitamente y reporta), una descarga cortada
a media comilla pasa desapercibida. Bajo impacto (requiere una interrupción
de red exactamente a media cadena entrecomillada) y fuera del foco original
de SR-22 (que es sobre encoding, no sobre truncamiento de transporte) — se
documenta aquí por transparencia, sin asignarle número de hallazgo nuevo.

**Veredicto: CERRADO** para el vector exacto de SR-22 (UTF-16LE/BE +
memoria de streaming), sin residual que amerite un ID nuevo.

## 4. Hallazgos nuevos de esta reverificación (SR-23, SR-24)

| ID | Severidad | Relacionado con | Hallazgo (evidencia) |
|---|---|---|---|
| SR-23 | MEDIA | SR-20 | `assertLegitimateResponseBody` con `minimalContentMarkers` (DOF) tiene doble filo: (a) **falso positivo** confirmado — una nota DOF con contenido de negocio real pero plantilla ligeramente distinta de los 2 regex hardcodeados se rechaza como `interface_changed` (el formato real de una nota con convocatorias nunca fue confirmado en vivo, según el propio README); (b) **falso negativo** confirmado end-to-end con `DiscoveryPipeline` real — un interstitial JS genérico ("verificando su navegador...") que preserva el `<title>`/`id` estáticos del sitio real de DOF pasa sin lanzar, `health.state="ok"`, `coverage.emptyResult=true` — la misma violación de REQ-148 que SR-20 debía cerrar, vía un vector (bloqueo que reutiliza el shell HTML del sitio) no contemplado por el marcador estructural mínimo actual. |
| SR-24 | **ALTA** | SR-21 | `ctx.reportDropped` solo está conectado en `compras-mx-connector.ts`/`compras-mx-historical-csv-connector.ts`. `create-ocds-connector.ts` (compartido por `OcdsShcpConnector`, `PdnS6Connector`, `StatePortalConnector` — 3 de los 4 `SourceId` no-ComprasMX) nunca lo invoca; `ocds-mapper.ts` descarta releases sin bloque `tender` con un `return null` silencioso. Confirmado end-to-end: un release package con 80% de sus releases sin `tender` produce `health.state="ok"`, `dropped:[]`, `errores:[]`, `coverage.emptyResult:false` — la MISMA violación de REQ-148 que motivó SR-21, invisible para 3 de las 4 fuentes que no son ComprasMX. La invariante "ningún registro se pierde en silencio" que la tabla de `sources-cierre.md` §4/§9 y el README (sección "Salud explícita por fuente") describen como ya cerrada solo es cierta para ComprasMX. |

Reparación sugerida (no aplicada, fuera de mi mandato de solo verificación):
SR-23: verificar contra el TEXTO/estructura de un aviso real de licitación
(p. ej. exigir que aparezca al menos un patrón de "convocatoria"/fecha, no
solo el título/id de plantilla del sitio) en vez de (o además de) marcadores
de plantilla estática que un interstitial puede replicar; y ampliar/relajar
los 2 marcadores actuales apenas se confirme el formato real de una nota
DOF con convocatorias. SR-24: extender `ctx.reportDropped` a
`create-ocds-connector.ts` (invocarlo desde `mapOcdsPackageToTenderRecords`
o su llamador por cada release sin `tender`, igual que ya hace
`mapComprasMxApiRecords`), para que `dropRateThreshold` proteja también a
OCDS-SHCP/PDN-S6/portales estatales.

## 5. Balance final del paquete (SR-01 a SR-24)

| Bloque | Veredicto |
|---|---|
| SR-01, SR-04, SR-05, SR-07, SR-08, SR-09, SR-11 (ronda 1) | **CERRADO** — sin cambios ni regresión esta ronda tampoco (fuera del ámbito de los 4 commits revisados) |
| SR-02, SR-06 (cerrados en rondas previas vía SR-12/15-17) | **CERRADO**, confirmado sin regresión |
| SR-03 (cerrado vía SR-14) | **CERRADO**, confirmado sin regresión (ver también SR-19/20/23 como su propia cadena de residuales) |
| SR-10 | Fuera de ámbito de `packages/sources`, sin cambios |
| SR-12 | **CERRADO** — confirmado sin regresión (suite verde, invariante ampliada intacta) |
| SR-13 | **CERRADO** con esta ronda (residual SR-21 corregido para ComprasMX; ver SR-24 para el residual del residual, ahora acotado a OCDS) |
| SR-14 | **CERRADO** con esta ronda para su vector original (residuales SR-19/SR-20 corregidos); SR-19 queda sólido, **SR-20 abre un nuevo residual acotado (SR-23)** |
| SR-15 | **CERRADO** con esta ronda (residual SR-22 corregido: UTF-16LE/BE + streaming de memoria) |
| SR-16, SR-17, SR-18 | **CERRADO**, sin cambios ni regresión esta ronda |
| SR-19 | **CERRADO** — confirmado sólido con 6 vectores adicionales, sin bypass |
| SR-20 | **PARCIAL** — vector original (vendors/login sin marcador) cerrado; **residual nuevo SR-23 (MEDIA)** |
| SR-21 | **PARCIAL** — vector original (ComprasMX, fronteras exactas del umbral) cerrado y confirmado robusto; **residual nuevo GRAVE SR-24 (ALTA)**, invariante rota para 3 de 4 fuentes no-ComprasMX |
| SR-22 | **CERRADO** — UTF-16LE/BE + streaming de memoria confirmados sólidos; 1 nota menor sin numerar (truncamiento de red a media comilla) |

**Conteo total del paquete**: CERRADO 20 de 22 hallazgos originales
(SR-01..SR-18 sin SR-10, más SR-19/SR-22 de esta última ronda) · fuera de
ámbito 1 (SR-10) · PARCIAL 2 (SR-20, SR-21), cada uno con exactamente un
residual nuevo, acotado y de severidad menor que el hallazgo que reemplazan
(MEDIA/ALTA nuevas vs. ALTA/MEDIA-ALTA originales, y en ambos casos el
vector original queda sólidamente cerrado) · **2 hallazgos nuevos** de esta
reverificación (SR-23 MEDIA, SR-24 ALTA).

El patrón de fondo señalado en `sources-cierre.md` §5 (una corrección cierra
exactamente el vector reproducido, pero dos de los residuales más severos
comparten causa raíz de "validación/propagación insuficientemente
generalizada") **se repite una vez más, en su forma más clara hasta ahora**:
SR-24 no es un caso nuevo de esquema permisivo, es literalmente el MISMO
mecanismo (`ctx.reportDropped`) que SR-21 introdujo, implementado en un solo
conector (ComprasMX) de los cinco registrados, sin extenderlo al conector
compartido que sirve a 3 de las otras 4 fuentes. La lección que este
proyecto viene repitiendo en `packages/agents`, `apps/worker` y ahora tres
veces en `packages/sources` (SR-13→SR-21, SR-14→SR-19/20, y ahora SR-21→
SR-24) es la misma: **corregir el síntoma exacto reproducido por el
auditor, en el lugar exacto donde se reprodujo, sin generalizar la
corrección al resto de los lugares estructuralmente equivalentes.**

## 6. Límites aceptados con causa (sin cambios respecto a README/ACEPTACION)

Confirmados sin cambios respecto a `sources-cierre.md` §6:

- **ComprasMX (API en vivo)**: bloqueada por reCAPTCHA (B-02), REQ-079 respetado, no se intenta eludir.
- **OCDS-SHCP / PDN Sistema 6 / portales estatales**: sin URL/API real confirmada, `PENDIENTE VERIFICACIÓN REAL`, sin cambios esta ronda.
- **Heurística de captcha/challenge (`ResponseClassifier`)**: lista finita de marcadores conocidos — límite estructural inherente a cualquier heurística de contenido, reafirmado por SR-23 (un vendor/mecanismo de bloqueo no listado, o que preserva el shell del sitio, sigue pudiendo evadir la heurística).
- **CSV histórico de 951 MB**: streaming implementado esta ronda (SR-22); memoria acotada medida (heap <5× un lote de 2 MiB, >230x más estricto que el 46.38x anterior). Límite aceptado: decisión de encoding/captcha sobre el primer chunk (~64 KiB) de la ruta streaming, confirmado en §3 SR-22 que su violación produce corrupción silenciosa por reemplazo de carácter (no excepción) — mecanismo ahora confirmado empíricamente, límite ya divulgado sin cambios.

## 7. REQ candidatos a estado CUMPLIDO — REQ-148 en particular

- **REQ-151** (TZ America/Mexico_City): sin cambios esta ronda, sigue candidato a CUMPLIDO (confirmado sin regresión: `test/tz-invariant.test.ts` 7/7 verde).
- **REQ-152/153/154** (dedupe/historial/idempotencia): sin cambios, sigue CUMPLE.
- **REQ-004** (registro único de conectores): sin cambios, sigue CUMPLE.
- **REQ-147** (registro `source_runs` con cobertura esperado/obtenido): sin cambios en esta ronda a nivel de `packages/sources`; la persistencia real vive en `apps/worker`/`apps/api` (fuera de este ámbito).
- **REQ-148** (estados explícitos, nunca "cero" silencioso) — **pregunta explícita del mandato: "¿ahora sí?"**. Respuesta: **NO, todavía NO se recomienda CUMPLIDO**, aunque el paquete avanzó sustancialmente: los 3 vectores originales de SR-19/20/21 (soft-block JSON, challenge sin marcador en `expected:"text"`, descarte silencioso de registros incompletos) están sólidamente cerrados PARA ComprasMX y para el caso JSON compartido. Pero esta reverificación confirma, con evidencia end-to-end real y no hipotética, que **el antipatrón exacto que REQ-148 prohíbe sigue siendo alcanzable por 2 vectores nuevos**: (1) SR-24, el más grave — 3 de las 4 fuentes no-ComprasMX pueden perder hasta el 100% de sus datos sin que `health.state` deje de ser `"ok"` ni aparezca ningún rastro en `dropped[]`/`errores[]`; (2) SR-23 — un interstitial de bloqueo que preserva el shell HTML del sitio evade el único mecanismo (`minimalContentMarkers`) que SR-20 añadió específicamente para este propósito en DOF. Debe permanecer `EN_EVIDENCIA`, con la nota adicional de que el mecanismo central (`reportDropped`/`dropRateThreshold`) es sólido en su diseño — el problema es de cobertura de implementación (1 de 5 conectores), no de concepto, lo que sugiere que cerrar SR-24 sería más rápido que las rondas anteriores de este mismo REQ.
- **REQ-168** (relevancia/elegibilidad separadas): sin cambios esta ronda.

## 8. Regresión en consumidores

```
npm run -w apps/worker typecheck   -> OK, sin salida
npm run -w apps/worker test        -> 11 archivos / 298 pruebas — TODAS en verde
npm run -w apps/api typecheck      -> OK, sin salida
```

Coincide exactamente con lo declarado por el corrector en `docs/PROGRESO.md`
("worker 298 OK; api typecheck OK"). Sin regresión.

---

## Nota metodológica

Los 34 casos de ataque (7 archivos temporales `test/ZZZ-reverify3-*.test.ts`)
se ejecutaron exclusivamente en `git worktree add <scratchpad>/reverify3-src
HEAD`; el worktree se eliminó al finalizar (`git worktree remove --force`) y
no quedó ningún archivo temporal en el repositorio (`git status --short`
vacío confirmado en el worktree antes de eliminarlo, y en el árbol principal
antes de este commit). No se modificó código de producción en ningún
momento de esta ronda (a diferencia de la ronda de reverificación 2, que sí
hizo una inyección real revertida) — todos los ataques son archivos de
prueba nuevos que importan las funciones/clases exportadas del paquete tal
como están. La investigación forense del incidente INC-06 (§1) se hizo
enteramente con comandos de lectura (`git log`, `git show`, `git diff`,
`git reflog`, `git merge-base`, `git rev-parse`) sobre el repositorio
principal, sin ninguna escritura ni operación destructiva. Este documento y
`docs/logs/reverify3-sources.log` son los únicos artefactos persistentes de
esta reverificación.
