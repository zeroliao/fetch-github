import { DashboardClient } from "@/components/DashboardClient";
import { getDashboardSnapshot } from "@/server/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const snapshot = await getDashboardSnapshot();

  return <DashboardClient initialData={snapshot} />;
}
