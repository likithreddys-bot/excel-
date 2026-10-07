import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vitest/config";

// Excel only loads add-ins over https with a certificate it trusts. `npm run certs` installs one
// (office-addin-dev-certs); without it we fall back to a self-signed cert, fine for a normal browser.
const certDir = join(homedir(), ".office-addin-dev-certs");
const trusted = existsSync(join(certDir, "localhost.key")) && existsSync(join(certDir, "localhost.crt"))
  ? { key: readFileSync(join(certDir, "localhost.key")), cert: readFileSync(join(certDir, "localhost.crt")) }
  : undefined;

export default defineConfig({
  plugins: trusted ? [] : [basicSsl()],
  server: { port: 3000, host: "localhost", https: trusted },
  build: { target: "es2022", outDir: "dist", rollupOptions: { input: "taskpane.html" } },
  test: { globals: true, include: ["test/**/*.test.ts"] },
});
