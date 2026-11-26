import { basename } from "node:path";

const python = new Bun.Glob("**/*.{py,pyi}");
const terraform = new Bun.Glob("**/*.{tf,tfvars}");
const workflows = new Bun.Glob(".github/workflows/*.{yml,yaml}");

export const pythonInput = (path: string) => python.match(path);
export const terraformInput = (path: string) => terraform.match(path);
export const workflowInput = (path: string) => workflows.match(path);
export const dockerfileInput = (path: string) =>
  /^(?:Dockerfile(?:\..*)?|.+\.Dockerfile|Containerfile)$/i.test(basename(path));
