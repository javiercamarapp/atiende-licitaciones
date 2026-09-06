# Reverificación adversarial — corrección de `packages/mail` (ML-01..ML-07)

Reverificador independiente (Sonnet, contexto separado del auditor original y del corrector).
Trabajo realizado en un `git worktree` aislado (`git worktree add <scratchpad>/reverify-mail HEAD`,
commit `65af1db`), `npm install` local, sin tocar el repo principal (no se usó `reset`/`checkout
<commit>`/`stash`/`rebase`/`add -A`). Rol: SOLO ENCONTRAR Y VERIFICAR — no se corrigió código.
Evidencia completa de comandos en `docs/logs/reverify-mail.log`.

## Resumen de veredicto

| # | Rubro | Veredicto |
|---|---|---|
| 1 | Ancestría / commits | CONFIRMADO — 6 commits lineales, cada uno solo toca `packages/mail/**` |
| 2 | Suite (252), cobertura, build, preview | CONFIRMADO — reproducido de punta a punta, cifras idénticas a lo declarado |
| 3 | Gate por mutación | NO EXISTE — no hay infraestructura de mutation testing en el repo (ver nota) |
| 4 | ML-01 (idempotencia bajo concurrencia) | **CORREGIDO, verificado con ataques nuevos** (50 concurrentes, release, claves distintas) — 1 hallazgo menor nuevo (ML-08) |
| 5 | ML-02 (List-Unsubscribe) | **CORREGIDO, verificado en las 16 plantillas** |
| 6 | ML-03 (safeUrl) | **CORREGIDO, verificado contra 12 variantes de ataque** — 0 bypass nuevo |
| 7 | ML-04 (contraste faint) | **CORREGIDO, re-derivado con función WCAG propia** — 1 hallazgo nuevo de bajo riesgo (ML-09, modo oscuro) |
| 8 | ML-05 (replay webhook) | **CORREGIDO, verificado contra 6 escenarios adversariales** — 0 bypass |
| 9 | ML-06 (npm audit dev) | CONFIRMADO — `npm audit --omit=dev` = 0 en este worktree |
| 10 | ML-07 (trazabilidad ACEPTACION.md) | **SIGUE SIN CORREGIR** (fuera de ámbito del corrector, como él mismo documentó) |

---

## 1. Ancestría y `git show --stat` de los 6 commits

Los 6 commits de corrección son lineales en `main`, consecutivos por timestamp
(`2026-09-06T13:11:02` a `13:23:02 -06:00`), cada uno tocando **exclusivamente**
`packages/mail/**` (README, `src/`, `test/`) — ninguno toca `apps/`, `packages/db`,
`docs/ACEPTACION.md` ni ningún otro paquete:

| Commit | Hallazgo | Archivos tocados | Líneas |
|---|---|---|---|
| `8dff783` | ML-01 | `mail-service.ts`, `send-store.ts`, 2 test, README | +219/-1 |
| `e2c2927` | ML-03 | `safe-url.ts`, 1 test, README | +69/-4 |
| `cef35a4` | ML-04 | `theme.ts`, 1 test | +23/-2 |
| `208b4c5` | ML-05 | `replay-guard.ts` (nuevo), `verify-signature.ts`, `index.ts`, 2 test, README | +221/-6 |
| `e498dc9` | ML-02 | `list-unsubscribe.ts` (nuevo), `mail-service.ts`, `EmailLayout.tsx`, `index.ts`, 5 test, README | +257/-5 |
| `649693d` | ML-06 (docs) | README (solo documentación, sin código) | +43/-3 |

Orden de aplicación real: ML-01 → ML-03 → ML-04 → ML-05 → ML-02 → ML-06 (no el orden ML-01..ML-07
del índice del informe original, pero eso es irrelevante — cada commit es autocontenido e
independiente, verificado individualmente con `git show`). No hay ningún commit posterior en
`main` que revierta o modifique estos cambios antes de `HEAD` (`65af1db`).

## 2. Reproducción: suite, cobertura, build, preview

Reproducido en el worktree aislado (`npm install`: 818 paquetes, mismos warnings de deprecación
documentados, sin errores):

- `npm audit --omit=dev` → **0 vulnerabilidades** (confirma ML-06 tal cual está documentado).
- `typecheck` → sin errores. `lint` → sin errores.
- `test` → **26 archivos / 252 pruebas, todas en verde** (idéntico a lo declarado en
  `docs/logs/fix-mail.log`).
- `test:coverage` → 252 pruebas en verde, cobertura global **96.26% stmts / 85.17% ramas / 97.89%
  funciones / 96.26% líneas** — cifras EXACTAS a las declaradas, por encima de los umbrales de
  `vitest.config.ts` (≥85/80/85/85).
- `build` (`tsc -p tsconfig.build.json`) → sin errores.
- `preview` → genera las 16 plantillas + índice, mismos asuntos declarados.

**No existe gate por mutación**: se buscó en todo el repositorio (`find . -iname "*stryker*"`,
`grep -r mutation`) y no hay ninguna herramienta de mutation testing (Stryker u otra) configurada
en `packages/mail` ni en ningún otro paquete del monorepo. La única señal de calidad de pruebas
disponible es cobertura de líneas/ramas (v8), no cobertura de mutantes. Esto no es un defecto de
la corrección auditada (nunca se prometió un gate de mutación), pero es relevante dejarlo
constatado: una cobertura de ramas de 85% no garantiza que las aserciones detecten una lógica
sutilmente incorrecta — los ataques adversariales de las secciones siguientes son la forma en que
esta ronda compensa esa ausencia.

---

## 3. Ataques adversariales por hallazgo

Todos los ataques se ejecutaron como pruebas Vitest ad-hoc del reverificador
(`packages/mail/test/_adhoc-reverify-*.test.ts`, no forman parte de la suite del repo — viven solo
en el worktree temporal) contra el código real de `src/`, nunca contra una reimplementación
propia. Salida completa en `docs/logs/reverify-mail.log`.

### ML-01 — idempotencia por `messageKey` bajo concurrencia

| Ataque | Resultado |
|---|---|
| 50 `send()` disparados en `Promise.all` con la MISMA `messageKey` | **1 sola llamada al provider**, 1 `sent` + 49 `already_sent` |
| `reserve()` tras `not_configured` (sin release explícito habría bloqueado para siempre) | El código SÍ llama `store.release()` explícitamente → una llamada NO concurrente posterior con la misma clave **se libera y reintenta con éxito** |
| Agotar reintentos hasta `dead` (fallo real del proveedor, todos los intentos `retryable`) | `dead` limpia la reserva en `save()` → una llamada NO concurrente posterior con la misma clave **se libera y reintenta con éxito** (no queda bloqueada para siempre) |
| Dos `messageKey` DISTINTAS, 10+10 llamadas en el mismo `Promise.all` | **2 llamadas al provider** (una por clave) — las claves no se bloquean entre sí, 2 `sent` + 18 `already_sent` |

**Veredicto: ML-01 sigue corregido.** La reserva atómica se sostiene ante 50 llamadas concurrentes
(5x más que el escenario reproducido en la auditoría original), y la respuesta a la pregunta
explícita del encargo — "¿se libera para reintento o queda bloqueada para siempre tras un fallo?"
— es: **se libera correctamente en ambos caminos de fallo** (`not_configured` vía `release()`
explícito; `permanent`/`dead` vía `save()`, que limpia la reserva como efecto secundario de guardar
un estado terminal). Solo el estado `sent` bloquea permanentemente, que es el comportamiento
correcto y deseado.

**ML-08 [NUEVO, severidad BAJA] — la ventana de espera del perdedor de la reserva (~200ms) es
mucho más corta que el timeout documentado de los adaptadores reales (5s).** `waitForReservedRecord`
sondea `store.get()` cada 5ms hasta 40 veces (≈200ms) antes de rendirse y devolver
`already_sent` SIN `providerMessageId`. Se reprodujo con un provider que tarda 400ms en responder
(razonable para una llamada HTTP real a Resend/Postmark, cuyo propio adaptador documenta un
timeout de 5s): la garantía central se sostiene (el provider real se llama **exactamente 1 vez**,
nunca 2), pero el llamador que pierde la carrera recibe un resultado ambiguo (`already_sent` sin
`providerMessageId`) mientras el ganador todavía está en vuelo — no hay forma de distinguir desde
ese resultado "ya se envió con éxito, aquí tienes el id" de "está en curso, no sé todavía". No es
un envío duplicado (la garantía de ML-01 no se rompe), pero es una discrepancia entre el
presupuesto de esta espera interna y la latencia real documentada de los proveedores que
`MailService` ya conoce. Reparación sugerida (no aplicada, fuera del rol de este agente): derivar
el presupuesto de espera de `retryPolicy`/el timeout del proveedor en vez de una constante fija de
200ms, o documentar explícitamente que un `already_sent` sin `providerMessageId` significa
"en curso, no confirmado" para que el llamador no lo trate como éxito silencioso.

### ML-02 — cabeceras `List-Unsubscribe` / `List-Unsubscribe-Post`

Se ejecutó `MailService.send()` contra las **16 plantillas** del catálogo (`listTemplates()`,
capturando el `OutboundEmail` real que llegaría al provider):

- Las **8 plantillas obligatorias** (`email-verification`, `organization-invite`,
  `password-reset`, `two-factor-enabled`, `backup-codes-generated`, `welcome-onboarding`,
  `contact-received`, y la categoría `internal`) → **0 cabeceras `List-Unsubscribe`** en las 8, sin
  excepción.
- Las **8 plantillas no obligatorias** → las 8 traen `List-Unsubscribe: <https://...>,
  <mailto:...>` y `List-Unsubscribe-Post: List-Unsubscribe=One-Click` exacto (valor RFC 8058, no
  solo "presente").
- La URL dentro de `List-Unsubscribe` parsea como `URL()` válida (`http(s)://`) y el `mailto:`
  cumple el patrón de correo válido — la baja de un clic es un enlace **verificable y de un solo
  `POST`** en el sentido de que el header es sintácticamente correcto para que un cliente de correo
  lo dispare sin interacción humana adicional. El endpoint `POST /api/correo/baja` en sí (quien
  aplica el efecto real) vive en `apps/api`, fuera de este paquete — documentado como pendiente,
  correctamente no reclamado como resuelto aquí.

**Veredicto: ML-02 sigue corregido**, sin excepciones en ninguna de las 16 plantillas.

### ML-03 — `safeUrl`

12 ataques ejecutados contra la función real:

| Entrada | Resultado |
|---|---|
| `http://localhost.evil.com/phish` | fallback (rechazado) |
| `http://127.0.0.1.evil/phish` | fallback (rechazado) |
| `http://[::1]/phish` (loopback IPv6) | fallback (rechazado — ver nota) |
| `http://localhost:4000/x` (puerto) | **aceptado** (comportamiento correcto, host exacto) |
| `http://user:pass@localhost/x` (credenciales) | **aceptado** (host exacto tras userinfo) |
| `http://user:pass@evil.com@localhost/x` (confusión de `@`) | **aceptado** — `URL()` resuelve correctamente el hostname real (`localhost`), consistente con cómo lo interpretaría cualquier cliente real |
| `http://localhost@evil.com/x` (userinfo `localhost`, host real `evil.com`) | fallback (rechazado — el host real es `evil.com`, no `localhost`) |
| `javascript:alert(1)` | fallback (rechazado) |
| `data:text/html,<script>` | fallback (rechazado) |
| `https://evil.com/...` | aceptado (comportamiento documentado: `https://` de cualquier host se permite) |
| `http://EVIL.COM/x` (mayúsculas) | fallback (rechazado, sin falso positivo por mayúsculas) |
| `MAIL_PUBLIC_APP_HOST` exacto vs. subdominio/sufijo del mismo | exacto aceptado, subdominio y sufijo **rechazados** (ancla exacta, no por substring) |

**Veredicto: ML-03 sigue corregido, 0 bypass nuevo encontrado** en los 12 vectores probados,
incluidos los explícitamente pedidos en el encargo (`localhost.evil.com`, `127.0.0.1.evil`,
`[::1]`, host con puerto/credenciales, `javascript:`). Nota sin severidad: `[::1]` (loopback IPv6)
no está en la lista blanca de hosts de desarrollo — esto es fail-closed (no es una vulnerabilidad,
es una limitación de completitud: un desarrollador usando IPv6 puro vería su URL caer al fallback),
no se reporta como hallazgo.

### ML-04 — contraste WCAG

Se re-derivó una función de luminancia relativa/razón de contraste **desde cero** (no se copió
`test/theme/contrast.test.ts`), calibrada contra el caso de referencia blanco/negro = 21:1.

- **`faint` (el color corregido por ML-04)**: 4.924:1 vs. `surface`, 4.668:1 vs. `canvas` — ambos
  **≥4.5:1**, cifras que coinciden con las declaradas (4.92/4.67) en el commit `cef35a4`.
  **Confirmado corregido.**
- Matriz completa de 8 tokens de texto × 3 fondos (`surface`/`canvas`/`well`) calculada
  independientemente: **todos los pares usados como texto real en el código (`ink`, `body`,
  `muted`, `faint`, `danger`, `warning`, `success`, `brand`) superan 4.5:1** contra los fondos
  donde realmente se usan como texto — incluyendo `muted` (5.14-5.43:1) y los colores de
  `ToneBadge` (`danger` 6.25:1, `warning` 5.02:1, `success` 5.02:1 contra `surface`), que en el
  código se pintan a 10-12px, tamaño que **no** califica como "texto grande" bajo la definición de
  WCAG (≥18.66px negrita o ≥24px normal) pese a que `test/theme/contrast.test.ts` los prueba con el
  umbral relajado de 3:1 bajo ese supuesto. **No es un hallazgo de accesibilidad real** (los colores
  reales superan 4.5:1 de cualquier forma), pero sí una imprecisión en la justificación/umbral del
  test existente que vale la pena corregir en una ronda futura para que el test no dé, por
  casualidad, un falso verde si algún día se ajusta ligeramente la paleta.

**ML-09 [NUEVO, severidad BAJA] — sin defensa de "modo oscuro" más allá de las etiquetas
`<meta name="color-scheme" content="light only">` / `<meta name="supported-color-schemes" content="light only">`.**
`EmailLayout.tsx` declara explícitamente el correo como "solo modo claro" — mitigación correcta y
suficiente para los clientes que HONRAN esas etiquetas (Apple Mail, Outlook.com/Windows Mail). No
existe, en cambio, ningún `@media (prefers-color-scheme: dark)` de respaldo ni una paleta oscura
alternativa (`grep -r dark src/` → 0 resultados). Simulación del caso límite (un cliente que
ignora la etiqueta e invierte el fondo dejando el color de texto igual, el patrón heurístico que
algunos clientes webmail aplican): `ink` (`#0f1b2d`, casi negro) contra un fondo oscuro típico
(`#1e1e1e`) da **1.037:1** — prácticamente ilegible. No se pudo verificar el comportamiento real en
un cliente Gmail/Outlook en vivo (fuera del alcance de esta ronda, igual que en la auditoría
original), así que esto se reporta como **riesgo residual documentado, no un defecto confirmado**:
la mitigación existente (meta tags) es la práctica estándar y probablemente suficiente en la
mayoría de los clientes, pero es un único punto de defensa sin redundancia.

### ML-05 — replay de webhooks Svix

6 escenarios adversariales contra el código real:

| Ataque | Resultado |
|---|---|
| Mismo `svix-id`, misma petición completa, repetida 3 veces DENTRO de la ventana | 1ª `{ok:true}`, 2ª y 3ª `{ok:false, reason:"replay"}` |
| Mismo `svix-id` reenviado FUERA de la ventana de tolerancia (600s con tolerancia 300s) | `{ok:false, reason:"timestamp_fuera_de_rango"}` — rechazado por antigüedad ANTES de tocar el replay guard (confirmado que el guard nunca "gasta" ese id) |
| IDs DISTINTOS reusando la MISMA firma robada | `{ok:false, reason:"firma_invalida"}` — la firma cubre `svix-id.timestamp.body`, cambiar el id la invalida |
| Firma VÁLIDA con timestamp viejo (1 hora) | `{ok:false, reason:"timestamp_fuera_de_rango"}` — una firma válida no basta si el timestamp expiró |
| Firma inválida con un `svix-id` que luego SÍ llega legítimo | La firma inválida no "gasta" el id en el replay guard — la petición legítima posterior con ese mismo id pasa correctamente |
| 20 `svix-id` distintos reclamados 3x cada uno en paralelo | Cada id termina reclamado exactamente una vez (`guard.size() === 20`), sin interferencia cruzada |

**Veredicto: ML-05 sigue corregido, 0 bypass encontrado** en los 6 vectores, incluidos los tres
pedidos explícitamente en el encargo (replay dentro/fuera de ventana, ids distintos con misma
firma, firma válida con timestamp viejo).

### ML-06 — `npm audit`

`npm audit --omit=dev` en el worktree aislado → **0 vulnerabilidades**, confirmando la afirmación
del README y de la tabla de estado. `npm audit` completo sigue reportando 7 (3 críticas/1 alta/3
moderadas) en la cadena `vitest`/`vite`/`esbuild`/`html-validate`, todas devDependencies. Sin
cambios respecto a lo documentado; la decisión de no forzar el upgrade sigue siendo razonable por
las mismas razones ya expuestas (devDependency compartida en el `node_modules` hoisted del
monorepo, salto de dos majors de `vitest`).

### ML-07 — trazabilidad `docs/ACEPTACION.md`

**Confirmado que sigue SIN corregirse** (tal como el propio corrector documentó como "fuera de
ámbito"): al momento de esta reverificación (`git log` hasta `65af1db`), `docs/ACEPTACION.md` sigue
leyendo literalmente para S4/S5/S6/S7/S12 y REQ-206..REQ-210:

```
S4  | ... | Sin código — packages/mail aún no existe | PENDIENTE
S5, S6, S7, S12 | ... | Sin código | PENDIENTE
REQ-207 | ... | Sin código | PENDIENTE
```

Esto sigue siendo falso: `packages/mail` existe, compila, tiene 252 pruebas en verde (no 220 como
cuando se escribió el ML-07 original — la cifra subestima aún más el avance real ahora). No es un
riesgo de seguridad, pero sí de gobierno/proceso: cualquiera que audite este repo guiándose
únicamente por `ACEPTACION.md` seguiría concluyendo erróneamente que no hay código de correo.

---

## Índice de hallazgos (reverificación)

| ID | Estado | Severidad | Resumen |
|---|---|---|---|
| ML-01 | **Corregido, reconfirmado** | (era Alta) | 50 concurrentes → 1 envío; release/dead se liberan para reintento; claves distintas aisladas |
| ML-02 | **Corregido, reconfirmado** | (era Alta) | Cabeceras List-Unsubscribe correctas en las 16 plantillas, ausentes en las 8 obligatorias |
| ML-03 | **Corregido, reconfirmado** | (era Media) | 12 vectores de ataque, 0 bypass, incluidos los 5 pedidos explícitamente |
| ML-04 | **Corregido, reconfirmado** | (era Media) | `faint` cumple AA; matriz completa de 8 tokens × 3 fondos, todos ≥4.5:1 en su uso real |
| ML-05 | **Corregido, reconfirmado** | (era Media) | 6 escenarios de replay/forjado, 0 bypass |
| ML-06 | **Sin cambios (documentado)** | Baja | 0 vulnerabilidades en runtime, confirmado de nuevo |
| ML-07 | **Sigue sin corregir** | Media (trazabilidad) | `ACEPTACION.md` sigue subestimando el avance (ahora con 252 pruebas, no 220) |
| ML-08 [NUEVO] | Hallazgo, no corregido | Baja | Ventana de espera del perdedor de la reserva (~200ms) más corta que el timeout documentado del proveedor (5s) — resultado ambiguo (`already_sent` sin id) bajo latencia real, sin llegar a duplicar el envío |
| ML-09 [NUEVO] | Riesgo residual documentado, no confirmado en cliente real | Baja | Sin `@media (prefers-color-scheme: dark)` de respaldo; la única defensa contra oscurecimiento automático son las etiquetas `light only`, sin redundancia |

## REQ/S candidatos a CUMPLIDO (a nivel de librería)

Con la salvedad explícita, ya señalada por la auditoría original (ML-07) y reafirmada aquí: lo
siguiente está **cubierto a nivel de librería** (`packages/mail` en aislamiento, proveedor/stores
falsos inyectados) y **reverificado con ataques adversariales adicionales** en esta ronda — la
integración real contra `apps/api` (endpoint HTTP de webhooks/baja, tablas Postgres reales para
`SendRecordStore`/`SuppressionStore`/`WebhookReplayGuard`, un flujo real de usuario) sigue en
curso por otro agente y NO se reclama como resuelta aquí:

- **REQ-181** (catálogo de 16 plantillas con asunto/variables tipadas) — CUMPLIDO a nivel de
  librería.
- **REQ-183/REQ-190** (captura sin proveedor, 0 red saliente) — CUMPLIDO a nivel de librería
  (`CaptureProvider`, `createMailProviderFromEnv` degrada de forma segura).
- **REQ-184** (previsualización con datos de ejemplo) — CUMPLIDO, reproducido en esta ronda
  (`npm run preview` genera las 16).
- **REQ-185** (tono/marca Atiende, sin Likida) — CUMPLIDO a nivel de librería (ya verificado por la
  auditoría original, sin cambios).
- **REQ-186** (enlaces firmados, expiración, verificación en servidor) — CUMPLIDO a nivel de
  librería; el matiz de "un solo uso" ya señalado en la auditoría original (responsabilidad de
  `apps/api`) sigue vigente sin cambios.
- **REQ-187** (preferencias/baja respetadas salvo seguridad) — CUMPLIDO a nivel de librería,
  reforzado ahora por ML-02 (las cabeceras de baja de un clic solo en categorías no obligatorias,
  verificado en las 16 plantillas en esta ronda).
- **REQ-188** (registro de envío + reintentos con backoff) — CUMPLIDO a nivel de librería,
  reforzado por la reverificación de ML-01 (la idempotencia bajo concurrencia real, el escenario
  más exigente de este requisito, ahora se sostiene con 50 llamadas concurrentes).
- **REQ-189** (nunca un destinatario no registrado) — CUMPLIDO a nivel de librería, sin cambios
  desde la auditoría original.
- **REQ-182** (proveedor único por adaptador, sin `if provider === X` disperso) — CUMPLIDO
  arquitectónicamente (un solo `factory.ts` decide), pero **sin el test estático explícito** que el
  propio REQ-182 pide ("test estático falla si aparece el patrón prohibido fuera del adaptador")
  — no se encontró tal test en `packages/mail/test/`. No es un defecto de la implementación (el
  patrón SÍ se respeta hoy), pero es una brecha de verificación automatizada que vale la pena
  cerrar en una ronda futura.

**Recomendación para REQ-210 / ACEPTACION.md (ML-07)**: actualizar S4/S5/S6/S7/S12 y REQ-206..210
de "Sin código/PENDIENTE" a "cubierto a nivel de librería en `packages/mail` (252 pruebas),
pendiente de integración real en `apps/api`" — sigue sin hacerse al cierre de esta ronda.

---

## Evidencia

- Log completo de comandos (`npm install`/`audit`/`typecheck`/`lint`/`test`/`test:coverage`/
  `build`/`preview` + salida de los 5 archivos de ataque adversarial): `docs/logs/reverify-mail.log`.
- `git show --stat` de los 6 commits: incluido en la sección 1 de este documento (derivado de
  `git log --oneline --all | grep -i "mail\|ML-0"` + `git show --stat` por commit).
- Los scripts de ataque adversarial (`test/_adhoc-reverify-ml0{1,1b,2,3,4,5}.test.ts`) vivieron
  únicamente en el worktree temporal `<scratchpad>/reverify-mail` (eliminado al cierre de esta
  ronda) — no se commitearon al repo principal, siguiendo el mismo criterio de "solo encontrar y
  verificar" de este rol.
