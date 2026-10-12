# Editor text token counts

Architect's local and browser profiles and the hub share a **Tokens** view.
Opening it counts the current draft without saving or changing the document.
Switching sections or closing the editor cancels pending work. Counts and failures
belong to that editor instance; they do not affect another open draft.

The view counts the name, character fields, appearance, greeting text, advanced
prompt fields, creator notes and character note. Alternate and group greetings
are tokenized separately and summed. Lorebook content includes entries enabled
explicitly or with no `enabled` property; `enabled: false` entries are excluded.
An unsupported flag or non-text field is reported as omitted, never stringified.
Null and missing text contribute zero. Tags, asset descriptors, source metadata,
lorebook keys/settings, multilingual notes and unrelated extensions are excluded.
The table shows the fields that contribute to the total.

This is an inventory of selected text, not a prediction of a chat application's
context usage or cost. Greetings are alternatives; lorebook activation, template
substitution, message wrappers and other prompt components depend on the chat app.

## Boundary and encoding

The editor accepts an optional `EditorTokenPort` with a label and an asynchronous
`count(texts, signal)` method. Hosts explicitly inject the browser worker adapter
from `@character-unity/editor/worker-tokenizer`. A host without a port has no Tokens
button. The pure editor controller owns no tokenizer, model, network or cache.

The worker calls the external SDK's public `GptTokenizer.encode` primitive. At
Foundry pin `0e464d69f5722073845954f06c46affb68539eb4`, its locked `gpt-tokenizer`
3.4.0 default export uses **o200k_base**. The existing SDK class name/description
says cl100k_base, but source inspection and exact Unicode token-ID vectors show
o200k_base. Unity labels the observed encoding and tests those vectors so an SDK
upgrade cannot silently change this interpretation. No tokenizer implementation
was copied into Unity and no existing SDK API was reinterpreted or changed.

`GptTokenizer.count` has a silent approximation fallback. Unity uses its throwing
`encode` method instead: a failure yields no total. Reserved token markers such as
`<|endoftext|>` currently fail explicitly. The worker returns a generic error,
without echoing card text or a tokenizer exception. It does not rewrite or escape
the author's text to obtain a count.

## Resource and failure behavior

- Counting runs in a dedicated browser worker. Card text goes only to that worker;
  there is no tokenization API request or provider service.
- The roughly 2.04 MB uncompressed vocabulary/worker asset loads when Tokens is
  first opened, not with the initial application bundle. Each count owns its
  worker, terminated on completion, failure, cancellation or a 15-second deadline.
- Input is capped at 2,000 text segments and 1,000,000 UTF-16 code units. Large or
  malformed inputs fail without a partial total. Unknown field values are omitted
  with a visible coverage notice; the remaining supported fields can be counted.
- The view waits 250 ms before starting a count. A changed draft clears the old
  result. Late results are ignored even if an injected provider ignores abort.
- A failed asset load or computation leaves the draft available to edit/save and
  offers retry. Counting needs the bundled worker asset to be available; this does
  not add offline page caching or guarantee a cold offline load.

## Verification

Five unit cases cover projection/coverage and document immutability, independent
instances and late results, input bounds and provider errors, exact public SDK
token-ID vectors, and worker termination on success/failure/timeout/cancellation.
Three Chromium workflows exercise real workers in local Architect, static
Architect and the hub: Unicode counts, separate greetings, enabled lorebook
content, lazy loading, load-failure retry, reserved-token failure, two independent
editors, explicit save/reopen and unchanged accepted originals. The mobile Tokens
view was inspected. The local Wrangler browser rehearsal also checks that the
Workers asset binding serves the bundled tokenizer correctly.
The fresh Node container rehearsal also compares the worker served over HTTPS
with the exact built asset bytes.

Selectable encodings, inline counts beside each field, chat-specific prompt
construction and AI assistance remain separate ports.
