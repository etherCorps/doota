// SPDX-License-Identifier: Apache-2.0
import { webcrypto } from "node:crypto";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * State-backed secrets: a provided env value always wins; otherwise a value
 * is minted once and persisted in the stack state store, so every later
 * deploy (local or CI, where no .env survives) reuses the same value. A fresh
 * MAIL_DEK would make previously stored mail unreadable; a fresh
 * BETTER_AUTH_SECRET would log everyone out. Resources are declared
 * unconditionally so minted values stay in state even while an env override
 * is in use.
 */

/** The app expects MAIL_DEK/MAIL_SEARCH_KEY as base64 of 32 raw bytes; Random emits hex. */
export const hexToBase64 = (hexValue: string) => Buffer.from(hexValue, "hex").toString("base64");

/**
 * Env-overridable state-minted secret. Random outputs resolve at deploy
 * time, so the re-encode rides an Output.map instead of touching the value
 * in the stack program.
 */
export const stateSecret = (
  envVarName: string,
  resourceId: string,
  encode: (hexValue: string) => string = (hexValue) => hexValue,
) =>
  Effect.gen(function* () {
    const minted = yield* Alchemy.makeRandom(resourceId);
    const provided = process.env[envVarName];
    if (provided) return Redacted.make(provided);
    return Output.map(minted, (mintedValue) => Redacted.make(encode(Redacted.value(mintedValue))));
  });

/**
 * State-backed VAPID (web-push) P-256 keypair. `Alchemy.Random` only mints
 * flat bytes; push needs a real keypair, so this custom resource mints one in
 * `reconcile` and persists it in stack state, so every deploy (local or CI)
 * reuses the same pair. Same lifecycle as Random: client-side only, nothing
 * remote to delete or list.
 */
export type VapidKeyPair = Alchemy.Resource<
  "Doota.VapidKeyPair",
  {},
  { publicKey: string; privateKey: Redacted.Redacted<string> }
>;
export const VapidKeyPair = Alchemy.Resource<VapidKeyPair>("Doota.VapidKeyPair");
export const VapidKeyPairProvider = () =>
  Provider.succeed(VapidKeyPair, {
    reconcile: ({ output }) =>
      output?.privateKey
        ? Effect.succeed(output)
        : Effect.promise(async () => {
            const keyPair = await webcrypto.subtle.generateKey(
              { name: "ECDSA", namedCurve: "P-256" },
              true,
              ["sign", "verify"],
            );
            const publicRaw = new Uint8Array(await webcrypto.subtle.exportKey("raw", keyPair.publicKey));
            const privateJwk = await webcrypto.subtle.exportKey("jwk", keyPair.privateKey);
            return {
              publicKey: Buffer.from(publicRaw).toString("base64url"),
              privateKey: Redacted.make(privateJwk.d!),
            };
          }),
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
    list: () => Effect.succeed([]),
  });
