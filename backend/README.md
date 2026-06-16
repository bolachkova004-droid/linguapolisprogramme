# Production database migration

The browser version uses IndexedDB so it runs without a server. `schema.sql` is a production-ready starting point for PostgreSQL/Supabase.

Recommended API endpoints:

- `POST /api/events` — append an action log event.
- `POST /api/answers` — save an evaluated answer.
- `GET /api/me/progress` — return profile, skills and unlocks.
- `PATCH /api/admin/profiles/:id` — edit skill values (admin only).
- `GET /api/admin/analytics` — aggregated answer and retention metrics.

Before production, add authentication, row-level access rules, server-side answer evaluation and retention/privacy controls. Never trust skill values or admin permissions sent by the browser.
