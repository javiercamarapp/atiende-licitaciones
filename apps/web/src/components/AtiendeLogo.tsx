// Recreación vectorial del logo real de "atiende" (misma marca que
// atiende-restaurantes). No existe un archivo maestro .svg/.png fuera del
// favicon en el proyecto de origen — el logo vive como componente React que
// genera el SVG inline; esto es una reconstrucción fiel al mismo mark, no un
// asset con licencia especial. Ver
// docs/investigacion/frontend-restaurantes.md §3.
export function AtiendeMark({
  className = "h-7 w-auto",
  animado = false,
}: {
  className?: string;
  animado?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 40 32"
      className={`${className} ${animado ? "atiende-glifo-animado" : ""}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Atiende"
    >
      <rect className="atiende-linea atiende-linea-1" x="0" y="4" width="13" height="4" rx="2" fill="#7DD3FC" />
      <rect className="atiende-linea atiende-linea-2" x="4" y="12" width="13" height="4" rx="2" fill="#7DD3FC" />
      <rect className="atiende-linea atiende-linea-3" x="0" y="20" width="13" height="4" rx="2" fill="#7DD3FC" />
      <circle cx="26" cy="6" r="5" fill="#38BDF8" />
      <path
        d="M14 32 L20 20 Q22 16 27 16 L31 16 Q34 16 36 13 L38 10"
        stroke="#1D4ED8"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export function AtiendeWordmark({
  className = "",
  markClassName = "",
  animado = false,
}: {
  className?: string;
  markClassName?: string;
  animado?: boolean;
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <AtiendeMark className={markClassName || "h-7 w-auto"} animado={animado} />
      {/* Antes usaba style={{ color: "#1D4ED8" }} fijo (copiado del origen):
          2.49:1 de contraste en modo oscuro, por debajo del 3:1 exigido para
          texto grande (violación axe "serious", W-05). El token `text-primary`
          tiene un valor propio en `.dark` (ver index.css) con contraste
          suficiente en ambos modos. */}
      <span className="font-display text-2xl font-bold tracking-tight text-primary">atiende</span>
    </span>
  );
}
