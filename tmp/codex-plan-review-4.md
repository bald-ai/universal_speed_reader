VERDICT: CHANGES_NEEDED

CRITIQUE:
- Test 3 is ambiguous: “fixture path (or validate-integrated equivalent)” permits bypassing `parseBookBytes`, so it may not prove the crash path is fixed.
- Constant ownership lacks an exact file/export path, leaving structure to the implementer.
- “May optionally also map `too_many_paragraphs`” leaves production behavior undecided.
- Import tests demand spies for internal operations without specifying existing injection/mock seams or required refactoring.
- Restore failure “surface” is not defined as an observable assertion beyond category/message.

REQUIRED_PLAN_EDITS:
- Name the exact module that defines and exports `MAX_BOOK_PARAGRAPHS`.
- Require Test 3 to invoke `parseBookBytes`; remove the alternative.
- Decide explicitly whether diagnostic classification maps `too_many_paragraphs`.
- Specify how prohibited operations will be observed, including any required dependency-injection/refactoring seam.
- Define the exact restore-visible state/output that proves the failure surfaced.