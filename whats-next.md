│  📁 Project steps                                                             │
│                                                                               │
│    1: pnpm run dev --open                                                     │
│                                                                               │
│  To close the dev server, hit Ctrl-C                                          │
│                                                                               │
│  🧩 Add-on steps                                                              │
│                                                                               │
│    sveltekit-adapter:                                                         │
│      - pnpm run gen # updates cloudflare types                                │
│    drizzle:                                                                   │
│      - Check DATABASE_URL in .env and adjust it to your needs                 │
│      - Run pnpm run db:push to update your database schema                    │
│    better-auth:                                                               │
│      - Run pnpm run auth:schema to generate the auth schema                   │
│      - Run pnpm run db:push to update your database                           │
│      - Check ORIGIN & BETTER_AUTH_SECRET in .env and adjust it to your needs  │
│      - Visit /demo/better-auth route to view the demo                         │
│                                                                               │
│  Stuck? Visit us at https://svelte.dev/chat                                   │
│
