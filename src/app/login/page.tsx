import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { LoginForm } from "@/components/stock/login-form";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sign in — OpenStock",
};

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/");
  return <LoginForm />;
}
