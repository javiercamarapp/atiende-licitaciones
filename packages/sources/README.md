# @atiende/sources

Librería de descubrimiento de convocatorias de licitación pública en México
(ComprasMX, DOF, OCDS-SHCP, PDN Sistema 6, portales estatales), matching
determinista y detección de cambios/versionado. Implementa REQ-001 a
REQ-005, REQ-006/007 (parcial, léxico), REQ-075/076/077/079,
REQ-132..135 de `docs/REQUISITOS.md`, y la ampliación de
`docs/AMPLIACION-BACKOFFICE.md` §2-3 (salud explícita por fuente y
versionado/detección de cambios).

Alcance de este paquete: **descubrimiento y normalización**, no persistencia
(`apps/api`/`packages/db` implementan `TenderRepository`/`CheckpointStore`/
`SourceHealthStore` reales contra Postgres) ni matching semántico/LLM (queda
como punto de extensión, ver `MatchExplanationEnricher`).

## Verificación en vivo — resumen por fuente (2026-09-05)

**Metodología**: se intentó, con red disponible desde este entorno, una
petición HTTP real de solo lectura (`curl`/`WebFetch`) contra cada fuente
antes de escribir el conector. Cuando el host respondió, se leyó el bundle
JS público de la SPA (si aplica) para localizar el API real subyacente. Se
documenta la evidencia exacta (URL, fecha, código HTTP) — nunca se afirma
integración verificada sin una respuesta 200 real capturada.

| Fuente | ¿Verificado en vivo? | Evidencia clave |
|---|---|---|
| ComprasMX | Parcialmente | Dominio y SPA reales confirmados; API real localizada; **bloqueada por reCAPTCHA** (401 real capturado). CSV histórico alterno SÍ verificado 100% en vivo. |
| DOF | Parcialmente | Dominio y patrón de URLs reales confirmados; formato exacto de convocatorias NO confirmado en la ventana de prueba. |
| OCDS-SHCP | No | `api.datos.gob.mx` inalcanzable (timeout); no se encontró el dataset en el CKAN real de `www.datos.gob.mx`. |
| PDN Sistema 6 | No | `plataformadigitalnacional.org` protegido por bot-detection (Zenedge); `api.plataformadigitalnacional.org` solo sirve nginx por defecto. |
| Portales estatales | No | Ningún host candidato (CDMX/Nuevo León/Yucatán) expone una API EDCA/OCDS localizable hoy. |

Cada conector expone `connector.liveVerification = { verified: boolean, note: string }`
con el detalle completo de lo intentado (ver también los comentarios JSDoc en
cada `*-connector.ts`). `verified: true` en este paquete solo se usa para el
parser OCDS 1.1 genérico (validado contra el estándar público, no contra un
endpoint mexicano) y para el CSV histórico de ComprasMX.

### ComprasMX (sitio operativo de la Plataforma Digital de Contrataciones Públicas)

**Fundamento legal vigente (verificado en `docs/legal/verificacion-legal.md`,
DECISIONES D-07, no re-verificado por esta ronda de correcciones — se cita
tal cual)**: la LAASSP nueva (DOF 16-abr-2025, en vigor desde 17-abr-2025)
sustituyó el nombre legal "CompraNet"/"ComprasMX" por la **"Plataforma
Digital de Contrataciones Públicas"** (Art. 5 fr. XI) y renombró a la
autoridad de la materia como **Secretaría Anticorrupción y Buen Gobierno**
(Art. 5 fr. XVII, antes Secretaría de la Función Pública). **ComprasMX**
(`comprasmx.buengobierno.gob.mx`) sigue siendo el nombre del SITIO
OPERATIVO vigente de esa Plataforma — es la marca real que confirma la
propia SPA en producción (ver abajo) — por lo que este conector mantiene
su `SourceId` técnico `"compras-mx"` (sin cambios, para no romper a
`apps/worker`) mientras usa la nomenclatura legal vigente al describir el
fundamento normativo.

- El portal vigente es **`https://comprasmx.buengobierno.gob.mx/`** (SPA
  Angular real, `GET / -> 200`, confirmado 2026-09-05), operado por la
  **Secretaría Anticorrupción y Buen Gobierno (SABG)** — el dominio
  `buengobierno.gob.mx` es justamente el de SABG. La SPA interna incluye la
  variable de entorno `qr_sitioCompraNet="https://comprasmx.buengobierno.gob.mx/contrataciones/#/"`,
  confirmando que ComprasMX es la marca vigente que sucede a CompraNet (no
  se infiere de fuentes de terceros, se leyó directamente del bundle JS
  público de producción).
- Se localizó el API real (`sitiopublico/main.*.js`, variable
  `qr_sitiopublicoMuleUrl`): `POST https://upcp-cnetservicios.buengobierno.gob.mx/whitney/sitiopublico/expedientes?rows=&page=`.
  Una petición de solo lectura SIN cabeceras de reCAPTCHA devolvió, en vivo:
  `401 {"success":false,"error":"Error","details":"Unauthorized","pid":null}`.
  El mismo servicio exige cabeceras `grc`/`igrc`/`xgrc` (tokens de reCAPTCHA
  v3). **Por política (REQ-079: nunca CAPTCHA-solving) este proyecto NO
  intenta rellenar esas cabeceras.** El esquema de `comprasmx-types.ts`
  (`ComprasMxApiRecordSchema`) es INFERIDO de los nombres de campo usados en
  las plantillas Angular compiladas (`codigo_expediente`, `titulo_expediente`,
  `tipo_expediente`, `tipo_contratacion`, `entidad_federativa_...`), no de un
  payload de respuesta real. **PENDIENTE VERIFICACIÓN REAL** contra un
  payload 200 legítimo (requiere que SABG habilite acceso sin CAPTCHA, o que
  el proveedor exponga una llave de servidor a servidor).
- **SR-09 (auditoría ronda 1)**: una petición de solo lectura independiente
  repetida el mismo día contra el mismo endpoint, sin cabeceras de
  reCAPTCHA, devolvió `403 {"success":false,"error":"Acceso no permitido.",
  "details":"Acceso no permitido. - /whitney/sitiopublico/expedientes -
  None","pid":null}` — un CÓDIGO Y CUERPO distintos del `401
  {"details":"Unauthorized"}` documentado arriba. Ambos resultados
  significan lo mismo (**el endpoint está protegido y este proyecto no
  intenta eludirlo**); la diferencia probablemente sea una huella de
  cliente distinta entre un WAF/edge (403) y el backend aplicativo (401).
  `classifySourceFailure()` clasifica 401 y 403 igual
  (`permission_missing`, ver más abajo), así que la clasificación funcional
  es robusta a esta variación — pero el código/cuerpo exacto de bloqueo NO
  debe tratarse como una constante estable en el tiempo ni usarse para nada
  más que esa clasificación ya robusta.
- Bonus real y 100% verificado: dataset abierto
  `contratos_expedientes_sistema_historico_compranet` (SABG, CKAN de
  `www.datos.gob.mx`, CSV de 951 MB, `last-modified: 2025-07-03`, sin
  reCAPTCHA/auth). Es historial de **contratos ya concluidos 2010-2022**, no
  convocatorias abiertas, y no trae columna de dependencia/entidad
  convocante (limitación documentada en `comprasmx-mapper.ts`). Fixture real
  (primeras filas, descargadas en vivo) en
  `test/fixtures/compras-mx/compranet-historico-real-sample.csv`.
  `parseComprasMxHistoricoCsv()` lo parsea y está cubierto por pruebas.

**Robustez del CSV histórico frente al archivo REAL de 951 MB (SR-15/16/17,
ronda 2 de corrección)**: la muestra verificada en vivo es UTF-8 bien
formada, pero el archivo completo (~951 MB, export de un sistema legado) no
tiene esa garantía. Tres gaps reales, sin evidencia de que ocurran hoy pero
sin protección si el export cambia:

- **Encoding (SR-15)**: `ComprasMxHistoricalCsvConnector` ya NO usa
  `response.text()` (decodifica SIEMPRE como UTF-8 por spec WHATWG,
  ignorando el charset real del servidor). `decodeHttpResponseText()`
  (`src/util/encoding.ts`) decodifica por bytes crudos: usa el charset
  declarado en `Content-Type` si lo hay y no es UTF-8, quita un BOM UTF-8
  explícito, y si nada de eso aplica intenta una decodificación UTF-8
  ESTRICTA — si los bytes no son UTF-8 válido (típico de Latin-1/
  Windows-1252, común en exports legados mexicanos), decodifica como
  `TextDecoder("latin1")` en vez de producir mojibake silencioso. El
  encoding real declarado por el servidor SABG en el archivo completo NO
  fue verificado explícitamente en esta ronda (solo `HEAD`, no `GET`
  completo) — la heurística cubre el caso en que no lo sea.
- **Resiliencia por fila (SR-16)**: `parseComprasMxHistoricoCsv()` valida y
  mapea cada fila en su PROPIO `try/catch`; una fila inválida (p.ej.
  `importe` no numérico) se acumula en `errors[]` con su número de fila,
  sin abortar el resto del lote (antes: una sola fila inválida en
  cualquier punto del archivo hacía perder TODAS las filas válidas, porque
  esta función arma el array completo antes de que el conector empiece a
  producir el primer registro — sigue sin ser streaming, limitación ya
  reconocida).
- **Filas con columnas de más (SR-17)**: `parseCsv()` (`src/util/csv.ts`)
  sigue rellenando con `""` las filas con MENOS columnas que el
  encabezado (tolerable), pero ahora RECHAZA explícitamente (como un error
  de fila con su número, no como un registro desalineado en silencio)
  cualquier fila con MÁS columnas — síntoma típico de una coma sin escapar
  en un campo no entrecomillado (antes: el excedente se descartaba en
  silencio, desalineando el resto de la fila sin ningún aviso).

`ComprasMxHistoricalCsvConnector.discover()` reporta cada fila descartada
vía `ctx.logger?.warn(...)` (visible para el consumidor) sin dejar de
producir los registros válidos del resto del archivo.

### DOF (Diario Oficial de la Federación)

- `https://dof.gob.mx/` responde 200. Usa `nota_detalle.php?codigo=&fecha=DD/MM/YYYY`
  para notas individuales e `index.php?year=&month=&day=` para el sumario
  diario (ambos confirmados en vivo). No expone API JSON/CSV.
  `busqueda_avanzada.php` redirige (302) a un buscador moderno,
  `https://sidof.segob.gob.mx/busquedaAvanzada/busqueda` (formulario POST con
  campos `BUSCAR_EN`/`FechaInicio`/`FechaHasta`/`TIPO_TEXTO`), no explorado
  más a fondo dentro de esta ventana.
- No se localizó, en las fechas muestreadas, una nota real con convocatorias
  de licitación (Sección de Avisos) para confirmar el formato exacto. El
  parser (`extractDofNoticesFromText`) corre sobre un fixture RECONSTRUIDO a
  partir del formato públicamente conocido de avisos de licitación (ver
  comentario en `test/fixtures/dof/nota-avisos-licitaciones.html`).
  **PENDIENTE VERIFICACIÓN REAL.**

### OCDS-SHCP y PDN Sistema 6

- `api.datos.gob.mx` (URL candidata documentada en blueprints de terceros
  para el feed OCDS nacional) fue **inalcanzable por timeout** en todos los
  intentos (raíz, `/v1/`, `/v2/`) desde este entorno.
- `www.datos.gob.mx` SÍ es real y funcional (CKAN, API
  `/api/3/action/package_search` confirmada con consultas reales). Se buscó
  "contrataciones abiertas", "OCDS", "EDCA", "PDN", "sistema 6" y bajo la
  organización `sfp`: **ningún resultado corresponde a un dataset de
  contrataciones abiertas/OCDS nacional**.
- `plataformadigitalnacional.org` responde 200 pero fuerza una redirección
  por JavaScript (protección Zenedge anti-bot) que no se pudo atravesar sin
  ejecutar JS. `api.plataformadigitalnacional.org` responde 200 con la
  página por defecto de nginx (ninguna API desplegada visible ahí hoy).
- Ambos conectores (`OcdsShcpConnector`, `PdnS6Connector`) comparten el mismo
  parser OCDS 1.1 genérico y validado (`ocds-mapper.ts`, fixture mínimo real
  del estándar público en `test/fixtures/ocds-shcp/`), listo para apuntarse
  a la URL real en cuanto el equipo la confirme con SHCP/Secretaría Ejecutiva
  del SNA. **PENDIENTE VERIFICACIÓN REAL de la URL/API vigente.**

### Portales estatales (REQ-135)

`StatePortalConnector` es un conector genérico configurable (reutiliza el
mismo parser OCDS `/edca/...`); no hace scraping específico por estado. Se
verificó en vivo:

- **CDMX**: `datos.cdmx.gob.mx` responde 200 y su API CKAN real
  (`/api/3/action/package_search`) no tiene ningún dataset de "contrataciones
  abiertas"/"edca". `contratacionesabiertas.cdmx.gob.mx` no resuelve por DNS.
- **Nuevo León**: `edca.nl.gob.mx` y `api.nl.gob.mx` no resuelven por DNS.
- **Yucatán**: `transparencia.yucatan.gob.mx` responde 200 (portal general,
  sin API EDCA localizada); `contratacionesabiertas.yucatan.gob.mx` no
  resuelve por DNS.

Los tres quedan en `DEFAULT_STATE_PORTALS` con `baseUrl: undefined` y
`verified: false` — `discover()` los omite sin error. **PENDIENTE
VERIFICACIÓN REAL** por estado (requiere que el equipo confirme con cada
gobierno estatal).

## Límites, reintentos y ToS (REQ-076/077/079)

- `HttpClient` (`src/http/http-client.ts`): timeout por petición, reintentos
  con backoff exponencial + jitter completo para 429/5xx/errores de red,
  respeta `Retry-After` (segundos o fecha HTTP), límite de concurrencia por
  host (`concurrencyPerHost`, default 2) y espaciado mínimo entre peticiones
  por host (`minIntervalMsPerHost`, default 1000 ms = ≤1 req/s), User-Agent
  identificable obligatorio, y **pausa total** de un host tras N (default 3)
  respuestas 403 consecutivas (`HostPausedError`) — nunca se reintenta 403
  automáticamente ni se resuelve CAPTCHA.
- Ningún conector implementa envío/escritura a un portal (solo lectura),
  consistente con REQ-046 (prohibido envío automático a ComprasMX) aunque
  ese requisito es responsabilidad final de `apps/api`.
- `robots.txt`/ToS: documentados por conector (`connector.termsNote`); ver
  las notas específicas arriba. Cuando no se pudo leer un `robots.txt` en
  texto plano (SPAs), se aplican de todas formas los límites generales.

## Modelo normalizado: `TenderRecord`

`src/types/tender-record.ts` — zod. Campos: `source`, `externalId`, `title`,
`contractingEntity`, `procuringUnit`, `procedureType`/`procedureTypeRaw`,
`classifiers[]` (CUCoP/UNSPSC/CPV/other), `budgetAmount`/`currency`,
`dates` (`published`/`clarificationMeeting`/`submissionDeadline`/`award`),
`status`/`statusRaw`, `url`, `attachments[]`, `state`, `snapshot`
(`sourceUrl`/`fetchedAt`/`rawHash` sha256/`httpStatus` — REQ-005 raw lake
inmutable), `sourceCursor` (para checkpoint).

Deduplicación:

1. **Exacta** por `(source, externalId)` — `sourceKey()`, usada por
   `TenderRepository.upsert`.
2. **Cruzada entre fuentes** por huella de título normalizado + entidad
   normalizada + fecha de publicación — `computeCrossSourceFingerprint()`
   (`src/dedupe/fingerprint.ts`), expuesta vía
   `TenderRepository.findByFingerprint`.

### `null` explícito en esquemas de entrada (SR-13, ronda 2 de corrección)

Los campos opcionales de los esquemas zod que validan payloads externos
crudos (`ComprasMxApiRecordSchema`/`ComprasMxHistoricoCsvRowSchema` en
`comprasmx-types.ts`, `DofNoticeSchema`, y todos los esquemas OCDS en
`ocds-types.ts`) usan `optionalNullish()` (`src/util/schema.ts`) en vez de
`.optional()` a secas: un `null` EXPLÍCITO (patrón muy común en APIs JSON
reales de gobierno, distinto de omitir la llave) se normaliza a
`undefined` ANTES de validar, en vez de tumbar el registro completo con un
`ZodError` que `classifySourceFailure` clasificaría como
`interface_changed` — una falsa alarma de "cambio de interfaz" cuando la
estructura real no cambió, solo el valor es `null`. El tipo inferido sigue
siendo `T | undefined` (nunca `T | null | undefined`): el resto del código
que ya maneja "campo ausente" no necesita cambios.

## Zona horaria (ampliación §3)

Todas las fechas de negocio son hora legal de México. México abolió el
horario de verano nacional en 2022, así que `America/Mexico_City` es
**UTC-6 fijo todo el año** (`src/util/timezone.ts`,
`MEXICO_CITY_FIXED_OFFSET = "-06:00"`). `fromMexicoCityNaive()` interpreta
una fecha/hora "naive" (sin zona, como las que trae el DOF) como hora del
Centro. Portales en otras zonas (p.ej. Baja California, Pacífico con DST por
frontera) deberían pasar su propio offset — no se asume la zona del proceso
que ejecuta el conector.

**Invariante (SR-12, ronda 2 de corrección)**: TODA fecha de negocio que
sale de un mapper de este paquete pasa por `fromMexicoCityNaive()` (vía el
wrapper propio de cada conector: `parseComprasMxDate()` en
`comprasmx-mapper.ts` — usado tanto por el API en vivo como por
`parseComprasMxHistoricoCsv()` desde esta ronda —, `parseDofDate()` en
`dof-mapper.ts`, `parseOcdsDate()` en `ocds-mapper.ts`). Antes de esta
ronda, `parseComprasMxHistoricoCsv()` (agregado por un commit posterior al
fix original de SR-02) mapeaba `fecha_inicio`/`fecha_fin` DIRECTO a
`TenderDatesSchema`, reintroduciendo la misma dependencia del `TZ` del
proceso para una fila naive que SR-02 ya había cerrado para el API en vivo.
`test/tz-invariant.test.ts` verifica, en subprocesos reales bajo
`TZ=UTC/America/Mexico_City/Asia/Tokyo`, que los 6 conectores registrados
producen el MISMO instante ante un fixture con fecha naive, y un test
estático (mismo archivo) prohíbe `new Date(<algo>)` con argumento en
`src/connectors/**` fuera de `new Date()` (reloj "ahora").

## Versionado y detección de cambios (ampliación §3)

`src/dedupe/version.ts`:

- `computeVersionHash()`: hash determinista del CONTENIDO de negocio de un
  `TenderRecord` (excluye `snapshot`/`sourceCursor`, que cambian en cada
  fetch aunque nada relevante haya cambiado).
- `detectChanges(previous, next)`: categoriza el cambio en `bases` (título/
  entidad/procedimiento/presupuesto/clasificadores), `aclaraciones` (junta),
  `plazos` (fechas de publicación/presentación/fallo), `anexos`
  (documentos) o `estatus`.
- `isDeadlineMovedEarlier()`: caso de prueba obligatorio "plazo adelantado".
- **Criterio de mayúsculas/acentos en claves de anexo/clasificador (SR-18,
  ronda 2)**: `canonicalizeVersionKey()` (`src/util/hash.ts`, NFD +
  casefold) se usa SOLO para `attachments[].name` y `classifiers[].code` al
  calcular `computeVersionHash()`/`detectChanges()`. Decisión de diseño
  explícita: un cambio SOLO de mayúsculas o acentos en el nombre de un
  anexo o el código de un clasificador (p.ej. volver a subir el mismo
  archivo con el nombre en otro casing) NO dispara una versión falsa — es
  formato incidental, no contenido real, la misma categoría que el orden de
  arrays (SR-01). El contenido real de un anexo vive en `url`/`sha256`, que
  SIGUEN comparándose tal cual (sensibles a cualquier cambio, sin
  excepción): un cambio de hash o de URL del mismo anexo SIEMPRE dispara
  `anexos`/versión nueva. `title`/`contractingEntity`/
  `classifier.description` NO usan este casefold (el casing sí puede ser
  semánticamente significativo ahí).
- `InMemoryTenderVersionStore`: historial **append-only** (nunca se
  sobreescribe una versión), idempotente ante replay exacto (mismo
  `versionHash` -> no crea versión ni dispara evento), y emite
  `ChangeDetectedEvent` en cada modificación real para que los consumidores
  (fuera de este paquete) invaliden tareas/propuestas dependientes.

## Salud explícita por fuente (ampliación §2)

`src/pipeline/source-health.ts`. Nunca se interpreta el silencio/fallo de
una fuente como "cero oportunidades": cada corrida de `DiscoveryPipeline`
produce, por fuente, un `SourceHealth` con estado explícito:

`ok | down | captcha_detected | interface_changed | permission_missing | rate_limited`

`classifySourceFailure()` mapea automáticamente `HttpError`(401/403 ->
`permission_missing`, 429 -> `rate_limited`, 5xx -> `down`),
`HostPausedError` -> `permission_missing`, `CaptchaDetectedError` ->
`captcha_detected`, `InterfaceChangedError`/`ZodError` (el parser no
reconoce la estructura recibida) -> `interface_changed`, y cualquier otro
error -> `down`. El `SourceHealth` conserva `lastSuccessAt` de la última
corrida exitosa aunque la corrida actual falle, y expone `staleForMs`
(frescura/obsolescencia) para que el back office pueda mostrarla
visiblemente en vez de ocultar el problema.

**`ResponseClassifier` (SR-14, ronda 2 de corrección)**:
`src/http/response-classifier.ts`, `assertLegitimateResponseBody(body,
{url, expected})`, común a todos los conectores. Antes de esta ronda, un
`fetchImpl` que devolviera **HTTP 200 real** con un cuerpo HTML de
captcha/bot-challenge (escenario que este mismo README documenta como real
para PDN-S6/Zenedge) hacía que el parser de turno simplemente no encontrara
nada, y `DiscoveryPipeline` reportaba `health.state = "ok"` / "0 nuevas" —
indistinguible de una corrida real sin novedades, la violación exacta que
REQ-148 prohíbe. `assertLegitimateResponseBody()`:

- Lanza `CaptchaDetectedError` si el cuerpo contiene un marcador reconocido
  de reCAPTCHA/hCaptcha/Cloudflare (`cf-challenge`, "checking your
  browser...")/Zenedge/mensajes en español ("verificar/verifica que no eres
  un robot") — sin importar el formato esperado.
- Lanza `InterfaceChangedError` si se esperaba `json`/`csv` y el cuerpo
  tiene forma de documento HTML sin ningún marcador de captcha reconocido
  (cambio de interfaz de la fuente, o un bloqueo genérico no identificado).

Se invoca en `DofConnector` (expected `"text"`, el único conector de
scraping de texto/HTML de hoy), `ComprasMxConnector`, `create-ocds-connector.ts`
(compartido por `OcdsShcpConnector`/`PdnS6Connector`), `StatePortalConnector`
(expected `"json"`) y `ComprasMxHistoricalCsvConnector` (expected `"csv"`).

## Pipeline de descubrimiento

`DiscoveryPipeline` (`src/pipeline/discovery-pipeline.ts`): ejecuta
conectores en paralelo con límite (`concurrency`, default 3 — no confundir
con la concurrencia HTTP por host), normaliza (cada conector ya produce
`TenderRecord` validado), deduplica vía `TenderRepository.upsert`, versiona
vía `InMemoryTenderVersionStore`, guarda `Checkpoint` por fuente tras cada
registro con cursor (permite reanudar exactamente), y produce un
`DiscoveryResult` **idempotente**: correr el pipeline dos veces sobre el
mismo contenido no duplica registros (segunda corrida: 0 nuevos, 0
actualizados). Emite eventos de trazabilidad (`connector-start`,
`record-processed`, `connector-error`, `connector-complete`,
`checkpoint-saved`, `ChangeDetected`).

`TenderRepository`, `CheckpointStore` y `SourceHealthStore` son interfaces;
este paquete solo trae implementaciones en memoria para pruebas —
`apps/api`/`packages/db` implementan las versiones persistentes.

## Registro de conectores (REQ-004)

`ConnectorRegistry` (`src/connectors/registry.ts`) es la ÚNICA estructura
autorizada a asociar un `SourceId` con su implementación. Ningún otro
archivo debe comparar `connector.id === "compras-mx"` (o cualquier otro id)
fuera de `registry.ts`; `test/connectors/registry.test.ts` incluye un test
ESTÁTICO que falla si aparece ese patrón en cualquier otro archivo de `src/`.

## Matching determinista

`MatchingEngine` (`src/matching/matching-engine.ts`): perfil de organización
(`classifierCodes`, `keywords`, `excludedKeywords`, `entities`,
`budgetRange`, `states`) -> `MatchResult` con DOS valores independientes
(REQ-168, AMPLIACION-BACKOFFICE §4):

- `score`/`criteria`: **relevancia** (afinidad léxica/temática) 0-100, con
  explicación por criterio. Solo participan los criterios que el perfil
  define (el peso de los ausentes se redistribuye proporcionalmente, nunca
  penaliza un perfil incompleto). Una palabra clave excluida anula el
  match (score 0, visible en `criteria`).
- `eligibility` (`src/matching/types.ts`, `EligibilityResult`):
  **elegibilidad** (cumplimiento de requisitos duros: presupuesto,
  cobertura geográfica, exclusiones) como `cumple` / `no_cumple` /
  `no_evaluable`, cada criterio con su propia explicación y referencia al
  requisito (`EligibilityCriterionResult.requirement`). Dato ausente en la
  convocatoria SIEMPRE produce `no_evaluable` para ese criterio (nunca se
  infiere "cumple" ni "no_cumple" por ausencia de dato); sin ningún
  criterio de elegibilidad configurado, el agregado es `no_evaluable` (no
  se asume "cumple" por defecto). `no_cumple` tiene prioridad sobre
  `no_evaluable` al agregar el estado.

Sin LLM; el punto de extensión para narrar el resultado con LLM es
`MatchExplanationEnricher` (`src/matching/types.ts`) — el score/elegibilidad
en sí deben seguir siendo deterministas siempre; el LLM solo podría narrar,
nunca recalcular.

## Comandos

```bash
npm install
npm run -w packages/sources typecheck
npm run -w packages/sources lint
npm run -w packages/sources test
npm run -w packages/sources build
```

Salida real de la primera corrida en `docs/logs/sources-ronda1.log`; ronda
2 de corrección (SR-12..SR-18, ver `docs/auditoria-1/sources-reverificacion.md`)
en `docs/logs/fix-sources-ronda2.log`.

## Pendientes explícitos (no inventar integración real)

1. ComprasMX: acceso sin reCAPTCHA al endpoint `expedientes` (requiere
   decisión/gestión con SABG; no se debe intentar resolver el CAPTCHA).
2. DOF: confirmar el formato exacto de un aviso de convocatoria real
   (Sección de Avisos) y, si aplica, evaluar el buscador SIDOF.
3. OCDS-SHCP / PDN Sistema 6: confirmar con el equipo la URL/API vigente (si
   existe) del feed OCDS nacional y del Sistema 6 de la PDN.
4. Portales estatales: localizar y verificar, estado por estado, la URL real
   del patrón `/edca/...` (CDMX, Nuevo León, Yucatán y los demás del roadmap).
5. `SourceHealthStore`/`CheckpointStore`/`TenderRepository` persistentes:
   implementación real en `packages/db`/`apps/api` (aquí solo en memoria).
