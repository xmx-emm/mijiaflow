declare module "*.md" {
  const text: string;
  export default text;
}

/** Injected by scripts/build.mjs via esbuild define; undefined outside the bundle. */
declare const __MIJIAFLOW_VERSION__: string | undefined;
