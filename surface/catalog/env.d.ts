// tsc reads no .astro file; Astro's compiler checks the components when the catalog builds.
declare module "*.astro" {
  const component: (props: Record<string, unknown>) => unknown;
  export default component;
}
