// Browser entry: the one module that the dashboard loads. It re-exports the shared data module
// and the Markdown libraries (marked renders briefs, DOMPurify sanitizes them).
// `bun run build` bundles all of them into dashboard.mjs, so the plugin ships no node_modules.
export * from "./factory-data.ts";
export { marked } from "marked";
export { default as DOMPurify } from "dompurify";
