# Contract drift: what the fields mean

`veridic drift --scope scope.json` (JSON) or `--md` (a section to paste).

- `undocumented_statuses`: the handler returns them, the contract does not
  list them. Each one is an acceptance scenario candidate.
- `unreturned_statuses`: documented, but nothing in the handler returns them.
  With `maybe_from`, a guard or the error handler may produce it, so check that
  guard. Without it, the contract is likely stale (or the code lost a branch).
- `undeclared_body_fields`: read straight from `req.body`, absent from the
  request schema, even past a validator (`validated_by`).
- `implemented_not_documented` / `documented_not_implemented`.

The status scan sees the handler body only. Codes set inside helpers it calls
are not seen; confirm by reading before you report a gap as fact.
