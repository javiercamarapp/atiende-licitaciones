import { Scale } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: Scale,
  title: "Go/No-Go",
  description: "Decisiones de participación sobre convocatorias evaluadas.",
  emptyTitle: "Aún no hay decisiones registradas",
  emptyDescription: "Cuando evalúes una convocatoria, su decisión de Go/No-Go aparecerá aquí.",
});

export default Page;
