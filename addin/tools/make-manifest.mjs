// Makes the manifest to hand to IT: the dev manifest with every https://localhost:3000 address replaced by the
// address the built files (dist/) are hosted at, and its own id so it never clashes with a developer's copy.
//
//   npm run build
//   npm run manifest -- https://addins.yourbank.example/sheet-assistant/
//
// Writes dist/manifest.xml. Upload that file in the Microsoft 365 admin center (see DEPLOY.md).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const base = process.argv[2];
if (!base || !/^https:\/\/[^\s]+$/.test(base)) {
  console.error("Usage: npm run manifest -- https://where-you-host-the-add-in/path/\nThe address must be https and end where taskpane.html lives.");
  process.exit(1);
}
const root = base.replace(/\/+$/, "");
const origin = new URL(root).origin;

let xml = readFileSync(join(here, "..", "manifest.xml"), "utf8");
// The production add-in has its own id (the dev one is only for sideloading on a developer's machine).
xml = xml.replace(/<Id>[^<]+<\/Id>/, "<Id>3f8c2d51-9a7e-4b64-8e1d-6c2a90b7d4e3</Id>");
xml = xml.replace(/<AppDomain>https:\/\/localhost:3000<\/AppDomain>/, `<AppDomain>${origin}</AppDomain>`);
xml = xml.replaceAll("https://localhost:3000", root);
xml = xml.replace(/<!--[\s\S]*?-->\s*/, "");
if (xml.includes("localhost")) throw new Error("A localhost address is still in the manifest.");

mkdirSync(join(here, "..", "dist"), { recursive: true });
writeFileSync(join(here, "..", "dist", "manifest.xml"), xml);
console.log(`Wrote dist/manifest.xml for ${root}/taskpane.html`);
