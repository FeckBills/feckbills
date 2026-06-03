// Sync the release version across the workspace. Called by semantic-release's
// @semantic-release/exec prepare step:  node scripts/release-set-version.mjs <version>
// Updates every package.json `version` and the CLI's AGENT_VERSION constant
// (what `feckbills --version` reports and what's stamped on every scan).
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`release-set-version: expected a semver argument, got "${version}"`);
  process.exit(1);
}

const packageFiles = ["package.json", "packages/core/package.json", "packages/cli/package.json"];
for (const file of packageFiles) {
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.version = version;
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}

const scanPath = "packages/cli/src/scan.ts";
const next = readFileSync(scanPath, "utf8").replace(
  /(export const AGENT_VERSION = ")[^"]*(";)/,
  `$1${version}$2`,
);
writeFileSync(scanPath, next);

console.log(`release-set-version: set v${version} across ${packageFiles.length} package.json + AGENT_VERSION`);
