// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import process from "node:process";
import find from "find-process";
import path from "node:path";
import which from "which";
import fs from "node:fs";
import os from "node:os";
import fsAsync from "node:fs/promises";
import util from "node:util";
import { shellResourcesPath, initResourcesPath } from "./constants.js";
import childProcess from "node:child_process";
import { KeyPressEvent } from "../ui/suggestionManager.js";
import log from "./log.js";
import sea from "node:sea";
import { fileURLToPath } from "node:url";

const exec = util.promisify(childProcess.exec);
const safeExec = async (command: string, options?: childProcess.ExecOptions) => {
  const defaultOptions: childProcess.ExecOptions = { timeout: 500, env: { ISTERM: "1" } };
  try {
    const { stdout, stderr } = await exec(command, { ...defaultOptions, ...options });
    return { stdout, stderr };
  } catch (e) {
    log.debug({ msg: `error executing exec command: ${e}` });
    return { stdout: undefined, stderr: undefined };
  }
};

export enum Shell {
  Sh = "sh",
  Bash = "bash",
  Powershell = "powershell",
  Pwsh = "pwsh",
  Zsh = "zsh",
  Fish = "fish",
  Cmd = "cmd",
  Xonsh = "xonsh",
  Nushell = "nu",
}

export const supportedShells = [
  process.platform !== "win32" ? Shell.Sh : null,
  Shell.Bash,
  process.platform == "win32" ? Shell.Powershell : null,
  Shell.Pwsh,
  Shell.Zsh,
  Shell.Fish,
  process.platform == "win32" ? Shell.Cmd : null,
  Shell.Xonsh,
  Shell.Nushell,
].filter((shell) => shell != null) as Shell[];

export const initSupportedShells = supportedShells.filter((shell) => shell != Shell.Cmd);
export const aliasSupportedShells = [Shell.Bash, Shell.Zsh];

export const userZdotdir = process.env?.ZDOTDIR ?? os.homedir() ?? `~`;
let zshDotdir: string | undefined;
export const zdotdir = () => {
  if (!zshDotdir) {
    zshDotdir = fs.mkdtempSync(path.join(os.tmpdir(), "inshellisense2-zsh-"));
    const directory = zshDotdir;
    process.once("exit", () => fs.rmSync(directory, { recursive: true, force: true }));
  }
  return zshDotdir;
};

export const getProfilePath = async (shell: Shell): Promise<string | undefined> => {
  switch (shell) {
    case Shell.Sh:
      return path.join(os.homedir(), ".profile");
    case Shell.Bash:
      return path.join(os.homedir(), ".bashrc");
    case Shell.Powershell:
    case Shell.Pwsh:
      try {
        const { stdout } = await util.promisify(childProcess.execFile)(shell, ["-NoProfile", "-NonInteractive", "-Command", "$PROFILE.CurrentUserAllHosts"], {
          timeout: 5_000,
        });
        return stdout.trim();
      } catch {
        return undefined;
      }
    case Shell.Zsh:
      return path.join(userZdotdir, ".zshrc");
    case Shell.Fish:
      return path.join(os.homedir(), ".config", "fish", "config.fish");
    case Shell.Xonsh:
      return path.join(os.homedir(), ".xonshrc");
    case Shell.Nushell:
      return (await safeExec(`echo $nu.env-path`, { shell, timeout: 5_000 })).stdout?.toString()?.trim();
  }
};

export const createShellConfigs = async (profileShell?: Shell, customProfile?: string) => {
  for (const shell of supportedShells) {
    const shellConfigName = getShellConfigName(shell);
    if (shellConfigName == null) continue;
    await fsAsync.mkdir(path.join(initResourcesPath, shell), { recursive: true });
    await fsAsync.writeFile(path.join(initResourcesPath, shell, shellConfigName), getShellConfig(shell, shell === profileShell ? customProfile : undefined));
  }
};

const getShellConfigName = (shell: Shell) => {
  switch (shell) {
    case Shell.Sh:
    case Shell.Bash:
      return "init.sh";
    case Shell.Powershell:
    case Shell.Pwsh:
      return "init.ps1";
    case Shell.Zsh:
      return "init.zsh";
    case Shell.Fish:
      return "init.fish";
    case Shell.Xonsh:
      return "init.xsh";
    case Shell.Nushell:
      return "init.nu";
    default:
      return undefined;
  }
};

export const setupZshDotfiles = async () => {
  const dir = zdotdir();
  await fsAsync.cp(path.join(shellResourcesPath, "shellIntegration-rc.zsh"), path.join(dir, ".zshrc"), { force: true });
  await fsAsync.cp(path.join(shellResourcesPath, "shellIntegration-profile.zsh"), path.join(dir, ".zprofile"), { force: true });
  await fsAsync.cp(path.join(shellResourcesPath, "shellIntegration-env.zsh"), path.join(dir, ".zshenv"), { force: true });
  await fsAsync.cp(path.join(shellResourcesPath, "shellIntegration-login.zsh"), path.join(dir, ".zlogin"), { force: true });
};

const findParentProcess = async () => {
  try {
    return (await find("pid", process.ppid)).at(0);
  } catch (e) {
    log.debug({ msg: `error finding parent process: ${e}` });
  }
};

export const inferShell = async () => {
  // try getting shell from shell specific env variables
  if (process.env.NU_VERSION != null) {
    return Shell.Nushell;
  } else if (process.env.XONSHRC != null) {
    return Shell.Xonsh;
  } else if (process.env.FISH_VERSION != null) {
    return Shell.Fish;
  } else if (process.env.ZSH_VERSION != null) {
    return Shell.Zsh;
  } else if (process.env.BASH_VERSION != null) {
    return Shell.Bash;
  }

  // try getting shell from env
  try {
    const name = path.parse(process.env.SHELL ?? "").name;
    const shellName = supportedShells.find((shell) => name === shell);
    if (shellName) return shellName;
  } catch {
    /* empty */
  }

  // try getting shell from parent process
  const processResult = await findParentProcess();
  const name = processResult?.name;
  return name != null ? supportedShells.find((shell) => path.parse(name).name === shell) : undefined;
};

export const gitBashPath = async (): Promise<string> => {
  const gitBashPaths = await getGitBashPaths();
  for (const gitBashPath of gitBashPaths) {
    if (fs.existsSync(gitBashPath)) {
      return gitBashPath;
    }
  }
  throw new Error("unable to find a git bash executable installed");
};

const getGitBashPaths = async (): Promise<string[]> => {
  const gitDirs: Set<string> = new Set();

  const gitExePath = await which("git.exe", { nothrow: true });
  if (gitExePath) {
    const gitExeDir = path.dirname(gitExePath);
    gitDirs.add(path.resolve(gitExeDir, "../.."));
  }

  const addValid = <T>(set: Set<T>, value: T | undefined) => {
    if (value) set.add(value);
  };

  // Add common git install locations
  addValid(gitDirs, process.env["ProgramW6432"]);
  addValid(gitDirs, process.env["ProgramFiles"]);
  addValid(gitDirs, process.env["ProgramFiles(X86)"]);
  addValid(gitDirs, `${process.env["LocalAppData"]}\\Program`);

  const gitBashPaths: string[] = [];
  for (const gitDir of gitDirs) {
    gitBashPaths.push(
      `${gitDir}\\Git\\bin\\bash.exe`,
      `${gitDir}\\Git\\usr\\bin\\bash.exe`,
      `${gitDir}\\usr\\bin\\bash.exe`, // using Git for Windows SDK
    );
  }

  // Add special installs that don't follow the standard directory structure
  gitBashPaths.push(`${process.env["UserProfile"]}\\scoop\\apps\\git\\current\\bin\\bash.exe`);
  gitBashPaths.push(`${process.env["UserProfile"]}\\scoop\\apps\\git-with-openssh\\current\\bin\\bash.exe`);

  return gitBashPaths;
};

export const getBackspaceSequence = (press: KeyPressEvent, shell: Shell) =>
  shell === Shell.Pwsh || shell === Shell.Powershell || shell === Shell.Cmd || shell === Shell.Nushell ? "\u007F" : press[1].sequence;

export const getPathSeparator = (shell: Shell) => (shell == Shell.Bash || shell == Shell.Xonsh || shell == Shell.Nushell ? "/" : path.sep);

const getPathSeparators = (shell: Shell) => (getPathSeparator(shell) === "\\" ? ["\\", "/"] : ["/"]);

export const containsPathSeparator = (dir: string, shell: Shell) => getPathSeparators(shell).some((separator) => dir.includes(separator));

export const removePathSeparator = (dir: string) => {
  return dir.endsWith("/") || dir.endsWith("\\") ? dir.slice(0, -1) : dir;
};

export const addPathSeparator = (dir: string, shell: Shell) => {
  const pathSep = getPathSeparator(shell);
  return dir.endsWith(pathSep) ? dir : dir + pathSep;
};

export const getPathDirname = (dir: string, shell: Shell) => {
  return endsWithPathSeparator(dir, shell) || path.dirname(dir) == "." ? dir : addPathSeparator(path.dirname(dir), shell);
};

export const endsWithPathSeparator = (dir: string, shell: Shell) => getPathSeparators(shell).some((separator) => dir.endsWith(separator));

// nu fully re-writes the prompt every keystroke resulting in duplicate start/end sequences on the same line & re-writes the prompt after accepting a command
// xonsh re-writes the prompt after accepting a command
export const getShellPromptRewrites = (shell: Shell) => shell == Shell.Nushell || shell == Shell.Xonsh;

export const getShellSourceCommand = (shell: Shell): string => {
  switch (shell) {
    case Shell.Sh:
      return `. "$HOME/.inshellisense2/init/sh/init.sh"`;
    case Shell.Bash:
      return `[ -f ~/.inshellisense2/init/bash/init.sh ] && source ~/.inshellisense2/init/bash/init.sh`;
    case Shell.Powershell:
    case Shell.Pwsh:
      return `if (Test-Path '${path.join(initResourcesPath, shell, "init.ps1").replaceAll("'", "''")}' -PathType Leaf) { . '${path
        .join(initResourcesPath, shell, "init.ps1")
        .replaceAll("'", "''")}' }`;
    case Shell.Zsh:
      return `[[ -f ~/.inshellisense2/init/zsh/init.zsh ]] && source ~/.inshellisense2/init/zsh/init.zsh`;
    case Shell.Fish:
      return `test -f ~/.inshellisense2/init/fish/init.fish && source ~/.inshellisense2/init/fish/init.fish`;
    case Shell.Xonsh:
      return `p"~/.inshellisense2/init/xonsh/init.xsh".exists() && source "~/.inshellisense2/init/xonsh/init.xsh"`;
    case Shell.Nushell:
      return `if ( '~/.inshellisense2/init/nu/init.nu' | path exists ) { source ~/.inshellisense2/init/nu/init.nu }`;
  }
  return "";
};

export const getShellConfig = (shell: Shell, customProfile?: string): string => {
  const quote = (value: string) => `'${value.replaceAll("'", shell === Shell.Pwsh || shell === Shell.Powershell ? "''" : "'\\''")}'`;
  const executable = sea.isSea() ? quote(process.execPath) : `${quote(process.execPath)} ${quote(fileURLToPath(new URL("../index.js", import.meta.url)))}`;
  switch (shell) {
    case Shell.Zsh:
      return `case ":$PATH:" in *:${quote(path.dirname(process.execPath))}:*) ;; *) export PATH=${quote(path.dirname(process.execPath))}:$PATH ;; esac
if [[ -z "\${ISTERM}" && $- = *i* && $- != *c* && -t 0 && -t 1 && -t 2 && -z "\${VSCODE_RESOLVING_ENVIRONMENT}" ]]; then
  if [[ -o login ]]; then
    exec ${executable} -s zsh --login
  else
    exec ${executable} -s zsh
  fi
fi`;
    case Shell.Sh:
      return `case ":$PATH:" in *:${quote(path.dirname(process.execPath))}:*) ;; *) export PATH=${quote(path.dirname(process.execPath))}:$PATH ;; esac
case "$-" in
  *i*)
    if [ "\${0##*/}" != sh ] && [ "\${0##*/}" != -sh ]; then return; fi
    if [ -z "\${ISTERM:-}" ] && [ -t 0 ] && [ -t 1 ] && [ -t 2 ] && [ -z "\${VSCODE_RESOLVING_ENVIRONMENT:-}" ]; then
      if [ "\${INSHELLISENSE2_SH_LOGIN:-}" = 1 ]; then
        unset INSHELLISENSE2_SH_LOGIN
        exec ${executable} -s sh --login
      fi
      case "$0" in
        -*) exec ${executable} -s sh --login ;;
        *) exec ${executable} -s sh ;;
      esac
    fi
    ;;
esac`;
    case Shell.Bash:
      return `case ":$PATH:" in *:${quote(path.dirname(process.execPath))}:*) ;; *) export PATH=${quote(path.dirname(process.execPath))}:$PATH ;; esac
if [[ -n "\${BASH_VERSION}" && -z "\${ISTERM}" && $- = *i* && $- != *c* && -t 0 && -t 1 && -t 2 && -z "\${VSCODE_RESOLVING_ENVIRONMENT}" ]]; then
  if shopt -q login_shell; then
    exec ${executable} -s bash --login
  else
    exec ${executable} -s bash
  fi 
fi`;
    case Shell.Powershell:
    case Shell.Pwsh:
      return `if (${quote(path.dirname(process.execPath))} -notin ($env:PATH -split [regex]::Escape([IO.Path]::PathSeparator))) { $env:PATH = ${quote(
        path.dirname(process.execPath),
      )} + [IO.Path]::PathSeparator + $env:PATH }
$__IsCommandFlag = ([Environment]::GetCommandLineArgs() | Where-Object { $_ -imatch '^-(c(ommand)?|e(ncodedcommand)?|f(ile)?|noni(nteractive)?)$' }).Count -gt 0
$__IsNoExitFlag = ([Environment]::GetCommandLineArgs() | Where-Object { $_ -imatch '^-noe(xit)?$' }).Count -gt 0
$__IsInteractive = -not $__IsCommandFlag -or ($__IsCommandFlag -and $__IsNoExitFlag)
if ([string]::IsNullOrEmpty($env:ISTERM) -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected -and ([Environment]::UserInteractive -or $env:SSH_TTY) -and $__IsInteractive -and [string]::IsNullOrEmpty($env:VSCODE_RESOLVING_ENVIRONMENT)) {
  ${customProfile ? `$env:INSHELLISENSE2_PS_PROFILE = ${quote(path.resolve(customProfile))}` : ""}
  & ${executable} -s ${shell}
  exit $LASTEXITCODE
}`;
    case Shell.Fish:
      return `if test -z "$ISTERM" && status --is-interactive && test -z "$VSCODE_RESOLVING_ENVIRONMENT"
  if status --is-login
    ${executable} -s fish --login ; kill %self
  else
    ${executable} -s fish ; kill %self
  end 
end`;
    case Shell.Xonsh:
      return `if 'ISTERM' not in \${...} and $XONSH_INTERACTIVE and 'VSCODE_RESOLVING_ENVIRONMENT' not in \${...}:
    if $XONSH_LOGIN:
        ${executable} -s xonsh --login ; exit
    else:
        ${executable} -s xonsh ; exit`;
    case Shell.Nushell:
      return `if "ISTERM" not-in $env and $nu.is-interactive and "VSCODE_RESOLVING_ENVIRONMENT" not-in $env {
    if $nu.is-login { ${executable} -s nu --login ; exit } else { ${executable} -s nu ; exit }
}`;
  }
  return "";
};
