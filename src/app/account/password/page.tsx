import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { ChangePasswordForm } from "@/components/stock/change-password-form";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Change password — OpenStock",
};

export default async function ChangePasswordPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return <ChangePasswordForm username={user.username} />;
}
