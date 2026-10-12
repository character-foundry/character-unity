# Standalone lorebook files

Local Architect, browser-only Architect and the hub use the same import/download
controls in the editor's Lorebook tab. These operate on the current card's embedded
book. A standalone library, linked-book fetching and cross-format conversion remain
future work.

1. Choose **Import lorebook JSON**. Supported input is a native `character_book`
   object with an `entries` array; each entry must have a string `content` and a
   string-array `keys`. Empty books are accepted. Wrapped character cards belong in
   the host's card importer instead.
2. Review the filename, book name, entry count and replacement notice. Reading or
   cancelling a file leaves the draft unchanged.
3. Choose **Attach lorebook to draft**, or **Replace draft lorebook** when a book
   already exists. Replacement includes the previous book's unsaved edits. It does
   not merge books or change other card fields, assets or extensions.
4. Choose **Save revision** to persist the result. Discard restores the saved card;
   a failed save retains the imported draft. Earlier revisions and the accepted
   card's original bytes remain unchanged.

**Download draft lorebook JSON** includes current unsaved lorebook edits. It
serializes the native JSON object without normalization, including unknown fields
and duplicate/missing entry IDs. It can also recover an object whose entries have
unsupported shapes; such a download may not meet the import requirements above.
The standalone input file's formatting, duplicate JSON member spelling and exact
bytes are not stored as a new source attachment. This workflow preserves parsed
JSON data, not the original standalone file's byte representation.

## Boundary and concurrency

Foundry's public `parseLorebook` provides format detection and the original shape.
Unity uses that shape for native books. At the pinned SDK commit, normalized
`book` output drops some settings, entry extensions, IDs and opaque fields.
Consequently this UI rejects SillyTavern world-info, Agnai, Risu and Wyvern
conversion instead of silently attaching normalized data. Native serialization
uses Foundry's public `serializeLorebook` with the original draft shape; no format
parser or converter has been copied into Unity.

Input is bounded to 256 KiB, 1,000 entries, 20,000 JSON values and nesting depth 64.
Malformed UTF-8, non-finite numbers and unsafe integers are rejected. The proposed
whole card must also fit 256 KiB before review; the save service still checks its
final revision after adding lineage. Downloads use the same byte, nesting, value
and numeric limits. These are application limits, not new format specifications.

Each controller issues immutable, single-use reviews tied to its exact state.
Another controller cannot apply them. An edit, discard or save transition requires
a new review. File reads are bounded before allocation; late results are ignored
after choosing another file or leaving the tab. If the draft changes while reading,
the result is rejected. There is no automatic save, network fetch or source URL
resolution in this workflow.

Five controller/transfer tests cover preservation, rejection, resource bounds,
review isolation, stale reviews, explicit replacement and failed saves. Three
Chromium workflows cover local/browser/hub review, cancel, replacement, download,
save, card export, reopen and discard, with exact accepted card bytes checked.
The local workflow also covers concurrent editor instances, a failed HTTP save,
and delayed file reads during edits and tab changes.
