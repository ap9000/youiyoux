/**
 * The preview frame without Vite, for the hub the npm package ships (`youiyoux ui` from npm):
 *
 * - buildFrameKit(out), once, when the package is built: the frame's own code (src/preview) as
 *   `frame.js`, the packages a system's components may import (React, Radix, cva, clsx,
 *   tailwind-merge, lucide-react) as one module each, all sharing one React, plus Tailwind's own
 *   sheets, the Geist font, the frame's sheet and the class names its code uses.
 * - buildFrame(snapshot, kit, out), for each snapshot: each `<name>.demo.tsx` bundled with
 *   esbuild, its imports of those packages left to the kit's modules (`/kit/…`), `demos.js`
 *   listing them with each one that could not be built and why, and `frame.css`, the frame's
 *   sheet compiled by Tailwind with the system's own system.css, for every class name in the
 *   frame's code and the system's components.
 *
 * The hub's server (hub-server.ts) serves the kit at /kit/ and the snapshot's frame at /frame/.
 * Nothing here reaches the network, and a demo is bundled only from the snapshot's own files.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { build, type Plugin } from "esbuild";
import { compile } from "tailwindcss";

const APP = resolve(import.meta.dirname, "..");
export const KIT_PATH = "/kit/";
export const FRAME_PATH = "/frame/";
/** What a system's components may import from outside their own files. */
const KIT_PACKAGES = ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "class-variance-authority", "clsx", "tailwind-merge", "lucide-react", "@radix-ui/react-dialog", "@radix-ui/react-label", "@radix-ui/react-separator", "@radix-ui/react-slot", "@radix-ui/react-switch", "@radix-ui/react-tabs"] as const;
/** React's packages are CommonJS: their names are listed so a demo can import them by name. */
const COMMONJS = new Set(["react", "react/jsx-runtime", "react-dom", "react-dom/client"]);
const TAILWIND_SHEETS = ["index.css", "theme.css", "preflight.css", "utilities.css"];
const FONT_IMPORT = '@import "@fontsource-variable/geist";';
const SYSTEM_IMPORT = '@import "@snapshot/preview/system.css";';

/** `@radix-ui/react-tabs` → `radix-ui-react-tabs.js`. */
const kitFile = (specifier: string): string => `${specifier.replace(/^@/, "").replace(/[/]/g, "-")}.js`;

const write = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/**
 * Every word in `text` that could be a class name: Tailwind ignores the ones that are not, so
 * reading too many costs nothing and missing one leaves a component unstyled.
 */
export function classCandidates(text: string): Set<string> {
  const words = new Set<string>();
  // Split twice: with parentheses kept (`opacity-(--x)`, `bg-[url(a.png)]`) and without them (`cn("px-2")`).
  for (const split of [/[\s"'`{};,\\]+/, /[\s"'`{}();,\\]+/]) {
    for (const word of text.split(split)) if (word && word.length < 200 && /[a-z]/.test(word) && !/^[/.]/.test(word)) words.add(word.replace(/^\$\{?|[?:]$/g, ""));
  }
  return words;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && /\.(tsx?|jsx?|mdx?|html)$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

/** The kit, once per package build; `nodeModules` is where its packages are resolved from (the hub's own). */
export async function buildFrameKit(out: string, nodeModules = APP): Promise<void> {
  rmSync(out, { recursive: true, force: true });
  const require = createRequire(join(nodeModules, "package.json"));
  const entries: Record<string, string> = {};
  const contents = new Map<string, string>();
  for (const specifier of KIT_PACKAGES) {
    const name = kitFile(specifier).slice(0, -3);
    entries[name] = `kit:${specifier}`;
    if (COMMONJS.has(specifier)) {
      const names = Object.keys(require(specifier) as object).filter((key) => /^[A-Za-z_$][\w$]*$/.test(key) && key !== "default");
      contents.set(specifier, `import * as m from ${JSON.stringify(specifier)};\nexport default m;\nexport const { ${names.join(", ")} } = m;\n`);
    } else {
      contents.set(specifier, `import * as m from ${JSON.stringify(specifier)};\nexport * from ${JSON.stringify(specifier)};\nexport default m.default;\n`);
    }
  }
  entries.frame = join(APP, "src/preview/main.tsx");
  const kit: Plugin = {
    name: "youiyoux-frame-kit",
    setup(b) {
      b.onResolve({ filter: /^kit:/ }, (args) => ({ path: args.path.slice(4), namespace: "kit" }));
      b.onLoad({ filter: /.*/, namespace: "kit" }, (args) => ({ contents: contents.get(args.path)!, resolveDir: nodeModules, loader: "js" }));
      // The frame's sheet is compiled per snapshot (buildFrame); the demos come from that snapshot's demos.js.
      b.onResolve({ filter: /\.css$/ }, () => ({ path: "css", namespace: "empty" }));
      b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
      b.onResolve({ filter: /^\.\/demos\.ts$/ }, () => ({ path: `${FRAME_PATH}demos.js`, external: true }));
    },
  };
  await build({
    entryPoints: entries,
    outdir: out,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    nodePaths: [join(nodeModules, "node_modules")],
    chunkNames: "chunks/[name]-[hash]",
    plugins: [kit],
    logLevel: "error",
    logOverride: { "import-is-undefined": "silent" },
  });

  // Tailwind's sheets and the font, so the frame's sheet compiles and draws with nothing else installed.
  const tailwind = dirname(require.resolve("tailwindcss/package.json"));
  mkdirSync(join(out, "tailwindcss"), { recursive: true });
  for (const sheet of TAILWIND_SHEETS) copyFileSync(join(tailwind, sheet), join(out, "tailwindcss", sheet));
  const geist = dirname(require.resolve("@fontsource-variable/geist/package.json"));
  const fontCss = readFileSync(join(geist, "index.css"), "utf8");
  mkdirSync(join(out, "fonts"), { recursive: true });
  for (const [, file] of fontCss.matchAll(/url\(\.\/files\/([\w.-]+)\)/g)) copyFileSync(join(geist, "files", file!), join(out, "fonts", file!));
  const sheet = readFileSync(join(APP, "src/preview/preview.css"), "utf8");
  if (!sheet.includes(FONT_IMPORT) || !sheet.includes(SYSTEM_IMPORT)) throw new Error("src/preview/preview.css no longer imports the font and the system's sheet as frame.ts expects: update frame.ts");
  write(join(out, "frame.css.src"), sheet.replace(FONT_IMPORT, fontCss.replaceAll("url(./files/", `url(${KIT_PATH}fonts/`)));
  const words = new Set<string>();
  for (const file of sourceFiles(join(APP, "src/preview"))) for (const word of classCandidates(readFileSync(file, "utf8"))) words.add(word);
  write(join(out, "candidates.json"), `${JSON.stringify([...words].sort())}\n`);
  write(join(out, "preview.html"), `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>YouIyouX preview</title>\n    <link rel="stylesheet" href="${FRAME_PATH}frame.css" />\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="${KIT_PATH}frame.js"></script>\n  </body>\n</html>\n`);
}

export interface FrameBuild {
  /** Each demo that was built, by component name. */
  readonly demos: readonly string[];
  /** Each demo that could not be built, with why. */
  readonly errors: Readonly<Record<string, string>>;
}

/** The first line of esbuild's complaint, without the snapshot's path. */
function reason(error: unknown, root: string): string {
  const errors = (error as { errors?: Array<{ text: string; location?: { file: string } | null }> }).errors;
  const first = errors?.[0];
  if (!first) return error instanceof Error ? error.message.split("\n")[0]! : String(error);
  const unresolved = /^Could not resolve "([^"]+)"/.exec(first.text);
  if (unresolved && !unresolved[1]!.startsWith(".")) return `it imports ${unresolved[1]}, which the hub's preview frame does not carry (it carries ${KIT_PACKAGES.filter((p) => !COMMONJS.has(p)).join(", ")}).`;
  return first.location?.file ? `${relative(root, resolve(root, first.location.file))}: ${first.text}` : first.text;
}

/**
 * The frame for one snapshot, into `out`: `demos.js`, a module per demo and `frame.css`. A demo
 * may import only the snapshot's own files and the kit's packages; anything else is refused
 * with its name, and the frame says so in place of that preview.
 */
export async function buildFrame(snapshot: string, kit: string, out: string): Promise<FrameBuild> {
  // Real paths: esbuild resolves through symlinks (macOS's /var is /private/var).
  const components = join(realpathSync(resolve(snapshot)), "preview", "components");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const fence: Plugin = {
    name: "youiyoux-frame-fence",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if ((KIT_PACKAGES as readonly string[]).includes(args.path)) return { path: `${KIT_PATH}${kitFile(args.path)}`, external: true };
        if (args.kind === "entry-point") return undefined;
        if (!args.path.startsWith(".")) return { errors: [{ text: `Could not resolve "${args.path}"` }] };
        const target = resolve(args.resolveDir, args.path);
        if (target !== components && !target.startsWith(`${components}${sep}`)) return { errors: [{ text: `${args.path} is outside the system's component files` }] };
        return undefined;
      });
    },
  };
  const names = existsSync(components) ? readdirSync(components).filter((f) => f.endsWith(".demo.tsx")).map((f) => f.slice(0, -".demo.tsx".length)).sort() : [];
  const demos: string[] = [];
  const errors: Record<string, string> = {};
  for (const name of names) {
    try {
      await build({ entryPoints: [join(components, `${name}.demo.tsx`)], outfile: join(out, `${name}.demo.js`), bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, plugins: [fence], logLevel: "silent", absWorkingDir: components });
      demos.push(name);
    } catch (error: unknown) {
      errors[name] = reason(error, components);
    }
  }
  const lines = demos.map((name) => `  ${JSON.stringify(name)}: () => import(${JSON.stringify(`./${name}.demo.js`)}),`);
  write(join(out, "demos.js"), `export const DEMOS = {\n${lines.join("\n")}\n};\nexport const DEMO_ERRORS = ${JSON.stringify(errors)};\n`);

  const words = new Set<string>(JSON.parse(readFileSync(join(kit, "candidates.json"), "utf8")) as string[]);
  for (const file of sourceFiles(components)) for (const word of classCandidates(readFileSync(file, "utf8"))) words.add(word);
  const system = join(resolve(snapshot), "preview", "system.css");
  const compiler = await compile(readFileSync(join(kit, "frame.css.src"), "utf8"), {
    base: kit,
    loadStylesheet: async (id: string, base: string) => {
      if (id === "tailwindcss" || id.startsWith("tailwindcss/")) {
        const sheet = id === "tailwindcss" ? "index.css" : id.slice("tailwindcss/".length).replace(/^(\w+)$/, "$1.css");
        if (!TAILWIND_SHEETS.includes(sheet)) throw new Error(`the frame has no Tailwind sheet ${id}`);
        return { path: join(kit, "tailwindcss", sheet), base: join(kit, "tailwindcss"), content: readFileSync(join(kit, "tailwindcss", sheet), "utf8") };
      }
      if (id === "@snapshot/preview/system.css") return { path: system, base: dirname(system), content: existsSync(system) ? readFileSync(system, "utf8") : "" };
      throw new Error(`the frame's sheet imports ${id} from ${base}, which it cannot load`);
    },
  });
  write(join(out, "frame.css"), compiler.build([...words]));
  return { demos, errors };
}

/** True when `out` holds a frame built after every file of the snapshot's preview it reads. */
export function frameIsCurrent(snapshot: string, out: string): boolean {
  const demos = join(out, "demos.js");
  if (!existsSync(demos)) return false;
  const built = statSync(demos).mtimeMs;
  const preview = join(resolve(snapshot), "preview");
  return sourceFiles(preview).concat(existsSync(join(preview, "system.css")) ? [join(preview, "system.css")] : []).every((file) => statSync(file).mtimeMs <= built);
}
