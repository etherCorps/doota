import { redirect } from "@sveltejs/kit";

// Org index → default to the DNS tab.
export const load = async ({ params }) => {
  redirect(307, `/admin/organizations/${params.orgId}/members`);
};
