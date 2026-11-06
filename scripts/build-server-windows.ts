// Builds the Windows server package: one bundled JS file, the web panel,
// built-in profiles, a private Node runtime and the service installer, zipped.
//
//   npm run package:server            -> release/BlueVue-Server-<version>-win-x64.zip
//   NODE_VERSION=v24.11.1 npm run package:server   (pin a Node version)
//
// The Node runtime comes from nodejs.org and is checked against its published
// SHA-256 before use.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const ROOT = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const OUT = join(ROOT, "release");
const NAME = "BlueVue-Server";
const STAGE = join(OUT, NAME);
const CACHE = join(OUT, ".cache");

async function main() {
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(join(STAGE, "app"), { recursive: true });
  mkdirSync(CACHE, { recursive: true });

  console.log("Building the web panel…");
  execFileSync("npx", ["vite", "build", "web"], { cwd: ROOT, stdio: "inherit" });

  console.log("Bundling the server…");
  await build({
    entryPoints: [join(ROOT, "src/index.ts")],
    outfile: join(STAGE, "app/server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // Some dependencies are CommonJS and call require(); give the ESM bundle one.
    banner: { js: 'import { createRequire as __bvRequire } from "node:module"; const require = __bvRequire(import.meta.url);' },
    // Optional native speedups for ws, and RS-232 (used on wall PCs, not the server).
    external: ["bufferutil", "utf-8-validate", "serialport"],
    logLevel: "warning",
  });

  cpSync(join(ROOT, "web/dist"), join(STAGE, "web/dist"), { recursive: true });
  cpSync(join(ROOT, "profiles/builtin"), join(STAGE, "profiles/builtin"), { recursive: true });
  mkdirSync(join(STAGE, "config"), { recursive: true });
  cpSync(join(ROOT, "config/example-site.json"), join(STAGE, "config/example-site.json"));
  cpSync(join(ROOT, "config/system.json"), join(STAGE, "config/system.json")); // for Start-BlueVue.cmd
  writeFileSync(join(STAGE, "package.json"), JSON.stringify({ name: "blue-vue-server", version: pkg.version, private: true }, null, 2));
  for (const f of ["install-server.ps1", "uninstall-server.ps1", "Start-BlueVue.cmd", "README.txt"]) {
    // Windows line endings: cmd.exe misreads labels in LF-only batch files.
    const text = readFileSync(join(ROOT, "packaging/windows", f), "utf8").replace(/\r?\n/g, "\r\n");
    writeFileSync(join(STAGE, f), text);
  }

  const node = await fetchNode();
  mkdirSync(join(STAGE, "runtime"), { recursive: true });
  cpSync(node.exe, join(STAGE, "runtime/node.exe"));
  writeFileSync(join(STAGE, "runtime/VERSION.txt"), `Node.js ${node.version} (win-x64), from nodejs.org\n`);

  const zip = join(OUT, `${NAME}-${pkg.version}-win-x64.zip`);
  rmSync(zip, { force: true });
  execFileSync("zip", ["-qr", zip, NAME], { cwd: OUT });
  console.log(`\nDone: ${zip}`);
}

/** Downloads and verifies node.exe for Windows x64, cached between builds. */
async function fetchNode(): Promise<{ exe: string; version: string }> {
  let version = process.env.NODE_VERSION;
  if (!version) {
    // Newest Node 24 release (the current LTS line).
    const index = (await (await fetch("https://nodejs.org/dist/index.json")).json()) as { version: string; files: string[] }[];
    version = index.find((r) => r.version.startsWith("v24.") && r.files.includes("win-x64-zip"))?.version;
    if (!version) throw new Error("Couldn't find a Node 24 release for Windows");
  }
  const base = `node-${version}-win-x64`;
  const exe = join(CACHE, base, "node.exe");
  if (existsSync(exe)) return { exe, version };

  console.log(`Downloading Node.js ${version} for Windows…`);
  const sums = await (await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
  const expected = sums.split("\n").find((l) => l.endsWith(`  ${base}.zip`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`No checksum published for ${base}.zip`);
  const res = await fetch(`https://nodejs.org/dist/${version}/${base}.zip`);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected) throw new Error(`Checksum mismatch for ${base}.zip`);
  const zipPath = join(CACHE, `${base}.zip`);
  writeFileSync(zipPath, data);
  execFileSync("unzip", ["-qo", zipPath, `${base}/node.exe`, "-d", CACHE]);
  return { exe, version };
}

await main();
