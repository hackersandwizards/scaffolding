# An Astro `client:only` directive without a framework name cannot hydrate the component.

Pass the exact framework this component is written in as the directive value, such as `client:only="react"` for a React component, so Astro loads the right client renderer.

No fix: copying `"react"` or another framework name that does not match the component.
