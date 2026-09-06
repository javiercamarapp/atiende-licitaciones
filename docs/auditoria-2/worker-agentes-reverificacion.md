# Reverificación adversarial — `apps/worker` Ronda K (WK6-01..WK6-03)

Fecha: 2026-09-06. Agente: **reverificador adversarial independiente (Opus,
respaldo autorizado por el usuario porque Sonnet está limitado, D-10)**,
contexto separado. Rol: **SOLO HALLAZGOS** — ningún archivo de código de
`apps/worker`, `packages/agents`, `packages/db` ni de cualquier otro paquete
fue modificado en el repositorio principal por este agente.

**Metodología.** Mismo `git worktree` desechable que la parte A
(`<scratchpad>/reverify-r6-wk6`, commit `cd803a4`), verificado byte a byte
idéntico al HEAD real para `apps/worker` y `packages/agents`, con los 3
commits de reparación (`c778526 caee2fe 93ea69f`) como ancestros. Se corrió
el script oficial de mutación, se aplicaron **dos mutaciones propias**
distintas de la suya (revirtiéndolas con `diff` byte a byte), y se escribió
un archivo de prueba adversarial temporal (`zz-rv-correlation.test.ts`),
ejecutado y **borrado** al terminar (`git status` del worktree limpio,
verificado en el log). El árbol principal nunca se tocó con comandos
destructivos. Evidencia real: `docs/logs/reverify-r6-wk6.log` (secciones
2, 8 y 9).

---

## Resumen ejecutivo

Las tres reparaciones son **reales y con red de pruebas de verdad**. La suite
de `apps/worker` reproduce **383/383 en dos pasadas consecutivas**, sin
ningún timeout — coincide exactamente con lo declarado. El script
`wk6-01-mutation-test-org-isolation.sh` funciona como anuncia (`exit 0` =
mutación detectada) y, lo más importante, la red de aislamiento **no está
sobreajustada a `fetchTender`**: dos mutaciones nuevas e independientes
—quitar `org_id` de `leer_bases`, y filtrar datos de otra organización
**disfrazados dentro de un resultado "no evaluable"**— también se detectan,
cada una por la aserción de contenido que corresponde. El `correlationId` de
negocio llega efectivamente a `agent_runs.output`, a cada entrada de
`toolCalls` y al log estructurado con `job_id` separado. El defecto nuevo es
que ese identificador **no se valida ni se sanea en ningún punto de
`apps/worker`** (WK6-04): 10 KB se propagan íntegros a cada línea de log y a
la base, un valor con saltos de línea y JSON falso sobrevive verbatim en el
campo, y un byte NUL rompe el encolado con un error de Postgres. Hoy no es
alcanzable desde fuera porque `apps/api` filtra el encabezado a UUID en su
frontera, pero el worker no tiene defensa propia y el README no declara el
límite.

### Suites completas ×2 (worktree aislado, HEAD real)

| Pasada | Resultado |
|---|---|
| `npm run -w apps/worker test` (1ª) | **383/383**, 22/22 archivos, 0 timeouts. 160.3 s |
| `npm run -w apps/worker test` (2ª) | **383/383**, 22/22 archivos, 0 timeouts. 151.3 s |

Coincide con lo declarado en el acta de reparación (383/383). A diferencia
de `apps/api` (ver R6-13 en el informe hermano), aquí **no** se observó
ninguna intermitencia.

---

## Veredicto por hallazgo original

### WK6-01 — **CONFIRMADO REPARADO** (y la red no está sobreajustada)

**(a) El script oficial funciona.** `apps/worker/scripts/wk6-01-mutation-test-org-isolation.sh`
ejecutado desde el worktree: crea su propio worktree temporal, superpone el
árbol de trabajo (aquí no había cambios sin commitear), enlaza
`node_modules`, aplica la mutación exacta del hallazgo original
(`fetchTender` sin `org_id`), corre los tests y **limpia siempre**:

```
Tests  2 failed | 43 passed (45)
AssertionError: expected 100 to be null
[wk6-01] OK: la suite FALLÓ bajo la mutación (exit=1) -- la regresión de
         aislamiento por organización SÍ se detecta.
[wk6-01] limpiando worktree temporal: .../wk6-01-mutation-nCKMFL
EXIT=0
```

Se verificó además con `git worktree list` que el worktree temporal quedó
efectivamente eliminado y que el árbol principal no se tocó.

**(b) Mutación propia 1 — otra herramienta distinta de `fetchTender`.** Se
quitó el filtro `org_id` de **`leer_bases`** (las dos consultas:
`tender_documents` y `requirement_items`), que es una superficie distinta y
que el script oficial no toca. Resultado: **ROJO**.

```
FAIL test/business-tools.test.ts > ... aislamiento cross-org (WK6-01) >
     leer_bases: tenderId real de orgA desde el contexto de orgB ->
     documentos/requisitos vacíos, nunca los de orgA
AssertionError: expected [ { …(4) } ] to have a length of +0 but got 1
Tests  1 failed | 44 passed (45)
```

**(c) Mutación propia 2 — fuga disfrazada de "no evaluable".** El ataque más
interesante, porque imita a un desarrollador que "respeta" el contrato de la
herramienta: se mantuvo `score: null`, `matchedKeywords: []`,
`missingProfileFields: ['tender']` y el texto literal "no evaluable", pero se
añadió una lectura global de `tenders` (sin `org_id`) y su `title`/
`contracting_body` se coló dentro de `explanation`. Resultado: **ROJO**.

```
FAIL ... proponer_matching: tenderId real de orgA desde el contexto de orgB
     -> "no evaluable" explícito, sin score ni texto de orgA
AssertionError: expected '{"tenderId":"5a833b50-c7ec-462b-b6ea-…' not to
                contain 'SECRETO-ORGA'
Tests  2 failed | 43 passed (45)
```

Es exactamente la aserción de contenido que WK6-01 introdujo
(`expect(JSON.stringify(output)).not.toContain(SECRET)`) la que atrapa la
fuga: sin ella, esta mutación habría pasado todos los asserts estructurales
(`score` null, `matchedKeywords` vacío, `explanation` con "no evaluable"). La
reparación cubre el caso que el hallazgo original describía **y** este, que
no estaba planteado.

Se revirtieron ambas mutaciones con `diff` confirmando archivo idéntico byte
a byte, en el mismo `trap EXIT` del harness.

### WK6-02 — **CONFIRMADO REPARADO** (con un límite nuevo, ver WK6-04)

Verificado en vivo, corriendo el handler real `createRunAgentHandler` sobre
un agente nombrado con datos reales:

- `agent_runs.output.correlationId` queda persistido con el valor de
  negocio; una sola consulta
  `where output->>'correlationId' = $1` lo recupera (test existente
  `run-agent-handler.test.ts`, reproducido verde).
- **Cada** entrada de `toolCalls` lleva el mismo identificador: en mi propia
  corrida, `toolCalls con el mismo valor: 3/3`.
- El log estructurado lleva el identificador de **negocio** en
  `correlation_id` y el de **cola** por separado en `job_id`
  (`job_id separado presente: true`).
- **Caída correcta a `job.id`** cuando el payload no trae un valor usable —
  se probaron 5 formas (`null`, `42`, `""`, `{a:1}`, `[]`) y las 5
  resolvieron exactamente a `job.id`, nunca a `"undefined"` ni a un valor
  vacío.

### WK6-03 — **CONFIRMADO REPARADO**

`testTimeout: 20000` a nivel de `describe` en
`db-proposals/PROPOSAL-06-agent-business-tools-grants.test.ts`. Dos pasadas
completas de la suite (160,3 s y 151,3 s) con **383/383** y **cero**
timeouts, incluso corriendo en paralelo con la suite de `apps/api` en la
misma máquina (contención real, no un entorno ocioso). No se reprodujo la
intermitencia original.

---

## Hallazgos nuevos

### WK6-04 — MEDIA. `apps/worker` no valida ni sanea el `correlationId` de negocio en ningún punto: se propaga íntegro al log y a la base, y un byte NUL rompe el encolado

**Rubro**: 4 (trazabilidad de la corrida) / robustez de entrada.

**Superficie**: el valor recorre tres puntos sin ninguna comprobación más
allá de "es un string no vacío":

1. `apps/worker/src/queue/worker.ts` — `businessCorrelationId(payload)`:
   ```ts
   if (typeof value === 'string' && value.length > 0) return value;
   ```
   sin tope de longitud ni filtro de caracteres; el resultado va directo a
   los *bindings* del logger hijo de pino.
2. `apps/worker/src/agents/enqueue-agent-run.ts` — `params.correlationId` se
   escribe tal cual en el `payload` jsonb del job.
3. `apps/worker/src/handlers/run-agent.ts:~447` —
   `correlationId: job.payload.correlationId ?? job.id`, de ahí a
   `AgentRunRequest`, a `run.correlationId` y a `agent_runs.output`.

**Evidencia (en vivo, `zz-rv-correlation.test.ts`, 6/6 verde)**:

- **Inyección de línea de log**: con
  `'abc"}\n{"level":50,"msg":"ALERTA FALSA INYECTADA",...}\n{"x":"'` como
  `correlationId`, pino **no** puede ser engañado para fabricar una línea
  (`lineas FABRICADAS por inyeccion: 0`, `lineas no parseables: 0`) porque
  serializa a JSON — eso está bien. Pero el valor **sobrevive verbatim** en
  el campo: `contiene salto de linea sin sanear: true`,
  `contiene comillas/llaves de inyeccion sin sanear: true`. Cualquier
  consumidor que renderice `correlation_id` sin escapar (una consola, un
  `grep`, un panel que muestre el campo como texto) verá la línea falsa.
- **10 KB**: `lineas con correlation_id=2, longitud maxima=10240
  (entrada=10240)`, `correlation_id truncado por el worker: false`, y
  `bytes totales de log emitidos=20886` — es decir, un job que emite dos
  líneas ("job iniciado"/"job completado") produce ~21 KB de log, ~98 % de
  ellos el identificador. Amplificación sin tope.
- **Persistencia**: con 10 KB más un salto de línea y un RTL override
  (U+202E), `agent_runs.output.correlationId longitud=10261
  (entrada=10261)`, `conserva salto de linea: true | RTL: true`,
  `truncado/saneado por el worker: false`, y los **3** `toolCalls` guardan
  el mismo valor íntegro.
- **Unicode/controles**: `correlation_id resultante = "‮gro-orto‬
  [31mROJO[0m💣"` — el RTL override y las secuencias de escape
  ANSI se conservan (`conserva RTL override U+202E: true`,
  `conserva escape ANSI: true`).
- **Byte NUL — rompe el encolado**: `queue.enqueue('run_agent', {
  correlationId: 'ok malo' })` lanza
  `error="unsupported Unicode escape sequence"` (Postgres/jsonb no admite
  ` `). No es solo cosmético: un productor que ponga un NUL hace que el
  job **no se encole en absoluto**, o —si el valor llega más tarde— que
  `updateAgentRunRow` falle y el resultado de la corrida nunca se persista.

**Alcance real hoy (nota de honestidad)**: no es explotable desde fuera.
`apps/api` sanea en su frontera —
`apps/api/src/plugins/correlation-id.plugin.ts` solo hereda
`X-Correlation-Id` si coincide con `UUID_RE`, y si no genera uno nuevo — y
los dos productores internos de `run_agent`
(`discover-tenders.ts`, `deadline-reminders.ts`) pasan UUIDs de base de
datos. El hallazgo es que **`apps/worker` no tiene defensa propia**: depende
por completo de la higiene de sus productores, y eso no está declarado en
ninguna parte. El README de `apps/worker` documenta honestamente varios
límites del `correlationId` (sin columna dedicada, sin índice, consulta
contra JSONB), pero **no** este.

**Severidad**: MEDIA. Hoy: fragilidad y amplificación de logs ante un
productor futuro o un valor mal formado. Si algún día `apps/api` o un
tercero pudiera fijar el `correlationId` de un job con menos filtro que el
actual, sube a ALTA (inyección visual en logs y crecimiento no acotado de
`agent_runs.output`).

**Reparación sugerida (no aplicada)**: una función única de saneamiento en
`apps/worker` —recortar a un tope (p. ej. 128 caracteres), rechazar/eliminar
caracteres de control incluidos ` ` y los overrides bidireccionales, y
caer a `job.id` si el valor no sobrevive— aplicada en `businessCorrelationId`,
en `enqueueAgentRun` y antes de construir `AgentRunRequest`; y declarar el
contrato ("el `correlationId` es de confianza limitada y se sanea aquí") en
el README junto a los demás límites ya documentados.

---

## Lo que está bien (verificado en vivo por este agente)

- **Reproducibilidad**: 383/383 en dos pasadas completas, 22/22 archivos,
  cero timeouts, incluso con la suite de `apps/api` corriendo en paralelo en
  la misma máquina. La cifra declarada en el acta se sostiene.
- **La red de aislamiento cross-org es genuina y no está sobreajustada**:
  tres mutaciones distintas (la oficial sobre `fetchTender`, y las dos mías
  sobre `leer_bases` y sobre una fuga camuflada en "no evaluable") producen
  rojo, cada una detectada por la aserción de contenido que le toca. El
  bloque `aislamiento cross-org (WK6-01)` de `business-tools.test.ts` cubre
  las **8** herramientas con un marcador distinguible, no solo `status: 'ok'`.
- **El script de mutación es honesto y seguro**: reporta correctamente
  (`exit 0` = detectada), crea su worktree con `--detach` sobre el HEAD real,
  nunca escribe en el árbol principal (solo lee con `git diff HEAD`/
  `git ls-files`), y limpia con `trap EXIT` incluso cuando la suite falla —
  comprobado con `git worktree list` después.
- **`correlationId` de negocio, camino feliz**: llega a
  `agent_runs.output.correlationId`, a los 3/3 `toolCalls`, y al log con
  `job_id` separado; una sola consulta SQL reconstruye la cadena
  convocatoria → matriz → propuesta.
- **Caída a `job.id` robusta**: `null`, número, string vacío, objeto y
  arreglo — los cinco resuelven a `job.id`, nunca a `"undefined"`.
- **Formato de log a prueba de inyección**: pino serializa a JSON, así que
  ni con saltos de línea y objetos JSON completos dentro del valor se
  consigue fabricar una línea de log falsa ni romper el parseo (0 líneas
  inyectadas, 0 no parseables). El problema de WK6-04 es el **contenido** del
  campo, no el formato del registro.
- **WK6-03 cerrado de verdad**: el `testTimeout` de 20 s del archivo de
  `PROPOSAL-06` aguantó cuatro corridas de la suite en esta sesión (dos mías
  completas más las de las mutaciones) sin un solo timeout.

---

## Resumen (≤10 líneas)

1. WK6-01, WK6-02 y WK6-03: **CONFIRMADOS REPARADOS**.
2. 383/383 en dos pasadas completas, 22/22 archivos, cero timeouts.
3. El script oficial de mutación detecta, reporta bien y limpia su worktree.
4. Mutación propia en `leer_bases` (otra herramienta): **detectada**.
5. Mutación propia "fuga camuflada de no evaluable": **detectada**, por la
   aserción de contenido — no por los asserts estructurales.
6. El `correlationId` de negocio llega a `agent_runs.output`, a los 3/3
   `toolCalls` y al log con `job_id` separado.
7. Nuevo WK6-04 (MEDIA): ese identificador **no se sanea** en `apps/worker`.
8. 10 KB pasan íntegros a cada línea de log (21 KB por un job de 2 líneas) y
   a la base; RTL/ANSI/saltos de línea sobreviven verbatim.
9. Un byte NUL rompe el encolado (`unsupported Unicode escape sequence`).
10. No es alcanzable desde fuera hoy: `apps/api` filtra a UUID en su
    frontera; el worker simplemente no tiene defensa propia ni lo declara.
