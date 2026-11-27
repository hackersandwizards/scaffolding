# The assertion on a locator always passes

Find the fix: a locator object exists even when its element is missing. Check the rendered state with `await expect(locator).toBeVisible()`.
