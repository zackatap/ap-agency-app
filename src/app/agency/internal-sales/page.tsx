import { redirect } from "next/navigation";

/** Old path — keep a redirect so bookmarks still work. */
export default function InternalSalesRedirect() {
  redirect("/sales");
}
