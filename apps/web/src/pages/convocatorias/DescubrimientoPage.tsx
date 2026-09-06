import { Radar } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: Radar,
  title: "Descubrimiento",
  description: "Bandeja de nuevas convocatorias detectadas en las fuentes configuradas.",
  emptyTitle: "Aún no hay convocatorias descubiertas",
  emptyDescription: "Configura al menos una fuente de convocatorias para empezar a recibir resultados aquí.",
});

export default Page;
