// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { jest } from "@jest/globals";

const mockSpawn = jest.fn();

jest.unstable_mockModule("node:child_process", () => ({
  default: { exec: jest.fn() },
  spawn: mockSpawn,
}));

const { buildExecuteShellCommand } = await import("../../runtime/utils.js");

test("isolates completion helpers from the controlling terminal on Unix", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: jest.fn(),
  }) as unknown as ChildProcessWithoutNullStreams;
  mockSpawn.mockImplementation(() => {
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });

  await buildExecuteShellCommand(5_000)({ command: "helper", args: ["arg"], cwd: process.cwd() });

  expect(mockSpawn).toHaveBeenCalledWith(
    "helper",
    ["arg"],
    expect.objectContaining({
      detached: process.platform !== "win32",
    }),
  );
});
