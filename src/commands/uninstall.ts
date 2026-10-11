// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { render } from "../ui/ui-uninstall.js";

const action = async (options: { profile?: string }) => {
  await render(options.profile);
};

const cmd = new Command("uninstall");
cmd.description(`removes automatic startup and cache resources for inshellisense2`);
cmd.option("--profile <path>", "remove startup from a custom profile");
cmd.action(action);

export default cmd;
