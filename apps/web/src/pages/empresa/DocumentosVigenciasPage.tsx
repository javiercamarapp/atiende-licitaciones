import { FileClock } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: FileClock,
  title: "Documentos y vigencias",
  description: "Registros, certificados y documentos de la empresa con su fecha de vigencia.",
  emptyTitle: "Aún no hay documentos cargados",
  emptyDescription: "Sube los documentos y certificados de tu empresa para llevar control de sus vigencias.",
});

export default Page;
