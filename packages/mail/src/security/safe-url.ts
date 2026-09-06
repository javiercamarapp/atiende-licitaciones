/**
 * Un href seguro para un correo. Los folios, nombres de contacto y textos de
 * convocatorias vienen de la base de datos y de formularios públicos: son
 * DATOS, nunca marcado. Un enlace `javascript:` o `data:` colado en un botón
 * sería una inyección con el remitente de Atiende como aval, así que solo se
 * dejan pasar `http(s)`.
 *
 * `https://` de cualquier host se deja pasar sin más (el destino de un
 * `tenderUrl` puede ser legítimamente un dominio externo, p. ej. un portal
 * de gobierno). `http://` en cambio SOLO se deja pasar hacia un puñado de
 * hosts de desarrollo/producción anclados EXACTAMENTE por nombre de host —
 * nunca por prefijo de cadena.
 */
export interface SafeUrlEnv {
  /** Dominio público (sin protocolo, p. ej. `app.atiende.mx`) que también
   *  puede recibir un enlace `http://` sin caer al fallback — por si algún
   *  entorno intermedio termina TLS antes de la app. Vacío en el caso normal
   *  (la app sirve HTTPS real y este permiso no se usa). */
  MAIL_PUBLIC_APP_HOST?: string;
}

/** Hosts de desarrollo que siempre pueden recibir `http://` sin cifrar. */
const LOCAL_DEV_HOSTS = ["localhost", "127.0.0.1"];

function httpAllowedHosts(env: SafeUrlEnv): string[] {
  const hosts = [...LOCAL_DEV_HOSTS];
  const publicHost = env.MAIL_PUBLIC_APP_HOST?.trim().toLowerCase();
  if (publicHost) hosts.push(publicHost);
  return hosts;
}

export function safeUrl(url: string, fallback: string, env: SafeUrlEnv = process.env as SafeUrlEnv): string {
  const trimmed = url.trim();
  if (/^https:\/\//i.test(trimmed)) return trimmed;

  // ML-03: antes se usaba el regex `^http:\/\/localhost`, SIN límite de
  // host — aceptaba cualquier host que EMPEZARA con la cadena "localhost"
  // (p. ej. "http://localhost.evil.com/phish"), útil para un ataque de
  // phishing con apariencia de entorno local. `URL` separa el `hostname`
  // del resto de la cadena de forma correcta y aquí se compara por
  // IGUALDAD EXACTA contra una lista blanca — nunca por prefijo.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fallback;
  }
  if (parsed.protocol === "http:" && httpAllowedHosts(env).includes(parsed.hostname.toLowerCase())) {
    return trimmed;
  }
  return fallback;
}
