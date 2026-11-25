# A commented-out test hides a failing check from the gate.

Uncomment the test, fix the code or test, and confirm it fails when you break the behaviour in its title. Delete it only after checking the code under test to confirm the behaviour is gone. If the finding is a prose comment starting like a test call (`it (` or `test(`), reword that sentence.

No fix: uncommenting and emptying its body, weakening assertions until it passes, or deleting it while the behaviour still exists.
