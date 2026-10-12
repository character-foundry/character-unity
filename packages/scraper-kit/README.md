# Scraper kit

The Archive's source-plugin interface and the shared machinery every source uses: polite HTTP (one request
at a time per source, minimum spacing, retries on transient failures only, bounded bodies, no redirects
followed silently), and the run loop that walks a source's listings into the Archive.

A plugin discovers listings and fetches one card at a time. It never stores anything: it returns the bytes it
fetched (card container, portrait, the raw API record) and the Archive's sink keeps them, write-once.

Rules for plugins:

- **Parse, never evaluate.** Scraped HTML and scripts are data. No `eval`, `new Function` or `vm`.
- **Return what was fetched.** Do not rewrite card files (no re-embedding definitions into PNGs). If a source
  only offers API fields, build the card JSON from them and also return the raw record.
- **Ask before fetching.** The run loop skips listings the Archive already holds at the same remote update
  time, so plugins should report `updatedAt` on listings whenever the source provides it.
- **Credentials come from the context**, never from the environment or files, and are never logged.
