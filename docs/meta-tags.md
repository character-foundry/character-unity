# Meta-tags

Open **Meta-tags** in the native navigation to manage named tag groups for the
selected workspace. Create a group, enter its name, and choose or type member tags.
For example, **Fantasy Guild** can contain `fantasy`, `adventure`, `guild`,
`party`, `medieval` and spelling variants found in imported cards.

Save explicitly. Reload keeps the saved catalog; Cancel discards only draft
changes after confirmation. Renaming, deleting or changing members never edits
card documents, their original files, identities or revisions. Deleting a group
does not delete its cards or literal tags.

Unsaved drafts survive navigation within the current workspace session. They are
not saved to storage or shared with another client. Save before reloading,
signing out or switching workspaces; the active editor warns before a browser
reload/exit. A failed Save or an out-of-date catalog retains the draft.

## Searching

Library and Archive filters have separate **Include Meta-tags** and **Exclude
Meta-tags** controls. A selected group matches its own name **or any member**.
Match all requires each selected group and each selected literal tag; Match any
accepts any of them. An excluded group rejects every card matching any member.
Settings exclusions remain literal tags.

Groups may overlap. Selecting one does not select another group, and ordinary
literal tags do not reverse-expand into groups. Typo variants belong in a group's
member list; the new editor does not enable automatic fuzzy matching. Semantic
query text and user-authored typed filters are not rewritten into tag expressions.

Saved search URLs retain group IDs. A deleted or inaccessible group stays visible
as an unavailable selection and must be removed or restored before the search can
run; it never quietly becomes an unfiltered search. Paging uses resolved rule
snapshots. Refreshing or a local group save reloads definitions from the captured
workspace, without background polling or indexing.

## Storage and conflicts

Groups live in the existing Unity database, not a new database or the Archive
corpus. SQL schema 17 adds workspace-owned catalog metadata. The browser profile
uses its existing schema-4 IndexedDB `meta` store and preserves its database name,
cards, original bytes and pending search work. Reads of an unused catalog return
version zero without creating a row.

Save replaces the bounded catalog with an expected-version check. If another
tab/client has saved first, Save returns a conflict and retains your draft. Reload
the saved catalog after reviewing/discarding the draft; stale writes cannot
overwrite the newer catalog. Account hosts use the normal workspace permissions
and commit-time session guard.

Limits: 100 groups, 1–100 members per group, 1,000 members per catalog, and 128
characters per name/member. Names are unique with ASCII case-insensitive matching;
duplicate members keep their first spelling. Search accepts up to 20 selected
groups and 1,000 expanded terms, including group names. Oversized encoded requests
are refused before transport with instructions to reduce the selection, not
truncated.

Catalog Save has a separate 1 MiB JSON body cap, covering the catalog's bounded
Unicode names and members. This is distinct from the smaller legacy-file import
limit below.

## Legacy search-index limits

Some existing Archive Lance rows were built with lossy comma splitting or Unicode
tag normalization. New group filters must not treat one literal `sea, sky` tag as
two tags, or silently change ASCII-only matching. For these older indexes, search
first determines exact eligible Archive IDs from metadata before ranking. This
path refuses selections over 10,000 eligible cards with an explicit unavailable
error; narrow the group/filter selection or clear the query in **Card text /
Boolean** mode to use SQL metadata browsing. **Indexed filters only** still uses
Lance and has the same older-index restriction.
Broad groups still work in the Library and metadata browsing. No corpus reindex
or embedding work is started by opening the editor or selecting a group.

Older Unity-owned Lance projections also require exact-tag verification before
tag-filtered search: at most 10,000 live rows and 8 MiB of metadata in 15 seconds,
per workspace/table version. An unsafe or over-budget projection returns an
explicit unavailable error; ordinary Library filtering remains available. New
tables carry an exact-tag marker at creation and do not need this legacy check.
Reads and partial updates never mark an old table as repaired.

## Existing alias files

**Import legacy JSON…** accepts a reviewed JSON object mapping canonical names to
member arrays, up to 256 KiB. Matching names replace draft members while retaining
their IDs; other groups are added and unlisted groups remain. The preview lists
the additions/replacements. Apply changes only the draft; Save is still required.

This imports configuration, not cards. It does not locate or overwrite the old
operator-owned `tag-aliases.json`, change scraper rules or activate a live writer.
Legacy implicit reverse/fuzzy behavior is not imported.
