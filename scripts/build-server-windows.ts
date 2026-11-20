// Builds the Windows server package: one bundled JS file, the web panel,
// built-in profiles, a private Node runtime, a private Python with pyatv (for
// Apple TV control) and the service installer, zipped.
//
//   npm run package:server            -> release/BlueVue-Server-<version>-win-x64.zip
//   NODE_VERSION=v24.11.1 npm run package:server   (pin a Node version)
//
// The Node runtime comes from nodejs.org and is checked against its published
// SHA-256 before use. Python comes from python.org and is checked against the
// SHA-256 pinned below; pyatv and what it needs come from PyPI as Windows
// wheels (needs python3 with pip on the build machine).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const ROOT = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const OUT = join(ROOT, "release");
const NAME = "BlueVue-Server";
const STAGE = join(OUT, NAME);
const CACHE = join(OUT, ".cache");

// The Python that runs the Apple TV helper. To move to a newer one, change all three.
const PYTHON_VERSION = "3.13.9";
const PYTHON_SHA256 = "91d828c2da3a029b41699e918674a0cb379c02cf20dab9c501306885f837402a";
// srptools 2 changed a call pyatv 0.18 makes, which breaks pairing; keep it on 1.x until pyatv follows.
const PYATV = "pyatv==0.18.0";
const PYATV_PINS = ["srptools==1.0.1"];
// Reading NDI streams off the network for the live pictures (cyndilib carries the NDI library).
const NDI_PACKAGES = ["cyndilib==0.1.3", "Pillow==13.0.0"];

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
  // When this package was built: the admin's Update button compares it with latest.json on GitHub.
  const built = new Date().toISOString();
  writeFileSync(join(STAGE, "build.json"), JSON.stringify({ built }, null, 2) + "\n");
  for (const f of ["Install Blue Vue.cmd", "Uninstall Blue Vue.cmd", "install-server.ps1", "uninstall-server.ps1", "Start-BlueVue.cmd", "README.txt"]) {
    // Windows line endings: cmd.exe misreads labels in LF-only batch files.
    const text = readFileSync(join(ROOT, "packaging/windows", f), "utf8").replace(/\r?\n/g, "\r\n");
    writeFileSync(join(STAGE, f), text);
  }

  const node = await fetchNode();
  mkdirSync(join(STAGE, "runtime"), { recursive: true });
  cpSync(node.exe, join(STAGE, "runtime/node.exe"));
  writeFileSync(join(STAGE, "runtime/VERSION.txt"), `Node.js ${node.version} (win-x64), from nodejs.org\n`);

  await addPython(join(STAGE, "runtime/python"));
  mkdirSync(join(STAGE, "app/appletv"), { recursive: true });
  cpSync(join(ROOT, "agent/src/transports/appletv/bluevue_atv.py"), join(STAGE, "app/appletv/bluevue_atv.py"));
  mkdirSync(join(STAGE, "app/ndi"), { recursive: true });
  cpSync(join(ROOT, "src/ndi/bluevue_ndi.py"), join(STAGE, "app/ndi/bluevue_ndi.py"));

  const zip = join(OUT, `${NAME}-${pkg.version}-win-x64.zip`);
  rmSync(zip, { force: true });
  execFileSync("zip", ["-qr", zip, NAME], { cwd: OUT });
  // Describes the newest package for servers checking for an update. Committed with the zip.
  const data = readFileSync(zip);
  const file = `${NAME}-${pkg.version}-win-x64.zip`;
  writeFileSync(
    join(ROOT, "packaging/windows/latest.json"),
    JSON.stringify({ built, package: file, url: `https://github.com/vlad907/blue-vue/raw/main/release/${file}`, sha256: createHash("sha256").update(data).digest("hex"), size: data.length }, null, 2) + "\n",
  );
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

/**
 * Puts Windows Python and pyatv in `dir`: python.org's embeddable package,
 * with the wheels unpacked into Lib/site-packages. Nothing is installed on
 * the server; the helper runs this copy directly.
 */
async function addPython(dir: string) {
  const base = `python-${PYTHON_VERSION}-embed-amd64`;
  const zipPath = join(CACHE, `${base}.zip`);
  if (!existsSync(zipPath)) {
    console.log(`Downloading Python ${PYTHON_VERSION} for Windows…`);
    const res = await fetch(`https://www.python.org/ftp/python/${PYTHON_VERSION}/${base}.zip`);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  }
  const actual = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  if (actual !== PYTHON_SHA256) {
    rmSync(zipPath);
    throw new Error(`Checksum mismatch for ${base}.zip`);
  }
  mkdirSync(dir, { recursive: true });
  execFileSync("unzip", ["-qo", zipPath, "-d", dir]);

  const packages = [PYATV, ...PYATV_PINS, ...NDI_PACKAGES];
  const wheels = join(CACHE, `wheels-${packages.join("-")}-py${PYTHON_VERSION}`);
  if (!existsSync(wheels)) {
    console.log(`Downloading ${packages.join(", ")} for Windows…`);
    const [major, minor] = PYTHON_VERSION.split(".");
    try {
      execFileSync(process.env.PYTHON ?? "python3", ["-m", "pip", "download", "--quiet", "--disable-pip-version-check", ...packages, "--platform", "win_amd64", "--python-version", `${major}.${minor}`, "--implementation", "cp", "--only-binary=:all:", "-d", wheels], { stdio: "inherit" });
    } catch (err) {
      rmSync(wheels, { recursive: true, force: true });
      throw new Error(`Couldn't download the Python packages. The build needs python3 with pip (set PYTHON to choose one). ${(err as Error).message}`);
    }
  }
  const site = join(dir, "Lib/site-packages");
  mkdirSync(site, { recursive: true });
  for (const wheel of readdirSync(wheels).filter((f) => f.endsWith(".whl"))) execFileSync("unzip", ["-qo", join(wheels, wheel), "-d", site]);
  // The embeddable Python only looks where this file says.
  const [major, minor] = PYTHON_VERSION.split(".");
  writeFileSync(join(dir, `python${major}${minor}._pth`), `python${major}${minor}.zip\r\n.\r\nLib\\site-packages\r\n`);
  writeFileSync(join(dir, "VERSION.txt"), `Python ${PYTHON_VERSION} (embeddable, win-amd64) from python.org, with ${packages.join(", ")} from PyPI\n`);
}

await main();
