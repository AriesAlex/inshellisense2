// Copyright (c) inshellisense2 contributors.
// Licensed under the MIT License.

// Real installers, real profile files, and real interactive PTYs in isolated homes.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import pty from "node-pty";
import xterm from "@xterm/headless";
import which from "which";

const run = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}) =>
  new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const releaseIndex = process.argv.indexOf("--release-directory");
const releaseDirectory = releaseIndex === -1 ? path.join(root, "pkg") : path.resolve(process.argv[releaseIndex + 1]);
const archive = `inshellisense2-${process.platform}-${process.arch}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
for (const name of [archive, "SHA256SUMS"]) assert(fs.existsSync(path.join(releaseDirectory, name)), `Missing ${name}`);
const server = http.createServer((request, response) => {
  const name = request.url?.slice(1);
  if (name !== archive && name !== "SHA256SUMS") {
    response.writeHead(404).end();
    return;
  }
  const file = path.join(releaseDirectory, name);
  response.setHeader("Content-Type", "application/octet-stream");
  response.setHeader("Content-Length", fs.statSync(file).size);
  fs.createReadStream(file).pipe(response);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const shells = process.platform === "win32" ? ["pwsh", "powershell"] : ["sh", "bash", "zsh", "pwsh"];
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "inshellisense2 install qa "));
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

try {
  for (const shell of shells) {
    if (shell === "pwsh" && process.platform !== "win32") {
      try {
        await run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]);
      } catch {
        continue;
      }
    }
    const home = path.join(artifacts, shell);
    fs.mkdirSync(home);
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      ZDOTDIR: home,
      ISTERM: "",
      INSHELLISENSE2_PS_PROFILE: "",
      IS2_PROFILE_COUNT: "",
      IS2_LOGIN_COUNT: "",
      IS2_ENV_COUNT: "",
      ENV: "",
      INSHELLISENSE2_SH_ENV: "",
      TERM: "xterm-256color",
      SHELL: `/bin/${shell}`,
      INSHELLISENSE2_VERSION: `v${version}`,
      INSHELLISENSE2_RELEASE_URL: `http://127.0.0.1:${port}`,
      PSModuleAnalysisCachePath: path.join(home, "module-analysis-cache"),
    };
    // Each PowerShell edition must discover its own standard modules.
    delete (env as NodeJS.ProcessEnv).PSModulePath;
    const powershell = shell === "pwsh" || shell === "powershell";
    const profile = powershell ? path.join(home, "profile.ps1") : path.join(home, shell === "zsh" ? ".zshrc" : shell === "bash" ? ".bashrc" : ".profile");
    const content = powershell
      ? "# CUSTOM_PROFILE_CONTENT\n$env:IS2_PROFILE_COUNT = [string](1 + [int]$env:IS2_PROFILE_COUNT)\n"
      : "# CUSTOM_PROFILE_CONTENT\nIS2_PROFILE_COUNT=$(( ${IS2_PROFILE_COUNT:-0} + 1 )); export IS2_PROFILE_COUNT\n";
    fs.writeFileSync(profile, content);
    if (shell === "bash")
      fs.writeFileSync(path.join(home, ".bash_profile"), 'IS2_LOGIN_COUNT=$(( ${IS2_LOGIN_COUNT:-0} + 1 )); export IS2_LOGIN_COUNT\n. "$HOME/.bashrc"\n');
    if (shell === "sh") {
      const legacyEnv = path.join(home, ".shrc");
      fs.writeFileSync(legacyEnv, "IS2_ENV_COUNT=$(( ${IS2_ENV_COUNT:-0} + 1 )); export IS2_ENV_COUNT\n");
      env.ENV = legacyEnv;
    }

    const executable = path.join(home, ".local", "bin", process.platform === "win32" ? "inshellisense2.exe" : "inshellisense2");
    for (let pass = 0; pass < 2; pass++) {
      if (process.platform === "win32") {
        await run(
          shell,
          ["-NoProfile", "-NonInteractive", "-File", path.join(root, "install.ps1"), "-InstallDirectory", path.dirname(executable), "-ProfilePath", profile],
          { env, timeout: 120000 },
        );
      } else {
        // The mirror is local; all downloaded bytes and checksum checks use the production installer.
        await run("sh", [path.join(root, "install.sh"), "--shell", shell], { env, timeout: 120000 });
        if (powershell) {
          // Also exercise an explicitly selected profile without changing the host user's profiles.
          await run(executable, ["init", shell, "--install", "--profile", profile], { env, timeout: 30000 });
        }
      }
    }
    const installed = fs.readFileSync(profile, "utf8");
    assert.equal(installed.split("# >>> inshellisense2 >>>").length - 1, 1, `${shell}: duplicate startup blocks`);
    assert(installed.endsWith(content), `${shell}: existing profile changed`);
    const nonInteractive = powershell
      ? ["-NoProfile", "-NonInteractive", "-Command", `. ${quote(profile)}; Write-Output "NONINTERACTIVE:$env:ISTERM"`]
      : ["-c", `. '${profile.replaceAll("'", "'\\''")}'; printf 'NONINTERACTIVE:%s\\n' "$ISTERM"`];
    const nonTty = await run(shell, nonInteractive, { env, timeout: 15000 });
    assert(nonTty.stdout.includes("NONINTERACTIVE:\n") || nonTty.stdout.includes("NONINTERACTIVE:\r\n"), `${shell}: UI started without TTY`);

    for (const login of powershell ? [false] : shell === "sh" ? [true] : [false, true]) {
      const args = powershell ? ["-NoProfile", "-NoExit", "-Command", `. ${quote(profile)}`] : login ? ["-il"] : ["-i"];
      const terminal = new xterm.Terminal({ cols: 70, rows: 18, allowProposedApi: true, scrollback: 1000 });
      const child = pty.spawn(which.sync(shell), args, { cwd: home, env, cols: 70, rows: 18, name: "xterm-256color", useConpty: true, useConptyDll: true });
      let exited = false;
      child.onExit(() => {
        exited = true;
      });
      let output = "";
      child.onData((data) => {
        output += data;
        terminal.write(data);
      });
      terminal.onData((data) => child.write(data));
      const waitFor = async (description: string, ready: () => boolean) => {
        const deadline = Date.now() + 30000;
        while (!ready()) {
          assert(Date.now() < deadline, `${shell} (${login ? "login" : "interactive"}): ${description}\n${output.slice(-3000)}`);
          await delay(50);
        }
        await delay(200);
      };
      try {
        await waitFor("prompt integration", () => output.includes("6973;PE"));
        const marker = powershell
          ? 'Write-Output "IS2_ONE:$env:ISTERM`:$env:IS2_PROFILE_COUNT"\r'
          : 'printf "IS2_ONE:%s:%s\\n" "$ISTERM" "$IS2_PROFILE_COUNT"\r';
        child.write(marker);
        await waitFor("profile must load once", () => output.includes("IS2_ONE:1:1"));
        output = "";
        child.write(powershell ? 'Write-Output "IS2_TWO:$env:ISTERM"\r' : 'printf "IS2_TWO:%s\\n" "$ISTERM"\r');
        await waitFor("second command", () => output.includes("IS2_TWO:1"));
        if (shell === "sh") {
          child.write('printf "IS2_ENV:%s\\n" "$IS2_ENV_COUNT"\r');
          await waitFor("original ENV must load once", () => output.includes("IS2_ENV:1"));
        }
        fs.writeFileSync(path.join(home, `session-${login ? "login" : "interactive"}.ansi`), output);
        output = "";
        child.write("exit\r");
        if (powershell) {
          // -NoExit keeps the explicitly invoked outer host alive after its script ends.
          await waitFor("wrapped shell exit", () => output.includes("\x1bc"));
          child.write("exit\r");
        }
        await waitFor("clean shell exit", () => exited);
      } finally {
        try {
          if (!exited) child.kill();
        } catch {
          /* Already exited. */
        }
        terminal.dispose();
      }
    }
    await run(executable, ["uninstall", "--profile", profile], { env, timeout: 30000 });
    assert.equal(fs.readFileSync(profile, "utf8").replace(/^\uFEFF/, ""), content, `${shell}: uninstall changed user content`);
    process.stdout.write(`PASS: ${shell} installer, repeated install, non-TTY, startup lifecycle, consecutive commands, uninstall\n`);
  }
  process.stdout.write(`Artifacts: ${artifacts}\n`);
} finally {
  server.close();
}
// ConPTY workers can keep Node's event loop alive after all PTYs have closed.
process.exit(0);
