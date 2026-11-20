import ts from "typescript";

export function readTypeScriptProject(configPath, overrides = {}) {
  const fail = (diagnostic) => {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  };
  const project = ts.getParsedCommandLineOfConfigFile(configPath, overrides, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: fail,
  });
  if (!project) throw new Error(`could not load ${configPath}`);
  for (const diagnostic of project.errors) {
    // A tsconfig can describe an Astro-only project whose virtual scripts supply its inputs.
    if (diagnostic.code !== 18003) fail(diagnostic);
  }
  return project;
}
