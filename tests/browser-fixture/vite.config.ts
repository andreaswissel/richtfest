import { defineConfig } from "../../richtfest-os/apps/web/node_modules/vite";
import tailwindcss from "../../richtfest-os/apps/web/node_modules/@tailwindcss/vite/dist/index.mjs";

const webRoot = new URL("../../richtfest-os/apps/web/", import.meta.url).pathname;

export default defineConfig({
  root: webRoot,
  resolve: {
    alias: {
      "@": new URL("../../richtfest-os/apps/web/src/", import.meta.url).pathname,
    },
  },
  plugins: [tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4187",
        configure: (proxy) => {
          proxy.on("proxyReq", (request) => {
            request.setHeader("origin", "http://127.0.0.1:5174");
          });
        },
      },
    },
  },
});
