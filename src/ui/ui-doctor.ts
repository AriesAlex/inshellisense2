// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { checkUnpackedVersion } from "../utils/node.js";
import { getVersion } from "../utils/version.js";
import { allResourcesPath } from "../utils/constants.js";

export const render = async () => {
  const ready = await checkUnpackedVersion();
  process.stdout.write(`inshellisense2 ${getVersion()} (${process.platform}-${process.arch})\n`);
  process.stdout.write(`Resources: ${allResourcesPath} — ${ready ? "ready" : "out of date"}\n`);
  if (!ready) {
    process.stderr.write("Run inshellisense2 init to refresh resources.\n");
    process.exitCode = 1;
  }
};
