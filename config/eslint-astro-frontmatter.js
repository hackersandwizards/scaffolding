import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { convertToTsx } from "@astrojs/astro2tsx";
import { createLanguage } from "@volar/language-core";
import { decorateLanguageServiceHost } from "@volar/typescript";
import ts from "typescript";

export const frontmatterBlock = "frontmatter.tsx";
export const frontmatterFiles = [`**/*.astro/*_${frontmatterBlock}`];

export function resolveAstroPackage(folder) {
  const read = createRequire(join(folder, "package.json"));
  let astro;
  try {
    astro = read.resolve("astro/package.json");
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    astro = createRequire(import.meta.url).resolve("astro/package.json");
  }
  return astro;
}

export const astroSnapshot = (text) =>
  text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);

export function createAstroLanguage(host, convert) {
  const loaded = new Set();
  const language = createLanguage(
    [
      {
        getLanguageId: (file) => (file.endsWith(".astro") ? "astro" : undefined),
        createVirtualCode(file, _languageId, snapshot) {
          const { code } = convert(file, snapshot.getText(0, snapshot.getLength()));
          return {
            id: "tsx",
            languageId: "typescriptreact",
            snapshot: astroSnapshot(code),
            mappings: [],
          };
        },
        typescript: {
          extraFileExtensions: [
            { extension: "astro", isMixedContent: true, scriptKind: ts.ScriptKind.Deferred },
          ],
          getServiceScript: (code) => ({
            code,
            extension: ".tsx",
            scriptKind: ts.ScriptKind.TSX,
            preventLeadingOffset: true,
          }),
        },
      },
    ],
    new Map(),
    (file) => {
      if (!file.endsWith(".astro") || loaded.has(file)) return;
      const source = host.readFile(file);
      if (source !== undefined) {
        loaded.add(file);
        language.scripts.set(file, astroSnapshot(source));
      }
    },
  );
  return language;
}

export function installAstroSourceFiles(host) {
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (file, version, ...args) => {
    if (!file.endsWith(".astro")) return getSourceFile(file, version, ...args);
    const snapshot = host.getScriptSnapshot(file);
    if (snapshot)
      return ts.createSourceFile(
        file,
        snapshot.getText(0, snapshot.getLength()),
        version,
        true,
        ts.ScriptKind.TSX,
      );
    return undefined;
  };
}

export function astroFrontmatter() {
  const components = new Map();

  function convert(file, source) {
    const cached = components.get(file);
    if (cached?.source === source) return cached;
    const converted = convertToTsx(source, { filename: file });
    const { frontmatterStatus, frontmatter, frontmatterSource, code, mappings } = converted;
    const entry = {
      source,
      code,
      region: frontmatterStatus === "closed" ? frontmatterSource : undefined,
      frontmatter,
      mappings: mappings.filter(([, length, , sourceLength]) => length && sourceLength),
    };
    components.set(file, entry);
    return entry;
  }

  return {
    convert,
    host(host, options, folder) {
      const astro = resolveAstroPackage(folder);
      const language = createAstroLanguage(host, convert);
      const resolutionCache = ts.createModuleResolutionCache(
        folder,
        host.getCanonicalFileName,
        options,
      );
      Object.assign(host, {
        getScriptVersion: () => "0",
        getScriptSnapshot: (file) => astroSnapshot(host.readFile(file)),
        getModuleResolutionCache: () => resolutionCache,
        // Install Volar's literal resolver for aliases, package exports and resolution modes.
        resolveModuleNameLiterals: () => [],
      });
      decorateLanguageServiceHost(ts, language, host);
      installAstroSourceFiles(host);
      return ["env.d.ts", "astro-jsx.d.ts"].map((name) => join(dirname(astro), name));
    },
  };
}

export function frontmatterMessages(entry, messages) {
  if (!messages.length) return messages;
  const { code, frontmatter, mappings, region, source } = entry;
  const generated = ts.computeLineStarts(code);
  const originalLines = ts.computeLineStarts(source);
  const originalLocation = (offset) => ts.computeLineAndCharacterOfPosition(originalLines, offset);
  const position = (line, column, end) => {
    const offset = generated[line - 1] + column - 1;
    if (offset < frontmatter.start || offset > frontmatter.end) return undefined;
    for (const [start, length, source, sourceLength] of mappings) {
      const delta = offset - start;
      if (delta < 0 || (end ? delta > length : delta >= length)) continue;
      const original = source + Math.min(delta, sourceLength);
      if (original >= region.start && original <= region.end) return originalLocation(original);
    }
    return undefined;
  };
  return messages.flatMap(({ fix: _fix, suggestions: _suggestions, ...message }) => {
    const start = position(message.line, message.column, false);
    if (!start) {
      if (message.fatal) {
        const { line, character } = originalLocation(region.start);
        return [{ ...message, line: line + 1, column: character + 1 }];
      }
      return [];
    }
    const end = message.endLine && position(message.endLine, message.endColumn, true);
    return [
      {
        ...message,
        line: start.line + 1,
        column: start.character + 1,
        endLine: end ? end.line + 1 : undefined,
        endColumn: end ? end.character + 1 : undefined,
      },
    ];
  });
}
