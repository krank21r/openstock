import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import OpenStockPage from "@/components/stock/openstock-page";

export const dynamic = "force-dynamic";

/**
 * Server shell: resolves the session before any client code or data query runs,
 * so an unauthenticated visitor is bounced to /login instead of watching a page
 * fill with 401s.
 */
export default async function Page() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return <OpenStockPage username={user.username} />;
}
