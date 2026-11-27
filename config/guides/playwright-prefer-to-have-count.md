# The count assertion reads the locator only once

Find the fix: Use `await expect(locator).toHaveCount(n)` so it retries as the page changes.
