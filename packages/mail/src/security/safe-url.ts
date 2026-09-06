/**
 * Un href seguro para un correo. Los folios, nombres de contacto y textos de
 * convocatorias vienen de la base de datos y de formularios públicos: son
 * DATOS, nunca marcado. Un enlace `javascript:` o `data:` colado en un botón
 * sería una inyección con el remitente de Atiende como aval, así que solo se
 * dejan pasar `http(s)`.
 */
export function safeUrl(url: string, fallback: string): string {
  const trimmed = url.trim();
  if (!/^https:\/\//i.test(trimmed) && !/^http:\/\/localhost/i.test(trimmed)) {
    return fallback;
  }
  return trimmed;
}
