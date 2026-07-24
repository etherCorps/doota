// SPDX-License-Identifier: Apache-2.0
import { createAuthClient } from "better-auth/svelte";
import {
  adminClient,
  lastLoginMethodClient,
  twoFactorClient,
  organizationClient,
  multiSessionClient,
} from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
  plugins: [
    adminClient(),
    lastLoginMethodClient(),
    twoFactorClient(),
    passkeyClient(),
    organizationClient(),
    multiSessionClient(),
  ],
});
