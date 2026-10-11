// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import chalk from "chalk";
import { unpackResources } from "../utils/node.js";
import { createShellConfigs } from "../utils/shell.js";
import {
  shellResourcesPath,
  nativeResourcesPath,
  loggingResourcesPath,
  initResourcesPath,
  specResourcesPath,
  versionResourcePath,
} from "../utils/constants.js";
import fs from "node:fs";

export const render = async () => {
  if (process.platform === "win32" && process.env.ISTERM) {
    throw new Error("Close inshellisense2 terminals and run reinit from PowerShell -NoProfile to release native modules.");
  }
  fs.rmSync(shellResourcesPath, { recursive: true, force: true });
  fs.rmSync(nativeResourcesPath, { recursive: true, force: true });
  fs.rmSync(loggingResourcesPath, { recursive: true, force: true });
  fs.rmSync(initResourcesPath, { recursive: true, force: true });
  fs.rmSync(specResourcesPath, { recursive: true, force: true });
  fs.rmSync(versionResourcePath, { force: true });
  process.stdout.write(chalk.green("✓") + " removed old inshellisense2 resources \n");

  await createShellConfigs();
  await unpackResources();

  process.stdout.write(chalk.green("✓") + " successfully installed inshellisense2 \n");
};
