import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "social-preview-dev-origin",
      apply: "serve",
      transformIndexHtml: (html) =>
        html.replaceAll("__PUBLIC_ORIGIN__", "http://localhost:5173"),
    },
  ],
  server: { port: 5173, proxy: { "/api": "http://localhost:3000" } },
  build: { manifest: true, target: "es2022" },
});
