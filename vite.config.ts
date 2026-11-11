import { resolve } from "node:path";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { viteStaticCopy } from "vite-plugin-static-copy";
import zipPack from "vite-plugin-zip-pack";

const root = process.cwd();
const isDev = process.env.NODE_ENV === "development";
const outDir = isDev ? "dev" : "dist";

/**
 * @design This standalone plugin was initialized from siyuan-note/plugin-sample.
 * Vite is the active bundler; no kernel.js is built, and all i18n source files remain
 * in src/i18n/{en,zh-CN}.json (NOT public/i18n).
 *
 * @safety browser-image-compression Worker is copied as an offline-local resource.
 * The output must be verified on both desktop and mobile before claiming support.
 */
export default defineConfig({
  plugins: [
    svelte(),
    viteStaticCopy({
      targets: [
        { src: "plugin.json", dest: ".", rename: { stripBase: true } },
        { src: "README*.md", dest: ".", rename: { stripBase: true } },
        { src: "src/i18n/*.json", dest: "i18n", rename: { stripBase: true } },
        {
          src: "node_modules/browser-image-compression/dist/browser-image-compression.js",
          dest: ".",
          rename: { stripBase: true },
        },
        { src: ".generated/icon.png", dest: ".", rename: { stripBase: true } },
        { src: "assets/omnikit-*.svg", dest: "assets", rename: { stripBase: true } },
      ],
    }),
    ...(!isDev ? [zipPack({ inDir: "./dist", outDir: "./", outFileName: "package.zip" })] : []),
  ],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: isDev ? "inline" : false,
    minify: !isDev,
    lib: {
      entry: resolve(root, "src/index.ts"),
      name: "OmniKitPlugin",
      formats: ["cjs"],
      fileName: () => "index.js",
      cssFileName: "index",
    },
    rollupOptions: {
      // SiYuan injects the Plugin API at runtime; never bundle an SDK copy.
      external: ["siyuan"],
      output: { entryFileNames: "index.js", assetFileNames: "[name][extname]" },
    },
  },
});
