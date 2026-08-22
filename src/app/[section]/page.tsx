import { notFound, redirect } from "next/navigation";
import { DashboardPage } from "../dashboard-page";
import { sectionFromPath } from "@/lib/navigation";

export const dynamic = "force-dynamic";

export default async function SectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const activeSection = sectionFromPath(`/${section}`);
  if (!activeSection) {
    notFound();
  }

  // Scan cycles remain an internal execution record. Keep old bookmarks valid
  // while directing users to the consolidated runtime view.
  if (activeSection === "jobs") {
    redirect("/operations");
  }

  return <DashboardPage section={activeSection} />;
}
