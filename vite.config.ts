import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Relative base so the same build works at a domain root or a GitHub Pages subpath.
export default defineConfig({
  base: "./",
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      // main.ts registers the worker itself, to reload onto a new version only at a safe moment.
      injectRegister: null,
      includeAssets: ["apple-touch-icon.png"],
      // pdf.js ships its worker as .mjs; cache it too so PDF import works offline.
      workbox: {
        globPatterns: ["**/*.{js,mjs,css,html,png,webmanifest}"],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        // The offline translation runtime (27 MB .wasm) is cached on first use rather than precached for
        // everyone; transformers.js caches the model files itself.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin === self.location.origin && url.pathname.endsWith(".wasm"),
            handler: "CacheFirst",
            // One entry: each onnxruntime upgrade renames the file, and old 27 MB copies should not pile up.
            options: { cacheName: "onnxruntime", cacheableResponse: { statuses: [200] }, expiration: { maxEntries: 1 } },
          },
        ],
      },
      manifest: {
        name: "LR Reader",
        short_name: "LR Reader",
        start_url: "./",
        scope: "./",
        display: "standalone",
        background_color: "#1c1b19",
        theme_color: "#1c1b19",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
    }),
  ],
});
