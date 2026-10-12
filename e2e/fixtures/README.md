# Synthetic container fixtures

`aster.png` and `aster.charx` contain the same synthetic CCv3 character and a
one-pixel PNG. They were generated with the public PNG/CharX exports of Foundry
commit `ba16cae46eaca13f6d38785d6f98610a3a61d55c`, the pinned Unity development SDK.
They contain unknown envelope/extension fields and a declared main portrait.
No Archive or user data is included. Browser tests edit them and compare complete
original downloads, asset references and persisted identity/lineage.

`opaque-assets.png` adds a portrait with opaque license metadata and two different
text assets whose authored names collide after CharX path sanitization. It was
generated with Foundry `685b849eef277525f1ff24dc03c567aac4a05b56`. A real browser
workflow edits it, exports CharX in descriptor-preservation mode, reimports it and
checks identity/lineage/metadata and exact originals. Service tests additionally
compare both distinct extracted text payloads. These fixtures do not prove
preservation through external applications such as SillyTavern.
