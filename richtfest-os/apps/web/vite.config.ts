import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createHash } from "node:crypto";
export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "app-build-version",
      apply: "build",
      enforce: "post",
      generateBundle(_options, bundle) {
        const version = createHash("sha256")
          .update(Object.keys(bundle).sort().join("\n"))
          .digest("hex");
        const html = bundle["index.html"];
        if (html?.type !== "asset") throw new Error("Missing web entry HTML");
        html.source = String(html.source).replace(
          "</head>",
          `<meta name="richtfest-build" content="${version}" /></head>`,
        );
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: JSON.stringify({ version }),
        });
      },
    },
    {
      name: "social-preview-dev-origin",
      apply: "serve",
      transformIndexHtml: (html) =>
        html.replaceAll("__PUBLIC_ORIGIN__", "http://localhost:5173"),
    },
  ],
  server: { port: 5173, proxy: { "/api": process.env.VITE_API_PROXY || "http://localhost:3000" } },
  build: { manifest: true, target: "es2022" },
});
