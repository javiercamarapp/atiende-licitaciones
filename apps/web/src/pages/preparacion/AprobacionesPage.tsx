import { ShieldCheck } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: ShieldCheck,
  title: "Aprobaciones",
  description: "Revisión y aprobación por rol de cada versión del expediente antes de su entrega.",
  emptyTitle: "Aún no hay aprobaciones pendientes",
  emptyDescription: "Las versiones de un expediente listas para revisión aparecerán aquí antes de aprobarse.",
});

export default Page;
