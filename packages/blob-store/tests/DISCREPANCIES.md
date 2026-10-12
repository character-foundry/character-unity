# Byte-storage discrepancies

No intentional filesystem/local-R2 semantic divergences are accepted for B01–B08.
Review date: 2026-10-11. Backend IO failures can preserve backend-specific causes;
the contract does not define a public HTTP error format. Local R2 success does not
prove remote deployment, permissions or crash-recovery behavior.
