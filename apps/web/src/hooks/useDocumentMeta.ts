import { useEffect } from "react";

export interface DocumentMetaInput {
  /** Sin el sufijo de marca: se agrega aquí (mismo patrón en todas las páginas públicas). */
  title: string;
  description?: string;
  /**
   * SEO básico (ronda 7, landing pública): `index.html` trae `noindex,
   * nofollow` fijo porque casi todo el sitio es un back office autenticado
   * (nada que indexar detrás de sesión). La landing (`/`) y `/demo` son las
   * únicas rutas pensadas para descubrirse por buscador — pasan
   * `robots: "index, follow"` para revertir ese valor por defecto mientras
   * están montadas; cualquier otra página deja el valor del documento como
   * está (no lo fuerza a "noindex" en cada montaje, evitando parpadeos de
   * la etiqueta entre navegaciones dentro del panel autenticado).
   */
  robots?: "index, follow" | "noindex, nofollow";
}

const BRAND_SUFFIX = "Atiende Licitaciones";

function setMeta(name: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("name", name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setOgMeta(property: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("property", property);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

/**
 * SEO básico por ruta (ronda 7): title + meta description + Open Graph
 * mínimo. No hay ningún paquete de gestión de `<head>` en las dependencias
 * (ver package.json) — para un SPA con un puñado de páginas públicas, un
 * hook directo sobre el DOM evita añadir una dependencia nueva solo para
 * esto. Restaura el título anterior al desmontar para no dejar el título de
 * una página pública "pegado" tras navegar a otra ruta que no llama a este
 * hook (todas las páginas relevantes sí lo hacen).
 */
export function useDocumentMeta({ title, description, robots }: DocumentMetaInput): void {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title} · ${BRAND_SUFFIX}`;
    if (description) {
      setMeta("description", description);
      setOgMeta("og:title", title);
      setOgMeta("og:description", description);
      setOgMeta("og:type", "website");
      setOgMeta("og:site_name", BRAND_SUFFIX);
    }
    if (robots) setMeta("robots", robots);
    return () => {
      document.title = previousTitle;
    };
  }, [title, description, robots]);
}
