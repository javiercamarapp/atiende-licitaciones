# Verificación puntual final — 3 cierres pequeños sin reverificación independiente

Fecha: 2026-09-06. Agente: verificador puntual independiente (Sonnet), sin
participación en la construcción, corrección ni reverificación previa de
ninguno de los tres paquetes. Rol: SOLO verifica — ningún código de
producción de `apps/worker`, `packages/agents` ni `packages/expediente` fue
modificado por este agente.

Metodología: todo el trabajo (`npm install`, `typecheck`/`lint`/`test`/
`test:coverage`, y los ataques adversariales propios) se ejecutó en
`git worktree add <scratchpad>/verify-final HEAD` (HEAD `10b477e`), nunca en
el árbol de trabajo principal. Cada archivo de test temporal
(`apps/worker/test/zz-verify-final.test.ts`,
`packages/agents/test/zz-verify-final-ag23.test.ts`,
`packages/expediente/test/zz-verify-final-expediente.test.ts`) se ejecutó,
se confirmó en verde y se **borró antes de continuar** — ninguno se
commiteó ni quedó en el worktree (confirmado con `git status --short`
vacío salvo `package-lock.json`, subproducto de `npm install`, sin
relación con el encargo). El worktree se elimina al cerrar este documento.
Evidencia completa (comandos y salidas reales, incluyendo los tests
propios antes de borrarlos) en `docs/logs/verify-final.log`.

---

## A) `apps/worker` vuelta 3 — WK-19..23 (`docs/auditoria-1/worker-cierre.md` §7)

### Ancestría

Los 4 commits citados son ancestros reales de HEAD (`git merge-base
--is-ancestor`, los 4 `OK`) y su `git show --stat` coincide con lo
declarado en `worker-cierre.md` §1/§7:

| Commit | Contenido | Ancestro |
|---|---|---|
| `4f7a933` | WK-22 — `toDbStatus()`/`JobQueue.cancel()` mapean 1:1 los estados finos y `'cancelled'` | OK |
| `7cdafc5` | WK-19/WK-23 — `organizationId` por `z.string().uuid()`, `worker_role` real en `updateAgentRunRow` | OK |
| `a3e42a3` | WK-20/WK-21 — clasificación exhaustiva 400-599, 407 vía undici | OK |
| `f06f9df` | README + columna Estado reparación ronda 4 | OK |

### Reproducibilidad

```
npm run -w apps/worker typecheck        -> OK
npm run -w apps/worker lint             -> OK
npm run -w apps/worker test             -> 11 archivos / 298 tests, 0 fallos, exit 0
npm run -w apps/worker test:coverage    -> 91.17% líneas / 82.65% ramas / 83.78% funcs (umbral 85/80, exit 0)
```

Coincide con lo declarado en `fix-worker-ronda4.log` (298/298, sin
`.pending`/`.skip` en `db-proposals/`).

### Ataques propios (13 tests, `apps/worker/test/zz-verify-final.test.ts`, borrado)

1. **Estados finos en `source_runs`**: se llamó `recordSourceRun()` con
   `fineState: 'rate_limited'`/`'not_configured'`/`'ingest_failed'` y se
   **releyó la fila real** con `SELECT status FROM source_runs WHERE id =
   $1` (no solo el valor de retorno de la función) — los 3 valores se
   persisten tal cual, nunca `'failed'`. `getLastSourceRun()` también
   expone el valor real.
2. **`cancel()` → `'cancelled'` y no reclamable**: `JobQueue.cancel()`
   sobre un job `queued` y sobre uno `running` deja `status='cancelled'`
   en la fila real (releída), nunca `'dead'`. Se intentó `claim()` con dos
   workers distintos después de cancelar: ninguno lo reclama (`claim()`
   filtra `status = 'queued' or (status='running' and locked_at < ...)`,
   `'cancelled'` queda fuera de ambas ramas).
3. **`updateAgentRunRow`/`worker_role` — identidad**:
   - Legítimo (org + actor reales, actor con membresía de escritura) →
     `succeeded` (control positivo).
   - Cross-tenant (cubierto también por el test oficial WK-08) → `rowCount
     = 0`, `AgentRunOrgMismatchError`, fila intacta.
   - **Actor inexistente** (UUID bien formado, v4, sin fila en `users`) →
     bloqueado por RLS (`AgentRunOrgMismatchError`, permanente), fila
     intacta.
   - Actor de otra organización (cubierto también por el test oficial
     WK-23) → bloqueado por RLS, fila intacta.
   - **`actorId = '  '`** (solo espacios) → rechazado por
     `z.string().uuid()` ANTES de tocar la base
     (`RunAgentInvalidActorError`, permanente), fila intacta.
   - **`organizationId = '  '`** a nivel del guard del handler → mismo
     resultado, fail-closed permanente, fila intacta.
   - **UUID en MAYÚSCULAS**: `actorId` real con casing invertido (mismo
     UUID, `toUpperCase()`) SÍ actualiza — Postgres normaliza `uuid` sin
     distinguir mayúsculas/minúsculas, y `z.string().uuid()` también
     acepta mayúsculas. No es un bypass: sigue siendo el mismo actor real.
   - **UUID v1 vs v4**: `z.string().uuid()` (zod 3.24) acepta cualquier
     versión de UUID (v1 y v4 confirmados con `safeParse`, además de
     `00000000-0000-0000-0000-000000000000`). Un `actorId` con forma UUID
     v1 pero **inexistente** en `users` es bloqueado por RLS, exactamente
     igual que el caso "actor inexistente" v4 — no hay bypass por versión
     de UUID, la validación de formato es solo la primera capa; RLS por
     identidad real es la que realmente protege.
4. **HTTP 501/505/599/407** (mock de `fetchImpl`, sin red real):
   - 501 → `status=501`, `retryable=false`, `permanent=true`, **1 sola
     llamada** (sin reintentos).
   - 505 → igual, `permanent=true`.
   - 599 (fuera de la muestra oficial de 12 códigos) → `retryable=true`,
     `permanent=false`, **SÍ reintenta** (2 llamadas con `maxRetries=1`).
   - 407 (simulando el `TypeError: fetch failed` desnudo de undici, con
     `cause` sin `.code`/`.message`) → `permanent=true`, **1 sola llamada**
     (no reintenta), mensaje menciona "proxy".

**Ningún ataque logró revertir WK-19/WK-20/WK-21/WK-22/WK-23.** Los 5
hallazgos de la ronda 3 se confirman **CERRADOS** de forma independiente,
sin hallazgos nuevos.

### Veredicto A

| Hallazgo | Veredicto |
|---|---|
| WK-19 | **CERRADO** (confirmado) |
| WK-20 | **CERRADO** (confirmado, incluida zona gris 501/505/506-599) |
| WK-21 | **CERRADO** (confirmado, 407 vía undici) |
| WK-22 | **CERRADO** (confirmado, fila real releída) |
| WK-23 | **CERRADO** (confirmado: legítimo OK, cross-tenant/no-actor/actor-otra-org/actor-inexistente/actor-formato-inválido todos bloqueados; UUID mayúsculas/v1 no son bypass) |

---

## B) `packages/agents` AG-23 (`docs/auditoria-1/agents-cierre.md`)

### Ancestría

El contenido de AG-23 fue absorbido por el commit `048ae47`
("feat(db): 0033 — ...", de otro agente trabajando en paralelo en la misma
ronda) — confirmado ancestro de HEAD. `git show --stat 048ae47` incluye
`packages/agents/src/tool-registry.ts` (+103/-…), `test/tool-registry.test.ts`
(+102) y `docs/logs/fix-agents-ag23.log`, junto con cambios no relacionados
de otros paquetes (migración `0033`, `packages/sources`) hechos por el
mismo commit combinado.

`isForbiddenFieldKey()` **está presente en HEAD**
(`packages/agents/src/tool-registry.ts:119`), usado en los 6 puntos de
chequeo (`findForbiddenFieldRecursive` estático y `findForbiddenKeyAtRuntime`
runtime, incluido `checkKeyTypeForForbiddenField`).

### Reproducibilidad

```
npm run -w packages/agents typecheck -> OK
npm run -w packages/agents lint      -> OK
npm run -w packages/agents test      -> 13 archivos / 263 tests, 0 fallos, exit 0
```

Coincide exactamente con lo declarado (263/263).

### Ataques propios (14 tests, `packages/agents/test/zz-verify-final-ag23.test.ts`, borrado)

Independientes del suite oficial (mismas variantes del encargo, contra
`ToolRegistry.register()`/`validateInput()` reales, no contra la función
interna):

- **Positivos** (deben bloquear, en runtime bajo `z.record(z.string(),
  z.any())`): `ORG_ID`, `org-id`, `Org.Id`, `org id`, `ｏｒｇ＿ｉｄ`
  (fullwidth), `x_org_id`, `org_id_override`, `tenantId2`, `orgid` (sin
  separador) — **los 9 bloquean** (`ForbiddenRuntimeInputFieldError`).
- **Negativos** (no deben bloquear): `organizacion_nombre`, `origin_id`,
  `tenderId`, `torg_idx` (contiene "orgid" en medio, ni prefijo ni sufijo)
  — **los 4 pasan sin error**, confirmando que la detección es
  prefijo/sufijo, no subcadena en cualquier posición.
- **Clave con caracteres zero-width** (ZWJ `‍` + ZWSP `​`
  intercalados en `"org_id"`) — **bloquea**: `normalizeFieldKey()` los
  elimina junto con cualquier no-alfanumérico, quedando `"orgid"` exacto.
- **Anidado en un ARRAY de `z.record(z.string(), z.any())`** y en **2
  niveles de arrays anidados** — **bloquea** en ambos casos (la recursión
  de `findForbiddenKeyAtRuntime` atraviesa arrays de records sin problema).
- **Registro estático** (no solo runtime): `"ORG-ID"` y `"ｏｒｇ＿ｉｄ"`
  como nombre de campo declarado también rechazan `register()` con
  `UnauthorizedToolInputError`.

**Ningún ataque logró evadir `isForbiddenFieldKey()`.** AG-23 se confirma
**CERRADO** de forma independiente, sin hallazgos nuevos ni falsos
positivos en los negativos probados.

### Veredicto B

| Hallazgo | Veredicto |
|---|---|
| AG-23 | **CERRADO** (confirmado; 14/14 ataques propios sin bypass, incluida la variante ZWJ y anidamiento en arrays no cubiertos explícitamente por el suite oficial) |

---

## C) `packages/expediente` micro (`docs/auditoria-1/expediente-cierre.md`)

### Ancestría

Los 3 commits de la micro-corrección (referidos como "#54" en el encargo)
son ancestros reales de HEAD:

| Commit | Contenido | Ancestro |
|---|---|---|
| `bc40b2a` | fix: REVERIFY3-EXP-A — `isSealedHashedInputs` exige `Object.hasOwn` + `WeakSet` de identidad | OK |
| `fccfdff` | fix: EX-EXP-18 residual — `stableStringify` ya no colisiona `-0`/`NaN`/`Infinity` | OK |
| `97d84cb` | docs: log de la micro-vuelta + columna Estado definitivo | OK |

### Reproducibilidad

```
npm run -w packages/expediente typecheck -> OK
npm run -w packages/expediente lint      -> OK
npm run -w packages/expediente test      -> 16 archivos / 398 tests, 0 fallos, exit 0
```

Coincide exactamente con lo declarado (398/398).

### Ataques propios (12 tests, `packages/expediente/test/zz-verify-final-expediente.test.ts`, borrado)

Contra `sealInputs`/`requireValidHashedInputs` reales (no re-implementados):

- **`Object.create(selladoAjeno)`** con `inputs`/`hash` PROPIOS
  auto-coherentes (recalculados con `computeInputsHash` real) →
  **rechazado** (`Object.hasOwn` falla sobre el símbolo heredado).
- **`Object.setPrototypeOf(objetoPlano, selladoReal)`** → **rechazado**
  (el objeto plano no declara `inputs`/`hash`/símbolo como propiedades
  PROPIAS, los hereda).
- **`Reflect.ownKeys(sellado)` para obtener el símbolo REAL** + construir
  un objeto NUEVO con ese símbolo exacto como propiedad propia (vía
  `Object.defineProperty`) + `inputs`/`hash` propios auto-coherentes →
  pasa las dos primeras capas (`hasOwn` del símbolo, `hasOwn` de
  `inputs`/`hash`) pero **sigue rechazado** por la tercera capa
  (`sealedInstances.has(value)`, `WeakSet` por identidad de instancia, no
  por estructura) — confirma que el `WeakSet` **no es falsificable**
  incluso teniendo el símbolo real en la mano.
- **Deserialización JSON** (`JSON.parse(JSON.stringify(sellado))`) →
  **rechazado** (el símbolo no sobrevive la serialización).
- **`structuredClone()`** → **rechazado** (mismo motivo).
- **Mutación de `inputs` DESPUÉS de sellar** (sobre el objeto sellado
  REAL, no uno forjado) → **rechazado** (la recomputación del hash ya no
  coincide).
- **Control positivo**: un `HashedInputs` legítimo real pasa sin error.
- **`-0`/`NaN`/`Infinity`**: `sha256Hex`/`stableStringify` con `NaN`,
  `Infinity`, `-Infinity` (sueltos y anidados en un objeto) **lanzan
  error** (fail-closed, no producen un hash). `-0` (suelto y anidado) **no
  lanza** y produce un hash **distinto** de `0` (confirmado
  `sha256Hex(-0) !== sha256Hex(0)`), sin colisión.

**Ningún ataque logró falsificar un `HashedInputs` ni colisionar `-0` con
`0`, ni producir un hash a partir de `NaN`/`Infinity`.** REVERIFY3-EXP-A y
el residual `-0`/`NaN`/`Infinity` de EX-EXP-18 se confirman **CERRADOS**
de forma independiente.

### Veredicto C

| Hallazgo | Veredicto |
|---|---|
| REVERIFY3-EXP-A (`isSealedHashedInputs` falsificable por herencia) | **CERRADO** (confirmado; `Object.create`/`setPrototypeOf`/copia de símbolo con `WeakSet` — 3 vectores adicionales sin bypass) |
| EX-EXP-18 residual (`-0`/`NaN`/`Infinity`) | **CERRADO** (confirmado; fail-closed en no-finitos, `-0` sin colisión) |

---

## Regresión: `apps/api typecheck` en el worktree

```
npm run -w apps/api typecheck -> OK, sin salida, exit 0
```

Sin errores que clasificar (ni "WIP ajeno" ni regresión real): el
typecheck del estado COMMITEADO en HEAD (`10b477e`) es limpio. Nota: el
árbol de trabajo del repo principal tiene cambios NO commiteados en
`packages/sources` (WIP de otro agente en curso al momento de esta
verificación) que, correctamente, no se materializan en
`git worktree add ... HEAD` y por tanto no afectan este resultado.

---

## Hallazgos nuevos

**Ninguno.** Los 3 cierres se confirman sin bypass, sin regresión y sin
gaps adicionales descubiertos por los 39 ataques propios ejecutados en
total (13 + 14 + 12).

---

## REQ candidatos a CUMPLIDO para `docs/ACEPTACION.md` (no se edita, solo se reporta)

- **REQ-147/REQ-148/REQ-149** (`source_runs` poblado con estado explícito,
  incluida la granularidad fina): con WK-22 confirmado CERRADO de forma
  independiente en esta ronda (`toDbStatus()` mapea 1:1
  `rate_limited`/`not_configured`/`ingest_failed`, confirmado con consulta
  directa a la fila real), la reserva de la ronda anterior ("NO candidato
  a CUMPLIDO todavía para la granularidad completa de estados") **queda
  resuelta a nivel de `apps/worker`**. Candidato a que el orquestador
  actualice la nota de estas 3 filas para reflejar que la granularidad
  fina ya se persiste en la columna real, no solo en `evidence.fineState`
  — sujeto a confirmar si `apps/api`/`apps/web` ya leen `source_runs.status`
  directamente (fuera del alcance de esta verificación puntual).
- **REQ-146/REQ-150** (unicidad de scheduler, verificación puntual de
  fuente): sin cambios respecto a la recomendación ya hecha en
  `worker-cierre.md` (candidatos a CUMPLIDO por la mitigación
  advisory-lock + índice único real); esta ronda no aporta evidencia nueva
  sobre ellos.
- **REQ-165** (prohibido enviar/firmar/actuar sin autorización explícita):
  la fila cita como parte de la razón para mantener EN_EVIDENCIA (además
  de AG-05) el hueco de AG-23 en la detección de `organizationId`/datos de
  tenant colados en argumentos de runtime. Con AG-23 confirmado CERRADO de
  forma independiente en esta ronda, **esa razón específica queda
  resuelta**; la fila debe permanecer EN_EVIDENCIA de todas formas por
  AG-05 (límite de diseño arquitectónico irresoluble, sin relación con
  AG-23, sin cambios en esta ronda) — recomendación: actualizar la nota de
  la fila para que cite únicamente AG-05 como causa pendiente, no ya AG-23.
- **REQ-159/REQ-161/REQ-162/REQ-163** (versionado, hash de insumos
  sellado, invalidación automática de aprobaciones): la advertencia de la
  ronda anterior ("con la advertencia de §3.1 sobre la precisión de la
  afirmación 'infalsificable'") **queda resuelta** — REVERIFY3-EXP-A se
  confirma CERRADO de forma independiente en esta ronda con 3 vectores de
  ataque adicionales (`Object.create`, `setPrototypeOf`, copia de símbolo
  real + `WeakSet`) sin bypass. Candidato a que el orquestador retire esa
  advertencia de la nota de estas filas a nivel de librería
  (`packages/expediente`); el veredicto agregado de A6-A15 en
  `docs/ACEPTACION.md` permanece sin cambios (depende de integración real
  API/UI, fuera de este alcance).
- Ningún otro REQ cambia de candidatura respecto a lo ya registrado en
  `worker-cierre.md`, `agents-cierre.md` y `expediente-cierre.md`.

---

## Conclusión

Los 3 cierres puntuales del encargo (`apps/worker` WK-19..23, `packages/agents`
AG-23, `packages/expediente` REVERIFY3-EXP-A + residual EX-EXP-18) se
confirman **CERRADOS** con evidencia adversarial directa e independiente
(39 ataques propios, 0 bypasses). Las 3 suites reproducen exactamente los
conteos declarados (298/263/398, los 3 con `exit 0`), y `apps/api
typecheck` sobre el HEAD commiteado no tiene errores que clasificar. No se
encontraron hallazgos nuevos.
