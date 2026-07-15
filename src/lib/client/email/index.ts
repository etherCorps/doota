import { renderEmail } from "./mail-renderer";
import VerificationMailTemplate from "./templates/verification-mail.svelte";

export async function verificationMailTemplate({
  verificationLink,
}: {
  verificationLink: string;
}) {
  return renderEmail(VerificationMailTemplate, { verificationLink });
}
