// Browser entry: the dashboard renders briefs with marked and sanitizes them with DOMPurify.
// `bun run build` bundles both into dashboard-markdown.mjs, so the plugin ships no node_modules.
export { marked } from "marked";
export { default as DOMPurify } from "dompurify";
