// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as esbuild from "esbuild";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

// Constants
const PKG_DIR = "pkg";
const BUNDLE_PATH = path.join(PKG_DIR, "index.cjs");
const SEA_CONFIG_PATH = path.join(PKG_DIR, "sea-config.json");
const SEA_BLOB_PATH = path.join(PKG_DIR, "sea-prep.blob");
const PLATFORM_ARCH = `${process.platform}-${process.arch}`;
const BINARY_NAME = process.platform === "win32" ? `inshellisense2-${PLATFORM_ARCH}.exe` : `inshellisense2-${PLATFORM_ARCH}`;
const BINARY_PATH = path.join(PKG_DIR, BINARY_NAME);
const NODE_VERSION = "22.21.1";
const ASSET_PATH_SEP = "____";

const getNodePtyPath = (): string => path.dirname(require.resolve("node-pty"));
const getAutocompletePath = (): string => path.dirname(require.resolve("@withfig/autocomplete"));

const getVersion = (): string => {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf-8"));
  return packageJson.version;
};

// Bundle utilities
const readBundle = (): string => fs.readFileSync(BUNDLE_PATH, "utf-8");
const writeBundle = (content: string): void => fs.writeFileSync(BUNDLE_PATH, content, "utf-8");

const patchBundle = (search: string, replacement: string, description: string): void => {
  const content = readBundle();
  writeBundle(content.replace(search, replacement));
  console.log(`Patched: ${description}`);
};

const unsignBinary = (): void => {
  if (process.platform === "darwin") {
    execSync(`codesign --remove-signature "${BINARY_PATH}"`, { stdio: "inherit" });
  }
  console.log(`Removed code signature (if applicable)`);
};

const signBinary = (): void => {
  if (process.platform === "darwin") {
    execSync(`codesign --sign - --force "${BINARY_PATH}"`, { stdio: "inherit" });
  }
  console.log(`Signed binary (if applicable)`);
};

// Build steps
const buildBundle = async (): Promise<esbuild.Metafile> => {
  const result = await esbuild.build({
    entryPoints: ["build/index.js"],
    bundle: true,
    outfile: BUNDLE_PATH,
    platform: "node",
    format: "cjs",
    sourcemap: true,
    metafile: true,
  });
  console.log(`Built bundle: ${BUNDLE_PATH}`);
  return result.metafile!;
};

const writeThirdPartyNotices = (bundle: esbuild.Metafile): void => {
  const packages = new Set<string>();
  for (const input of [...Object.keys(bundle.inputs), getNodePtyPath(), getAutocompletePath()]) {
    if (!input.includes("node_modules")) continue;
    let directory = path.resolve(input);
    if (fs.statSync(directory).isFile()) directory = path.dirname(directory);
    while (true) {
      const manifest = path.join(directory, "package.json");
      if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name) break;
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`Cannot identify bundled package: ${input}`);
      directory = parent;
    }
    packages.add(directory);
  }
  const nodeDirectory = process.platform === "win32" ? path.dirname(process.execPath) : path.dirname(path.dirname(process.execPath));
  const notices = [`Node.js ${NODE_VERSION}\n\n${fs.readFileSync(path.join(nodeDirectory, "LICENSE"), "utf8")}`];
  for (const directory of [...packages].sort()) {
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    const license = fs.readdirSync(directory).find((name) => /^licen[cs]e(?:[.-].*)?$/i.test(name));
    // These npm tarballs omit license files; pinned upstream originals live in licenses/.
    const vendored = metadata.name.startsWith("@xterm/") ? "xterm.LICENSE" : metadata.name === "eastasianwidth" ? "eastasianwidth.LICENSE" : undefined;
    if (!license && !vendored) throw new Error(`Missing bundled dependency license: ${metadata.name}`);
    const licensePath = license ? path.join(directory, license) : path.join("licenses", vendored!);
    notices.push(`${metadata.name} ${metadata.version}\n\n${fs.readFileSync(licensePath, "utf8")}`);
  }
  fs.writeFileSync(path.join(PKG_DIR, "THIRD_PARTY_NOTICES.txt"), notices.join("\n\n----------------------------------------\n\n"));
};

const bundleNodePtyWorker = async (): Promise<string> => {
  const workerPath = path.join(getNodePtyPath(), "worker", "conoutSocketWorker.js");
  const result = await esbuild.build({
    entryPoints: [workerPath],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  });
  return result.outputFiles?.[0]?.text ?? "";
};

const applyBundlePatches = async (): Promise<void> => {
  // Patch native require
  patchBundle(
    'return { dir, module: require(dir + "/" + name + ".node") };',
    `var req = require("module").createRequire(__filename);
    return { dir, module: req(dir + "/" + name + ".node") };`,
    "native require",
  );

  // Patch native locations
  patchBundle(
    'var dirs = ["build/Release", "build/Debug", "prebuilds/" + process.platform + "-" + process.arch];',
    `var os_1 = require("os");
    var path_1 = require("path");
    var dirs = [path_1.join(os_1.homedir(), ".inshellisense2", "native", "${getVersion()}"), "build/Release", "build/Debug", "prebuilds/" + process.platform + "-" + process.arch];`,
    "native locations",
  );

  // Patch to handle absolute paths correctly (skip relative prefixes for absolute paths)
  patchBundle('var dir = r + "/" + d;', 'var dir = path_1.isAbsolute(d) ? d : r + "/" + d;', "absolute path handling");

  // Patch worker inline
  const workerCode = await bundleNodePtyWorker();
  patchBundle(
    'this._worker = new worker_threads_1.Worker(path_1.join(scriptPath, "worker/conoutSocketWorker.js"), { workerData });',
    `var script = \`${workerCode}\`
    this._worker = new worker_threads_1.Worker(script, { workerData, eval: true });`,
    "inline worker",
  );

  // Patch version
  patchBundle("__VERSION__", getVersion(), "version");
};

const copyNodePtyNatives = (): void => {
  const srcDir = path.join(getNodePtyPath(), "..", "prebuilds", PLATFORM_ARCH);
  if (!fs.existsSync(srcDir)) return;

  const destDir = path.join(PKG_DIR, "prebuilds", PLATFORM_ARCH);
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
  console.log(`Copied natives: ${srcDir} -> ${destDir}`);
};

const copyAutocompleteSpecs = (): void => {
  const srcDir = path.join(getAutocompletePath());
  if (!fs.existsSync(srcDir)) return;

  const destDir = path.join(PKG_DIR, "specs");
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
  console.log(`Copied specs: ${srcDir} -> ${destDir}`);
};

const generateSeaConfig = (): void => {
  const shellAssets = fs.readdirSync("shell");
  const prebuildsDir = path.join(PKG_DIR, "prebuilds", PLATFORM_ARCH);
  const specsDir = path.join(PKG_DIR, "specs");

  const nativeAssets = fs
    .readdirSync(prebuildsDir, { recursive: true })
    .map(String)
    .filter((file) => !file.endsWith(".pdb"))
    .filter((file) => fs.statSync(path.join(prebuildsDir, file)).isFile());

  const specAssets = fs
    .readdirSync(specsDir, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".js"))
    .filter((file) => fs.statSync(path.join(specsDir, file)).isFile())
    .filter((file) => !["gcloud", "az", "aws"].some((name) => file.startsWith(name + path.sep)));

  const assets: Record<string, string> = {};
  shellAssets.forEach((file) => (assets[file] = `shell/${file}`));
  nativeAssets.forEach((file) => {
    assets[file.replaceAll(path.sep, ASSET_PATH_SEP)] = `pkg/prebuilds/${PLATFORM_ARCH}/${file}`.replaceAll(path.sep, "/");
  });
  specAssets.forEach((file) => {
    assets[file.replaceAll(path.sep, ASSET_PATH_SEP)] = `pkg/specs/${file}`.replaceAll(path.sep, "/");
  });

  const seaConfig = {
    main: BUNDLE_PATH,
    output: SEA_BLOB_PATH,
    execArgvExtension: "cli",
    disableExperimentalSEAWarning: true,
    assets,
  };

  fs.mkdirSync(PKG_DIR, { recursive: true });
  fs.writeFileSync(SEA_CONFIG_PATH, JSON.stringify(seaConfig, null, 2), "utf-8");
  console.log(`Generated SEA config: ${SEA_CONFIG_PATH}`);
};

const generateSeaBlob = (): void => {
  execFileSync(BINARY_PATH, ["--experimental-sea-config", SEA_CONFIG_PATH], { stdio: "inherit" });
  console.log(`Generated SEA blob: ${SEA_BLOB_PATH}`);
};

const copyNodeExecutable = async (): Promise<void> => {
  if (process.versions.node !== NODE_VERSION) throw new Error(`Packaging requires Node.js ${NODE_VERSION}; current version is ${process.versions.node}`);
  fs.copyFileSync(process.execPath, BINARY_PATH);
  console.log(`Copied Node executable: ${BINARY_PATH}`);
};

const injectSeaBlob = async (): Promise<void> => {
  unsignBinary();

  const args = [BINARY_PATH, "NODE_SEA_BLOB", SEA_BLOB_PATH, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
  if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
  execFileSync(process.execPath, [require.resolve("postject/dist/cli.js"), ...args], { stdio: "inherit" });
  console.log(`Injected SEA blob: ${BINARY_PATH}`);

  signBinary();
};

const main = async (): Promise<void> => {
  const bundle = await buildBundle();
  await applyBundlePatches();
  copyNodePtyNatives();
  copyAutocompleteSpecs();
  await copyNodeExecutable();
  generateSeaConfig();
  generateSeaBlob();
  await injectSeaBlob();
  fs.copyFileSync("LICENSE", path.join(PKG_DIR, "LICENSE"));
  writeThirdPartyNotices(bundle);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
