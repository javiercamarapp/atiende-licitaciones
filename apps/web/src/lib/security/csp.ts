// WI-01 (docs/auditoria-2/web-integrado.md): antes de esta corrección no
// existía NINGUNA Content-Security-Policy en todo el sistema -- ni en
// `apps/api` (`contentSecurityPolicy: false` explícito en su `helmet`) ni
// en el HTML/JS servido por `apps/web`. Esto agrava el riesgo YA documentado
// de que el refresh token vive en `localStorage` (ver src/lib/api/session.ts):
// sin CSP, un XSS que lograra inyectar un `<script>` tendría vía libre para
// leerlo y rotarlo indefinidamente. Una CSP real (`script-src` restrictivo,
// sin `'unsafe-inline'` ni `'unsafe-eval'`) es la mitigación de defensa en
// profundidad obvia que faltaba -- no evita el XSS en sí, pero sí reduce
// drásticamente la probabilidad de que uno llegue a ejecutarse.
//
// Fuente única de verdad: usada tanto para inyectar el `<meta
// http-equiv="Content-Security-Policy">` en el HTML de producción
// (vite.config.ts, plugin `security-headers`, solo en `vite build`) como
// para las cabeceras HTTP reales que sirve `vite preview` (mismo plugin,
// `configurePreviewServer`) -- evita que ambas fuentes diverjan con el
// tiempo.
//
// `style-src` incluye `'unsafe-inline'` a propósito: Radix UI (usado en
// casi todos los componentes de `src/components/ui/`) posiciona popovers/
// dropdowns/tooltips con estilos inline calculados en tiempo de ejecución
// (`style="transform: ..."`), y CSS3 no ofrece un mecanismo de
// nonce/hash práctico para estilos generados dinámicamente por una
// librería de terceros sin parchearla. El riesgo real que mitiga
// `script-src` (ejecución arbitraria de JS) es cualitativamente mayor que
// el de estilos inline (a lo sumo permite alteraciones visuales/CSS
// exfiltration muy limitadas) -- es un trade-off deliberado, no un
// descuido.
const CSP_DIRECTIVES: readonly [string, readonly string[]][] = [
  ["default-src", ["'self'"]],
  ["script-src", ["'self'"]],
  ["style-src", ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]],
  ["font-src", ["'self'", "https://fonts.gstatic.com"]],
  ["img-src", ["'self'", "data:"]],
  ["connect-src", ["'self'"]],
  ["object-src", ["'none'"]],
  ["base-uri", ["'self'"]],
  ["form-action", ["'self'"]],
];

export const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.map(([directive, values]) => `${directive} ${values.join(" ")}`).join("; ");

/**
 * Cabeceras adicionales servidas SOLO por `vite preview` (el build de
 * producción real, no `vite dev`): `frame-ancestors` (bloquea
 * clickjacking) y `sandbox` no tienen efecto dentro de un `<meta
 * http-equiv="Content-Security-Policy">` (restricción del propio estándar
 * CSP -- ver https://www.w3.org/TR/CSP3/#meta-element), así que
 * `frame-ancestors` se declara aquí, en la cabecera HTTP real, no en el
 * meta tag. En producción real (nginx/Caddy, ver README) el operador debe
 * fijar las MISMAS cabeceras -- ver "Cabeceras de seguridad en producción"
 * en apps/web/README.md.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": `${CONTENT_SECURITY_POLICY}; frame-ancestors 'none'`,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
