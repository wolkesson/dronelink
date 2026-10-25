import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import type { GuiAssets } from "@dronelink/ground-client-sdk";

const webClient = (path: string) => new URL(`../../ground-web-client/${path}`, import.meta.url);

/**
 * Bundles the ground-web-client's flight-control panel (TypeScript, with ui-kit-ground and
 * core-transport) into one browser ES module. Done at startup, so there is no generated file
 * to keep in sync; it takes well under a second.
 */
export function bundleFlightControlScript(): string {
  const result = buildSync({
    entryPoints: [fileURLToPath(webClient("src/flight-control.ts"))],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

export function loadGuiAssets(): GuiAssets {
  return {
    page: readFileSync(webClient("public/index.html"), "utf8"),
    clientScript: readFileSync(webClient("public/gui-client.js"), "utf8"),
    qrScript: readFileSync(webClient("public/qrcode.mjs"), "utf8"),
    flightControlScript: bundleFlightControlScript(),
  };
}
