import { defineConfig } from "vite";
import mkcert from "vite-plugin-mkcert";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    mkcert(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "DroneLink",
        short_name: "DroneLink",
        description: "Air-side drone command-and-control PWA",
        theme_color: "#1a1a2e",
        background_color: "#1a1a2e",
        display: "standalone",
        icons: [],
      },
    }),
  ],
  server: {
    https: true,
  },
  test: {
    globals: true,
    environment: "node",
  },
});
