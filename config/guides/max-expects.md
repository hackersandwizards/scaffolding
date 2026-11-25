# More than five `expect` calls mean a test checks multiple behaviours, several inputs sequentially, or duplicated expectations.

Overloaded tests hide which behaviour failed and repeat assertions already owned by other tests.

Find the fix: identify the single behaviour this test checks. Split distinct behaviours into separate tests, each named for its behaviour and arranging only what it needs. Replace repeated checks of one behaviour over several inputs with `test.each`, giving one row per input and expected result. Compare the fields of one result returned by a single call as a whole with `toEqual`. Remove assertions that another test in the suite already verifies, confirming each surviving test fails when the behaviour in its title is broken.

No fix: splitting into tests that repeat one setup for fragments, hiding assertions in a helper, or packing unrelated checks into an array, object, or `&&`. Switching to another assertion API or a snapshot, deleting uncovered assertions, or raising the limit is also no fix.
