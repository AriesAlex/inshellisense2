// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Live PTY regression scenarios. No mocked shell or terminal output.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import pty from "node-pty";
import xterm from "@xterm/headless";
import { Unicode11Addon } from "@xterm/addon-unicode11";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binaryIndex = process.argv.indexOf("--binary");
const executable = binaryIndex === -1 ? process.execPath : path.resolve(process.argv[binaryIndex + 1]);
const prefix = binaryIndex === -1 ? [path.join(root, "build", "index.js")] : [];
const shell = process.platform === "win32" ? "pwsh" : "zsh";
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "inshellisense-terminal-"));
const env = {
  ...process.env,
  HOME: artifacts,
  USERPROFILE: artifacts,
  ZDOTDIR: artifacts,
  XDG_CONFIG_HOME: path.join(artifacts, ".config"),
  ISTERM: "",
  FORCE_COLOR: "3",
  TERM: "xterm-256color",
};

execFileSync(executable, [...prefix, "init", shell], { env, cwd: root, timeout: 30000, stdio: "pipe" });
fs.writeFileSync(
  path.join(artifacts, "application.mjs"),
  `process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
const alternate = process.argv[2] === 'alternate';
if (alternate) process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[H');
process.stdout.write('APP-READY\\r\\n\\x1b]10;?\\x1b\\\\\\x1b]11;?\\x07');
let input = '';
process.stdin.on('data', data => {
  input += data;
  if (input.includes('\\x1b]10;rgb:dcdc/dfdf/e4e4\\x1b\\\\') && input.includes('\\x1b]11;rgb:dcdc/dfdf/e4e4\\x1b\\\\')) {
    process.stdout.write('COLOR-REPLY-OK\\r\\n');
    input = '';
  }
  if (data.includes('\\x03')) {
    process.stdin.setRawMode(false);
    if (alternate) process.stdout.write('\\x1b[?10');
    setTimeout(() => {
      process.stdout.write((alternate ? '49l' : '') + 'APP-EXIT\\r\\n', () => process.exit(0));
    }, 20);
  }
});
`,
);

const terminal = new xterm.Terminal({ cols: 55, rows: 12, allowProposedApi: true, scrollback: 2000 });
terminal.loadAddon(new Unicode11Addon());
terminal.unicode.activeVersion = "11";
const child = pty.spawn(executable, [...prefix, "-s", shell, "-T", "-V"], {
  cwd: artifacts,
  env,
  cols: terminal.cols,
  rows: terminal.rows,
  name: "xterm-256color",
  useConpty: true,
  useConptyDll: true,
});
let output = "";
let replies = 0;
const events = ["resize 55 12"];
child.onData((data) => {
  output += data;
  events.push(`output ${Buffer.from(data).toString("base64")}`);
  terminal.write(data);
});
terminal.onData((data) => child.write(data));
for (const color of [10, 11]) {
  terminal.parser.registerOscHandler(color, (data) => {
    if (data === "?") {
      replies++;
      child.write(`\x1b]${color};rgb:dcdc/dfdf/e4e4\x1b\\`);
    }
    return true;
  });
}

const screen = () => {
  const buffer = terminal.buffer.active;
  return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "").join("\n");
};
const waitFor = async (description: string, ready: () => boolean) => {
  const deadline = Date.now() + 15000;
  while (!ready()) {
    assert(Date.now() < deadline, `Timed out: ${description}\n${screen()}`);
    await delay(50);
  }
  await delay(200);
};
const checkpoint = async (name: string) => {
  await new Promise<void>((resolve) => terminal.write("", resolve));
  events.push(`checkpoint ${name}`);
  fs.writeFileSync(path.join(artifacts, `${name}.txt`), screen());
  const buffer = terminal.buffer.active;
  const viewport = Array.from({ length: terminal.rows }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? "");
  fs.writeFileSync(path.join(artifacts, `${name}.viewport.txt`), viewport.join("\n"));
  fs.writeFileSync(path.join(artifacts, `${name}.cursor.txt`), `${buffer.cursorX + 1},${buffer.cursorY + 1}`);
};
const resize = async (cols: number, rows: number) => {
  events.push(`resize ${cols} ${rows}`);
  terminal.resize(cols, rows);
  child.resize(cols, rows);
  await delay(500);
};
const cancel = async () => {
  child.write(process.platform === "win32" ? "\x1b[67;46;3;1;8;1_\x1b[67;46;3;0;8;1_" : "\x03");
  await delay(500);
};
const quote = (value: string) => `'${value.replaceAll("'", shell === "pwsh" ? "''" : "'\\''")}'`;

try {
  await waitFor("initial prompt", () => screen().includes(shell === "pwsh" ? "PS > " : "> "));
  if (shell === "pwsh") {
    child.write("Set-PSReadLineOption -HistorySaveStyle SaveNothing -PredictionSource None\r");
    await delay(700);
  }
  await checkpoint("prompt");
  child.write(shell === "pwsh" ? "1..6 | ForEach-Object { 'KEEP-ROW-' + $_ }\r" : "printf 'KEEP-ROW-%s\\n' {1..6}\r");
  await waitFor("command output", () => screen().includes("\nKEEP-ROW-6"));
  child.write("p");
  await waitFor("suggestions on a small screen", () => screen().includes("┌"));
  await checkpoint("small");
  await resize(90, 26);
  child.write("n");
  await delay(700);
  await checkpoint("resized");
  await cancel();
  await checkpoint("cancelled");
  assert(!/[┌┐└┘│]/u.test(screen()), "Suggestion box survived Ctrl+C");
  for (let i = 1; i <= 6; i++) {
    assert.equal(
      screen()
        .split("\n")
        .filter((line) => line.trim() === `KEEP-ROW-${i}`).length,
      1,
      `History row ${i} lost or duplicated`,
    );
  }

  for (const size of [
    [40, 12],
    [32, 8],
    [55, 12],
  ]) {
    child.write("p");
    await delay(400);
    await resize(size[0], size[1]);
    await cancel();
  }
  await resize(120, 30);
  await checkpoint("tiny-resizes");
  assert(!/[┌┐└┘│]/u.test(screen()), "Suggestion box survived a tiny resize");

  for (const mode of ["normal", "alternate"]) {
    const previousReplies = replies;
    const previousOutputLength = output.length;
    child.write(`${shell === "pwsh" ? "& " : ""}${quote(process.execPath)} ${quote(path.join(artifacts, "application.mjs"))} ${mode}\r`);
    await waitFor(`${mode} application and terminal replies`, () => screen().includes("COLOR-REPLY-OK"));
    assert.equal(replies - previousReplies, 2, "Terminal color queries did not reach the outer terminal");
    assert(!screen().includes("10;rgb:"), "Terminal response leaked into visible input");
    await checkpoint(`application-${mode}`);
    await cancel();
    await waitFor(`${mode} application exit`, () => output.slice(previousOutputLength).includes("APP-EXIT"));
    await checkpoint(`exit-${mode}`);
    assert.equal(terminal.buffer.active.type, "normal", "Alternate buffer was not left");
    assert.equal(
      screen()
        .split("\n")
        .filter((line) => line.trim() === "APP-EXIT").length,
      mode === "normal" ? 1 : 2,
      "Application exit replayed or lost history",
    );
    child.write(`p`);
    await waitFor("suggestions after application exit", () => screen().includes("┌"));
    await cancel();
  }
  child.write(shell === "pwsh" ? "Write-Output SECOND-COMMAND-OK\r" : "printf 'SECOND-COMMAND-OK\\n'\r");
  await waitFor("second command", () => screen().includes("\nSECOND-COMMAND-OK"));
  await checkpoint("finished");
  child.write(shell === "pwsh" ? "1..1100 | ForEach-Object { 'HISTORY-ROW-' + $_ }\r" : "printf 'HISTORY-ROW-%s\\n' {1..1100}\r");
  await waitFor("long history", () => screen().includes("\nHISTORY-ROW-1100"));
  child.write("p");
  await delay(700);
  await resize(55, 12);
  await cancel();
  await resize(120, 30);
  await checkpoint("history");
  assert.equal(
    screen()
      .split("\n")
      .filter((line) => line.trim() === "HISTORY-ROW-1").length,
    1,
    "Resize truncated or duplicated long history",
  );
  console.log(
    `PASS: live ${shell} PTY, bounded overlays, resize, OSC replies, Ctrl+C, alternate buffer, second command, long history.\nArtifacts: ${artifacts}`,
  );
} finally {
  fs.writeFileSync(path.join(artifacts, "output.ansi"), output);
  fs.writeFileSync(path.join(artifacts, "events.terminal"), events.join("\n"));
  child.kill();
  terminal.dispose();
}
process.exit(0);
