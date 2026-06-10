import { redirect } from "next/navigation";
import { DashboardClient } from "@/components/DashboardClient";
import type { Section } from "@/lib/navigation";
import { getCurrentUser } from "@/server/auth";
import { getDashboardSnapshot } from "@/server/store";

export async function DashboardPage({ section }: { section: Section }) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const snapshot = await getDashboardSnapshot();
  return <DashboardClient initialData={snapshot} initialSection={section} />;
}
