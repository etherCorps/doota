# @doota/sdk

Official client for the [Doota](https://github.com/etherCorps/doota) email API.
Send transactional and templated mail from your app with a service-account
bearer key.

```sh
npm i @doota/sdk
```

```ts
import { Doota } from "@doota/sdk";

const doota = new Doota("dk_live_…", { baseUrl: "https://mail.acme.com" });

// Raw send
await doota.emails.send({
  to: "ana@example.com",
  subject: "Hello",
  html: "<p>Sent via the Doota API.</p>",
});

// Templated send — Doota renders the hosted template with your data
await doota.emails.send({
  to: ["ana@example.com"],
  templateId: "tmpl_welcome",
  data: { name: "Ana", code: "1234" },
  idempotencyKey: "welcome-user-9012",
});
```

`send()` resolves to `{ submissionId, deduped }`. On failure it throws a
`DootaError` carrying the HTTP `status` and the server message.

## API

`new Doota(apiKey, { baseUrl, fetch? })`

- `apiKey` — a service-account key (`dk_…`), created in your Doota instance.
- `baseUrl` — your instance origin, e.g. `https://mail.acme.com`.
- `fetch` — optional `fetch` override (custom agent, tests).

`doota.emails.send(params)` — see `SendParams`: `to`/`cc`/`bcc`, `subject`,
`text`, `html`, `templateId`, `data`, `mailboxId`, `fromAliasId`,
`parentMessageId`, `sendAt`, `idempotencyKey`, `attachments`.

`attachments` — each `{ filename, content }` (a `Buffer`/`Uint8Array` or base64
string, encoded for you) **or** `{ filename, url }` (fetched server-side, SSRF-
guarded). Up to 20 files, 25 MB each, 40 MB total.

Full endpoint reference: the [API keys guide](https://github.com/etherCorps/doota).

## License

Apache-2.0
