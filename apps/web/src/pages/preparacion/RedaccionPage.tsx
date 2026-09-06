import { PenLine } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: PenLine,
  title: "Redacción",
  description: "Elaboración de la propuesta técnica y económica.",
  emptyTitle: "Aún no hay propuestas en redacción",
  emptyDescription: "Inicia una propuesta desde una convocatoria en preparación para verla aquí.",
  disclosure: true,
});

export default Page;
