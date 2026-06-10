import { DashboardPage } from "./dashboard-page";

export const dynamic = "force-dynamic";

export default async function Home() {
  return <DashboardPage section="recommendations" />;
}
