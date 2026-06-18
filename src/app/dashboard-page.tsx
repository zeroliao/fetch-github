import { redirect } from "next/navigation";
import { DashboardClient } from "@/components/DashboardClient";
import type { Section } from "@/lib/navigation";
import { getCurrentUser } from "@/server/auth";
import { getDashboardShellSnapshot } from "@/server/store";

export async function DashboardPage({ section }: { section: Section }) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const snapshot = await getDashboardShellSnapshot();
  return <DashboardClient initialData={snapshot} initialSection={section} />;
}
