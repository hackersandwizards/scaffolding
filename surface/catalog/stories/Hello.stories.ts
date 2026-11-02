import Hello from "../components/Hello.astro";

export default { component: Hello };

export const Default = {};
export const Named = { args: { name: "catalog" } };
