// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import readline from "node:readline";
import { PassThrough } from "node:stream";
import ansi from "ansi-escapes";
import chalk from "chalk";
import { Command } from "commander";

import log from "../utils/log.js";
import { getBackspaceSequence, Shell } from "../utils/shell.js";
import { enableWin32InputMode, resetToInitialState } from "../utils/ansi.js";
import { getMaxLines, type KeyPressEvent } from "./suggestionManager.js";

export const renderConfirmation = (live: boolean): string => {
  const statusMessage = live ? chalk.green("live") : chalk.red("not found");
  return `inshellisense session [${statusMessage}]\n`;
};

export const renderMissingResources = (): string => {
  return chalk.red(`inshellisense resources out of date, run "is reinit" to refresh\n`);
};

const writeOutput = (data: string) => {
  log.debug({ msg: "writing data", data });
  process.stdout.write(data);
};

// DECSC/DECRC also work in JediTerm, which does not implement CSI s/u.
const saveCursor = "\x1b7";
const restoreCursor = "\x1b8";

export const render = async (program: Command, shell: Shell, underTest: boolean, login: boolean) => {
  const [isterm, { SuggestionManager }] = await Promise.all([import("../isterm/index.js"), import("./suggestionManager.js")]);
  const term = await isterm.default.spawn(program, { shell, rows: process.stdout.rows, cols: process.stdout.columns, underTest, login });
  const suggestionManager = new SuggestionManager(term, shell);
  let overlay: { top: number; restore: string } | undefined;
  let revision = 0;
  const stdinStartedInRawMode = process.stdin.isRaw;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const shellInput = new PassThrough();
  readline.emitKeypressEvents(shellInput);

  const clearOverlay = () => {
    if (!overlay) return;
    const { hidden } = term.getCursorState();
    writeOutput(ansi.cursorHide + saveCursor + ansi.cursorTo(0, overlay.top) + overlay.restore + restoreCursor + (hidden ? "" : ansi.cursorShow));
    overlay = undefined;
  };

  const drawOverlay = () => {
    const state = term.getCommandState();
    if (term.isAlternateBuffer() || !state.commandText || !state.cursorTerminated || state.hasOutput) return;
    const { cursorY, hidden } = term.getCursorState();
    const below = term.rows - cursorY - 1;
    const above = cursorY;
    const direction = below >= getMaxLines() || below >= above ? "below" : "above";
    const height = Math.min(getMaxLines(), direction === "below" ? below : above);
    const patches = suggestionManager.render(direction, height);
    if (patches.length === 0) return;
    const top = direction === "below" ? cursorY + 1 : cursorY - patches.length;
    overlay = { top, restore: term.getPatch(top, patches.length) };
    writeOutput(
      ansi.cursorHide + saveCursor + ansi.cursorTo(0, top) + term.getPatch(top, patches.length, patches) + restoreCursor + (hidden ? "" : ansi.cursorShow),
    );
  };

  const refreshSuggestions = async () => {
    const currentRevision = revision;
    await suggestionManager.exec();
    if (currentRevision !== revision) return;
    clearOverlay();
    drawOverlay();
  };

  writeOutput(ansi.clearTerminal);
  term.onBeforeData(() => {
    revision++;
    clearOverlay();
  });
  term.onData((data) => {
    writeOutput(data.replaceAll(enableWin32InputMode, ""));
    if (!term.isAlternateBufferOutput()) void refreshSuggestions();
  });

  shellInput.on("keypress", (...keyPress: KeyPressEvent) => {
    const press = keyPress[1];
    const hadOverlay = overlay !== undefined;
    revision++;
    clearOverlay();
    if ((hadOverlay || press.name === "return" || (press.name === "c" && press.ctrl)) && suggestionManager.update(press)) {
      void refreshSuggestions();
      return;
    }
    term.write(press.name === "backspace" ? getBackspaceSequence(keyPress, shell) : press.sequence);
  });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data: string) => {
    // Terminal responses and application input must retain their original byte boundaries.
    if (term.isAlternateBuffer() || term.getCommandState().promptText == null) {
      term.write(data, true);
    } else {
      shellInput.write(data);
    }
  });

  term.onExit(({ exitCode }) => {
    clearOverlay();
    if (process.stdin.isTTY && !stdinStartedInRawMode) process.stdin.setRawMode(false);
    process.stdout.write(resetToInitialState);
    process.exit(exitCode);
  });
  process.stdout.on("resize", () => {
    revision++;
    const hadOverlay = overlay !== undefined;
    overlay = undefined;
    term.resize(process.stdout.columns, process.stdout.rows);
    if (hadOverlay && !term.isAlternateBuffer()) {
      // The client has already reflowed the overlay, possibly into scrollback.
      const { hidden } = term.getCursorState();
      writeOutput(ansi.cursorHide + ansi.clearTerminal + "\x1b[3J" + term.getSnapshot() + (hidden ? "" : ansi.cursorShow));
    }
    void refreshSuggestions();
  });
};
