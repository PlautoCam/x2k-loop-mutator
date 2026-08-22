// The editor runtime bundle is produced by a separate esbuild pass in build.ts
// (src/editor/runtime/main.ts -> browser IIFE) and provided to this project as
// a virtual text module so it can be inlined into the modal dialog HTML.
declare module "virtual:editor-runtime" {
  const source: string;
  export default source;
}
