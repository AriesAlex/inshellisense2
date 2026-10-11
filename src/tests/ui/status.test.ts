// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { test, expect, Shell } from "@microsoft/tui-test";
import os from "node:os";

const shell = os.platform() == "darwin" ? Shell.Zsh : os.platform() == "linux" ? Shell.Bash : Shell.Powershell;

test.describe("status checks", () => {
  test.describe("inside inshellisense2 session", () => {
    test.use({ program: { file: "inshellisense2", args: ["-T", "-s", shell] } });

    test("current status", async ({ terminal }) => {
      await expect(terminal.getByText(">  ")).toBeVisible({ timeout: 30_000 });

      terminal.write("inshellisense2 -c\r");
      await expect(terminal.getByText("live")).toBeVisible();
      await expect(terminal.getByText("live")).toHaveFgColor(2);
    });
  });

  test.describe("outside inshellisense2 session", () => {
    test("current status", async ({ terminal }) => {
      await expect(terminal.getByText(">  ")).toBeVisible();

      terminal.write("inshellisense2 -c\r");
      await expect(terminal.getByText("not found")).toBeVisible();
      await expect(terminal.getByText("not found")).toHaveFgColor(1);
    });
  });
});
