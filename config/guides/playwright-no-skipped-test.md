# The skipped test provides no coverage

Find the fix: Repair and enable the test, or delete it if the behavior no longer exists. Inside a test, an environment condition with a reason is allowed, for example `test.skip(browserName !== "chromium", "This checks Chromium behavior")`. Every skip needs a condition and a reason.
