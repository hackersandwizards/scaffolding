# The assertion reads the page only once

Find the fix: Replace `expect(await locator.isVisible())` with `await expect(locator).toBeVisible()` so the assertion retries.
