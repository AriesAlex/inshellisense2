// Copyright (c) inshellisense2 contributors.
// Licensed under the MIT License.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Shell, getProfilePath, getShellSourceCommand } from "./shell.js";

const begin = "# >>> inshellisense2 >>>";
const end = "# <<< inshellisense2 <<<";

const getStartupProfiles = async (shell: Shell, customProfile?: string) => {
  if (![Shell.Sh, Shell.Bash, Shell.Zsh, Shell.Pwsh, Shell.Powershell].includes(shell)) {
    throw new Error(`Automatic profile installation does not support ${shell}. Use the source command printed by init ${shell}.`);
  }
  const profile = customProfile ?? (await getProfilePath(shell));
  if (!profile) throw new Error(`Cannot locate the ${shell} profile`);
  const profiles = [profile];
  if (shell === Shell.Bash && !customProfile) {
    const candidates = [".bash_profile", ".bash_login", ".profile"].map((name) => path.join(os.homedir(), name));
    let loginProfile = candidates[2];
    for (const candidate of candidates) {
      if (
        await fs.stat(candidate).then(
          () => true,
          () => false,
        )
      ) {
        loginProfile = candidate;
        break;
      }
    }
    profiles.push(loginProfile);
  }

  return profiles;
};

export const installShellProfile = async (shell: Shell, customProfile?: string) => {
  const profiles = await getStartupProfiles(shell, customProfile);
  let source = getShellSourceCommand(shell);
  if (shell === Shell.Sh) {
    source = `if [ -z "\${ISTERM:-}" ]; then
  if [ "\${ENV:-}" != "$HOME/.inshellisense2/init/sh/init.sh" ]; then
    INSHELLISENSE2_SH_ENV=\${ENV:-}
    export INSHELLISENSE2_SH_ENV
  fi
  ENV="$HOME/.inshellisense2/init/sh/init.sh"
  export ENV
  INSHELLISENSE2_SH_LOGIN=1
  ${source}
  unset INSHELLISENSE2_SH_LOGIN
fi`;
  }
  for (const destination of profiles) {
    const current = await fs.readFile(destination, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    if (current.includes(begin) !== current.includes(end)) throw new Error(`Incomplete inshellisense2 block in ${destination}`);
    const body = current.replace(/^\uFEFF/, "").replace(/# >>> inshellisense2 >>>[\s\S]*?# <<< inshellisense2 <<<\r?\n(?:\r?\n)?/g, "");
    const newline = current.includes("\r\n") ? "\r\n" : "\n";
    const block = `${begin}\n${source}\n${end}\n\n`.replaceAll("\n", newline);
    const bom = shell === Shell.Powershell || current.startsWith("\uFEFF") ? "\uFEFF" : "";
    const next = bom + block + body;
    if (next !== current) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, next, "utf8");
    }
    process.stdout.write(`Configured ${destination}\n`);
  }
};

export const removeShellProfiles = async (customProfile?: string) => {
  const shells = process.platform === "win32" ? [Shell.Pwsh, Shell.Powershell] : [Shell.Sh, Shell.Bash, Shell.Zsh, Shell.Pwsh];
  const profiles = new Set<string>();
  if (customProfile) profiles.add(customProfile);
  else
    for (const shell of shells) {
      const profile = await getProfilePath(shell);
      if (profile) for (const destination of await getStartupProfiles(shell)) profiles.add(destination);
    }
  for (const destination of profiles) {
    const current = await fs.readFile(destination, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    const next = current.replace(/# >>> inshellisense2 >>>[\s\S]*?# <<< inshellisense2 <<<\r?\n(?:\r?\n)?/g, "");
    if (next !== current) await fs.writeFile(destination, next, "utf8");
  }
};
