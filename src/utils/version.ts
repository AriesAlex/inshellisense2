// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bundledVersion = "__VERSION__";

export const getVersion = (): string => {
  if (!bundledVersion.startsWith("__")) return bundledVersion;

  const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"));
  return packageJson.version;
};
