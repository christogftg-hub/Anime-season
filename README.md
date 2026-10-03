# Anime Season Board

Every anime airing this season, with next-episode countdowns, trailers, and a personal watchlist per account.

- **Show data**: fetched live from the public AniList API in the visitor's browser (no server, no nightly job).
- **Accounts + watchlists**: Supabase Auth (email + password) and one table, `user_anime`, protected by Row Level Security.
- **Hosting**: GitHub Pages, straight from the `main` branch.

## Files
- `index.html`, `styles.css`, `app.js`: the site
- `config.js`: your Supabase project URL and anon/publishable key (both safe to be public)
- `supabase/schema.sql`: run once in Supabase → SQL Editor

## Season logic
The board shows the current season, and switches to the next one from the 15th of a season's last month
(e.g. from 15 September it shows Fall). The season picker lets visitors look back or ahead.
