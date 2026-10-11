// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import chalk from "chalk";
import { deleteCacheFolder } from "../utils/config.js";
import { removeShellProfiles } from "../utils/profile.js";

export const render = async (profile?: string) => {
  await removeShellProfiles(profile);
  try {
    deleteCacheFolder();
  } catch (error) {
    if (!["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    process.stdout.write("Removed automatic shell startup. Close inshellisense2 terminals, then run uninstall again to remove locked cache files.\n");
    return;
  }
  process.stdout.write(chalk.green("✓") + " successfully deleted the .inshellisense2 cache folder \n");
  process.stdout.write("Removed automatic shell startup. You can now delete the inshellisense2 executable.\n");
};
