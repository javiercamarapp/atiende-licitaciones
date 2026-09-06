# Reverificación adversarial — `apps/api` ronda 6 (R6-01..R6-09)

Fecha: 2026-09-06. Agente: **reverificador adversarial independiente (Opus,
respaldo autorizado por el usuario porque Sonnet está limitado, D-10)**,
contexto separado. Rol: **SOLO HALLAZGOS** — ningún archivo de código de
`apps/api`, `packages/db`, `apps/web` ni `apps/worker` fue modificado en el
repositorio principal por este agente. Lo único que este agente escribe son
los dos informes de reverificación y `docs/logs/reverify-r6-wk6.log`.

**Metodología.** Se reutilizó el `git worktree` desechable que había dejado
el agente Sonnet cortado a mitad
(`<scratchpad>/reverify-r6-wk6`, commit `cd803a4`), tras comprobar con
`git diff --stat cd803a4 525ac2d -- apps/api apps/worker packages/db
packages/agents package-lock.json` que era **byte a byte idéntico al HEAD
real** para toda la superficie auditada, y que los 8 commits de reparación
(`83b806d b50e45d be4a37a b8fa205 11aafb2 aa16d15 13ee279 cef42a8`) son
ancestros suyos. Se eliminaron sus restos huérfanos
(`zz-audit-r604-debug.test.ts`, `zz-repro-pdf*.mjs`) antes de empezar. El
árbol principal **nunca** se tocó con `reset`/`checkout <commit>`/`stash`/
`rebase`/`amend`/`add -A`.

Para cada hallazgo se aplicó la **mutación inversa** de su corrección dentro
del worktree, se corrieron los tests que deberían atraparla, y se revirtió
el archivo verificando con `diff` que quedaba idéntico byte a byte. Además
se escribieron 4 archivos de prueba adversariales temporales
(`zz-rv-pdf`, `zz-rv-radar`, `zz-rv-concurrency`, `zz-rv-crossorg`),
ejecutados y **borrados** al terminar (`git status` del worktree limpio,
verificado en el log). Evidencia real de comandos y salidas:
`docs/logs/reverify-r6-wk6.log`.

**Entorno**: Node v25.6.1, npm 11.12.1, macOS (Darwin 24.6.0), fuera de
iCloud Drive (`/private/tmp`).

---

## Resumen ejecutivo

Ocho de las nueve correcciones son **reales y con red de pruebas**: revertir
cada una pone la suite en rojo. La excepción es **R6-04**: el código
corregido es correcto, pero su test "de concurrencia" **pasa exactamente
igual con y sin la corrección** (mutación inversa VERDE) — el 409 que
observa no lo produce el `UPDATE` condicionado sino la validación del grafo,
porque bajo PGlite (una sola conexión) `Promise.all` no produce
entrelazado real. La afirmación del acta de reparación *"Confirmado EN
VIVO... una 200, la otra 409"* describe un mecanismo que no es el que
ocurre (R6-10). El criterio estructural de R6-09 **sí puede satisfacerse
trivialmente** con una sola consulta sin límite que traiga todo (12
sentencias, test verde) — lo que salva la situación es el test *vecino* de
paginación por cursor, no el criterio en sí. Se encontraron además tres
defectos nuevos con impacto real: los límites anti "PDF bomb" se aplican
**después** de hacer todo el trabajo (263 KB → **42 s** de CPU síncrona,
R6-11), el endpoint de lectura del radar no pagina en absoluto
(60.000 alertas / **32,4 MB** en una respuesta, R6-12), y la suite de
`apps/api` es **intermitente en el HEAD actual** por un flake de reloj en el
helper compartido de 2FA (pasada 1 roja, pasada 2 verde, R6-13). El resto de
la superficie atacada — PDFs con object streams, cifrados, páginas vacías,
50 MB, truncados; radar con 0/1/20.000 contratos y dedupe; barrido cross-org
de los 18 endpoints post-adjudicación — se comprobó **correcto**, con
evidencia en vivo.

### Suites completas ×2 (worktree aislado, HEAD real)

| Pasada | Resultado |
|---|---|
| `npm run -w apps/api test` (1ª) | **342/343**, 1 archivo rojo — `expediente-inconformidad.test.ts` (ver R6-13). 285.0 s |
| `npm run -w apps/api test` (2ª) | **343/343** verde. 387.6 s |

El acta de reparación declara "288/288 en dos pasadas" en un worktree y
"322/322 y 326/326" en el árbol real. En el HEAD de esta reverificación el
total es **343** (otros agentes sumaron tests) y **la primera pasada fue
roja**: el gate de esa ronda no es reproducible tal como está declarado.

---

## Veredicto por hallazgo original

### R6-01 — **CONFIRMADO REPARADO**

`pdf-parse@1.1.1` ya no figura en `apps/api/package.json` (solo se menciona
en comentarios históricos); el motor es `pdfjs-dist` legacy. Los dos
fixtures reales (`test/fixtures/pdf/xref-stream.pdf`, `xref-classic.pdf`) se
extraen: `xref-stream=extracted xref-classic=extracted`.

**Mutación inversa** (hacer que `extractPdfPages` lance
`"Unknown compression method in flate stream"` ante `/Type /XRef`, que es
exactamente lo que hacía `pdf-parse@1.1.1`) → **ROJO**: `2 archivos
fallan, 5 tests | 8 pasan (13)`, con `expected 'failed' to be 'extracted'`
— el mismo síntoma que denunciaba el hallazgo original.

### R6-02 — **CONFIRMADO REPARADO**

`sourcePage` sale de `concatWithPageBoundaries`/`pageForIndex`, es decir de
los rangos de offset de páginas **reales**.

**Mutación inversa** (volver a la aproximación proporcional
`floor(index/total * nPáginas)+1`) → **ROJO**: `expected 1 to be 2` en
`expediente-contract-extraction.test.ts`.

Ataque adicional: un PDF generado por `pdf-lib` con **object streams**
(`/ObjStm` + XRef stream) de 3 páginas se extrae con `pageCount=3` y cada
página contiene su propio marcador (`PAGINA-OBJSTM-1/2/3`) — página real,
no aproximada.

### R6-03 — **CONFIRMADO REPARADO**

**Mutación inversa** (dedupe una consulta por alerta, el N+1 original) →
**ROJO**, y el número medido es contundente: `consultas SQL=15019` frente al
umbral `< 100` (`expected 15019 to be less than 100`).

Escala nueva verificada en vivo: **20.000 contratos / 60.000 alertas** en
una sola petición → `consultasSQL=58`, `elapsed=8999ms`, `truncated=false`;
el re-escaneo completo crea **0** alertas nuevas.

### R6-04 — **REPARADO EN CÓDIGO, PERO SIN RED DE PRUEBAS Y CON EVIDENCIA DECLARADA FALSA** → ver R6-10

El `UPDATE` sí lleva `and status = $4` y responde 409 con `currentStatus`, y
el mecanismo funciona: un `UPDATE` con un `fromStatus` obsoleto afecta
**0 filas** (verificado en vivo, `RV-CONC-3`). Pero:

**Mutación inversa** (quitar `and status = $4`) → **VERDE**:
`Test Files 1 passed (1) / Tests 6 passed (6)`. El test
`R6-04: dos transiciones concurrentes...` pasa **igual sin la corrección**.

La causa, medida: el 409 de la segunda petición no viene del `UPDATE`
condicionado sino de `checkTransition`. Cuerpo literal de la respuesta 409:

```
"Transición inválida: \"contrato_firmado_declarado\" -> \"contrato_firmado_declarado\".
 Estados permitidos desde \"contrato_firmado_declarado\": en_ejecucion, modificado, ..."
```

y no el mensaje del camino de carrera (*"El estado del contrato cambió
mientras se procesaba"*). Se instrumentó explícitamente:
`ORIGEN REAL DEL 409: VALIDACION-DEL-GRAFO (checkTransition)`.

Se detalla como hallazgo nuevo **R6-10**.

### R6-05 — **CONFIRMADO REPARADO**

**Mutación inversa** (quitar `and contract_id = $3` de la consulta del
documento y `and d.contract_id = $3` de la del campo) → **ROJO**:
`expected 200 to be 404` en el test cruzado entre dos contratos de la misma
organización.

### R6-06 — **CONFIRMADO PARCIAL, como se declaró**

`apps/api/src/lib/step-up.ts:36` dice ahora "migración 0066". La primera
línea de `packages/db/migrations/0066_...sql` sigue siendo
`-- 0065_r6_step_up_purposes_contract_inconformidad.sql`, y la
justificación declarada es **real**: `packages/db/src/migrate.ts` calcula un
`sha256` del contenido de cada migración aplicada (`function checksum`,
columna `checksum text not null`), así que editar el comentario invalidaría
la verificación en cualquier base ya migrada. Límite honesto, no un pendiente
disfrazado.

### R6-07 — **CONFIRMADO REPARADO (cobertura)**

**Mutación inversa** (`loadOfficialHolidays` devuelve `[]` siempre) →
**ROJO**: `expected '2026-01-13T00:00:00.000Z' to contain '2026-01-14'` — el
test sí depende del feriado cargado en `calendar_holidays`, no solo de
sábado/domingo.

### R6-08 — **CONFIRMADO REPARADO (cobertura)**

**Mutación inversa** (`viability: 'media'` → `'alta'`) → **ROJO**:
`expected 'alta' to be 'media'`.

### R6-09 — **CONFIRMADO REPARADO en lo que arreglaba; el criterio ES trivialmente satisfacible** → ver R6-14

Verdadero lo reparado: ningún `assert` depende de milisegundos
(`expect(scanQueries).toBeLessThan(100)`), y el tiempo solo se imprime. La
pregunta del despacho —¿puede satisfacerse trivialmente con una sola
consulta sin límite que traiga todo?— se respondió **ejecutándola**:

Se mutó `scanContractsPage` para quitar `limit $3`, ignorar `pageSize` y
forzar `hasMore: false` (una sola consulta que trae **todos** los contratos
de la organización, sin paginación). Resultado real:

```
R6-03 perf: 5000 contratos, primer escaneo=1027ms, consultas SQL=12
R6-03 perf: 5000 contratos, segundo escaneo (dedupe)=266ms, consultas SQL=9
✓ R6-03: 5,000 contratos ... se escanean con un numero de consultas O(paginas) ...
× R6-03: paginación por cursor ... → expected 1 to be 3
```

Es decir: **el test del criterio estructural PASA** con la implementación
degradada (12 sentencias, muy por debajo de 100); lo que atrapa la
regresión es el **otro** test, el de paginación por cursor. La red existe,
pero no es la que el acta de R6-09 presenta como criterio. Se registra como
**R6-14 (BAJA)**.

---

## Hallazgos nuevos

### R6-10 — MEDIA. El test de R6-04 es vacuo: pasa con y sin la corrección, y el acta atribuye el 409 a un mecanismo que no es el que ocurre

**Rubro**: máquina de estados (REQ-051), concurrencia / honestidad de la
evidencia.

**Evidencia**: mutación inversa VERDE (arriba) + el cuerpo literal del 409 +
la traza instrumentada `ORIGEN REAL DEL 409: VALIDACION-DEL-GRAFO
(checkTransition)`. Se repitió con 5 peticiones simultáneas al mismo destino
válido: `codigos=[200,409,409,409,409]`, historial encadenado correcto
(`adjudicado->contrato_firmado_declarado`,
`contrato_firmado_declarado->en_ejecucion`, `en_ejecucion->entregado`) y
`audit_log contract.transition total=3` — todo correcto, pero **por el
grafo**, no por la carrera.

Causa raíz: PGlite es de una sola conexión y serializa las transacciones, así
que `Promise.all` de dos peticiones HTTP **no** produce dos lecturas del
estado antes de que cualquiera confirme. La segunda transacción empieza
cuando la primera ya hizo commit, lee el estado nuevo y muere en
`checkTransition`. La ventana que R6-04 vino a cerrar nunca se abre en este
entorno de pruebas.

El `UPDATE` condicionado **sí funciona**: se comprobó de forma determinista
(no dependiente de una carrera) ejecutando el mismo `UPDATE ... and status =
$fromStatus` con un `fromStatus` ya obsoleto — `afecto 0 filas`, y el
contrato conserva su estado real. Ese es el test que faltaba.

**Severidad**: MEDIA. El código de producción es correcto; lo que no existe
es la red de regresión, y el acta de reparación declara como "confirmado en
vivo" algo que su test no confirma. Cualquiera que en el futuro quite
`and status = $4` (refactor, merge) pasaría los 343 tests.

**Reparación sugerida (no aplicada)**: añadir un test determinista del
`UPDATE` condicionado con un `fromStatus` obsoleto (0 filas ⇒ 409 con el
mensaje de carrera), y en el test de `Promise.all` afirmar sobre el
**mensaje** del 409, no solo sobre el código. Documentar en el propio test
que PGlite no puede reproducir el entrelazado real (mismo caveat B-03 que
`apps/worker` ya declara).

### R6-11 — ALTA. Los límites anti "PDF bomb" (AE-05) se evalúan DESPUÉS de hacer todo el trabajo: 263 KB de entrada = 42 s de CPU en el handler HTTP

**Rubro**: extracción de contrato/bases (REQ-052), disponibilidad.

**Evidencia (en vivo)**: `extractPdfPages` recorre **todas** las páginas
(`for (let p = 1; p <= pdf.numPages; p += 1) { getPage; getTextContent }`) y
solo **después** `extractDocumentText` comprueba
`pageCount > MAX_PDF_PAGES (500)` y
`totalLength > MAX_EXTRACTED_TEXT_LENGTH (5.000.000)`. Medido:

```
bomba de paginas: archivo=269069 bytes (263 KB) para 20.000 paginas
bomba de paginas: status=requires_ocr pageCount=20000 elapsed=42141ms
```

**42,1 segundos** por un archivo de 263 KB, muy por debajo del límite de
subida (~22 MB de `decodeBase64Content`). Peor: como las páginas están en
blanco, el texto concatenado queda vacío y gana la rama `requires_ocr`
(línea 192) **antes** que la comprobación de `MAX_PDF_PAGES` (línea 203) —
el límite de 500 páginas **ni siquiera llega a dispararse**, y el usuario
recibe "requiere OCR" en vez de un rechazo por bomba.

Segundo vector, mismo patrón: un stream flate con ratio **343:1** (122 KB de
archivo → 41,9 MB descomprimidos, 23 MB de texto extraído) tarda **4,35 s**
antes de ser rechazado correctamente por `MAX_EXTRACTED_TEXT_LENGTH`
(`status=failed`, detalle explícito). El rechazo es correcto; el coste de
llegar a él, no.

Agravantes: (a) no hay **ningún** límite de tiempo en el parseo de PDF; (b)
`storeFile` + `extractDocumentText` se ejecutan en el handler **antes** de
abrir la transacción (`contract.routes.ts:344-346`), así que el trabajo se
consume aunque después falle todo; (c) no hay límite de tasa específico para
subidas.

**Severidad**: ALTA. Unas pocas peticiones concurrentes de 263 KB bastan
para saturar el proceso de la API con trabajo síncrono. Nada se fabrica
nunca (eso está bien y se verificó), pero la disponibilidad sí está
expuesta.

**Reparación sugerida (no aplicada)**: comprobar `pdf.numPages >
MAX_PDF_PAGES` **inmediatamente después** de `loadingTask.promise` y antes
del bucle; acumular la longitud del texto **dentro** del bucle y abortar al
cruzar `MAX_EXTRACTED_TEXT_LENGTH`; envolver toda la extracción en un
`AbortSignal.timeout`/deadline explícito; y mover la extracción a un job en
segundo plano (el mismo patrón que R6-03 ya introdujo para el radar).

### R6-12 — MEDIA. `GET /expediente/renewals/alerts` no pagina: una sola consulta sin límite que trae todo (32,4 MB medidos)

**Rubro**: radar (REQ-055).

**Evidencia**: `renewal-radar.routes.ts:373`

```sql
select * from renewal_alerts where org_id = $1 order by predicted_date asc
```

sin `limit`, sin cursor, sin `offset`, y con `select *`. Medido tras el
escaneo de 20.000 contratos:

```
GET /expediente/renewals/alerts devolvio 60000 alertas en 1310ms,
payload=33998725 bytes (32.4 MB)
```

Es exactamente el antipatrón que R6-03 eliminó del lado de escritura, vivo
en el lado de lectura de la misma funcionalidad — y fuera por completo del
criterio de R6-09, que solo instrumenta la transacción del handler de
`scan`. Otros endpoints de la misma familia sí paginan
(`GET /organizations/:orgId/memberships` tiene `limit`/`nextCursor`), así
que la convención existe en el proyecto y aquí no se aplicó.

**Severidad**: MEDIA (una organización grande recibe decenas de MB en una
sola respuesta; memoria del proceso y del cliente, y candidato a timeout de
gateway).

**Reparación sugerida**: `limit`/`nextCursor` con el mismo patrón keyset ya
usado en `scan`, y columnas explícitas en vez de `select *`.

### R6-13 — MEDIA. La suite de `apps/api` es intermitente en el HEAD actual: flake de reloj TOTP en el helper compartido de 2FA

**Rubro**: reproducibilidad — exactamente el rubro que R6-01/R6-09 vinieron
a limpiar.

**Evidencia**: misma máquina, mismo worktree, mismo commit, dos pasadas
consecutivas:

- Pasada 1: `Test Files 1 failed | 72 passed (73)`, `Tests 1 failed | 342 passed (343)`
- Pasada 2: `Test Files 73 passed (73)`, `Tests 343 passed (343)`

El fallo (transcripción literal en el log):

```
FAIL test/expediente-inconformidad.test.ts > ... marcar como revisado exige step-up ...
Error: 2fa verify-enrollment failed: 403 {"title":"Código TOTP inválido o ya utilizado (replay rechazado)."}
 ❯ Module.enrollTwoFactorFull test/helpers.ts:152:11
```

El usuario del test es nuevo y solo verifica una vez, así que no es un
replay real: `enrollTwoFactorFull` genera el código con
`generateTotpCodeForTesting` en el reloj de pared T y el servidor lo
verifica en T+Δ; `verifyTotpCode` usa `otplib.verify` sin tolerancia de
ventana y el propio módulo rechaza además cualquier `timeStep <= lastUsed`.
Bajo la suite completa (73 archivos en paralelo, 285-388 s) Δ puede cruzar
el límite de 30 s del `timeStep`, y el mensaje único
("inválido **o** ya utilizado") oculta cuál de los dos casos ocurrió.

Es más grave que WK6-03 por alcance: vive en `test/helpers.ts`, compartido
por todos los tests que necesitan step-up, no en un solo archivo.

**Severidad**: MEDIA (no es un defecto de producto; es que el gate declarado
verde no lo es de forma reproducible, y cualquier CI compartido lo verá).

**Reparación sugerida**: en el helper, generar el código y reintentar una
vez si el servidor responde 403 tras cruzar el límite de ventana, o fijar el
reloj (`vi.setSystemTime`) alrededor de la pareja generar/verificar.
Alternativa de producto (decisión aparte, no un bug): valorar una tolerancia
de **una** ventana hacia atrás en `verifyTotpCode`, que la protección de
replay por `timeStep` ya haría segura — hoy un teléfono con desfase leve de
reloj es rechazado.

### R6-14 — BAJA. El criterio estructural de R6-09 no acota el conjunto de trabajo: `pageSize` admite hasta 20.000 y una implementación sin límite lo satisface

**Rubro**: radar (REQ-055), calidad del criterio de aceptación.

**Evidencia**: (a) la mutación "una sola consulta sin límite" pasa el test
del conteo con 12 sentencias (detalle arriba, en R6-09); (b)
`renewalScanRequestSchema.pageSize` es `.max(20000)`, así que un llamador
legítimo puede pedir una página de 20.000 contratos (60.000 alertas
candidatas construidas en memoria, más 8 arreglos paralelos para el
`unnest`) dentro de una sola transacción, sin que ningún test lo note: el
conteo de sentencias **baja** al subir `pageSize`. El criterio premia
exactamente lo contrario de lo que quiere acotar.

**Severidad**: BAJA (el test vecino de paginación sí impide la degradación
más burda; esto es sobre la precisión del criterio declarado).

**Reparación sugerida**: complementar el conteo de sentencias con una
aserción sobre el **número de páginas** realmente recorridas (p. ej. contar
las ejecuciones de la consulta de contratos) y bajar el techo de `pageSize`
a un valor defendible.

---

## Lo que está bien (verificado en vivo por este agente)

- **Extracción de PDF, nunca fabrica**: PDF **cifrado** (`/Encrypt`
  `/Filter /Standard`) → `failed` en 1 ms con detalle explícito
  (`No password given`) y `text: null`; se comprobó además que ningún
  marcador del contenido real aparece en la respuesta. PDF **truncado al
  60%** → `failed`, sin texto. PDF de **páginas en blanco** →
  `requires_ocr` con `pageCount` real, nunca `extracted` con texto vacío.
  PDF de **50 MB** → resuelto en 2 ms (pdfjs no parsea objetos no
  referenciados) y **rechazado por la ruta** de subida
  (`decodeBase64Content`, límite ~22 MB): `rechazado por la ruta = true`.
- **Object streams** (`/ObjStm`) y **xref-stream** y **xref clásico**: los
  tres se extraen, con paginación real.
- **Radar, escalas extremas**: 0 contratos → `alertsCreated:0`,
  `evaluatedContracts:0`, `truncated:false`, `nextCursor:null`, sin error, 8
  sentencias; 1 contrato → 3 alertas (90/60/30) y **cuatro** escaneos
  seguidos dejan exactamente 3 alertas; 20.000 contratos → 60.000 alertas en
  1 petición, 58 sentencias, 9,0 s, y el re-escaneo completo crea 0.
  (Nota honesta: el intento de insertar una alerta duplicada **a mano** fue
  rechazado por un `NOT NULL` de `confidence` antes de llegar al índice
  único parcial `ux_renewal_alerts_contract_lead`, así que ese índice no
  quedó ejercitado directamente por esta prueba; el dedupe sí quedó probado
  a las tres escalas por la vía del handler.)
- **Aislamiento cross-org, barrido exhaustivo**: se sembró en la
  organización A un expediente post-adjudicación completo (contrato con
  `contract_number` marcado, transición, documento subido con extracción y
  campos, inconformidad, autopsia del fallo con lección, y alertas de
  renovación), todo con el marcador `SECRETO-ORGA-RV`. Desde la
  organización B se atacaron **los 18 endpoints** de ronda 6 con los
  identificadores reales de A: 15 respondieron `404 Convocatoria no
  encontrada`, `mark-reviewed` respondió `403` (step-up), y los 3 endpoints
  de organización (`lessons-learned`, `renewals/*`) devolvieron solo datos
  vacíos de B. **Ninguna** respuesta contuvo el marcador. Después del
  barrido, el contrato de A conserva `status` y `contract_number` intactos,
  su inconformidad sigue sin `revisado`, sigue teniendo 1 documento, y B no
  creó ningún contrato.
- **Historial y `audit_log` coherentes bajo peticiones simultáneas**: con 5
  transiciones concurrentes al mismo destino, exactamente 1 → 200 y 4 → 409;
  el historial tiene los 3 saltos encadenados sin `from_status` fantasma y
  `audit_log` tiene exactamente 3 filas `contract.transition`.
- **`UPDATE` condicionado**: con un `fromStatus` obsoleto afecta 0 filas y
  el estado real no se pisa (la garantía de R6-04 es correcta a nivel de
  código y de SQL, aunque su test no la ejercite).
- **`pdf-parse` erradicado**: no aparece en `apps/api/package.json`; solo
  quedan menciones en comentarios que documentan la historia.
- **R6-06**: la justificación del "PARCIAL por diseño" (checksum sha256 de
  migraciones ya aplicadas) es real y verificable en
  `packages/db/src/migrate.ts`.

---

## Resumen (≤10 líneas)

1. 8 de 9 correcciones R6 son reales: revertirlas pone la suite en rojo.
2. R6-04 es la excepción: su test pasa igual **sin** la corrección (mutación
   VERDE) — el 409 lo produce `checkTransition`, no el `UPDATE` condicionado.
3. El código de R6-04 sí es correcto: con `fromStatus` obsoleto, 0 filas.
4. El criterio de R6-09 **sí** se satisface trivialmente (12 sentencias con
   una consulta sin límite); lo salva el test vecino de paginación.
5. Nuevo R6-11 (ALTA): 263 KB de PDF = 42 s de CPU; los límites anti-bomba
   se aplican después del trabajo y el de 500 páginas ni se dispara.
6. Nuevo R6-12 (MEDIA): `GET /renewals/alerts` sin `limit` → 60.000
   alertas / 32,4 MB en una respuesta.
7. Nuevo R6-13 (MEDIA): suite intermitente en HEAD (342/343 → 343/343) por
   un flake de ventana TOTP en `test/helpers.ts`.
8. Nuevo R6-10 (MEDIA) y R6-14 (BAJA): tests/criterios que no miden lo que
   dicen medir.
9. Nada fabrica texto: cifrado, truncado, vacío y bombas siempre terminan en
   un estado explícito.
10. Cross-org: 18/18 endpoints post-adjudicación sin fuga alguna.

---

## Estado de reparación (agente corrector Sonnet, apps/api, sobre esta reverificación)

Un commit por hallazgo (`git log`, mensajes `fix(api): R6-nn ...` /
`test(api): R6-nn ...`); evidencia real de "test rojo → arreglo → verde" en
`docs/logs/fix-api-r6b.log`. Ámbito de este agente: `apps/api/**`
(expediente/extracción PDF, post-award/renewals, `test/helpers.ts`) — no
toca `apps/worker`, `apps/web` ni `packages/db`.

| Hallazgo | Severidad | Estado reparación |
|---|---|---|
| R6-11 | ALTA | **REPARADO**. `extractPdfPages` (`apps/api/src/lib/expediente/text-extraction.ts`) comprueba `pdf.numPages > MAX_PDF_PAGES` inmediatamente tras `getDocument`, ANTES de tocar una sola página (antes se comprobaba después de extraer texto de todas). Dentro del bucle se acumulan caracteres y tiempo de pared página a página y se aborta en cuanto se cruza cualquier límite (antes se sumaba el total tras el bucle completo); se cede el event loop cada 20 páginas. Nuevo campo `limitExceeded: 'paginas'\|'caracteres'\|'tiempo'` + `detail` con el literal `rechazado_por_limite` (no se pudo usar como valor de `TextExtractionStatus`: esa columna tiene un `check` en `packages/db`, fuera de ámbito). Reproducción real del ataque del auditor (20.000 páginas en blanco, ~260 KB, generado con `pdf-lib`): código viejo confirmado en rojo (52,8 s, cae en `requires_ocr`); código nuevo, verde en <2 s (`test/expediente-text-extraction.test.ts`, caso "R6-11"). |
| R6-12 | MEDIA | **REPARADO**. `GET /renewals/alerts` paginado: mismo patrón keyset ya usado en `GET /organizations/:orgId/memberships` (`lib/cursor.ts`) -- `limit`/`cursor` de entrada (default 100, máximo 1000), `order by (predicted_date, id)` con desempate único, columnas explícitas en vez de `select *`, `nextCursor` de salida. Test nuevo con 1.000 alertas sembradas directamente: la primera página nunca trae las 1.000 de un tirón y recorrer todas las páginas con `nextCursor` reúne exactamente 1.000 sin duplicados. |
| R6-10 | MEDIA | **REPARADO**. `updateContractStatusConditioned` extraída como función propia (`contract.routes.ts`) y probada de forma DETERMINISTA con un `fromStatus` deliberadamente obsoleto (sin depender de ninguna carrera real, imposible de forzar bajo PGlite): 0 filas, 409 con el mensaje de carrera, sin transición fantasma ni entrada de `audit_log`. Confirmado mutante: revertir a mano `and status = $4` pone el test nuevo en rojo (evidencia en el log; revertido de inmediato). El test de `Promise.all` original se conservó pero renombrado y con aserción sobre el MENSAJE del 409 (validación del grafo, no el de la carrera) -- honesto sobre qué mecanismo prueba, en vez de vacuo. |
| R6-13 | MEDIA | **REPARADO**. `test/helpers.ts`: `enrollTwoFactor`/`enrollTwoFactorFull` reintentan UNA vez con un código TOTP recién generado si la primera verificación falla (nunca reutilizan el código ya rechazado); si el segundo intento también falla, propagan el error real sin ocultarlo. Test nuevo (`test/helpers-totp-window-retry.test.ts`) que intercepta la primera llamada a `/auth/2fa/verify-enrollment` para reproducir determinísticamente el 403 ambiguo medido por el reverificador, sin depender de ganar una carrera de reloj real. Verificado además que el rechazo de REPLAY real (mismo código dos veces) sigue funcionando (`security-req044-064-step-up-2fa.test.ts`). |
| R6-09 (criterio) | — | **REPARADO**. `countTxQueries` (`test/expediente-renewal-radar.test.ts`) ahora también cuenta, vía `matchSql`, cuántas veces se ejecuta ESPECÍFICAMENTE la consulta de una página de contratos -- no solo el total de sentencias. Con 5,000 contratos / `pageSize` por defecto (2,000): `ceil(5000/2000) = 3` ejecuciones exactas; una implementación sin límite ejecuta esa consulta 1 sola vez. Confirmado mutante reproduciendo la mutación exacta del acta (quitar `limit $3` de `scanContractsPage`): 12 sentencias totales (idéntico a lo medido por el reverificador) pero `paginas=1` en vez de 3 -- el nuevo assert lo atrapa donde el criterio original no lo hacía. |
| R6-14 | BAJA | **REPARADO**. Techo de `pageSize` bajado de 20,000 a 5,000 en `renewalScanRequestSchema` y `renewalScanEnqueueRequestSchema` (mismo orden de magnitud que el escaneo de 5,000 contratos ya medido y probado, R6-03) -- ya no admite una sola página con hasta 60,000 alertas candidatas en memoria. Test nuevo: `pageSize:20000` -> 422 (antes 200) en ambos endpoints; `pageSize:5000` sigue funcionando. |

Cierre: `npm run -w apps/api typecheck && lint && test` ×2 en primer plano,
salida real en `docs/logs/fix-api-r6b.log`. Pasada 1: `typecheck`/`lint`
limpios, tests **75/76 archivos, 358/359** -- único rojo
`security-am02-mail-timing.test.ts` (timing-oracle de correo, FUERA del
ámbito de este agente y no un hallazgo R6-09..R6-14; no se tocó). Pasada
2: `typecheck`/`lint` limpios, **76/76 archivos, 359/359** verde, incluida
`security-am02-mail-timing.test.ts` (confirma flake de carga de máquina
compartida con otros agentes, no una regresión de esta ronda).
