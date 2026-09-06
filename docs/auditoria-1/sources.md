# Auditoría adversarial — packages/sources (ronda 1)

**Ámbito auditado**: `packages/sources/**` en el commit
`3dc9ce72357e0f85eb938c55d01f1b1576ef8993`
("feat(sources): add discovery pipeline for MX tender sources (ComprasMX, DOF,
OCDS-SHCP, PDN-S6, state portals)").

**Auditor**: agente Sonnet independiente, sin participación en la construcción de este
paquete. Ejecución real de: `npm install`, `typecheck`/`lint`/`test`/`build`, 11 pruebas
adversariales propias y 5 mutaciones manuales de reglas clave — todo en un `git worktree`
separado (`git worktree add`), nunca en el árbol principal. Se hicieron además peticiones
HTTP de solo lectura reales (sin resolver CAPTCHA ni tocar áreas autenticadas) contra cada
fuente declarada para contrastar la evidencia del README. El worktree fue eliminado
(`git worktree remove --force`) al terminar; no queda ningún archivo de prueba adversarial
en el repositorio.

**Comandos y salida completa**: `docs/logs/audit-sources-ronda1.log`.

---

## Resumen ejecutivo

`packages/sources` es, en general, un paquete honesto: su README documenta con
extraordinario detalle qué se verificó en vivo y qué no (evidencia exacta: URL, fecha,
código HTTP, tamaño de bytes), declara `liveVerification.verified = false` para 4 de 5
conectores, y su lista de "Pendientes explícitos" es consistente con `docs/PROGRESO.md`.
La reproducibilidad es perfecta: 11 archivos / 64 pruebas en verde, typecheck/lint/build
limpios, igual que `docs/logs/sources-ronda1.log`. Repetí de forma independiente una
petición de lectura contra cada una de las 5 fuentes declaradas (ComprasMX dominio y API,
DOF, OCDS-SHCP, PDN-S6, CDMX) y contra el CSV histórico de ComprasMX: **todas las
afirmaciones cuantificables del README (tamaño del CSV en bytes, `Last-Modified`, tamaño
exacto de la nota del DOF, 0 resultados CKAN de CDMX, timeout de `api.datos.gob.mx`,
página nginx+Zenedge de PDN) se confirmaron de forma independiente**, con una única
excepción parcial: el 401 exacto de ComprasMX no se reprodujo (ver SR-09).

Sin embargo, la auditoría adversarial encontró varios **gaps de comportamiento reales,
no solo teóricos**, en las áreas que el propio `AMPLIACION-BACKOFFICE.md` §2-3 marca como
"tolerancia cero" (estados explícitos de fuente, versionado sin duplicados/falsos
positivos, zona horaria correcta):

- **Reordenar un array (`classifiers`/`attachments`) sin cambiar su contenido dispara una
  "nueva versión" y un evento `ChangeDetected` reales** — porque el hash de versión y
  `detectChanges` comparan arrays por orden posicional, no por contenido. Esto es
  exactamente la "falsa versión" que la ampliación pide comprobar, y puede invalidar en
  cascada matrices/expedientes/aprobaciones (REQ-155/REQ-162) sin que nada haya cambiado
  realmente.
- **Las fechas del conector ComprasMX (esquema inferido, nunca confirmado contra un
  payload real) NUNCA pasan por `fromMexicoCityNaive()`**, a diferencia del conector DOF
  que sí lo hace explícitamente. Con una prueba en subproceso real (dos TZ de proceso
  distintos, mismo dato de entrada) confirmé que el mismo campo de fecha produce
  **instantes que difieren 6 horas** según si el servidor de producción corre en UTC
  (default común de contenedores) o en `America/Mexico_City`. Esto es precisamente el
  supuesto de zona horaria que la ampliación pide cuestionar.
- **El conector DOF, con su configuración por defecto (`noteCodes: []`), nunca toca la
  red y aun así reporta `health.state = "ok"` / "Corrida exitosa sin registros nuevos"**
  — indistinguible de una corrida real sin novedades. Es exactamente el antipatrón que
  REQ-148 prohíbe explícitamente ("nunca se interpreta el silencio como cero
  oportunidades"), producido no por una fuente caída sino por una fuente jamás consultada.
- **Una redirección HTTP cross-host (302) no pasa por el límite de concurrencia, el
  espaciado mínimo ni la pausa por 403 del host de destino** — confirmado con un
  experimento HTTP real (dos servidores locales, redirect A→B): las 5 peticiones
  concurrentes contra A llegaron sin ningún límite a B. El propio README documenta un
  caso real de esta forma (`DOF` redirige a `sidof.segob.gob.mx`).
- **Mutation testing (5 reglas)**: 4 de 5 mutaciones manuales fueron detectadas por la
  suite oficial (versión por plazo, dedupe/idempotencia, `Retry-After`, checkpoint); 1 de 5
  (clasificación de `HttpError(401|403)` → `permission_missing` en
  `classifySourceFailure`) **no está cubierta por ningún test** — solo se prueba
  `HostPausedError`, `HttpError(429)`, "captcha" y `ZodError`.

Ninguno de estos hallazgos contradice una afirmación explícita de "hecho"/"verificado" del
README (que en general es prudente y declara `PENDIENTE VERIFICACIÓN REAL` donde
corresponde); son gaps de comportamiento real del código frente a los requisitos de
`AMPLIACION-BACKOFFICE.md` §2-3, no evidencia de deshonestidad deliberada.

---

## 1. Reproducibilidad

Reproducido en worktree limpio (`npm install`, 627 paquetes):

```
typecheck: OK (tsc --noEmit, sin salida)
lint:      OK (eslint src test --ext .ts, sin salida)
test:      11 archivos / 64 pruebas — TODAS en verde
build:     OK (tsc -p tsconfig.build.json)
```

Idéntico a `docs/logs/sources-ronda1.log` (mismo conteo de archivos/tests por suite, mismos
nombres). Ver `docs/logs/audit-sources-ronda1.log` para la salida completa de esta ronda.
**Veredicto: CUMPLE.**

## 2. Veracidad de la verificación real (contraste README vs. peticiones propias)

Repetí, el mismo día, una petición de lectura mínima contra cada fuente declarada (sin
CAPTCHA-solving ni credenciales):

| Fuente | Petición propia | Resultado propio | Coincide con README |
|---|---|---|---|
| ComprasMX (dominio) | `GET https://comprasmx.buengobierno.gob.mx/` | `200` | Sí |
| ComprasMX (API) | `POST .../whitney/sitiopublico/expedientes?rows=5&page=1` sin cabeceras reCAPTCHA | `403 {"success":false,"error":"Acceso no permitido.",...}` | **Parcial** — README documenta `401 {"details":"Unauthorized"}` (ver SR-09) |
| DOF (dominio) | `GET https://dof.gob.mx/` | `200` | Sí |
| DOF (nota real citada) | `GET .../nota_detalle.php?codigo=5797937&fecha=04/09/2026` | `200`, `716478` bytes | Sí, tamaño exacto coincide |
| OCDS-SHCP | `GET https://api.datos.gob.mx/v2/contratacionesabiertas` | timeout (10s, sin respuesta) | Sí |
| PDN-S6 | `GET https://api.plataformadigitalnacional.org/` | `200`, página nginx por defecto (con script Zenedge embebido, no mencionado explícitamente) | Sí (con detalle adicional) |
| Portal estatal (CDMX) | `GET .../api/3/action/package_search?q=contrataciones+abiertas` | `success:true, count:0` | Sí |
| CSV histórico ComprasMX | `HEAD` sobre la URL citada en el test | `content-length: 951619345` (≈951 MB), `last-modified: Thu, 03 Jul 2025` | Sí, coincide exactamente con "951 MB" y "2025-07-03" del README |

El fixture `test/fixtures/compras-mx/compranet-historico-real-sample.csv` (15 filas de
datos, 5788 bytes) es internamente consistente con el dataset real confirmado arriba (mismas
columnas, mismo formato de fecha con offset `+00:00`); no se alteró ni se recortó de forma
engañosa — el README ya declara explícitamente que son solo "las primeras filas". El fixture
del DOF (`nota-avisos-licitaciones.html`) está correctamente marcado como
"RECONSTRUIDO"/"PENDIENTE VERIFICACIÓN REAL" en el propio archivo y en el README, no como
real. El esquema `ComprasMxApiRecordSchema` está correctamente marcado como "INFERIDO ...
no de un payload de respuesta real".

**Único desajuste encontrado**: la evidencia citada de ComprasMX (`401 Unauthorized`) no se
reprodujo en mi propia petición (`403 Acceso no permitido`, cuerpo distinto) — ver **SR-09**.
`parseComprasMxHistoricoCsv` (la única integración "100% real y verificada") nunca se invoca
desde ningún `SourceConnector` registrado — ver **SR-06**.

**Veredicto: PARCIAL** (el grueso de las afirmaciones cuantificables se confirmó
independientemente; el 401 exacto de ComprasMX no, y el "bono real" del CSV no está
integrado al pipeline real).

## 3. Honestidad de estados (SourceHealth)

`classifySourceFailure()` (`src/pipeline/source-health.ts`) mapea correctamente
`HostPausedError`→`permission_missing`, mensajes con "captcha"→`captcha_detected`,
`ZodError`→`interface_changed`, `HttpError(429)`→`rate_limited`,
`HttpError(401|403)`→`permission_missing`, cualquier otro→`down` — confirmado por
`test/pipeline/discovery-pipeline.test.ts` para todos los casos **excepto**
`HttpError(401|403)`, que no tiene test directo (confirmado por mutación, ver §8).
`interface_changed` sí se detecta con una heurística real (`instanceof ZodError`), no solo
"cualquier excepción de parser genérica" — es sólida en el sentido de que un cambio real de
esquema (el parser deja de reconocer los campos) SIEMPRE produce un `ZodError` porque todos
los mappers terminan en `parseTenderRecord()`/`*Schema.parse()`.

**Encontré una forma real de producir "0 nuevas" sin que la fuente haya fallado ni haya
sido consultada**: el conector DOF con su configuración por defecto
(`createDofConnector()` sin `noteCodes`) nunca llama a `ctx.http.request` (el bucle
`for (const codigo of codes)` itera sobre un arreglo vacío) y aun así
`DiscoveryPipeline` registra `health.state = "ok"`, `evidence.message = "Corrida exitosa
sin registros nuevos de la fuente."` — indistinguible en el back office de una corrida real
sin novedades. Ver **SR-03**.

**Veredicto: PARCIAL.**

## 4. Versionado y cambios

`InMemoryTenderVersionStore` es correctamente idempotente ante replay exacto (mismo
`versionHash` → no crea versión ni evento, confirmado por test oficial y por mi propia
ejecución del pipeline dos veces), preserva historial append-only, y
`isDeadlineMovedEarlier()` detecta correctamente el caso "plazo adelantado" (confirmado por
test oficial + mutación).

**Encontré una fuente real de "falsa versión"**: `computeVersionHash()` usa
`stableStringify()` (`src/util/hash.ts`), que ordena las CLAVES de los objetos
recursivamente pero **no ordena el contenido de los arrays**. `detectChanges()` compara
`classifiers`/`attachments` con `JSON.stringify` directo (ni siquiera con
`stableStringify`). Confirmé con una prueba propia que dos `TenderRecord` con el MISMO
conjunto de clasificadores en distinto ORDEN producen `versionHash` distintos y disparan
`ChangeDetected` con `changes: ["bases"]` (y análogamente `"anexos"` para `attachments`
reordenados) sin que el contenido de negocio haya cambiado realmente. Esto es relevante en
la práctica porque ninguna API real garantiza el mismo orden de array entre dos respuestas
(paginación, orden no determinista del backend, etc.). Ver **SR-01**.

Zona horaria: `MEXICO_CITY_FIXED_OFFSET = "-06:00"` es correcto (México abolió el DST
nacional en 2022; el propio comentario del código cita el decreto). `fromMexicoCityNaive()`
funciona correctamente para el conector DOF (confirmado por test oficial:
`parseDofDate("10/09/2026")` → `2026-09-10T06:00:00.000Z`, es decir 00:00 CDMX). **Pero
`comprasmx-mapper.ts` nunca llama a `fromMexicoCityNaive()`** para
`fecha_publicacion`/`fecha_junta_aclaraciones`/`fecha_apertura_proposiciones`/`fecha_fallo`
— pasan directo a `TenderDatesSchema` (`z.coerce.date()`, que delega en `new Date(string)`).
Confirmé con una prueba en subproceso real (dos procesos Node, `TZ=UTC` vs.
`TZ=America/Mexico_City`, mismo dato de entrada `"2026-09-10T14:00:00"`) que el
`submissionDeadline` resultante **difiere 6 horas** según el TZ del proceso — es decir, el
resultado depende de un ajuste de entorno externo al código, no de una conversión de zona
horaria explícita como la que sí existe para DOF. Dado que el esquema de ComprasMX está
declarado "INFERIDO... no confirmado" y los backends gubernamentales mexicanos suelen
emitir fecha/hora sin offset, este es un riesgo de producción real, no solo hipotético. Ver
**SR-02**. Nota: el sandbox de esta auditoría tiene `TZ=America/Merida` por defecto del
sistema operativo (confirmado con `Intl.DateTimeFormat().resolvedOptions().timeZone`), lo
que hace que el bug sea invisible en pruebas manuales rápidas dentro de este entorno —
motivo de más para exigir una prueba explícita con TZ inyectado.

Sobre dedupe por huella con títulos casi iguales de **entidades distintas**: no encontré
falsos positivos en ese sentido exacto — `computeCrossSourceFingerprint()` incluye la
entidad normalizada, así que dos títulos parecidos de entidades distintas SÍ producen
huellas distintas (comportamiento correcto, confirmado con los tests oficiales existentes).
Pero sí encontré el caso adyacente que la ampliación también le preocupa a la práctica: dos
procedimientos DISTINTOS y REALES de la **misma** entidad, con un título administrativo
genérico compartido ("Adquisición de material de oficina") y la misma fecha de publicación,
colisionan en la misma huella aunque sus `externalId` sean distintos. Hoy el riesgo práctico
es bajo porque `findByFingerprint()` no se invoca desde ningún punto de
`DiscoveryPipeline`/`processRecord` (es un método expuesto pero no usado en la fusión
automática), pero cualquier consumidor futuro que confíe en la huella para fusionar
heredaría el falso positivo sin aviso. Ver **SR-07**.

**Veredicto: PARCIAL.**

## 5. HttpClient

Confirmado correcto: backoff exponencial acotado (`Math.min(maxDelayMs, base*2^attempt)`)
con jitter completo (`random() * capped`, determinista si se inyecta `random`);
`Retry-After` se parsea correctamente tanto en segundos (`^\d+$`) como en fecha HTTP
(`Date.parse` + resta contra `now`), con test oficial cubriendo el caso de segundos y
confirmado indirectamente por mutación (ver §8); pausa total tras N 403 consecutivos
(`HostPausedError`), que exige `resetHostPause()` manual — nunca se reintenta 403
automáticamente (confirmado con test oficial); User-Agent identificable aplicado siempre
que el llamador no lo sobreescriba; la clave de throttle (`new URL(url).host`) sí
diferencia correctamente por puerto y por subdominio (dos hosts distintos → dos
`HostThrottle` independientes, comportamiento correcto).

**Concurrencia bajo carga real (50 peticiones)**: el test oficial solo prueba 6 peticiones
con reloj falso. Repetí el experimento con 50 peticiones reales concurrentes
(`concurrencyPerHost: 3`, timers reales, sin fake clock): `maxInFlight` nunca superó 3,
`totalCalls = 50` — el límite se sostiene correctamente a mayor escala.

**Encontré un gap real en redirecciones cross-host**: monté dos servidores HTTP locales
(A en un puerto, B en otro) donde A responde `302` hacia B, y disparé 5 peticiones
"concurrentes" reales contra A con `concurrencyPerHost: 1`. Las 5 llegaron a B sin ningún
límite, porque el redirect ocurre **dentro** de una sola llamada a `fetch()` — el
`HostThrottleRegistry` nunca se entera de que la petición terminó siendo atendida por otro
host, así que ni `concurrencyPerHost`, ni `minIntervalMsPerHost`, ni la pausa por 403
repetidos del host de destino se aplican jamás. El propio README documenta un caso real de
esta forma (`DOF`: `busqueda_avanzada.php` → 302 → `sidof.segob.gob.mx`). No se detectó
fuga de cabeceras sensibles: en el mismo experimento, `Authorization`/`Cookie` inyectados
en la petición original NO llegaron al host B (comportamiento correcto del `fetch`/`undici`
subyacente, que los descarta en redirects cross-origin por spec); `User-Agent` sí se
propaga (no es sensible). Ver **SR-04**.

**Veredicto: PARCIAL.**

## 6. DiscoveryPipeline (idempotencia y checkpoints)

Confirmado con pruebas oficiales + mi propia ejecución en worktree limpio: correr el
pipeline dos veces sobre el mismo contenido produce `nuevos=0, actualizados=0,
sinCambios=N` en la segunda corrida, sin duplicar filas en el repositorio (A2, replay
exacto). El checkpoint por cursor permite reanudar exactamente desde donde se cortó
(confirmado con test oficial que fuerza un checkpoint intermedio manualmente).

Confirmé con una prueba propia que **un conector que lanza una excepción a mitad de su
`AsyncIterable` NO tumba a los demás conectores del mismo `run()`** (cada `runConnector` se
ejecuta en su propio `try/catch` dentro del worker de `runWithConcurrencyLimit`) **y
conserva los registros ya emitidos ANTES del throw** (el `for await` procesa
incrementalmente; el registro emitido antes de la excepción sí queda en `nuevos` y en el
repositorio) — comportamiento correcto y más matizado de lo que exige la ampliación (no
solo "no tumba a los demás", sino "no descarta el trabajo parcial ya hecho").

No se probaron explícitamente límites de memoria con un `AsyncIterable` de gran volumen
(no encontré ni agregué un test de ese tipo dado el volumen de trabajo restante); dado que
el pipeline procesa registro por registro con `for await` sin acumular arreglos completos
en memoria (el único arreglo dimensionado por `runWithConcurrencyLimit` es del tamaño del
número de CONECTORES, no de registros), el diseño es estructuralmente streaming y de bajo
riesgo, pero esto queda como **verificación no realizada** más que como hallazgo.

**Veredicto: CUMPLE**, con la salvedad de memoria no verificada explícitamente.

## 7. MatchingEngine

`MatchingEngine` es puramente determinista (mismo input → mismo output, confirmado por
test oficial), acota el score a `[0,100]`, redistribuye pesos proporcionalmente solo entre
criterios configurados (no penaliza un perfil incompleto), y una palabra clave excluida
anula el match con score `-100`/`maxScore 0` visible en `criteria` (veto duro, no solo
resta). Cada criterio expone una `explanation` legible.

**No implementa ningún concepto de "elegibilidad" separado de "relevancia"**: todo el
motor produce un único `score` 0-100 con criterios de matching léxico
(clasificadores/palabras clave/presupuesto/entidad/estado); no existe un campo booleano ni
un estado "no evaluable" distinto del score numérico en `MatchCriterionResult`/`MatchResult`
(`src/matching/types.ts`). Para presupuesto/estado ausentes, el motor asigna un score
NEUTRO (0.5/1) que SÍ se explica en prosa ("score neutro... no disponible") pero que un
consumidor que solo lea `.score` no puede distinguir de "evaluado, coincide a medias". El
propio README acota correctamente el alcance ("REQ-006/007 parcial, léxico"; matching
semántico y elegibilidad quedan fuera de este paquete), así que esto **no contradice**
ninguna afirmación del README, pero tampoco lo registra en su lista de "Pendientes
explícitos" pese a que AMPLIACION §4 y REQ-168 (prioridad alta) exigen explícitamente
"relevancia y elegibilidad... como dos valores independientes". Ver **SR-11**.

**Veredicto: PARCIAL** (correcto y honesto dentro del alcance declarado; el alcance
declarado no cubre un requisito de prioridad alta y ese vacío no está anotado donde
correspondería anotarlo).

## 8. Calidad de pruebas / mutación

Mutación manual de 5 reglas clave, cada una revertida antes de continuar
(`git diff --stat` limpio al finalizar, confirmado):

| # | Regla mutada | Archivo | Detectada por la suite oficial |
|---|---|---|---|
| 1 | `HttpError(401\|403)` → `permission_missing` desactivado (`if (false)`) | `source-health.ts` | **NO** — 10/10 tests de `discovery-pipeline.test.ts` siguieron en verde |
| 2 | `detectChanges` deja de comparar `submissionDeadline` en "plazos" | `version.ts` | Sí — 3 tests fallan (`dedupe.test.ts` x2, `discovery-pipeline.test.ts` x1) |
| 3 | `InMemoryTenderRepository.upsert` → `wasNew` siempre `true` | `repository.ts` | Sí — 1 test falla (idempotencia, `nuevos` esperado 0 recibido 2) |
| 4 | `parseRetryAfterMs` siempre retorna `undefined` | `retry.ts` | Sí — 1 test falla (`http-client.test.ts`, `sleep` llamado con 0 en vez de 7000) |
| 5 | `DiscoveryPipeline` ignora el `cursor` del checkpoint guardado | `discovery-pipeline.ts` | Sí — 1 test falla (reanudación de checkpoint) |

**4/5 detectadas. La mutación #1 no fue detectada por ningún test** — ver **SR-05**. Esto
es un hallazgo real de cobertura, no solo teórico: confirma que existe una rama de código
(`HttpError(401)`/`HttpError(403)` → `permission_missing`, la clasificación que aplica
justo al caso documentado de ComprasMX) que puede romperse sin que CI lo note.

No hay `vitest --coverage` configurado (ni `vitest.config.ts` con umbrales); la métrica de
cobertura de este rubro se basa en conteo de tests + mutación manual, no en un reporte de
cobertura de líneas/ramas.

Trazabilidad REQ (los que el propio README de `packages/sources` declara implementar):

| REQ | Evidencia en el código | Estado |
|---|---|---|
| REQ-001 (ingesta horaria + dedupe) | `DiscoveryPipeline` + `sourceKey()`; el "horaria" (scheduler) NO está en este paquete (ver REQ-146) | Parcial |
| REQ-004 (registro único de conectores) | `ConnectorRegistry` + test estático que escanea `src/` en busca de `=== "<sourceId>"` fuera de `registry.ts` — verifiqué que el test realmente recorre el filesystem, no es un mock | Cumple |
| REQ-005 (raw lake inmutable, sha256+URL+cabeceras+fetchedAt) | `SourceSnapshotSchema` (`sourceUrl`,`fetchedAt`,`rawHash`,`httpStatus`); "nunca se reescribe" depende de la persistencia real en `packages/db` (fuera de este paquete, correctamente indicado en README) | Parcial (solo el modelo, no la garantía de storage) |
| REQ-076/077/079 (concurrencia/reintentos/rate) | `HttpClient`/`HostThrottle` — ver §5 | Cumple con el gap de redirects (SR-04) |
| REQ-132..135 (conectores) | 5 conectores + `liveVerification` explícito | Cumple (honesto sobre lo no verificado) |
| REQ-146 (scheduler por fuente, cadencia auditable) | **No implementado en `packages/sources`** (no hay cron/interval por fuente en `src/`); el propio README NO lo lista entre lo que implementa (correcto), pero `docs/PROGRESO.md` sí lista "REQ-146..155" como alcance de esta ronda sin aclarar que el scheduler quedó fuera | Ver **SR-10** |
| REQ-147 (`source_runs`) | `SourceHealth`/`SourceHealthStore` en memoria; tabla real en `packages/db` (fuera de alcance, correctamente indicado) | Parcial |
| REQ-148 (estados explícitos, nunca "cero" silencioso) | `classifySourceFailure` — ver §3 (gap real: SR-03) | Parcial |
| REQ-149 (frescura/obsolescencia) | `staleForMs`/`lastSuccessAt` preservado entre corridas fallidas (confirmado por test oficial) | Cumple |
| REQ-150 (verificación puntual documentada antes de "activo") | `liveVerification.verified` — 4/5 conectores en `false` con evidencia | Cumple |
| REQ-151 (TZ America/Mexico_City) | `fromMexicoCityNaive` solo aplicado en DOF, no en ComprasMX — ver **SR-02** | Parcial |
| REQ-152 (dedupe por identidad+versión, 0 filas nuevas en reingesta) | Confirmado por test oficial + réplica propia | Cumple |
| REQ-153 (historial completo consultable) | `InMemoryTenderVersionStore.history()` append-only | Cumple |
| REQ-154 (idempotencia de detección de cambios) | Confirmado, con el matiz de **SR-01** (reordenar arrays rompe la idempotencia semántica) | Parcial |
| REQ-155 (invalidación de dependientes ante cambio) | El paquete solo EMITE `ChangeDetectedEvent`; la invalidación real es responsabilidad de un consumidor fuera de este paquete (correctamente indicado) — pero un evento espurio por **SR-01** dispararía esa invalidación sin causa real | Parcial |

No encontré ningún pendiente declarado (README "Pendientes explícitos", 5 ítems) que se
haya marcado como "hecho" en otro documento del repo; `docs/PROGRESO.md` y
`docs/BACKLOG.md` (épica E3, estado "PENDIENTE") son consistentes entre sí sobre lo que
falta.

**Veredicto: PARCIAL.**

---

## Tabla de hallazgos

| ID | Severidad | Rubro | Hallazgo (evidencia) | Reparación sugerida (separada, no aplicada) | Estado reparación |
|---|---|---|---|---|---|
| SR-01 | **ALTA** | 4. Versionado | Reordenar `classifiers[]`/`attachments[]` sin cambiar su contenido produce un `versionHash` distinto y dispara `ChangeDetectedEvent` con `changes: ["bases"]`/`["anexos"]` reales. Causa: `stableStringify()` (`src/util/hash.ts:14-34`) ordena claves de objeto recursivamente pero NO ordena elementos de array; `detectChanges()` (`src/dedupe/version.ts:47,64`) compara `classifiers`/`attachments` con `JSON.stringify` directo (posicional). Confirmado con 2 pruebas propias (`computeVersionHash` distinto para el mismo conjunto reordenado; `InMemoryTenderVersionStore.record()` dispara `ChangeDetected` real). Riesgo: cualquier fuente cuyo backend no garantice orden estable de array (paginación, orden no determinista) generaría versiones/eventos falsos que invalidarían en cascada matriz/expediente/aprobaciones (REQ-155/REQ-162) sin causa real. | Ordenar (por una clave estable, p. ej. `code`/`scheme` para clasificadores, `url`/`name` para adjuntos) los arrays ANTES de hashear en `comparableContent()`, y usar la misma normalización en `detectChanges()` en vez de `JSON.stringify` posicional directo. | CORREGIDO — commit `fix(sources): SR-01 canonicaliza hash de versión (orden de arrays + NFC + espacios)`. Test que reproduce y falla antes del fix: `test/dedupe.test.ts` > describe `SR-01: hash de versión canónico...` (3 casos: reordenar classifiers/attachments no genera versión; cambiar un anexo real sí; NFC/NFD+espacios no genera versión). Fix: `computeVersionHash`/`detectChanges` en `src/dedupe/version.ts` ahora canonicalizan `classifiers[]`/`attachments[]` (orden estable `scheme:code`/`url:name`) y campos de texto (NFC + espacios colapsados) vía `canonicalizeWhitespaceAndUnicode` (`src/util/hash.ts`) antes de hashear/comparar. Suite completa: 68/68 tests en verde, typecheck limpio. |
| SR-02 | **ALTA** | 4. Versionado / TZ | `comprasmx-mapper.ts` mapea `fecha_publicacion`/`fecha_junta_aclaraciones`/`fecha_apertura_proposiciones`/`fecha_fallo` directo a `TenderDatesSchema` (`z.coerce.date()` → `new Date(string)`), SIN pasar por `fromMexicoCityNaive()` (a diferencia de `dof-mapper.ts`, que sí lo hace). Confirmado con prueba en subproceso real: el mismo dato de entrada (`"2026-09-10T14:00:00"`, naive) produce `submissionDeadline` = `2026-09-10T14:00:00.000Z` con `TZ=UTC` pero `2026-09-10T20:00:00.000Z` con `TZ=America/Mexico_City` (diferencia de 6 horas). El esquema de ComprasMX está marcado "INFERIDO... no confirmado contra un payload real" — si el API real emite fecha/hora sin offset (común en backends de gobierno mexicanos) y el servidor de producción corre en UTC (default típico de contenedores), el plazo de presentación quedaría registrado 6 horas antes de lo real. | Enrutar cualquier cadena de fecha sin offset explícito de ComprasMX/OCDS/portales estatales a través de `fromMexicoCityNaive()` (o su equivalente), en vez de dejar la interpretación a `z.coerce.date()`/`new Date()`, cuyo resultado depende del TZ del proceso. | CORREGIDO — commit `fix(sources): SR-02 fechas de ComprasMX/OCDS pasan por fromMexicoCityNaive()`. Test que reproduce y falla antes del fix (en SUBPROCESO real, no simulable dentro del mismo proceso vitest): `test/timezone-independence.test.ts` (spawns `test/tz-harness/print-comprasmx-deadline.ts` con TZ=UTC/America/Mexico_City/Asia/Tokyo; antes del fix el mismo dato naive `2026-09-10T14:00:00` producía 3 instantes distintos). Fix: `fromMexicoCityNaive()` (`src/util/timezone.ts`) ahora respeta un offset explícito si ya viene en la cadena y solo reinterpreta como hora de México cuando es naive; `comprasmx-mapper.ts` y `ocds-mapper.ts` (compartido por OCDS-SHCP/PDN-S6/portales estatales) enrutan sus 4 campos de fecha a través de esa función. Suite completa: 69/69 tests en verde, typecheck limpio. |
| SR-03 | **ALTA** | 3. Honestidad de estados | `createDofConnector()` sin `noteCodes` (valor por defecto `[]`) nunca invoca `ctx.http.request` (el `for` itera sobre un arreglo vacío) y `DiscoveryPipeline` registra `health.state = "ok"` con `evidence.message = "Corrida exitosa sin registros nuevos de la fuente."` — indistinguible de una corrida real sin novedades. Confirmado con 2 pruebas propias (0 llamadas HTTP, pipeline completo con `health.state === "ok"`). No hay ningún crawler automático de índice diario (`index.php?year=&month=&day=`) implementado en este paquete que alimente `noteCodes`; ese cableado es responsabilidad de un consumidor externo (`apps/api`/worker) que el README no advierte explícitamente como requisito de seguridad para evitar este antipatrón. | El conector debe distinguir explícitamente "corrida sin códigos configurados" (estado propio, p. ej. `not_configured`/`interface_changed`) de "corrida real sin novedades"; como mínimo, emitir un evento/advertencia visible cuando `discover()` produce 0 llamadas HTTP por falta de `noteCodes`. | CORREGIDO — commit `fix(sources): SR-03 estado not_configured cuando un conector no toca la red`. Test que reproduce y falla antes del fix: `test/pipeline/discovery-pipeline.test.ts` > "SR-03: createDofConnector() sin noteCodes NUNCA reporta ok..." (0 llamadas HTTP confirmadas por spy, antes health.state==="ok", ahora "not_configured"). Fix: nuevo estado `not_configured` en `SourceHealthState` (`src/pipeline/source-health.ts`, aditivo — ya lo consumía `apps/worker` como `SourceRunFineState`) y nueva `SourceNotConfiguredError` (`src/connectors/types.ts`) que `classifySourceFailure` mapea a ese estado; `createDofConnector().discover()` la lanza explícitamente cuando `noteCodes` está vacío, antes de iterar (0 llamadas HTTP reales). Suite completa: 72/72 tests en verde, typecheck y lint limpios. `npm run -w apps/worker typecheck` falla por una causa NO relacionada y preexistente (`apps/worker/src/handlers/run-agent.ts`, `ToolDefinition.declaredEffects`, trabajo en curso de otro agente en `packages/agents`; ese archivo no importa `@atiende/sources`). |
| SR-04 | MEDIA | 5. HttpClient | Una redirección 302 hacia otro host/puerto ocurre íntegramente dentro de una sola llamada a `fetch()`, por lo que el `HostThrottleRegistry` del `HttpClient` nunca aplica `concurrencyPerHost`/`minIntervalMsPerHost`/pausa-403 al host de DESTINO. Confirmado con experimento HTTP real (2 servidores locales, A→302→B, `concurrencyPerHost:1`): las 5 peticiones concurrentes llegaron sin límite a B. El propio README documenta un caso real de este patrón (`DOF busqueda_avanzada.php` → 302 → `sidof.segob.gob.mx`). No se observó fuga de cabeceras sensibles (`Authorization`/`Cookie` correctamente descartadas cross-origin por el `fetch` subyacente; ver "Comprobado correcto"). | Fijar `redirect: "manual"` en `fetchWithTimeout` y re-entrar la petición al destino a través de `request()` (para que pase por el throttle/pausa del host real), o rechazar explícitamente redirecciones cross-host dado el alcance de solo-lectura de REQ-079. | CORREGIDO — commit `fix(sources): SR-04 throttle/pausa aplicados al host de destino tras redirección`. Test que reproduce y falla antes del fix: `test/http-client.test.ts` > describe "HttpClient: redirecciones cross-host (SR-04)" (5 casos: concurrencyPerHost del host de destino tras redirect cross-host con 5 orígenes distintos; Authorization/Cookie NO se reenvían cross-host pero sí se preservan same-host; redirección a esquema no-https rechazada; límite de saltos; redirect same-host normal sigue funcionando). Fix: `fetchWithTimeout` ahora fija `redirect: "manual"`; `HttpClient.request()` delega a un `requestInternal` privado que, ante un 3xx con `Location`, valida https, aplica el límite de saltos (`maxRedirects`, default 5) y reentra la petición al host de destino a través de sí mismo (por lo que throttle/espaciado/pausa-403 se evalúan para ESE host), descartando `Authorization`/`Cookie`/`Proxy-Authorization` si el host cambia y degradando método/cuerpo a GET para 303 (o 301/302 sobre POST), igual que `fetch` nativo. API pública sin cambios (`request(url, init)` misma firma); `maxRedirects` es una opción nueva opcional. Suite completa: 77/77 tests en verde, typecheck y lint limpios. |
| SR-05 | MEDIA | 8. Calidad de pruebas | Ningún test ejercita `classifySourceFailure(new HttpError(401,...))` ni `HttpError(403,...)` directamente (solo `HostPausedError`→`permission_missing`, `HttpError(429)`→`rate_limited`, mensaje "captcha"→`captcha_detected`, `ZodError`→`interface_changed`, y error genérico→`down`). Confirmado por mutación manual: desactivar esa rama (`if (false)` en vez de la condición real) dejó los 10/10 tests de `discovery-pipeline.test.ts` en verde. Esta es justo la clasificación que aplicaría al caso documentado de ComprasMX (401/403 real). | Agregar un test explícito con `new HttpError(401, url, body)` y `new HttpError(403, url, body)` pasando por un conector real vía `DiscoveryPipeline`, análogo a los ya existentes para 429/`HostPausedError`. | CORREGIDO — commit `fix(sources): SR-03 estado not_configured cuando un conector no toca la red` (a90888c; SR-05 se resolvió junto con SR-03 al tocar el mismo archivo de test, documentado explícitamente en el cuerpo del commit). Test que reproduce la cobertura faltante: `test/pipeline/discovery-pipeline.test.ts` > "clasifica un HttpError(401) como permission_missing (SR-05...)" y su par para 403, vía `DiscoveryPipeline` con un conector real que lanza `HttpError`. Confirmado manualmente que la mutación descrita por la auditoría (desactivar la rama 401/403 en `classifySourceFailure`) SÍ hace fallar estos 2 tests nuevos (antes pasaba 10/10 sin detectarla). No se tocó código de producción (la clasificación ya era correcta; solo faltaba cobertura). Suite completa: 72/72 tests en verde. |
| SR-06 | MEDIA | 2. Veracidad de integración | `parseComprasMxHistoricoCsv()` (el "bonus real y 100% verificado en vivo" del README) no está envuelto en ningún `SourceConnector` ni se invoca desde `createComprasMxConnector().discover()`; solo se ejercita desde `test/connectors/compras-mx.test.ts`. El `ConnectorRegistry`/`DiscoveryPipeline` real nunca la usa — el conector `compras-mx` registrado depende exclusivamente del endpoint bloqueado por reCAPTCHA. En la práctica, ninguna corrida real del pipeline de descubrimiento obtiene datos de ComprasMX hoy, pese a existir una función 100% verificada y probada para un dataset real. | Envolver el CSV histórico en su propio `SourceConnector` (aunque se documente como "solo benchmark histórico, no descubrimiento de convocatorias abiertas") o, como mínimo, aclarar en el README/BACKLOG que ningún dato real fluye hoy por `DiscoveryPipeline` para esta fuente. | Pendiente |
| SR-07 | MEDIA | 4. Dedupe | `computeCrossSourceFingerprint()` (título normalizado + entidad normalizada + fecha de publicación por día) colisiona entre dos procedimientos REALES y distintos (externalId distinto) de la misma entidad, publicados el mismo día, con un título administrativo genérico compartido (confirmado con prueba propia: dos records con `externalId` "PROC-A"/"PROC-B" producen la misma huella). El riesgo práctico actual es bajo porque `findByFingerprint()` no se invoca desde `DiscoveryPipeline`/`processRecord` (no hay fusión automática hoy), pero el tipo/documentación no advierte este riesgo a un consumidor futuro. | Documentar explícitamente en el JSDoc de `findByFingerprint`/`computeCrossSourceFingerprint` que un resultado es "candidato a revisar", nunca fusión automática; considerar añadir una señal adicional (monto estimado, primeras palabras del objeto/descripción) a la huella. | Pendiente |
| SR-08 | BAJA | 8. Calidad de pruebas | No hay `vitest.config.ts` ni script con `--coverage`; no se puede cuantificar "cobertura real" más allá de conteo de tests + mutación manual (que sí se hizo, ver §8). | Agregar `@vitest/coverage-v8` y un script `test:coverage` con umbral mínimo, igual que en otros paquetes del monorepo. | Pendiente |
| SR-09 | BAJA | 2. Veracidad de la verificación | Mi petición de solo lectura contra el endpoint real de ComprasMX (`POST .../expedientes?rows=5&page=1`, sin cabeceras reCAPTCHA) devolvió `403 {"success":false,"error":"Acceso no permitido.","details":"Acceso no permitido. - /whitney/sitiopublico/expedientes - None","pid":null}`, NO el `401 {"details":"Unauthorized"}` documentado textualmente en el README/JSDoc del conector y usado como ejemplo en `test/connectors/compras-mx.test.ts` (el test usa un mock, no depende de esto). No compromete la clasificación funcional (`classifySourceFailure` trata 401 y 403 igual: `permission_missing`), pero indica que el código/cuerpo exacto de bloqueo observado varía (probable diferencia de huella de cliente entre un WAF/edge y el backend aplicativo) y que la evidencia puntual citada como fija puede no ser estable en el tiempo. | Anotar en el README que el código de bloqueo observado puede variar entre 401 (app) y 403 (edge/WAF) según el cliente, y no depender de él para nada más que la clasificación ya robusta a ambos casos. | Pendiente |
| SR-10 | BAJA | 8. Trazabilidad REQ | `docs/PROGRESO.md` (Ronda 1, packages/sources) lista "REQ-146..155" como alcance de la ronda, pero REQ-146 (scheduler de ingesta configurable por fuente, cadencia declarada/auditable) no tiene ninguna implementación en `packages/sources` (no hay cron/interval por fuente en `src/`). El propio README del paquete es honesto y no lo incluye en su lista de "Implementa REQ-...". `docs/BACKLOG.md` mantiene la épica E3 en "Estado: PENDIENTE", así que no hay una marca falsa de "cerrado", pero la trazabilidad podría ser más precisa. | Anotar explícitamente en `docs/PROGRESO.md` que REQ-146 (scheduler) queda pendiente de implementar, fuera del alcance de `packages/sources` (corresponde a `apps/api`/worker). | Pendiente |
| SR-11 | MEDIA | 7. MatchingEngine | `MatchingEngine` solo calcula "relevancia" (score léxico 0-100); no existe ningún concepto de "elegibilidad" independiente en `src/matching/types.ts`/`matching-engine.ts`, pese a que `AMPLIACION-BACKOFFICE.md` §4 y REQ-168 (prioridad alta) exigen explícitamente exponer relevancia y elegibilidad como dos valores independientes. El README acota correctamente el alcance del paquete ("parcial, léxico") y no reclama REQ-168, pero tampoco anota este vacío en su propia lista de "Pendientes explícitos" (que sí detalla otros 5 pendientes). Para presupuesto/estado ausentes, el motor asigna un score numérico neutro (0.5) sin un campo booleano "no evaluable" distinto del score. | Agregar el punto a "Pendientes explícitos" del README de `packages/sources`, y/o exponer un campo `eligibility: "not_evaluated"` explícito en `MatchResult` para dejar sin ambigüedad que este paquete no evalúa elegibilidad. | Pendiente |

---

## Comprobado correcto

- **Reproducibilidad exacta**: 11 archivos / 64 pruebas en verde, typecheck/lint/build
  limpios, igual a `docs/logs/sources-ronda1.log` (§1).
- **Verificación en vivo del README confirmada de forma independiente** para: dominio
  ComprasMX (200), dominio y nota exacta del DOF (200, 716478 bytes idénticos), timeout de
  `api.datos.gob.mx` (OCDS-SHCP), página nginx+Zenedge de `api.plataformadigitalnacional.org`
  (PDN-S6), 0 resultados CKAN de CDMX para "contrataciones abiertas", y tamaño/fecha exactos
  del CSV histórico de ComprasMX (951,619,345 bytes, `Last-Modified: 2025-07-03`) — todos
  coinciden con lo documentado (§2).
- **`HttpClient` — backoff, `Retry-After`, pausa por 403**: backoff exponencial acotado con
  jitter completo; `Retry-After` respetado tanto en segundos como en fecha HTTP (test
  oficial + confirmado indistinguible por mutación); pausa total tras 403 repetidos que
  exige `resetHostPause()` manual, nunca reintento automático de 403 (test oficial).
- **Concurrencia por host bajo carga real (50 peticiones)**: `concurrencyPerHost` se
  mantiene con timers reales (no solo fake clock) a una escala mayor que la del test
  oficial (6 peticiones) — verificado con prueba propia (`maxInFlight ≤ 3` con 50
  peticiones concurrentes).
- **Sin fuga de cabeceras sensibles en redirect cross-host**: `Authorization`/`Cookie`
  inyectados en la petición original no llegaron al host de destino en el experimento real
  (comportamiento correcto del `fetch` subyacente); solo el LÍMITE de tasa/concurrencia no
  se propaga al host destino (SR-04), no las credenciales.
- **Aislamiento entre conectores en el mismo `run()`**: un conector que lanza a mitad de su
  `AsyncIterable` no afecta a otro conector sano en el mismo `pipeline.run()` Y conserva los
  registros ya emitidos antes del throw (confirmado con prueba propia: `nuevos: 1` para el
  conector que falló a mitad, `nuevos: 2` intactos para el conector sano).
- **Idempotencia y checkpoints**: replay exacto produce `0 nuevos/0 actualizados` en la
  segunda corrida sin duplicar filas (test oficial + confirmado en worktree limpio);
  reanudación desde el cursor guardado en vez de reprocesar desde el inicio (test oficial,
  confirmado indistinguible por mutación); `staleForMs`/`lastSuccessAt` se preservan
  correctamente entre una corrida exitosa y una fallida posterior.
- **Versionado — plazo adelantado**: `isDeadlineMovedEarlier()` detecta correctamente el
  caso obligatorio de la ampliación (test oficial + confirmado indistinguible por
  mutación, con 3 tests fallando al romper la regla).
- **Registro de conectores (REQ-004)**: el test estático que prohíbe `=== "<sourceId>"`
  fuera de `registry.ts` realmente recorre el filesystem de `src/` (no es un mock ni una
  lista fija) — verifiqué el código de `test/connectors/registry.test.ts` y confirmé que
  usa `readdirSync`/`readFileSync` reales sobre el árbol de fuentes.
- **`MatchingEngine` determinista y acotado**: mismo input produce siempre el mismo
  output; score acotado a `[0,100]`; exclusión dura por palabra clave anula el match de
  forma visible en `criteria` (no solo internamente); pesos se redistribuyen solo entre
  criterios configurados por el perfil, sin penalizar campos no configurados.
- **README y `docs/PROGRESO.md` honestos sobre el estado real**: 4 de 5 conectores
  declaran `liveVerification.verified = false` con evidencia detallada (URL, fecha, código
  HTTP); los fixtures reconstruidos/no confirmados (DOF, esquema de ComprasMX) están
  marcados explícitamente como tales en el propio código y comentarios, no presentados
  como reales; ningún pendiente declarado del README aparece marcado como "hecho" en
  `docs/BACKLOG.md`/`docs/PROGRESO.md` (la épica E3 permanece en "PENDIENTE").

---

## Nota metodológica

Todas las pruebas adversariales y las 5 mutaciones se ejecutaron en
`git worktree add <scratchpad>/audit-src 3dc9ce7`, nunca en el árbol principal; el
worktree fue eliminado (`git worktree remove --force`) al finalizar y no se modificó ningún
archivo de `packages/sources/src` ni `packages/sources/test` de forma persistente. El único
archivo de prueba adversarial creado (`test/_audit-adversarial.test.ts`) nunca se
commiteó y se eliminó junto con el worktree. Las peticiones HTTP de verificación fueron
todas de solo lectura (`GET`/`HEAD`, y un único `POST` de solo lectura sin cuerpo útil
contra el endpoint ya documentado como bloqueado), sin intentar resolver CAPTCHA ni acceder
a áreas autenticadas, consistente con REQ-079. Este documento y
`docs/logs/audit-sources-ronda1.log` son los únicos artefactos persistentes de esta
auditoría.
