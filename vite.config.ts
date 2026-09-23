import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Relative base so the same build works at a domain root or a GitHub Pages subpath.
export default defineConfig({
  base: "./",
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["apple-touch-icon.png"],
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
