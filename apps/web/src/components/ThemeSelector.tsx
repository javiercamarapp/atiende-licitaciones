import { useEffect, useState } from "react";
import { Sun, Monitor, Moon } from "lucide-react";

// Mismo patrón que atiende-restaurantes (ver informe §2.3): estado en
// localStorage, "sistema" solo se resuelve a oscuro/claro mientras el
// usuario lo tenga elegido explícitamente.
const KEY = "atiende-licitaciones-tema";
type Tema = "claro" | "sistema" | "oscuro";

function leerTema(): Tema {
  const v = window.localStorage.getItem(KEY);
  return v === "oscuro" || v === "sistema" ? v : "claro";
}

function aplicar(tema: Tema) {
  const oscuro = tema === "oscuro" || (tema === "sistema" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", oscuro);
}

const OPCIONES: Array<{ valor: Tema; Icono: typeof Sun; rotulo: string }> = [
  { valor: "claro", Icono: Sun, rotulo: "Tema claro" },
  { valor: "sistema", Icono: Monitor, rotulo: "Seguir al sistema" },
  { valor: "oscuro", Icono: Moon, rotulo: "Tema oscuro" },
];

export function ThemeSelector() {
  const [tema, setTema] = useState<Tema>("claro");

  useEffect(() => {
    const t = leerTema();
    setTema(t);
    aplicar(t);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (leerTema() === "sistema") aplicar("sistema");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const elegir = (nuevo: Tema) => {
    window.localStorage.setItem(KEY, nuevo);
    setTema(nuevo);
    aplicar(nuevo);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Tema de la interfaz"
      className="inline-flex items-center gap-0.5 rounded-full bg-muted p-0.5"
    >
      {OPCIONES.map(({ valor, Icono, rotulo }) => {
        const activo = tema === valor;
        return (
          <button
            key={valor}
            type="button"
            role="radio"
            aria-checked={activo}
            aria-label={rotulo}
            title={rotulo}
            onClick={() => elegir(valor)}
            className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
              activo ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
            }`}
          >
            <Icono className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
