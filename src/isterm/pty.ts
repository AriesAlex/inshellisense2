// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { EventEmitter } from "node:events";
import process from "node:process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SerializeAddon } from "@xterm/addon-serialize";

import pty from "node-pty";
import type { IPty, IEvent } from "node-pty";
import { Shell, userZdotdir, zdotdir } from "../utils/shell.js";
import { IsTermOscPs, IstermOscPt, IstermPromptStart, IstermPromptEnd } from "../utils/ansi.js";
import xterm from "@xterm/headless";
import type { IBufferCell } from "@xterm/xterm";

interface ICellData extends IBufferCell {
  extended: { underlineStyle: number };
  hasExtendedAttrs(): number;
}
import { CommandManager, CommandState } from "./commandManager.js";
import log from "../utils/log.js";
import { gitBashPath } from "../utils/shell.js";
import * as ansi from "../utils/ansi.js";
import { Command } from "commander";
import which from "which";
import { shellResourcesPath } from "../utils/constants.js";

const ISTermOnDataEvent = "data";
const ISTermBeforeDataEvent = "beforeData";
const ISTermOnExitEvent = "exit";
// Win32 scan codes for Ctrl+A through Ctrl+Z.
const windowsControlScanCodes = [
  0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31, 0x18, 0x19, 0x10, 0x13, 0x1f, 0x14, 0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c,
];

type ISTermOptions = {
  env?: { [key: string]: string | undefined };
  rows: number;
  cols: number;
  shell: Shell;
  shellArgs?: string[];
  underTest: boolean;
  login: boolean;
};

export type ISTermPatch = {
  startX: number;
  length: number;
  data: string;
};

export class ISTerm implements IPty {
  readonly pid: number;
  cols: number;
  rows: number;
  readonly process: string;
  readonly handleFlowControl = false;
  readonly onData: IEvent<string>;
  readonly onBeforeData: IEvent<void>;
  readonly onExit: IEvent<{ exitCode: number; signal?: number }>;
  cwd: string = "";
  cursorHidden: boolean = false;
  #alternateBufferOutput = false;
  #pendingData: string[] = [];
  #parsingData = false;
  #pendingExit?: { exitCode: number; signal?: number };

  readonly #pty: IPty;
  readonly #ptyEmitter: EventEmitter;
  readonly #term: xterm.Terminal;
  readonly #serializer = new SerializeAddon();
  readonly #commandManager: CommandManager;
  readonly #shell: Shell;

  constructor({ shell, cols, rows, env, shellTarget, shellArgs, underTest, login }: ISTermOptions & { shellTarget: string }) {
    this.#pty = pty.spawn(shellTarget, shellArgs ?? [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: { ...convertToPtyEnv(shell, underTest, login), ...env },
      useConpty: true,
      useConptyDll: true,
    });
    this.pid = this.#pty.pid;
    this.cols = this.#pty.cols;
    this.rows = this.#pty.rows;
    this.process = this.#pty.process;

    const unicode11Addon = new Unicode11Addon();
    this.#term = new xterm.Terminal({ allowProposedApi: true, rows, cols, scrollback: 100000 });
    this.#term.loadAddon(unicode11Addon);
    this.#term.loadAddon(this.#serializer);
    this.#term.unicode.activeVersion = "11";

    this.#term.parser.registerOscHandler(IsTermOscPs, (data) => this._handleIsSequence(data));
    for (const final of ["h", "l"]) {
      this.#term.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        if (params.includes(25)) this.cursorHidden = final === "l";
        return false;
      });
    }
    this.#commandManager = new CommandManager(this.#term, shell);
    this.#shell = shell;

    this.#ptyEmitter = new EventEmitter();
    this.#term.buffer.onBufferChange(() => {
      this.#alternateBufferOutput = true;
    });
    this.#pty.onData((data) => {
      this.#pendingData.push(data);
      this._parseData();
    });

    this.onData = (listener) => {
      this.#ptyEmitter.on(ISTermOnDataEvent, listener);
      return {
        dispose: () => this.#ptyEmitter.removeListener(ISTermOnDataEvent, listener),
      };
    };
    this.#pty.onExit((event) => {
      this.#pendingExit = event;
      this._parseData();
    });
    this.onExit = (listener) => {
      this.#ptyEmitter.on(ISTermOnExitEvent, listener);
      return { dispose: () => this.#ptyEmitter.removeListener(ISTermOnExitEvent, listener) };
    };
    this.onBeforeData = (listener) => {
      this.#ptyEmitter.on(ISTermBeforeDataEvent, listener);
      return { dispose: () => this.#ptyEmitter.removeListener(ISTermBeforeDataEvent, listener) };
    };
  }

  private _parseData(): void {
    if (this.#parsingData) return;
    if (this.#pendingData.length === 0) {
      if (this.#pendingExit) {
        const event = this.#pendingExit;
        this.#pendingExit = undefined;
        this.#ptyEmitter.emit(ISTermOnExitEvent, event);
      }
      return;
    }
    this.#parsingData = true;
    const data = this.#pendingData.shift()!;
    this.#ptyEmitter.emit(ISTermBeforeDataEvent);
    this.#alternateBufferOutput = this.isAlternateBuffer();
    this.#term.write(data, () => {
      log.debug({ msg: "parsing data", data });
      this.#commandManager.termSync();
      this.#ptyEmitter.emit(ISTermOnDataEvent, data);
      this.#parsingData = false;
      this._parseData();
    });
  }
  on(event: "data", listener: (data: string) => void): void;
  on(event: "exit", listener: (exitCode: number, signal?: number | undefined) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  on(_event: unknown, _listener: unknown): void {
    throw new Error("Method not implemented as deprecated in node-pty.");
  }

  private _deserializeIsMessage(message: string): string {
    return message.replaceAll(/\\(\\|x([0-9a-f]{2}))/gi, (_match: string, op: string, hex?: string) => (hex ? String.fromCharCode(parseInt(hex, 16)) : op));
  }

  private _sanitizedCwd(cwd: string): string {
    if (cwd.match(/^['"].*['"]$/)) {
      cwd = cwd.substring(1, cwd.length - 1);
    }
    // Convert a drive prefix to windows style when using Git Bash
    if (os.platform() === "win32" && this.#shell == Shell.Bash && cwd && cwd.match(/^\/[A-z]{1}\//)) {
      cwd = `${cwd[1]}:\\` + cwd.substring(3, cwd.length);
    }
    // Make the drive letter uppercase on Windows (see vscode #9448)
    if (os.platform() === "win32" && cwd && cwd[1] === ":") {
      return cwd[0].toUpperCase() + cwd.substring(1);
    }
    return cwd;
  }

  private _handleIsSequence(data: string): boolean {
    const argsIndex = data.indexOf(";");
    const sequence = argsIndex === -1 ? data : data.substring(0, argsIndex);
    switch (sequence) {
      case IstermOscPt.PromptStarted:
        this.#commandManager.handlePromptStart();
        break;
      case IstermOscPt.PromptEnded:
        this.#commandManager.handlePromptEnd();
        break;
      case IstermOscPt.CurrentWorkingDirectory: {
        const cwd = data.split(";").at(1);
        if (cwd != null) {
          this.cwd = path.resolve(this._sanitizedCwd(this._deserializeIsMessage(cwd)));
        }
        break;
      }
      default:
        return false;
    }
    return true;
  }

  resize(columns: number, rows: number) {
    this.cols = columns;
    this.rows = rows;
    this.#pty.resize(columns, rows);
    this.#term.resize(columns, rows);
  }

  clear() {
    this.#term.reset();
    this.#pty.clear();
  }

  kill(signal?: string) {
    this.#pty.kill(signal);
  }

  pause(): void {
    this.#pty.pause();
  }

  resume(): void {
    this.#pty.resume();
  }

  write(data: string, applicationInput = false): void {
    log.debug({ msg: "reading data", data, bytes: Uint8Array.from([...data].map((c) => c.charCodeAt(0))) });
    const code = data.length === 1 ? data.charCodeAt(0) : -1;
    if (process.platform === "win32" && code > 0 && code < 27 && ![8, 9, 10, 13].includes(code)) {
      // ConPTY needs a control modifier for apps reading Win32 key events.
      const key = code + 64;
      const scan = windowsControlScanCodes[code - 1];
      const unicode = applicationInput ? code : code + 96;
      this.#pty.write(`\x1b[${key};${scan};${unicode};1;8;1_\x1b[${key};${scan};${unicode};0;8;1_`);
      return;
    }
    this.#pty.write(data);
  }

  getCommandState(): CommandState {
    return this.#commandManager.getState();
  }

  getCursorState() {
    return {
      cursorX: this.#term.buffer.active.cursorX,
      cursorY: this.#term.buffer.active.cursorY,
      hidden: this.cursorHidden,
    };
  }

  isAlternateBuffer(): boolean {
    return this.#term.buffer.active.type === "alternate";
  }

  isAlternateBufferOutput(): boolean {
    return this.#alternateBufferOutput;
  }

  private _sameAccent(baseCell: ICellData | undefined, targetCell: ICellData | undefined) {
    return (
      baseCell?.isBold() == targetCell?.isBold() &&
      baseCell?.isItalic() == targetCell?.isItalic() &&
      baseCell?.isUnderline() == targetCell?.isUnderline() &&
      baseCell?.extended.underlineStyle == targetCell?.extended.underlineStyle &&
      baseCell?.hasExtendedAttrs() == targetCell?.hasExtendedAttrs() &&
      baseCell?.isInverse() == targetCell?.isInverse() &&
      baseCell?.isBlink() == targetCell?.isBlink() &&
      baseCell?.isInvisible() == targetCell?.isInvisible() &&
      baseCell?.isDim() == targetCell?.isDim() &&
      baseCell?.isStrikethrough() == targetCell?.isStrikethrough()
    );
  }

  private _getAnsiAccents(cell: ICellData | undefined): string {
    if (cell == null) return "";
    let underlineAnsi = "";
    if (cell.isUnderline()) {
      if (cell.hasExtendedAttrs() && cell.extended.underlineStyle) {
        underlineAnsi = `\x1b[4:${cell.extended.underlineStyle}m`;
      } else {
        underlineAnsi = "\x1b[4m";
      }
    }
    const boldAnsi = cell.isBold() ? "\x1b[1m" : "";
    const dimAnsi = cell.isDim() ? "\x1b[2m" : "";
    const italicAnsi = cell.isItalic() ? "\x1b[3m" : "";
    const blinkAnsi = cell.isBlink() ? "\x1b[5m" : "";
    const inverseAnsi = cell.isInverse() ? "\x1b[7m" : "";
    const invisibleAnsi = cell.isInvisible() ? "\x1b[8m" : "";
    const strikethroughAnsi = cell.isStrikethrough() ? "\x1b[9m" : "";

    return boldAnsi + italicAnsi + underlineAnsi + inverseAnsi + dimAnsi + blinkAnsi + invisibleAnsi + strikethroughAnsi;
  }

  private _sameColor(baseCell: ICellData | undefined, targetCell: ICellData | undefined) {
    return (
      baseCell?.getBgColorMode() == targetCell?.getBgColorMode() &&
      baseCell?.getBgColor() == targetCell?.getBgColor() &&
      baseCell?.getFgColorMode() == targetCell?.getFgColorMode() &&
      baseCell?.getFgColor() == targetCell?.getFgColor()
    );
  }

  private _getAnsiColors(cell: ICellData | undefined): string {
    if (cell == null) return "";
    let bgAnsi = "";
    if (cell.isBgDefault()) {
      bgAnsi = "\x1b[49m";
    } else if (cell.isBgPalette()) {
      bgAnsi = `\x1b[48;5;${cell.getBgColor()}m`;
    } else {
      const color = cell.getBgColor();
      bgAnsi = `\x1b[48;2;${color >> 16};${(color >> 8) & 255};${color & 255}m`;
    }

    let fgAnsi = "";
    if (cell.isFgDefault()) {
      fgAnsi = "\x1b[39m";
    } else if (cell.isFgPalette()) {
      fgAnsi = `\x1b[38;5;${cell.getFgColor()}m`;
    } else {
      const color = cell.getFgColor();
      fgAnsi = `\x1b[38;2;${color >> 16};${(color >> 8) & 255};${color & 255}m`;
    }
    return bgAnsi + fgAnsi;
  }

  clearCommand() {
    this.#commandManager.clearActiveCommand();
  }

  getSnapshot(): string {
    return this.#serializer.serialize({ excludeModes: true, excludeAltBuffer: true });
  }

  getPatch(startY: number, height: number, patches: ISTermPatch[] = []): string {
    const viewportStart = this.#term.buffer.active.baseY;
    const viewportEnd = this.#term.buffer.active.baseY + this.#term.rows - 1;
    const writeLine = (y: number, patch?: ISTermPatch): string => {
      if (y < viewportStart || y > viewportEnd) return "";
      const line = this.#term.buffer.active.getLine(y);
      const hasPatch = patch != null;
      const ansiPrePatch = [ansi.resetColor, ansi.resetLine];
      const ansiPostPatch = hasPatch ? [ansi.resetColor] : [];
      if (line == null) return "";

      let prevCell: ICellData | undefined;
      let ansiLine = ansiPrePatch;
      let blankCellCount = 0;
      const flushBlankCells = () => {
        if (blankCellCount == 0) return;
        ansiLine.push(ansi.cursorForward(blankCellCount));
        blankCellCount = 0;
      };

      const patchStartX = patch?.startX ?? 0;
      const patchEndX = (patch?.startX ?? 0) + (patch?.length ?? 0);
      for (let x = 0; x < line.length; x++) {
        if (hasPatch && x >= patchStartX && x < patchEndX) {
          flushBlankCells();
          prevCell = undefined;
          ansiLine = ansiPostPatch;
          continue;
        }

        const cell = line.getCell(x) as unknown as ICellData | undefined;
        const chars = cell?.getChars() ?? "";

        const sameColor = this._sameColor(prevCell, cell);
        const sameAccents = this._sameAccent(prevCell, cell);
        if (!sameColor || !sameAccents) {
          flushBlankCells();
          ansiLine.push(ansi.resetColor);
        }
        if (!sameColor) {
          ansiLine.push(this._getAnsiColors(cell));
        }
        if (!sameAccents) {
          ansiLine.push(this._getAnsiAccents(cell));
        }
        const isWide = prevCell?.getWidth() == 2 && cell?.getWidth() == 0;
        if (chars == "") {
          if (!isWide) blankCellCount++;
        } else {
          flushBlankCells();
          ansiLine.push(chars);
        }
        prevCell = cell;
      }
      flushBlankCells();
      return [ansiPrePatch.join(""), patch?.data ?? "", ansiPostPatch.join("")].join("");
    };

    const lines: string[] = [];
    for (let y = Math.max(startY, 0); y < Math.min(startY + height, this.rows); y++) {
      lines.push(writeLine(viewportStart + y, patches[y - startY]));
    }
    return lines.join(ansi.cursorNextLine);
  }
}

export const spawn = async (program: Command, options: ISTermOptions): Promise<ISTerm> => {
  const { shellTarget, shellArgs } = await convertToPtyTarget(options.shell, options.underTest, options.login);
  if (!(await shellExists(shellTarget))) {
    program.error(`shell not found on PATH: ${shellTarget}`, { exitCode: 1 });
  }
  return new ISTerm({ ...options, shellTarget, shellArgs });
};

const shellExists = async (shellTarget: string): Promise<boolean> => {
  const fileExists = fs.existsSync(shellTarget);
  const fileOnPath = await which(shellTarget, { nothrow: true });
  return fileExists || fileOnPath != null;
};

const convertToPtyTarget = async (shell: Shell, underTest: boolean, login: boolean) => {
  const platform = os.platform();
  const shellTarget = shell == Shell.Bash && platform == "win32" ? await gitBashPath() : platform == "win32" ? `${shell}.exe` : shell;
  let shellArgs: string[] = [];

  switch (shell) {
    case Shell.Bash:
      shellArgs = ["--init-file", path.join(shellResourcesPath, "shellIntegration.bash")];
      break;
    case Shell.Powershell:
    case Shell.Pwsh:
      shellArgs = [
        "-noexit",
        "-command",
        `${underTest ? "Import-Module PSReadLine; " : ""}try { . "${path.join(shellResourcesPath, "shellIntegration.ps1")}" } catch {}`,
      ];
      if (underTest) shellArgs.unshift("-NoProfile");
      break;
    case Shell.Fish:
      shellArgs =
        platform == "win32"
          ? ["--init-command", `. "$(cygpath -u '${path.join(shellResourcesPath, "shellIntegration.fish")}')"`]
          : ["--init-command", `. ${path.join(shellResourcesPath, "shellIntegration.fish").replace(/(\s+)/g, "\\$1")}`];
      break;
    case Shell.Xonsh: {
      const sharedConfig = os.platform() == "win32" ? path.join("C:\\ProgramData", "xonsh", "xonshrc") : path.join("etc", "xonsh", "xonshrc");
      const userConfigs = [
        path.join(os.homedir(), ".xonshrc"),
        path.join(os.homedir(), ".config", "xonsh", "rc.xsh"),
        path.join(os.homedir(), ".config", "xonsh", "rc.d"),
      ];
      const configs = [sharedConfig, ...userConfigs].filter((config) => fs.existsSync(config));
      shellArgs = ["--rc", ...configs, path.join(shellResourcesPath, "shellIntegration.xsh")];
      break;
    }
    case Shell.Nushell:
      shellArgs = ["-e", `source \`${path.join(shellResourcesPath, "shellIntegration.nu")}\``];
      if (underTest) shellArgs.push("-n");
      break;
  }

  if (login) {
    switch (shell) {
      case Shell.Powershell:
      case Shell.Pwsh:
        shellArgs.unshift("-login");
        break;
      case Shell.Zsh:
      case Shell.Fish:
      case Shell.Xonsh:
      case Shell.Nushell:
        shellArgs.unshift("--login");
        break;
    }
  }

  return { shellTarget, shellArgs };
};

const convertToPtyEnv = (shell: Shell, underTest: boolean, login: boolean) => {
  const env: Record<string, string> = {
    ...process.env,
    ISTERM: "1",
  };
  if (underTest) env.ISTERM_TESTING = "1";
  if (login) env.ISTERM_LOGIN = "1";

  switch (shell) {
    case Shell.Cmd: {
      if (underTest) {
        return { ...env, PROMPT: `${IstermPromptStart}$G ${IstermPromptEnd}` };
      }
      const prompt = process.env.PROMPT ? process.env.PROMPT : "$P$G";
      return { ...env, PROMPT: `${IstermPromptStart}${prompt}${IstermPromptEnd}` };
    }
    case Shell.Zsh: {
      return { ...env, ZDOTDIR: zdotdir(underTest), USER_ZDOTDIR: userZdotdir };
    }
  }

  return env;
};
