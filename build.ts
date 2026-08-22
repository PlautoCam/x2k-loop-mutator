import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

// The editor runtime is bundled separately as a browser IIFE and inlined into
// the extension bundle as a string. Keeping it as real TypeScript modules
// gives us tsc type checking, linting, and unit tests for the DSP/pattern
// logic that previously lived in an unchecked <script> template string.
const editorBuild = await esbuild.build({
  entryPoints: ["src/editor/runtime/main.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  write: false,
  minify: production,
  sourcesContent: false,
  logLevel: "warning",
});
const editorRuntimeSource = editorBuild.outputFiles[0]!.text;

const editorRuntimePlugin: esbuild.Plugin = {
  name: "editor-runtime",
  setup(build) {
    build.onResolve({ filter: /^virtual:editor-runtime$/ }, (args) => ({
      path: args.path,
      namespace: "jslm-editor-runtime",
    }));
    build.onLoad({ filter: /.*/, namespace: "jslm-editor-runtime" }, () => ({
      contents: editorRuntimeSource,
      loader: "text",
      resolveDir: ".",
    }));
  },
};

const inlineCssFontsPlugin: esbuild.Plugin = {
  name: "inline-css-fonts",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, (args) => {
      const css = fs.readFileSync(args.path, "utf8");
      const contents = css.replace(
        /url\((['"]?)([^'")]+\.woff2)\1\)/g,
        (_match, _quote, fontUrl: string) => {
          const fontPath = fontUrl.startsWith("@")
            ? path.resolve("node_modules", fontUrl)
            : path.resolve(path.dirname(args.path), fontUrl);
          const fontData = fs.readFileSync(fontPath).toString("base64");
          return `url("data:font/woff2;base64,${fontData}")`;
        },
      );

      return { contents, loader: "text" };
    });
  },
};

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
  loader: { ".html": "text" },
  plugins: [inlineCssFontsPlugin, editorRuntimePlugin],
});
