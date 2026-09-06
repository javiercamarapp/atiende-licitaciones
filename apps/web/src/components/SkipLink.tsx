import type { MouseEvent, ReactNode } from "react";

export interface SkipLinkProps {
  targetId: string;
  children: ReactNode;
}

/**
 * Enlace "saltar a..." que mueve el foco de verdad, en vez de depender del
 * comportamiento nativo del navegador de enfocar el destino de un fragmento
 * (`href="#id"`) — ese comportamiento solo ocurre si el elemento ya es
 * focuseable (`tabIndex={-1}` explícito) y no es consistente entre
 * navegadores. Aquí se llama `.focus()` explícitamente sobre el destino
 * (que sí debe declarar `tabIndex={-1}`), así el foco siempre aterriza en
 * el contenido real de la página en vez de quedarse en `<body>` (W-09).
 */
export function SkipLink({ targetId, children }: SkipLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const target = document.getElementById(targetId);
    if (!target) return;
    event.preventDefault();
    target.focus();
    if (window.location.hash !== `#${targetId}`) {
      window.history.replaceState(null, "", `#${targetId}`);
    }
  };

  return (
    <a href={`#${targetId}`} onClick={handleClick} className="skip-link">
      {children}
    </a>
  );
}
