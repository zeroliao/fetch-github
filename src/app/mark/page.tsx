import { redirect } from "next/navigation";
import { MarkWorkspace } from "@/components/MarkWorkspace";
import { getCurrentUser } from "@/server/auth";
import { listMarkWorkspace } from "@/server/markStore";

export const dynamic = "force-dynamic";

export default async function MarkPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?from=/mark");
  const snapshot = await listMarkWorkspace(user.id);
  return <MarkWorkspace initialData={snapshot} />;
}
