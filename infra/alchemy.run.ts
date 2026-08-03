// SPDX-License-Identifier: Apache-2.0
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
// Importing ./env.ts loads infra/.env and validates the VAPID pair.
import { aliasDomains, canonicalDomain, optionalSecret, optionalVar, originsValue } from "./env.ts";
import { hexToBase64, stateSecret, VapidKeyPair, VapidKeyPairProvider } from "./secrets.ts";

/**
 * Doota infrastructure as an Alchemy Stack: the three Workers (web, mail-in,
 * mail-jobs) plus every shared resource they bind (D1, KV, R2, the three
 * queues, the MailEventHub Durable Object, the Email Service sender).
 *
 * Full guide — stages, env vars, secret minting, CI, production adoption —
 * lives in ./README.md. The short version:
 *   - default deploy lands on stage `dev_<username>` with suffixed resource
 *     names; only `--stage production` touches the bare production names
 *     (first production deploy against an existing account needs `--adopt`
 *     AND the live secrets in env — see README).
 *   - secrets: env wins; absent ones are minted once into stack state.
 *   - custom domains come from ORIGINS (see env.ts).
 *   - D1 migrations from ../drizzle apply on every deploy (create included).
 *   - run from THIS folder; build the web app first (`pnpm infra:deploy`
 *     at the root does both).
 */
export default Alchemy.Stack(
  "Doota Mail",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), VapidKeyPairProvider()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // Production keeps the bare pre-existing names (adoption path); any other
    // stage suffixes every physical name so test deploys are self-labelling
    // and collision-free. Cloudflare names allow [a-z0-9-] — sanitize the
    // stage (default `dev_<username>` contains an underscore).
    const stage = yield* Alchemy.Stage;
    const isProduction = stage === "production";
    const stageSuffix = stage.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const named = (baseName: string) => (isProduction ? baseName : `${baseName}-${stageSuffix}`);

    // ── Shared resources (pre-existing in production; per-stage otherwise) ──
    const database = yield* Cloudflare.D1.Database("Database", {
      name: named("doota"),
      migrationsDir: "../drizzle",
    });
    // Production title must match the live namespace's dashboard title —
    // check before the adopting deploy; a mismatch would CREATE a new one.
    const authKv = yield* Cloudflare.KV.Namespace("AuthKv", { title: named("AUTH_KV") });
    const mailRawBucket = yield* Cloudflare.R2.Bucket("MailRaw", { name: named("doota-mail-raw") });
    const inboundQueue = yield* Cloudflare.Queues.Queue("MailInbound", { name: named("doota-mail-inbound") });
    const outboundQueue = yield* Cloudflare.Queues.Queue("MailOutbound", { name: named("doota-mail-outbound") });
    const mailEventsQueue = yield* Cloudflare.Queues.Queue("MailEvents", { name: named("doota-mail-events") });

    const compatibility = {
      date: "2026-04-28",
      flags: ["nodejs_als", "nodejs_compat"] as const,
    } as Alchemy.Input<{ date?: string | undefined; flags?: ("nodejs_als" | "nodejs_compat" | (string & {}))[] | undefined; } | undefined>;

    const workerObservability = {
      enabled: true,
      logs: { enabled: true, invocationLogs: true, persist: true, headSamplingRate: 1 },
    };

    // ── Secrets (env wins; otherwise minted once into state — secrets.ts) ──
    const mailDek = yield* stateSecret("MAIL_DEK", "MailDek", hexToBase64);
    const mailSearchKey = yield* stateSecret("MAIL_SEARCH_KEY", "MailSearchKey", hexToBase64);
    const betterAuthSecret = yield* stateSecret("BETTER_AUTH_SECRET", "BetterAuthSecret");
    if (isProduction && !process.env.MAIL_DEK) {
      // Fine for a brand-new production; catastrophic when adopting an
      // existing deployment — its mail is encrypted under the LIVE key, and
      // binding a state-minted one instead makes all of it unreadable.
      console.warn(
        "[infra] production deploy with a state-minted MAIL_DEK — correct only for a FRESH deployment. Adopting an existing one? Provide the live MAIL_DEK (and the other live secrets) via env.",
      );
    }

    const mintedVapid = yield* VapidKeyPair("VapidKeys", {});
    const sharedMailSecrets = {
      MAIL_DEK: mailDek,
      MAIL_SEARCH_KEY: mailSearchKey,
    };
    const webPushKeys = {
      VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY ?? mintedVapid.publicKey,
      VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY
        ? Redacted.make(process.env.VAPID_PRIVATE_KEY)
        : mintedVapid.privateKey,
    };

    // ── mail-jobs: outbound consumer + cron sweep; HOSTS the MailEventHub DO.
    // Deployed first — the other two bind its DO cross-script.
    const mailJobsWorker = yield* Cloudflare.Worker("MailJobs", {
      name: named("doota-mail-jobs"),
      main: "../apps/mail-jobs/src/index.ts",
      compatibility,
      observability: workerObservability,
      crons: ["*/5 * * * *"],
      env: {
        DB: database,
        MAIL_RAW: mailRawBucket,
        MAIL_OUT_QUEUE: outboundQueue,
        MAIL_EVENTS: Cloudflare.DurableObject("MailEventsHub", { className: "MailEventHub" }),
        EMAIL_SENDER: Cloudflare.Email.SendEmail("EmailSender"),
        ...sharedMailSecrets,
        ...webPushKeys,
        ...optionalVar("LOG_LEVEL"),
      },
    });
    yield* Cloudflare.Queues.Consumer("OutboundConsumer", {
      queueId: outboundQueue.queueId,
      scriptName: mailJobsWorker.workerName,
      settings: { batchSize: 10, maxRetries: 5 },
    });
    yield* Cloudflare.Queues.Consumer("MailEventsConsumer", {
      queueId: mailEventsQueue.queueId,
      scriptName: mailJobsWorker.workerName,
      settings: { batchSize: 10, maxRetries: 5 },
    });

    // ── mail-in: Email Routing catch-all target + inbound queue consumer.
    // Name is load-bearing: the routing rule (domains.remote.ts) points at it.
    const mailInWorker = yield* Cloudflare.Worker("MailIn", {
      name: named("doota-mail-inbound"),
      main: "../apps/mail-in/src/index.ts",
      compatibility,
      observability: workerObservability,
      env: {
        DB: database,
        MAIL_RAW: mailRawBucket,
        AUTH_KV: authKv,
        MAIL_QUEUE: inboundQueue,
        MAIL_EVENTS: Cloudflare.DurableObject("MailEventsHub", {
          className: "MailEventHub",
          scriptName: mailJobsWorker.workerName,
        }),
        ...sharedMailSecrets,
        ...webPushKeys,
        ...optionalVar("LOG_LEVEL"),
      },
    });
    yield* Cloudflare.Queues.Consumer("InboundConsumer", {
      queueId: inboundQueue.queueId,
      scriptName: mailInWorker.workerName,
      settings: { batchSize: 10, maxRetries: 5 },
    });

    // ── web: the SvelteKit app. Prebuilt entry is bundled here (same as
    // wrangler does) because _worker.js imports ../output/server relatively;
    // the assets directory's .assetsignore keeps _worker.js out of the assets.
    const webWorker = yield* Cloudflare.Worker("Web", {
      name: named("doota"),
      main: "../apps/web/.svelte-kit/cloudflare/_worker.js",
      assets: "../apps/web/.svelte-kit/cloudflare",
      // `alchemy dev` runs the mail workers locally, but web dev is vite
      // (`pnpm dev` at the repo root — HMR + getPlatformProxy bindings), so
      // don't boot the built output in workerd; point at the vite server.
      // (Also dodges an alchemy-dev crash parsing the assets `_headers` file.)
      dev: { mode: "external", url: "http://localhost:5173" },
      compatibility,
      observability: workerObservability,
      // Custom domain(s) from ORIGINS (wrangler's `custom_domain: true`
      // routes equivalent): canonical + aliases all serve the worker. Unset →
      // prop omitted, which leaves existing attachments unmanaged and stage
      // deploys on workers.dev.
      ...(canonicalDomain
        ? {
            domain: {
              name: canonicalDomain,
              ...(aliasDomains.length ? { aliases: aliasDomains } : {}),
            },
          }
        : {}),
      env: {
        DB: database,
        AUTH_KV: authKv,
        MAIL_RAW: mailRawBucket,
        MAIL_QUEUE: inboundQueue,
        MAIL_OUT_QUEUE: outboundQueue,
        MAIL_EVENTS: Cloudflare.DurableObject("MailEventsHub", {
          className: "MailEventHub",
          scriptName: mailJobsWorker.workerName,
        }),
        EMAIL_SENDER: Cloudflare.Email.SendEmail("EmailSender"),
        // ORIGINS is the app-wide origin standard: comma-separated full URLs,
        // first entry canonical, all entries better-auth allowed hosts. Unset
        // → the worker's own URL (custom domain in production, workers.dev on
        // stages) becomes the single entry, so auth always matches the served
        // host.
        ORIGINS: originsValue ?? Cloudflare.Worker.URL,
        MAIL_IN_WORKER_NAME: mailInWorker.workerName,
        BETTER_AUTH_SECRET: betterAuthSecret,
        ...sharedMailSecrets,
        ...webPushKeys,
        ...optionalSecret("APP_CLOUDFLARE_API_TOKEN"),
        ...optionalVar("APP_CLOUDFLARE_ACCOUNT_ID"),
        ...optionalSecret("CRON_SECRET"),
        ...optionalSecret("SETUP_TOKEN"),
        ...optionalVar("UNSUBSCRIBE_URL"),
        ...optionalVar("LOG_LEVEL"),
      },
    });

    return {
      webUrl: webWorker.url,
      mailInWorker: mailInWorker.workerName,
      mailJobsWorker: mailJobsWorker.workerName,
      // Where each secret came from this deploy — "env" (provided) or
      // "state" (minted once, persisted in the stack state store).
      secretSources: {
        MAIL_DEK: process.env.MAIL_DEK ? "env" : "state",
        MAIL_SEARCH_KEY: process.env.MAIL_SEARCH_KEY ? "env" : "state",
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ? "env" : "state",
        VAPID_KEYS: process.env.VAPID_PUBLIC_KEY ? "env" : "state",
      },
    };
  }),
);
