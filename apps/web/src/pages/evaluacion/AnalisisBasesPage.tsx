import { FileSearch } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: FileSearch,
  title: "Análisis de bases",
  description: "Checklist de requisitos extraídos de los pliegos de licitación.",
  emptyTitle: "Aún no hay bases analizadas",
  emptyDescription: "Sube o vincula el pliego de una convocatoria para extraer su checklist de requisitos.",
  disclosure: true,
});

export default Page;
