# Deployment — waba.outreach-pro.in

Live: **https://waba.outreach-pro.in**

| Piece | Where |
|---|---|
| App | Vercel project `wacrm`, team `Bitan's projects` (Hobby) |
| Database / Auth / Storage | Supabase project `wacrm` (ref `wtwosbvkpwbhtwarqcxs`), org `godseyeautomation-sketch's Org`, region `ap-south-1` (Mumbai), free tier |
| DNS | Cloudflare zone `outreach-pro.in` |
| Source | this repo (`bitan-del/wacrm`), forked from `ArnasDon/wacrm` |

## DNS records (Cloudflare)

| Type | Name | Value | Proxy |
|---|---|---|---|
| CNAME | `waba` | `99e559a4e58e11c7.vercel-dns-017.com` | **DNS only (grey cloud)** |
| TXT | `_vercel` | `vc-domain-verify=waba.outreach-pro.in,…` | n/a |

> The CNAME target is **project-specific** — do not replace it with the generic
> `cname.vercel-dns.com`. Get the current value from
> `GET /v6/domains/waba.outreach-pro.in/config`.
>
> Proxy **must stay off**. Turning the orange cloud on breaks Vercel's
> certificate renewal.

## Redeploying

There is no Git integration: the Vercel account has no GitHub Login Connection,
so deploys are made from a local checkout.

```bash
vercel deploy --prod --yes --scope bitans-projects-ca6ba37b
```

To get push-to-deploy instead, connect GitHub at
Vercel → Settings → Authentication → GitHub → Connect, then run
`vercel git connect`.

## Environment variables

Set on the Vercel project (the three Supabase vars were re-pointed at
`wtwosbvkpwbhtwarqcxs` for **Production** only — the Preview copies still hold
the dead project's values):

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — must be type **config**, not secret: it is a
  `NEXT_PUBLIC_*` var and has to be inlined at build time
- `SUPABASE_SERVICE_ROLE_KEY` — secret
- `ENCRYPTION_KEY` — secret
- `NEXT_PUBLIC_APP_LOCALE` = `en`
- `NEXT_PUBLIC_SITE_URL` = `https://waba.outreach-pro.in`

> `ENCRYPTION_KEY` is deliberately **identical** in `.env.local` and on Vercel.
> Both point at the same Supabase database, so a mismatch would make already
> encrypted WhatsApp tokens undecryptable.

Not set yet: **`META_APP_SECRET`** — add it when connecting the WhatsApp
Business API.

## Database

> **Nov 2026:** the original Supabase project (`dfbajwhafywmpkquancs`) disappeared
> (its hostname stopped resolving, so every request hit a 504
> `MIDDLEWARE_INVOCATION_TIMEOUT`). Its data could not be recovered. A fresh
> project `wtwosbvkpwbhtwarqcxs` was created and all migrations re-applied;
> users had to sign up again and WhatsApp has to be reconnected in Settings.

All migrations from `supabase/migrations/` are applied (`001` → `060`;
`050` and `056` do not exist upstream). `supabase/ci/verify-schema.sql`
passes: 37 tables, 101 RLS policies.

Auth → URL Configuration: Site URL `https://waba.outreach-pro.in`, redirect
allow-list `https://waba.outreach-pro.in/**`.

The direct host `db.<ref>.supabase.co` is **IPv6-only** on the free tier. From an
IPv4-only network use the session pooler instead:

```
host=aws-0-ap-south-1.pooler.supabase.com port=5432 user=postgres.wtwosbvkpwbhtwarqcxs
```

Applying new migrations (or paste them into the dashboard SQL editor):

```bash
psql "host=db.wtwosbvkpwbhtwarqcxs.supabase.co port=5432 user=postgres \
      dbname=postgres sslmode=require" -v ON_ERROR_STOP=1 -1 -f supabase/migrations/0NN_x.sql
```

Free-tier projects pause after about a week without traffic — if the site
starts timing out again, check the Supabase dashboard for a paused project first.

## Theme

Brand accent is emerald green, set by `DEFAULT_THEME` in `src/lib/themes.ts`.
The neutral chrome hue was moved 260 → 162 in the two `html[data-mode="…"]`
blocks of `src/app/globals.css`. The other accents (violet, cobalt, amber, rose)
are untouched and still selectable in Settings.
