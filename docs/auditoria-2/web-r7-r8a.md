# Auditoría adversarial apps/web — rondas 7 y 8a (Atiende Licitaciones)

**Alcance**: ronda 7 (landing pública `/`, términos `/legal/terminos`, onboarding `/onboarding`,
panel/dashboard `/panel` REQ-169, demo de solo lectura `/demo`) y ronda 8a (login/registro con
Google, `/auth/google/callback`, `/registro`, `/sin-acceso` D-09, honestidad de huecos de 2FA en
`/configuracion`). **Fuera de alcance**: ronda 8b (recuperación de contraseña, verificación de
correo, invitación por enlace, contacto, preferencias) — ya presente en el código de este worktree
(commits posteriores a ronda 8a) pero auditada por otro agente en el árbol principal.

**HEAD auditado**: `d993bf6` (worktree `wt-web-r7r8a`, detached). **Procedencia**: continuación de
dos agentes previos cortados por límite; se recuperó y reverificó su log parcial
(`scratchpad/audit-web-r7-r8a.log`, a un HEAD anterior `e8da855`, hoy desactualizado) y se
delegó a dos agentes Sonnet de solo lectura (máx. 2 a la vez) para los rubros 2/10/11 y 4/7/8/9;
ambos completaron y sus hallazgos, reverificados donde fue posible, están incorporados abajo con
su procedencia indicada.

Formato de severidad: **ALTA** (explotable o rompe un criterio de tolerancia cero) / **MEDIA**
(defecto real con impacto acotado) / **BAJA** (cosmético, de cobertura o de documentación).

---

## 1. Reproducibilidad

Comandos y salida real completa en `docs/logs/audit-web-r7-r8a.log`.

| Comando | Resultado |
|---|---|
| `npm run -w apps/web typecheck` ×2 | exit 0, exit 0 |
| `npm run -w apps/web lint` ×2 | exit 0, exit 0 |
| `npm run -w apps/web build` | exit 0, code-splitting real por ruta |
| `npm run -w apps/web test` ×2 (sin `--coverage`) | 1/2: **8 archivos / 9 tests fallidos** de 46/225; 2/2: **46/46 archivos, 225/225 verde** |
| `RATE_LIMIT_PROFILE=e2e npm run -w apps/web test:e2e:full` ×1 | **138 passed, 2 failed, 2 flaky** (recuperados en reintento) de 142, en 26.0 min |
| `npm run -w apps/web test:coverage` ×2 | no se pudo reproducir en esta sesión (límite de tasa/tiempo del entorno); ver hallazgo WB-01 sobre el log parcial previo, ya desactualizado |

**WB-01 (MEDIA) — `test:e2e:full` no es reproduciblemente verde en este HEAD.**
Corrida única con `RATE_LIMIT_PROFILE=e2e`: 138 passed / 2 failed / 2 flaky de 142 (26.0 min).
Dos fallos **deterministas** (fallaron también en el reintento automático de Playwright):
1. `e2e/landing.spec.ts:21` — `getByRole('link', { name: 'Aviso de privacidad' })` viola el modo
   estricto de Playwright porque hay **dos** enlaces con ese nombre accesible en la misma página:
   el pie de página (`LandingFooter`, `LandingPage.tsx:609-611`, "Aviso de privacidad") y la letra
   pequeña del formulario de contacto (`LandingPage.tsx:588-590`, "aviso de privacidad", agregado
   por ronda 8b). Es un defecto real de accesibilidad de la landing de ronda 7 (dos enlaces al
   mismo destino sin distinguirse por nombre para un lector de pantalla), solo que quedó "mudo"
   hasta que 8b agregó el segundo enlace.
2. `e2e/onboarding.spec.ts:26` — el test de ronda 7 espera navegar a `/sin-acceso` tras
   `register()+login()`, pero aterriza en `/revisa-tu-correo`: la causa raíz es de ronda 8b
   (`REQUIRE_EMAIL_VERIFICATION` activo por defecto en `scripts/e2e-full.mjs`), fuera de mi
   alcance, pero el síntoma deja **roto** el E2E de onboarding de ronda 7 en este HEAD.

Los 2 "flaky" (`login-parity.spec.ts`, `skip-link.spec.ts` en Redacción) se recuperaron en
reintento — consistentes con la contención de CPU que el propio `apps/web/README.md` documenta
para este entorno sandboxeado, no defectos nuevos.

**Verificado (reparado río abajo, fuera de mi alcance)**: en el árbol principal (`HEAD 2d06943`,
57 commits después de `d993bf6`, confirmado ancestro real con `git merge-base --is-ancestor`),
ambos tests ya fueron corregidos (`git diff d993bf6 HEAD -- apps/web/e2e/landing.spec.ts
apps/web/e2e/onboarding.spec.ts`): el primero se acotó con `page.getByRole("contentinfo")` para
desambiguar, y el segundo ahora confirma el correo real antes de intentar login. Nota importante:
la corrección del primero es solo al **test** (lo acota al `<footer>`) — `LandingPage.tsx` no fue
tocado, así que los dos enlaces con el mismo nombre accesible probablemente **siguen** en el DOM
real de la landing en `HEAD 2d06943` (no confirmado directamente, fuera del alcance de este pase).

**WB-02 (BAJA) — `npm run -w apps/web test` (sin coverage) no es determinista.**
Corrida 1/2: 8 archivos / 9 tests fallidos de 46/225, incluida una condición de carrera real en
`RevisionPage.test.tsx` (`Error: locator.click: ... pointer-events: none` sobre el botón "Aprobar
expediente", código de ronda 5, fuera del contenido auditado pero visible en la señal global de la
suite). Corrida 2/2: 46/46 archivos, 225/225 verde. Coincide con la contención de CPU ya
documentada; a diferencia de Playwright (`retries: 0/1` explícito), Vitest no tiene `retry`
configurado en este proyecto — posible mejora, no bloqueante.

**Correcto**: `typecheck`/`lint` deterministas y limpios; `build` limpio con code-splitting real
(`lazy()` por cada ruta en `App.tsx`, confirmado en el bundle: un chunk `.js` por página).

---

## 2. Landing / SEO / legal / CSP (rubro delegado, sub-agente Sonnet)

**WB-03 (BAJA, ya conocido — reverificado)**: `apps/web/public/robots.txt` = `Disallow: /` íntegro
y `index.html:7` fija `noindex, nofollow` — contradice la letra de REQ-197 ("accesibles"), decisión
defendible (sitio no lanzado) pero documentada como tal. `sitemap.xml` no existe en este HEAD.

**WB-04 (MEDIA-BAJA)**: `src/hooks/useDocumentMeta.ts:51-64` — el cleanup del `useEffect` solo
restaura `document.title`, no el `<meta name="robots">`. Al navegar dentro de la SPA desde `/` o
`/demo` (que fijan `index, follow`) hacia cualquier ruta sin `useDocumentMeta`, el meta `robots`
queda pegado en `index, follow` en el DOM real del navegador (impacto de SEO limitado porque un
crawler real hace petición fresca por URL, pero es un bug de código real en la utilidad construida
para esto).

**WB-05 (MEDIA)**: `PrivacyNoticePage.tsx` (`/privacidad`) y `LoginPage.tsx` (`/login`), ambas
públicas, **no llaman** `useDocumentMeta` — sin metaetiquetas propias, algo que
`docs/ACEPTACION.md:276` no aclara como excepción intencional al listar las páginas cubiertas.

**WB-06 (BAJA)**: `src/pages/login.css:11` carga la fuente Fraunces vía `@import` CSS (bloqueante
de CSSOM, mitigado por `display=swap`), único recurso de terceros del sitio, solo usado en
`/login`. Cubierto por CSP, no es hallazgo de seguridad.

**WB-07 (BAJA)**: `docs/ACEPTACION.md:288` cita `e2e/demo.spec.ts` con 6 casos; el archivo real
tiene 5 (`grep -c '  test(' e2e/demo.spec.ts`). Desfase de documentación, no de código.

**WB-08 (MEDIA)** — ver WB-01: duplicidad de nombre accesible "Aviso de privacidad" entre el pie
de página (ronda 7) y la letra pequeña del formulario de contacto (ronda 8b) — real defecto de
accesibilidad de la landing, evidenciado por la corrida de `test:e2e:full` de este pase.

**Correcto y verificado** (comando + salida real citados en el log): suite unitaria de axe
(`vitest-axe`) corre el ruleset **completo** sin exclusión de reglas (`grep` sin
`configureAxe`/exclusiones) — de hecho más estricta que el filtro `serious`/`critical` del E2E
(`e2e/utils/a11y.ts`), 20/20 tests verdes en corrida real; E2E de landing/demo cubre 3 viewports
reales (1280×800, 390×844, 320×568); CSP real en `apps/web` (`src/lib/security/csp.ts`),
`script-src 'self'` sin `unsafe-inline`/`unsafe-eval`, inyectada solo en `vite build` y replicada
en `nginx.web.conf` para producción, confirmada en el HTML del build real; sin analítica ni scripts
de terceros no declarados; "Likida" solo en comentarios de código, nunca en texto visible.

---

## 3. Legales (`/legal/terminos`, `/privacidad`)

Sin hallazgos. `src/lib/legal/termsContent.ts` marca 5 apartados explícitos con `FaltaDato`
(responsabilidad económica, vigencia/terminación, propiedad intelectual, ley aplicable), expone
`TERMS_STATUS = "borrador_pendiente_validacion_juridica"` renderizado visiblemente en
`TermsPage.tsx:44` ("Borrador pendiente de validación jurídica"), y no inventa ningún cumplimiento
normativo no verificado. "Likida" aparece únicamente en comentarios de desarrollador
(`LandingPage.tsx:36`, `OnboardingPage.tsx:52`, `SinAccesoPage.tsx:15`), nunca en texto visible al
usuario — cumple la regla de marca.

---

## 4. Onboarding (rubro delegado, sub-agente Sonnet)

**WB-09 (BAJA, ya conocido — reverificado)**: REQ-191 exige 6 pasos; `OnboardingPage.tsx:24-30`
implementa 5 (`STEPS`), faltan "verificación de correo" y "primera convocatoria".

**WB-10 (BAJA)**: `OnboardingPage.tsx:61` mantiene el paso del wizard solo en `useState` de React
(sin `localStorage`/`sessionStorage`, confirmado por grep). Si el usuario ya avanzó a un paso
opcional (invitar equipo / primer documento) y recarga la página, el wizard siempre reinicia en el
paso 2 (perfil) — sin riesgo de seguridad (los datos ya guardados se recuperan del servidor), pero
regresión de UX no documentada.

**Correcto y verificado**: las ~30 rutas de `App.tsx` fueron revisadas una por una — todo lo que
cuelga de `<AppShell/>` está anidado dentro de `<RequireOrganization/>` dentro de `<RequireAuth/>`,
sin ninguna ruta de negocio sin guard; `RequireAuth` solo renderiza `<Outlet/>` cuando
`status === "authenticated"`, y `memberships` ya está poblado en ese punto (`hydrateUserAndMemberships`
en `useAuth.tsx`) — sin condición de carrera. XSS en nombre de organización **probado sin
vulnerabilidad**: `grep -rn "dangerouslySetInnerHTML" apps/web/src` da un único resultado (un
comentario que explica que NO se usa); el nombre se renderiza siempre como texto JSX plano
(`OrganizationSwitcher.tsx:50,59`) — React lo escapa por defecto, aunque ni cliente ni servidor
(`createOrgBodySchema`, solo `min(1)`) lo saneen. El endpoint real es `POST /organizations` (no
`/orgs`). REQ-192 confirmado: `useActivationChecklist.ts` con 5 ítems reales, ninguno inventado.
REQ-193 reconfirmado con grep exacto: `actionLabel=` aparece 1 sola vez en todo `src/` y es el test
del propio componente `EmptyState` — 0 usos reales en los 36 archivos que lo importan.

---

## 5/6. Reverificación de hallazgos previos (dashboard, demo)

Reverificados con lectura directa del código en este HEAD, confirmando lo ya reportado por agentes
anteriores:

- **R5-1 (MEDIA, reverificado)**: `e2e/dashboard.spec.ts:12` — `test.skip(!process.env.E2E_API_URL)`
  gatea el único E2E que cambia de organización en el panel; `PanelPage.test.tsx` mockea una sola
  organización y nunca ejercita el cambio.
- **R5-3 (BAJA, reverificado)**: sin tests unitarios de `useDashboard.ts`/`useActivationChecklist.ts`
  (confirmado: no existen los `.test.ts` correspondientes).
- **R6-1 (ALTA, reverificado)**: `e2e/demo.spec.ts:19-31` — el listener de la línea 21 solo
  acumula URLs que **ya** contienen `/demo-api/`; la aserción de las líneas 28-30 busca, dentro de
  ese mismo arreglo, una URL que **no** contenga `/demo-api/` — imposible por construcción. El test
  "nunca mezcla con datos reales" no puede fallar bajo ninguna circunstancia.
- **R6-2 (MEDIA, reverificado)**: sin prueba de salir de `/demo` a `/panel` sin recargar (confirmado,
  no existe tal caso en `e2e/demo.spec.ts`).
- **Correcto (reverificado)**: `currentOrgId` en 231 usos de `queryKey`; `clearUnscopedQueries()`
  real, llamado desde `switchOrg()`; 403 honesto con `request_id` (`ApiError.requestId` propagado
  por `describeApiError`, mostrado en `PanelPage.tsx`); `DemoPage`/`mocks/` sin `useQuery`/
  react-query; `msw` es `dependency` real (no `devDependency`) en `package.json`.

---

## 7. Google OAuth (rubro delegado, sub-agente Sonnet)

**WB-11 (BAJA)**: comentario desactualizado en `GoogleAuthButton.tsx:35` — afirma que `/registro`
"queda para ronda 8b" cuando ya existe en esta misma ronda 8a y ya reutiliza el componente.

**Correcto y verificado — contradice la sospecha inicial de cobertura insuficiente**:
`GoogleCallbackPage.tsx` maneja honestamente los 7 estados pedidos (`state` ausente, inválido/
reutilizado vía 400 del servidor, 403 REQ-180, 503, `sin_acceso`, `requires_2fa` con pantalla
dedicada, guard `ranOnce` solo contra el doble montaje de StrictMode — un reintento real por
navegador se propaga como 400 honesto, comportamiento esperado). El `state` es generado y validado
100% por el servidor: sin `sessionStorage`/`localStorage` en el cliente (`grep` sin resultados en
`pages/auth`, `lib/api/google.ts`). Mismo mecanismo de tokens que email+contraseña
(`completeSession` compartido en `useAuth.tsx`, sin camino paralelo). `GoogleAuthButton.tsx:65` usa
`window.location.assign(authorizationUrl)`, navegación completa real, nunca `fetch`. **Sí existe**
cobertura de test para `state` corrupto: `GoogleCallbackPage.test.tsx` tiene 8 pruebas, incluida una
explícita para "state inválido/expirado (400 real de apps/api)".

---

## 8. `/registro` (rubro delegado, sub-agente Sonnet)

**WB-12 (MEDIA/BAJA)**: `RegistroPage.test.tsx:96-99` afirma en comentario que el 429 no se prueba
ahí porque el reintento-con-backoff de `rawRequest` (`http.ts`) "ya está cubierto por
`client.test.ts`" — verificado que `client.test.ts` (8 pruebas) **no menciona** 429 ni
`Retry-After` en ninguna, y no existe ningún `http.test.ts` dedicado. El mecanismo real de
reintento (`MAX_RATE_LIMIT_RETRIES = 6`) no tiene ningún test unitario en todo el repo — el
comentario que afirma lo contrario es falso/obsoleto (sí hay honestidad de 429 probada en otras
pantallas vía el mensaje final, pero no el mecanismo de reintento en sí).

**Correcto y verificado**: mismo formulario que el botón de Google (sin pantalla separada);
esquema Zod cliente coincide exactamente con `registerBodySchema` del servidor (email, password
`min(8)`); antienumeración verificada de extremo a extremo — `DUMMY_PASSWORD_HASH` de costo
constante en el servidor + mensaje idéntico ("Credenciales inválidas") para email inexistente y
para contraseña incorrecta de un email existente, con test que lo confirma.

---

## 9. 2FA en `/configuracion` (rubro delegado, sub-agente Sonnet)

Sin hallazgos nuevos de severidad ALTA/MEDIA. Verificado con precisión contra las rutas reales de
`apps/api` en este HEAD (no contra el README): `modules/twofa/routes.ts` tiene exactamente 4 rutas
(ninguna desenrola), `modules/auth/routes.ts` exactamente 4 (`logout` solo revoca la sesión
actual), `modules/me/routes.ts` exactamente 1 (`GET /me`). `ConfiguracionPage.tsx` declara
exactamente estos 3 huecos (desactivar 2FA, regenerar códigos de respaldo, sesiones activas) sin
ningún botón que los intente, con texto preciso y sin prometer nada inexistente. Sin otros huecos
de seguridad no declarados (no hay cambio de contraseña autenticado en `apps/api` fuera del flujo
de correo de ronda 8b).

**Importante para la siguiente reverificación**: en el árbol principal (`HEAD 2d06943`) estos tres
huecos **ya fueron cerrados** (migraciones/rutas E19/E21, `ConfiguracionPage.tsx` con botones reales
de desactivar 2FA, regenerar códigos y sesiones activas) — confirmado por `git show --stat 2d06943`
y grep directo en el árbol principal. Esto no invalida la verificación de `d993bf6` (la honestidad
declarada era exacta contra las rutas de ese HEAD), solo señala que el hallazgo "correcto" de este
rubro queda obsoleto frente a `HEAD 2d06943` y no debe reabrirse como pendiente contra ese HEAD.

---

## 10. Rendimiento (rubro delegado, sub-agente Sonnet)

**WB-13 (MEDIA)**: la landing pública precarga el chunk completo de Radix UI
(`app-platform-*.js`, 82.61 kB gzip) más `query-*.js` (15.06 kB) aunque solo usa
`@radix-ui/react-slot` (vía `Button`/`Form`). Causa: `App.tsx:110-113` monta `<TooltipProvider/>` y
`<Toaster/>` incondicionalmente en la raíz (fuera de cualquier lazy/Suspense), y
`vite.config.ts` agrupa **todos** los paquetes `@radix-ui/*` en un solo `manualChunks`
("app-platform"), arrastrando Dialog/DropdownMenu/Select/Tabs/ScrollArea que la landing nunca
ejecuta. Carga mínima estimada antes de pintar `/`: `index` (63.59) + `app-platform` (82.61) +
`query` (15.06) + CSS (7.77) + `LandingPage` (5.88) ≈ **175 kB gzip**, alto para una página cuyo
único propósito es SEO/conversión rápida.

**No verificado explícitamente**: LCP/TBT/CLS real vía Lighthouse — no hay `lighthouserc` en el
repo y ejecutar una recolección real (`vite preview` + Chrome headless) excedía el alcance
razonable de una auditoría de solo lectura en este entorno; se usaron heurísticas declaradas como
tales (CSR puro, `<div id="root">` vacío en el HTML servido; CSS único no crítico pero pequeño;
sin imágenes en la landing).

**Correcto**: code-splitting real por ruta (`lazy()` en las ~30 páginas de `App.tsx`, un chunk por
página en el build); MSW (296.75 kB / 97.77 kB gzip) solo se descarga bajo demanda en `/demo`
(`import()` dinámico dentro del componente, sin `modulepreload` en `index.html`).

---

## 11. Teclado (rubro delegado, sub-agente Sonnet)

Sin hallazgos de severidad relevante. Skip-link real (`.focus()` explícito, no depende de
`href="#id"` nativo) cubierto por E2E físico (`Tab`+`Enter`) en ~30 rutas, incluida verificación de
que el indicador de foco es *visible* (no solo presente). FAQ de la landing usa `<details>/
<summary>` nativo real. Sin overrides rotos de foco en diálogos Radix (`onOpenAutoFocus`/
`onCloseAutoFocus` sin resultados en todo el repo). Sin `<div onClick>` haciendo de botón falso sin
`role`/`tabIndex`/`onKeyDown` en el alcance auditado (revisión manual de los ~29 candidatos de
`grep`).

---

## 12. Trazabilidad

**WB-14 (BAJA)**: las cifras "137/137" (`test:e2e:full`) y "162/162" (`test`) citadas en
`apps/web/README.md`/`docs/ACEPTACION.md` corresponden al cierre de ronda 8a y ya no reflejan el
HEAD aquí auditado (`d993bf6`, que acumula 18 archivos/1662 líneas más de ronda 8b) — no es un
defecto sino el desfase esperable de una rama compartida en evolución continua durante la propia
auditoría; se deja anotado para que la próxima reverificación no asuma esas cifras vigentes. Sumado
a WB-07 (desfase de conteo de `e2e/demo.spec.ts`).

**Correcto**: los logs citados (`docs/logs/web-ronda7.log`, `web-ronda8.log`) existen y su
contenido coincide con lo narrado en README/ACEPTACION; los commits citados para REQ-172/174/178/
191..198 fueron verificados contra el código real por ambos sub-agentes sin discrepancias de
fondo, más allá de los desfases de conteo ya anotados.

---

## Cambios posteriores en HEAD `2d06943` (árbol principal) que afectan hallazgos de este pase

El árbol principal recibió, tras `d993bf6`, un merge (`2d06943`, 57 commits después — confirmado
`d993bf6` ancestro real de `2d06943` con `git merge-base --is-ancestor`) con trabajo del 7-sep no
incluido en este worktree. Verificado directamente en el árbol principal:

- **REQ-193 (EmptyState con acción)**: pasa de 0-1 usos reales de `actionLabel=` (este HEAD) a
  **6** páginas (`TenderSelect`, `JobsPage`, `AuditoriaPage`, `MatchingPage`, `GoNoGoPage`,
  `RedaccionPage`, `AprobacionesPage`) en `2d06943` — de los 36 archivos que importan `EmptyState`.
  Sigue **PARCIAL**, no CUMPLIDO: la mayoría de los estados vacíos del producto siguen sin acción.
- **REQ-197 (sitemap.xml)**: agregado en `2d06943` (`apps/web/public/sitemap.xml`, comentario
  cita E22). `robots.txt` sigue `Disallow: /` íntegro — WB-03 se mantiene sobre ese punto.
- **Rubro 9 (huecos de 2FA)**: ver nota al final de esa sección — los 3 huecos que verifiqué como
  correctamente declarados en `d993bf6` ya fueron **cerrados** en `2d06943` (E19 Google unlink,
  E21 desactivar 2FA / regenerar códigos / sesiones activas), con botones reales en
  `ConfiguracionPage.tsx` del árbol principal.
- **WB-01/WB-08 (duplicidad "Aviso de privacidad")**: el test se corrigió en `2d06943`
  (`page.getByRole("contentinfo")` para desambiguar), pero `LandingPage.tsx` **no** fue tocado en
  ese diff — el defecto de accesibilidad de fondo (dos enlaces con el mismo nombre accesible)
  probablemente persiste en el DOM real de `2d06943`, solo que el test ya no lo detecta. No
  confirmado directamente (fuera del alcance de este pase); recomendado para la siguiente
  reverificación.

---

## Resumen (≤10 líneas)

Typecheck/lint deterministas y limpios (×2); build limpio con code-splitting real. `test` y
`test:e2e:full` **no son reproduciblemente verdes** en `d993bf6`: fallo determinista de
accesibilidad en la landing (dos enlaces "Aviso de privacidad", WB-01/WB-08) y ruptura del E2E de
onboarding de ronda 7 por la compuerta de verificación de correo de ronda 8b — ambos ya
remediados en `HEAD 2d06943` del árbol principal, aunque el defecto de fondo de accesibilidad
probablemente sigue sin tocar. Legales y 2FA declarado en `/configuracion` correctos y honestos en
este HEAD (2FA ya se cerró río abajo). Onboarding/guardas de ruta/antienumeración de registro/
Google OAuth sin huecos de seguridad reales — solo deuda de cobertura y documentación (WB-02,
WB-04 a WB-07, WB-09 a WB-14, más R5-1/R5-3/R6-1/R6-2 reconfirmados, R6-1 sigue ALTA por ser un
test que no puede fallar nunca). Rendimiento: landing carga ~175 kB gzip de Radix UI que no usa
(WB-13). Sin hallazgos en teclado.
