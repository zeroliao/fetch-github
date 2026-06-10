import { notFound } from "next/navigation";
import { DashboardPage } from "../dashboard-page";
import { sectionFromPath } from "@/lib/navigation";

export const dynamic = "force-dynamic";

export default async function SectionPage({
  params
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const activeSection = sectionFromPath(`/${section}`);
  if (!activeSection) {
    notFound();
  }

  return <DashboardPage section={activeSection} />;
}
