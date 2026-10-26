import { defineConfig } from "vite";
import mkcert from "vite-plugin-mkcert";
import { VitePWA } from "vite-plugin-pwa";

// DRONELINK_DEV_HTTP=1 serves the dev server over plain http (http://localhost is still a
// secure context) without mkcert, e.g. for the headless SITL drills (tools/sitl/drills).
const plainHttp = process.env.DRONELINK_DEV_HTTP === "1";

export default defineConfig({
  plugins: [
    process.env.VITEST || plainHttp ? undefined : mkcert(),
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
  ].filter(Boolean),
  server: {
    https: !plainHttp,
  },
});
