# Writing requirement tests

A requirement is **tested** only when a test whose name starts with its id
(`it("FR-015: …")`) exists and that test file reaches the code the requirement
cites, and the test asserts something. Empty tests, tests with no assertion
(or only `expect(true).toBe(true)`), and skipped ones (`.skip`, `xit`, inside
`describe.skip`) don't count: their requirement shows `unasserted` or `todo`.
Tests whose only checks are loose (`toBeTruthy`, `toBeDefined`, bare
`toHaveBeenCalled()`) count but are listed in `weak_tests`; assert the actual
value instead. `plumb tests --spec S` measures it; `--run` runs them and reports
passing/failing per requirement.

1. `plumb scaffold --spec S --out <test path> --harness express` prints a
   skeleton: one `it.todo("FR-xxx: …")` per requirement, grouped by route, with
   the router import and citations. Use the repo's own test helpers (a DB mock,
   fixtures) the way its existing tests do.
2. Replace each placeholder with a test that asserts what the requirement
   states, keeping the id at the start of the name.
3. Prove the test can fail: change the guarded line (drop the check, move the
   limit) and confirm that requirement's test goes red, then restore it.
4. `plumb tests --spec S --run`.
