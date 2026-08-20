# Doota docs media

Screenshots for the docs site, the root README, and the
`docs/screenshots.md` gallery. Served at site root:
`public/media/x.png` → `/media/x.png`.
Scrub personal data (names, real addresses) from every screenshot.

Most are theme-aware pairs (`-light` / `-dark`) shown via the `<Shot>` component
in the docs, and via `<picture>` + `prefers-color-scheme` in the README.

Captured with `apps/web/e2e/capture-shots.mjs` against a deployed stack — see
that file's header for the run command and form-factor table.

## Current files

Un-suffixed names are the 13" laptop capture (1440 × 900), which is what the
docs pages link to.

- thread-light/dark        — conversation timeline (Overview, Inbox, README hero)
- sign-in-light/dark       — sign-in screen (Getting started)
- composer-light/dark      — message composer (Writing & sending)
- aliases-light/dark       — extra addresses (Aliases)
- admin-org-dashboard-light/dark — org overview (Administration)

Form-factor set, `docs/screenshots.md` only:

- thread-desktop-light/dark  — 1920 × 1080
- thread-tablet-light/dark   — 834 × 1112
- thread-mobile-light/dark   — 390 × 844
- inbox-mobile-light/dark    — 390 × 844
- composer-mobile-light/dark — 390 × 844, the standalone compose page
- composer-full-light/dark   — the expanded full-screen desktop composer

## Nice-to-have (not yet added)
- admin-domains-light/dark — domain onboarding screen (admin/domains, first-run)
