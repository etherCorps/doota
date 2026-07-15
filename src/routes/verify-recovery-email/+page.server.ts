import { verifyRecoveryEmailToken } from "$lib/server/recovery-email.js";

export const load = async ({ url, locals }) => {
  const token = url.searchParams.get("token");
  const ctx = await locals.auth.$context;
  const verified = token ? await verifyRecoveryEmailToken(ctx, token) : false;
  return { verified };
};
