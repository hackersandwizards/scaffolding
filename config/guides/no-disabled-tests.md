# A skipped test hides a failing check from the gate.

Remove the skip modifier, fix the code or test, and confirm it fails when you break the behaviour in its title. Delete it only after checking the code under test to confirm the behaviour is gone.

No fix: emptying or commenting out the test, using `test.todo`, weakening assertions to pass, or deleting a still-valid test.
