// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { createShellConfigs, initSupportedShells as shells, getShellSourceCommand, Shell } from "../utils/shell.js";
import { unpackResources } from "../utils/node.js";
import { render } from "../ui/ui-init.js";
import { installShellProfile } from "../utils/profile.js";
import { inferShell } from "../utils/shell.js";

const supportedShells = shells.join(", ");

const action = (program: Command) => async (shell: string | undefined, options: { install?: boolean; profile?: string }) => {
  if (options.install && shell == null) shell = await inferShell();
  if (options.profile && !options.install) program.error("--profile requires --install");
  if (shell != null && !shells.map((s) => s.valueOf()).includes(shell)) {
    program.error(`Unsupported shell: '${shell}', supported shells: ${supportedShells}`, { exitCode: 1 });
  }
  if (options.install && shell == null) program.error("Cannot identify your shell. Run inshellisense2 init <shell> --install.");
  await createShellConfigs(shell as Shell | undefined, options.profile);
  await unpackResources();

  if (shell == null) {
    await render();
    return;
  }
  if (options.install) {
    await installShellProfile(shell as Shell, options.profile);
    return;
  }
  const config = getShellSourceCommand(shell as Shell);
  process.stdout.write(`\n\n${config}\n`);
};

const cmd = new Command("init");
cmd.description(`generates shell configurations & prints the source command for a specified shell`);
cmd.argument("[shell]", `shell to generate plugin for, supported shells: ${supportedShells}`);
cmd.option("--install", "automatically configure the shell's startup profile");
cmd.option("--profile <path>", "use a custom startup profile with --install");
cmd.action(action(cmd));

export default cmd;
