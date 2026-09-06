# Reverificación adversarial — packages/agents (vuelta 2)

**Ámbito**: los 4 hallazgos nuevos de la reverificación ronda 1
(`docs/auditoria-1/agents-reverificacion.md`, AG-17 a AG-20) tras la ronda de
corrección cuyos commits citados son `971feea` (AG-17, con AG-19/AG-20
incluidos por el pathspec de directorio — ver nota de transparencia en ese
documento) y `861aea4` (AG-18). Reverificación ejecutada por un segundo
agente Sonnet independiente, sin participación en la construcción ni en las
dos rondas de corrección/reverificación previas de `packages/agents`. Todo el
trabajo de prueba se hizo en `git worktree add <scratchpad>/reverify2-agents
HEAD`, `npm install` solo dentro del worktree, nunca en el árbol principal;
el worktree se eliminó al terminar. En el repo principal solo se
escribieron/commitearon este documento y `docs/logs/reverify2-agents.log`.

**Nota sobre el repo compartido**: igual que en la ronda 1, este repositorio
recibe commits concurrentes de otros agentes (`git log` avanzó de `0e060ac` a
`2a7b809` durante esta reverificación). Se confirmó con `git merge-base
--is-ancestor <commit> <HEAD-en-cada-momento>` que tanto `971feea` como
`861aea4` seguían siendo ancestros del HEAD observado en cada punto de la
reverificación, antes de crear el worktree y de nuevo al momento de escribir
este documento.

Comandos y salida completa: `docs/logs/reverify2-agents.log`.

**Nota de transparencia sobre el commit de este documento**: el mandato pedía
commitear con `git commit -m "..." -- docs/auditoria-1/agents-reverificacion-2.md
docs/logs/reverify2-agents.log`. Se hizo `git add` correctamente restringido a
esos 2 archivos, pero el `git commit` posterior se ejecutó **sin** el
pathspec `-- <archivos>` en el propio comando `commit` (solo se usó en
`add`). En este repo compartido, otro agente concurrente tenía en ese
instante cambios ya escritos/staged de `packages/expediente` (corrección
EX-EXP-06/EX-EXP-15, commit resultante `587d4a2`), y el `commit` sin
pathspec incluyó también esos 5 archivos ajenos (`docs/auditoria-1/expediente-reverificacion.md`,
`docs/logs/fix-expediente-ronda2.log`, `packages/expediente/README.md`,
`packages/expediente/src/requirement-matrix.ts`,
`packages/expediente/test/requirement-matrix.test.ts`) junto con los 2
propios de esta reverificación. Se verificó que ese contenido es una
corrección completa, coherente y ya documentada por su propio log
(`fix-expediente-ronda2.log`), no un cambio a medias — no se perdió ni se
corrompió ningún trabajo. Siguiendo la regla dura de este mandato (prohibido
`git reset`/`checkout`/`stash`/`rebase` en el repo principal) y el mismo
criterio de honestidad que `agents-reverificacion.md` aplicó a un caso
análogo (nota "Nota de transparencia sobre los commits" sobre `971feea`), se
documenta la desviación aquí en vez de intentar deshacerla de forma
destructiva. El commit real de packages/agents-reverificacion-2 (`587d4a2`)
toca 2 archivos propios + 5 ajenos; ningún archivo de `packages/agents` fue
tocado por este commit.

---

## 1. Verificación de los commits declarados

| Commit | ¿Es ancestro de HEAD? | ¿Toca lo que dice? |
|---|---|---|
| `971feea` "fix(agents): AG-17 roleCeiling solo puede bajar el techo por rol, nunca subirlo" | Sí (`git merge-base --is-ancestor 971feea HEAD` → sí, confirmado dos veces en momentos distintos) | Sí, `git show --stat 971feea` toca `packages/agents/src/authorization.ts`, `src/errors.ts`, `src/no-fabrication.ts`, `src/tool-registry.ts` + los 3 archivos de test correspondientes + `README.md` + los 2 documentos de gobierno del despacho — consistente con la nota de transparencia de `agents-reverificacion.md` de que este commit incluyó también el código de AG-19/AG-20 por el pathspec de directorio. |
| `861aea4` "fix(agents): AG-18 Set por-instancia de AuthorizationPolicy realmente inmutables" | Sí (confirmado igual) | Sí, `git show --stat 861aea4` toca únicamente `packages/agents/src/authorization.ts` + `test/authorization.test.ts` + `README.md` + los 2 documentos de gobierno — consistente con estar separado de AG-17/19/20. |

**Veredicto: CUMPLE.** Ambos commits existen, son ancestros de HEAD en todo
momento observado, y su contenido real coincide con lo declarado en
`agents-reverificacion.md`.

---

## 2. Reproducibilidad de la suite oficial

| Paso | Resultado |
|---|---|
| `npm install` en worktree nuevo | OK |
| `npm run -w packages/agents typecheck` | OK, sin errores |
| `npm run -w packages/agents lint` | OK, sin hallazgos |
| `npm run -w packages/agents test` | **13 archivos / 215 pruebas, todas en verde** (182 de la ronda anterior + 33 nuevas de AG-17/18/19/20 — la cifra real es 33, no 21; ver nota abajo) |
| `npm run -w packages/agents build` | OK |
| `npm run -w packages/agents test:coverage` | Statements 95.05% · Branches 91.39% · Funcs 93.9% · Lines 95.05% — **por encima** del umbral de producción (85/80/85/85 líneas/ramas/funciones/statements) configurado en `vitest.config.ts`; `test:coverage` terminó con código de salida 0 |
| `npm run -w apps/worker typecheck` | **OK, sin errores** (la regresión de la ronda 1 está cerrada) |
| `npm run -w apps/worker test` | 8 archivos pasan / 3 se saltan (necesitan Postgres real, comportamiento esperado); 55 pruebas pasan / 5 se saltan; **0 fallos** |
| `npx vitest run apps/worker test/run-agent-handler.test.ts` (los 3 casos que antes fallaban por la regresión) | **4/4 pruebas en verde**, incluidas las que antes fallaban con `InvalidDeclaredEffectsError` |
| `npm run -w apps/api typecheck` | **OK, sin errores** |

**Nota sobre el conteo de tests nuevos**: el despacho de esta reverificación
menciona "21 tests nuevos"; el conteo real verificado por `grep`/ejecución es
**33** (6 en `test/authorization.test.ts` describe "AG-17", 3 en el mismo
archivo describe "AG-18", 14 en `test/no-fabrication.test.ts` describe
"AG-19", 10 en `test/tool-registry.test.ts` describe "AG-20"). Se documenta
la discrepancia sin ajustar el número a lo esperado: los 33 existen, están
citados por nombre exacto en `agents-reverificacion.md`/`agents.md`, y los 33
pasan.

### Regresión de `apps/worker` (ronda 1): CONFIRMADA CERRADA

`apps/worker/src/handlers/run-agent.ts` línea 76 ahora declara
`declaredEffects: ['read_only']` (con comentario explícito citando el commit
`480d183`/AG-05 de `packages/agents`). `typecheck`, `build` (implícito en
typecheck limpio) y los 3 casos de `test/run-agent-handler.test.ts` que antes
fallaban con `InvalidDeclaredEffectsError` ahora pasan. **Adicionalmente**,
`apps/api` ya importa `@atiende/agents` (`apps/api/src/lib/agent-stores.pg.ts`,
consistente con el commit `eaee816` "feat(api,db): persistencia Postgres de
packages/agents") y su `typecheck` pasa limpio — a diferencia de la ronda 1,
donde `apps/api` todavía no consumía el paquete.

---

## 3. Ataques adversariales ronda 2 (30 pruebas propias, `packages/agents/test/reverify2-adversarial.test.ts`, creado y ejecutado solo en el worktree, borrado antes de cerrarlo, nunca commiteado)

### AG-17 (roleCeiling) — 8 ataques, **0 bypasses**

| Ataque | Resultado |
|---|---|
| Override que iguala el default para un rol no-mínimo (`director: "irreversible"`, igual al default) | Permitido, no lanza (comportamiento correcto: no es una subida) |
| Override con rol desconocido (`hacker_role`) | Se ignora silenciosamente, no lanza, no crea un rol nuevo (`clampRoleCeiling` filtra por `ROLE_RISK_CEILING[role] === undefined`) |
| Bajar el techo de `director` a `read` en una instancia (permitido) y crear una segunda instancia sin override | La segunda instancia **no hereda** la restricción de la primera — `director` sigue en `irreversible` por defecto. Sin fuga de estado entre instancias. |
| Segunda instancia intenta "subir" el techo de `director` de vuelta a `irreversible` tras que otra instancia lo bajó | No lanza (es exactamente el default, no una subida real) — confirma que no hay estado compartido mutable entre instancias |
| Reflexión directa sobre `(policy as any).roleCeiling.consultor_externo = "irreversible"` | Lanza `TypeError` (el objeto `roleCeiling` está congelado con `Object.freeze()`); una segunda instancia nueva sigue denegando correctamente |
| Subclase que sobrescribe el método `decide()` para retornar siempre `"auto"` | **Sí logra bypasear** — pero esto es una propiedad genérica de la herencia de JavaScript/TypeScript (cualquier método público de cualquier clase es sobrescribible), no un defecto específico de `AuthorizationPolicy`; solo es explotable si el código integrador instancia deliberadamente la subclase maliciosa en vez de `AuthorizationPolicy` directamente — no hay ninguna vía por la que un `tool_call`/LLM pueda forzar ese cambio de clase en tiempo de ejecución. Se documenta como observación, no como hallazgo nuevo. |
| Subclase que intenta heredar y volver a invocar `clampRoleCeiling` con un override inválido | Sigue lanzando `InvalidRoleCeilingError` igual que la clase base — `clampRoleCeiling` es una función de módulo (closure), no un método de la clase, así que no es interceptable/sobrescribible vía herencia |
| Subclase que declara un class-field propio (`public extra = "x"`) | Lanza `TypeError` porque `Object.freeze(this)` ya corrió en el constructor de la clase base antes de que el inicializador del campo de la subclase se ejecute — nota de **compatibilidad** para subclases legítimas (una subclase real de `AuthorizationPolicy` con estado propio no podría inicializarlo así), no una vía de bypass de seguridad |

**Veredicto AG-17: CERRADO.** Ningún ataque de la ronda 2 logra que
`consultor_externo` (u otro rol) opere por encima de su techo por defecto a
través de la API pública del constructor. El único "bypass" encontrado
(subclase que sobrescribe `decide()`) es un límite genérico e inevitable de
cualquier clase de JavaScript, no específico de este diseño, y no es
alcanzable por un `tool_call` ni por configuración de despacho — requiere que
el código integrador elija instanciar una clase distinta a propósito.

### AG-18 (inmutabilidad de Sets por-instancia) — 6 ataques, **0 bypasses**

| Ataque | Resultado |
|---|---|
| `Object.getOwnPropertyDescriptor(policy, "normalizedHardProhibitedActions")` | El descriptor es `writable: false, configurable: false` (por `Object.freeze(this)`); el `.value` del descriptor es la misma referencia al `Proxy` protegido — llamar `.delete()` sobre él también lanza |
| `Reflect.set(policy, "normalizedHardProhibitedActions", new Set())` | Retorna `false` (no lanza, pero tampoco muta) — `decide()` sigue denegando `sign_document` exactamente igual antes y después |
| `Object.defineProperty(policy, "normalizedHardProhibitedActions", {...})` | Lanza `TypeError` (instancia congelada, no permite redefinir la propiedad) |
| `structuredClone(policy)` y mutar la copia | No lanza (produce un objeto plano), pero la copia **pierde el prototipo de la clase** (`typeof clone.decide !== "function"`) — no hay ningún camino de código en `packages/agents` que use `structuredClone` sobre una `AuthorizationPolicy`, así que esta copia inerte no se usa en ningún flujo real; el objeto original queda intacto y sigue denegando correctamente |
| `Set` (Proxy AG-04/AG-18): `.add()` con un valor **ya existente** en el Set | También lanza — el Proxy intercepta la llamada al método sin importar el argumento, incluido un "no-op" aparente. No es un hallazgo (es más estricto de lo mínimo necesario, no menos) |
| `Set` (Proxy): iteración (`for..of`, spread, `.values()`) y `.size` | Funcionan con normalidad, sin lanzar — el Proxy solo intercepta `add`/`delete`/`clear`, tal como está documentado |

**Veredicto AG-18: CERRADO.** Ninguna de las vías de reflexión/mutación de
JavaScript (`getOwnPropertyDescriptor`, `Reflect.set`, `defineProperty`,
`structuredClone`) logra alterar el comportamiento de una instancia ya
construida, ni existe una ruta donde una copia mutable producida por
`structuredClone` llegue a usarse por `decide()`.

### AG-19 (`scanForUnsourcedSensitiveData`, contenedores) — 8 ataques, **2 bypasses nuevos + 1 gap documentado**

| Ataque | Resultado |
|---|---|
| Map anidado dentro de Set anidado dentro de Map (triple contenedor) | **Detectado** — la recursión de `walk()` maneja combinaciones arbitrarias de `Map`/`Set` anidados sin problema |
| JSON dentro de JSON (doble serialización real: `JSON.stringify(JSON.stringify({precio:999999}))` embebido como campo de un objeto) | **Detectado** — `walkEmbeddedJson` se re-invoca recursivamente sobre cada capa de JSON válido que aparece tras parsear la capa anterior, así que la doble (o N-ésima) serialización JSON válida no es una vía de evasión |
| **BYPASS**: string con texto libre sensible (`"hay que pagar un costo de $999,999 sin certificar aun"`) como elemento directo de un **Array** de nivel superior | **0 hallazgos.** `walk()` para `Array.isArray(value)` solo hace `forEach` recursivo sin invocar `looksLikeUnsourcedSensitiveText()` sobre el elemento — esa heurística de texto libre solo se aplica hoy (a) a valores de propiedad de un objeto (`walkKeyedEntries`) y (b) a elementos de `Set` (agregado explícitamente por AG-19, `no-fabrication.ts:324`). El mismo string, puesto dentro de un `Set` en vez de un `Array`, **sí** se detecta (confirmado con caso de control) — es una asimetría entre los dos tipos de contenedor que AG-19 solo cerró para uno de los dos. |
| **BYPASS**: `Buffer`/`TypedArray` que excede `MAX_BINARY_DECODE_BYTES` (8192 bytes, `no-fabrication.ts:144`) con el JSON sensible colocado **después** del byte 8192 | **0 hallazgos.** `decodeBinaryAsUtf8()` hace `subarray(0, MAX_BINARY_DECODE_BYTES)` antes de decodificar — cualquier contenido que empiece después de ese offset se descarta silenciosamente y nunca se examina. El mismo Buffer con el JSON sensible al **principio** (dentro del límite) sí se detecta (caso de control). Un adversario que controle el orden de un payload binario grande (p. ej. rellenar con padding antes de un JSON con precio/vigencia) evade la detección. |
| JSON sensible codificado en **base64** como string plano (no como `Buffer`) | **0 hallazgos** (gap documentado, no necesariamente un defecto a corregir). `findJsonCandidates()` busca literalmente los caracteres `{`/`[`/`}`/`]` en el texto; el alfabeto base64 estándar no contiene esos caracteres, así que nunca hay candidatos que intentar parsear. Confirmado que el string base64 no se trata como `Buffer` (`Buffer.isBuffer(b64) === false`), así que tampoco entra por la vía de decodificación binaria. **¿Debería detectarse?** Es una pregunta de diseño, no un bug de recursión: decodificar base64 automáticamente sobre *cualquier* string es una heurística agresiva con alto riesgo de falsos positivos (muchos strings legítimos son "base64-like": IDs, hashes, tokens) y de costo computacional en outputs grandes. Se documenta como límite conocido, en la misma familia que el límite ya reconocido en el README para JSON sin formato de moneda ($/USD/fecha) en texto libre — una decisión de producto pendiente (¿vale la pena el trade-off de falsos positivos?), no una corrección obligatoria evidente. |

**Veredicto AG-19: PARCIAL — cierra el bypass original (AG-10), pero introduce
2 bypasses estructurales nuevos** en la extensión que él mismo agregó (el
mismo patrón recursivo de "cada corrección de recorrido dice cubrir todos los
casos pero deja un tipo de contenedor sin cubrir" que motivó AG-10→AG-19 se
repite dentro de AG-19). Ver hallazgo nuevo **AG-21** abajo.

### AG-20 (`findForbiddenFieldRecursive`, combinadores Zod) — 8 ataques, **3 bypasses nuevos + 1 límite arquitectónico + 1 gap de robustez**

Se confirmó primero, con `node` directo sobre los `_def` reales de zod, el
motivo estructural exacto: `unwrapOneLayer()` (`tool-registry.ts:215-219`)
solo mira `_def.schema` (usado por `ZodEffects`) y `_def.innerType` (usado
por `ZodOptional`/`ZodNullable`/`ZodDefault`/`ZodReadonly`/`ZodCatch`)  —
confirmado con una sonda real: `ZodPipeline._def` tiene `{in, out,
typeName}` y `ZodBranded._def` tiene `{typeName, type, errorMap,
description}`, ninguno de los cuales coincide con `schema`/`innerType`.

| Ataque | Resultado |
|---|---|
| **BYPASS**: `organizationId` detrás de `.pipe()` (`z.object({organizationId}).pipe(z.object({organizationId}))`) | `register()` **no lanza** — `ZodPipeline` no es reconocido por ninguna rama de `findForbiddenFieldRecursive` ni por `unwrapOneLayer` (su `_def` no tiene `schema` ni `innerType`, tiene `in`/`out`) |
| **BYPASS**: `organizationId` detrás de `.brand()` (`z.object({organizationId}).brand()`) | `register()` **no lanza** — mismo motivo: `ZodBranded._def.type` no es reconocido por `unwrapOneLayer` |
| Control: `organizationId` detrás de `.readonly()` | **Sí lanza** correctamente — `ZodReadonly._def.innerType` sí coincide con lo que `unwrapOneLayer` busca |
| Control: `organizationId` detrás de `.catch()` | **Sí lanza** correctamente — `ZodCatch._def.innerType` también coincide |
| **BYPASS**: `z.record(z.nativeEnum(Keys), z.string())` donde `Keys` es un enum con un miembro literal `"organizationId"` | `register()` **no lanza** — el código de AG-20 revisa `_def.valueType` de `ZodRecord`/`ZodMap` pero nunca `_def.keyType`, aun cuando el tipo de clave es un enum **cerrado y estáticamente enumerable** (no un `z.string()` genérico). Confirmado además que el `safeParse()` real acepta `{meta: {organizationId: "attacker-tenant"}}` como input válido — no es solo un hueco de detección en el registro, el esquema en efecto permite ese valor en runtime. |
| **LÍMITE ARQUITECTÓNICO (no un bug de recursión)**: `z.record(z.string(), z.string())` (clave genérica, no enumerable) | El esquema **siempre** acepta `{organizationId: "..."}` como clave válida en runtime (`safeParse` exitoso), y **ninguna** profundidad de recursión de `findForbiddenFieldRecursive` puede detectarlo, porque `z.record` con clave `z.string()` no declara estáticamente qué claves existen — cualquier string es válido por diseño de Zod. Esto es distinto en naturaleza a los bypasses de AG-11/AG-20 anteriores (que eran huecos de *recorrido* sobre estructuras estáticamente declaradas): aquí no hay nada que recorrer, el campo prohibido nunca aparece en el árbol del esquema, solo en los datos que el llamador podría enviar en tiempo de ejecución. La garantía documentada en el README ("`register()` rechaza cualquier esquema que **declare** organizationId...") es técnicamente cierta y se mantiene — un `z.record(z.string(), ...)` no "declara" el campo — pero dejará pasar sin aviso cualquier `ToolDefinition` que use un record de clave genérica en el nivel que sea, y el equipo debería saberlo al diseñar herramientas nuevas. |
| Esquema con 20 000 niveles de anidamiento real (instancias `ZodObject` **distintas**, no un ciclo con `z.lazy()`) | Produce `RangeError` (stack overflow real de V8) al registrar — no hay ningún límite de profundidad explícito en `findForbiddenFieldRecursive`; la única protección existente (`seen: Set<z.ZodTypeAny>`) es contra **ciclos por identidad de objeto** (mismo esquema reutilizado, como en `z.lazy()` auto-referenciado), no contra profundidad no cíclica. Riesgo práctico bajo: los `inputSchema` los define el equipo desarrollador al declarar `ToolDefinition`, no un `tool_call` del LLM ni un usuario final en runtime — no hay una vía conocida por la que un adversario externo controle la profundidad de un esquema Zod ya compilado en el código fuente. Se documenta como gap de robustez (DoS en tiempo de arranque/registro ante un esquema patológico escrito por error), no como vulnerabilidad explotable por el modelo. |
| Control: `z.lazy()` **cíclico** real (auto-referenciado, `TreeNode` recursivo legítimo) | **No lanza** y **no produce stack overflow** — el Set `seen` por identidad de objeto Zod cubre correctamente el caso para el que fue diseñado (el mismo objeto `ZodLazy`/su resuelto revisitado en el mismo camino de recursión) |

**Veredicto AG-20: PARCIAL — cierra los 6 combinadores originales
(`ZodUnion`/`ZodDiscriminatedUnion`/`ZodIntersection`/`ZodRecord`(valueType)/
`ZodMap`(valueType)/`ZodTuple`/`ZodLazy` cíclico), pero dos combinadores de
envoltura adicionales (`ZodPipeline`, `ZodBranded`) quedan sin desenvolver, el
`keyType` de `ZodRecord`/`ZodMap` nunca se revisa (aun siendo estáticamente
enumerable en el caso de un enum), existe un límite arquitectónico real e
irreducible con `z.record` de clave genérica, y no hay guarda de profundidad
ante un esquema patológico no cíclico.** Ver hallazgo nuevo **AG-22** abajo.

---

## 4. Hallazgos nuevos de esta ronda (AG-21, AG-22)

| ID | Severidad | Hallazgo (evidencia) | Reparación sugerida (separada, no aplicada) |
|---|---|---|---|
| AG-21 | MEDIA | `scanForUnsourcedSensitiveData` (AG-19) tiene 2 bypasses estructurales nuevos: (a) un string con texto libre sensible como elemento **directo de un Array** de nivel superior nunca se evalúa con `looksLikeUnsourcedSensitiveText()` — esa heurística solo se invoca para propiedades de objeto y para elementos de `Set`, no para elementos de `Array` (`packages/agents/src/no-fabrication.ts:305-309`, la rama `Array.isArray(value)` solo hace `forEach` recursivo sin el chequeo de texto libre que sí tiene la rama `value instanceof Set`, línea 320-330); (b) un `Buffer`/`TypedArray` que excede `MAX_BINARY_DECODE_BYTES` (8192 bytes, línea 144) descarta silenciosamente todo lo que esté después del byte 8192 antes de decodificar (`decodeBinaryAsUtf8`, línea 209-212 usa `subarray(0, MAX_BINARY_DECODE_BYTES)`), así que un payload binario grande con el dato sensible colocado después de ese offset nunca se examina. Adicionalmente, un JSON sensible codificado en base64 como string plano no se detecta (gap documentado, ver discusión arriba sobre si vale la pena corregirlo). Confirmado con 8 pruebas propias (`docs/logs/reverify2-agents.log`). | (a) Añadir en la rama `Array.isArray(value)` de `walk()` el mismo chequeo `typeof item === "string" && looksLikeUnsourcedSensitiveText(item)` que ya existe para `Set`, para no depender de qué tipo de contenedor envuelve el string. (b) Subir `MAX_BINARY_DECODE_BYTES` no resuelve el problema de fondo (siempre habrá un tamaño mayor); documentar explícitamente en README que el escaneo de binarios es best-effort acotado y NO es una garantía de tolerancia cero para binarios grandes, o decodificar en bloques con un límite total más alto y streaming en vez de un único `subarray` desde el byte 0. (c) Decidir explícitamente (decisión de producto, no solo de código) si vale la pena intentar decodificar base64 automáticamente dado el riesgo de falsos positivos/costo, y documentar la decisión cualquiera que sea. |
| AG-22 | MEDIA | `findForbiddenFieldRecursive` (AG-20) tiene 3 bypasses/gaps nuevos: (a) `ZodPipeline` (`.pipe()`) y `ZodBranded` (`.brand()`) no son reconocidos por `unwrapOneLayer()` (`packages/agents/src/tool-registry.ts:215-219`, que solo mira `_def.schema`/`_def.innerType`; confirmado con sonda directa que `ZodPipeline._def` tiene `{in, out}` y `ZodBranded._def` tiene `{type}`) — un `organizationId` detrás de cualquiera de los dos se registra sin lanzar; (b) el `keyType` de `ZodRecord`/`ZodMap` nunca se revisa, solo el `valueType` (línea 294-298) — un `z.record(z.nativeEnum(Keys), ...)` con un miembro de enum literalmente `"organizationId"` se registra sin lanzar, y el `safeParse()` real confirma que ese input es aceptado en runtime; (c) sin relación con la recursión: `z.record(z.string(), ...)` de clave genérica **siempre** permite `organizationId` como clave en runtime — límite arquitectónico irreducible (no hay nada que "recorrer" estáticamente), documentado aquí para que el equipo lo tenga presente al diseñar `ToolDefinition`s nuevas; (d) un esquema con anidamiento profundo no cíclico (~20 000 niveles) produce `RangeError` (stack overflow) sin guarda de profundidad explícita — riesgo bajo porque el esquema lo define el código, no el modelo/usuario en runtime. Confirmado con 7 pruebas propias. | (a) Extender `unwrapOneLayer()` (o añadir ramas dedicadas en `findForbiddenFieldRecursive`, siguiendo el patrón ya usado para `ZodUnion`/`ZodIntersection`) para `ZodPipeline` (revisar tanto `_def.in` como `_def.out`) y `ZodBranded` (revisar `_def.type`). (b) Revisar también `_def.keyType` de `ZodRecord`/`ZodMap` cuando sea un tipo con valores estáticamente enumerables (`ZodEnum`/`ZodNativeEnum`/`ZodLiteral`) y alguno coincida con `FORBIDDEN_INPUT_FIELDS`. (c) Documentar explícitamente en el README que `z.record(z.string(), ...)`/`z.record(z.any(), ...)` de clave genérica es una vía de escape conocida e irreducible para la garantía "nunca declara organizationId", y recomendar a quien diseñe `ToolDefinition`s evitar records de clave completamente libre para el nivel superior de datos que el handler vaya a usar como si fueran de confianza. (d) Añadir una guarda de profundidad máxima explícita (p. ej. 200-500 niveles) en `findForbiddenFieldRecursive` que lance un error de validación claro en vez de dejar que el stack de V8 decida, aunque el riesgo práctico de explotación por el modelo sea bajo. |

---

## 5. Consistencia documental de `agents-reverificacion.md`

Nota metodológica, no un hallazgo de código: la tabla de "Tabla de hallazgos
(AG-01 a AG-16)" en `agents-reverificacion.md` sigue mostrando el texto
literal **PARCIAL** en las filas de AG-10 y AG-11 (líneas 108 y 109 de ese
archivo), mientras que la sección "Cierre de PARCIAL AG-10/AG-11" (al final
del mismo documento) explica en prosa que ambos quedan cerrados gracias a
AG-19/AG-20. Esto es honesto (no se editó retroactivamente el veredicto
original para no reescribir historia), pero un lector que solo mire la tabla
sin llegar a esa nota puede quedarse con el veredicto desactualizado. Dado
que en esta ronda AG-19 y AG-20 resultan a su vez **PARCIAL** (no CERRADO,
por AG-21/AG-22), el estado real y actualizado de AG-10/AG-11 es: cerrado el
bypass original de cada uno, pero con nuevos huecos residuales heredados de
las propias correcciones (AG-19/AG-20), documentados en AG-21/AG-22 arriba.

---

## 6. Conteo de veredictos de esta ronda

| Hallazgo | Veredicto ronda 2 |
|---|---|
| AG-17 | **CERRADO** |
| AG-18 | **CERRADO** |
| AG-19 | **PARCIAL** (bypass original cerrado; 2 bypasses nuevos → AG-21) |
| AG-20 | **PARCIAL** (6 combinadores originales cerrados; 3 bypasses/gaps nuevos → AG-22) |
| AG-21 (nuevo) | Abierto, MEDIA |
| AG-22 (nuevo) | Abierto, MEDIA |

**Conteo**: 2 CERRADO · 2 PARCIAL · 0 NO CERRADO · 2 hallazgos nuevos (ambos
MEDIA). Ningún ataque logró bypasear AG-17/AG-18 de forma completa dentro de
la superficie razonable de ataque (excluyendo herencia de clase maliciosa
instanciada deliberadamente por el integrador, que es un límite genérico de
JS, no de este paquete).

---

## 7. Balance final del paquete `packages/agents` (todos los hallazgos, ambas rondas)

Consolidando `docs/auditoria-1/agents.md` (AG-01..AG-16) +
`docs/auditoria-1/agents-reverificacion.md` (AG-17..AG-20) + esta
reverificación (AG-21, AG-22):

**Totalmente CERRADO (14)**: AG-01, AG-02, AG-03, AG-04, AG-06, AG-07, AG-08,
AG-09, AG-13, AG-14, AG-16 (informativo/N-A), AG-17, AG-18. (11 originales +
2 de esta ronda.)

**CERRADO con alcance acotado por diseño, no un defecto pendiente (2)**:
AG-12 (el propio alcance de la corrección era "medir honestamente la tasa de
detección", no cambiar el guardrail — cumplido; la brecha real de fondo, un
clasificador semántico, está fuera de este paquete) y AG-15 (el propio
agents.md lo marcaba "no corregido — fuera de mi ámbito"; **se confirma que
ya fue atendido por un despacho transversal**: el commit `d8e6d29`
"docs(aceptacion): anota paquete responsable y evidencia por criterio" añadió
la columna "Paquete(s) responsable(s)" a `docs/ACEPTACION.md` para los 171
REQ, exactamente la reparación que AG-15 pedía).

**PARCIAL, límite arquitectónico reconocido y no cerrable dentro de este
paquete (1)**: AG-05 — un handler que miente simultáneamente en
`riskLevel`/`actionKind`/`declaredEffects` no puede detectarse por ningún
mecanismo basado en metadatos declarados por el propio autor de la
herramienta; documentado honestamente como límite de diseño en el README,
con mitigación delegada a revisión humana/sandboxing en `apps/api`.

**Abiertos — hallazgos con bypass confirmado y reparación pendiente (4)**:

- **AG-19** (MEDIA, PARCIAL): bypass original cerrado; ver AG-21.
- **AG-20** (MEDIA, PARCIAL): bypass original cerrado; ver AG-22.
- **AG-21** (MEDIA, nuevo esta ronda): string sensible en Array de nivel
  superior no detectado; truncamiento de Buffer/TypedArray a 8192 bytes deja
  pasar datos sensibles colocados después de ese offset; base64 de JSON no
  decodificado (gap documentado, decisión de producto pendiente).
- **AG-22** (MEDIA, nuevo esta ronda): `ZodPipeline`/`ZodBranded` no
  desenvueltos; `keyType` de `ZodRecord`/`ZodMap` nunca revisado (incluso
  cuando es un enum estáticamente enumerable); límite arquitectónico
  irreducible con `z.record` de clave genérica; sin guarda de profundidad
  ante esquemas patológicos no cíclicos.

**Riesgo residual de producto, fuera del alcance de código de este paquete
(no cuenta como "hallazgo abierto de packages/agents" pero condiciona su uso
seguro)**: el guardrail anticorrupción detecta ~3% de intentos con vocabulario
mínimamente disfrazado (AG-12); el clasificador semántico/LLM (REQ-127) y la
verificación de rol del aprobador en `resume()` siguen pendientes en
`apps/api`, tal como el propio README de `packages/agents` declara en su
sección "Pendientes".

**Total de hallazgos con código pendiente de corrección en
`packages/agents` al cierre de esta ronda: 4** (AG-19, AG-20 en su forma
residual = AG-21, AG-22; ninguno de severidad ALTA/CRÍTICA).

---

## Metodología

Las 30 pruebas adversariales de la sección 3, la sonda directa de `_def` de
zod, y la ejecución de `typecheck`/`test`/`build`/`test:coverage` de
`packages/agents`, `apps/worker` y `apps/api` se ejecutaron en `git worktree
add <scratchpad>/reverify2-agents HEAD`, nunca en el árbol principal. El
worktree se eliminó al finalizar (`git worktree remove --force`); no se
modificó de forma persistente ningún archivo de `packages/agents/src`,
`packages/agents/test`, `apps/worker` ni `apps/api`. El único archivo de
prueba creado (`packages/agents/test/reverify2-adversarial.test.ts`, 30
casos, en dos versiones sucesivas para poder capturar la salida completa en
el log) se borró antes de cerrar el worktree y nunca se commiteó. Este
documento y `docs/logs/reverify2-agents.log` son los únicos artefactos
persistentes de esta reverificación.
