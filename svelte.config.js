import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// @design Use Svelte 5 runes and the standard Vite preprocess pipeline.
// Do not copy the template's broad accessibility-warning suppression rules.
export default {
  preprocess: vitePreprocess(),
};
