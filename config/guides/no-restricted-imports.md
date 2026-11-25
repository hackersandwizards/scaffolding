# This import crosses a forbidden layer boundary in the repository architecture.

The repository restricts imports between layers so lower layers stay independent of higher ones. The finding line prints the boundary message and names the layer where code needing this import belongs.

Find the fix: follow the boundary message. Move the code needing the import into the layer the message names. Or extract only the shared piece into a lower layer that both modules may import, keeping test-only or caller-specific code in its own layer. Where the caller is already in a layer that may import it, pass the value in as an argument. Confirm the forbidden import is gone from this file.

No fix: re-exporting the symbol through a third file whose path bypasses the rule, copying the imported code into this layer, or loosening the pattern in `.oxlintrc.json`.
