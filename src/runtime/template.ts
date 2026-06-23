// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import fsAsync from "node:fs/promises";
import log from "../utils/log.js";

const hiddenLast = (a: { name?: string }, b: { name?: string }): number => {
  const aName = a.name ?? "";
  const bName = b.name ?? "";
  if (aName === ".." || bName === "..") return aName === ".." ? -1 : 1;
  const aHidden = aName.startsWith(".");
  const bHidden = bName.startsWith(".");
  if (aHidden !== bHidden) return aHidden ? 1 : -1;
  return aName.localeCompare(bName);
};

const filepathsTemplate = async (cwd: string, signal?: AbortSignal): Promise<Fig.TemplateSuggestion[]> => {
  signal?.throwIfAborted();
  const files = await fsAsync.readdir(cwd, { withFileTypes: true });
  return [{ name: "..", priority: 56, context: { templateType: "filepaths" }, type: "folder" } as Fig.TemplateSuggestion]
    .concat(
      files
        .filter((f) => f.isFile() || f.isDirectory())
        .sort(hiddenLast)
        .map((f) => ({ name: f.name, priority: 55, context: { templateType: "filepaths" }, type: f.isDirectory() ? "folder" : "file" })),
    )
    .sort(hiddenLast);
};

const foldersTemplate = async (cwd: string, signal?: AbortSignal): Promise<Fig.TemplateSuggestion[]> => {
  signal?.throwIfAborted();
  const files = await fsAsync.readdir(cwd, { withFileTypes: true });
  return [{ name: "..", priority: 56, context: { templateType: "folders" }, type: "folder" } as Fig.TemplateSuggestion]
    .concat(
      files
        .filter((f) => f.isDirectory())
        .sort(hiddenLast)
        .map((f) => ({
          name: f.name,
          priority: 55,
          context: { templateType: "folders" },
          type: "folder",
        })),
    )
    .sort(hiddenLast);
};

// TODO: implement history template
const historyTemplate = (): Fig.TemplateSuggestion[] => {
  return [];
};

// TODO: implement help template
const helpTemplate = (): Fig.TemplateSuggestion[] => {
  return [];
};

export const runTemplates = async (template: Fig.TemplateStrings[] | Fig.Template, cwd: string, signal?: AbortSignal): Promise<Fig.TemplateSuggestion[]> => {
  const templates = template instanceof Array ? template : [template];
  return (
    await Promise.all(
      templates.map(async (t) => {
        try {
          switch (t) {
            case "filepaths":
              return await filepathsTemplate(cwd, signal);
            case "folders":
              return await foldersTemplate(cwd, signal);
            case "history":
              return historyTemplate();
            case "help":
              return helpTemplate();
          }
        } catch (e) {
          log.debug({ msg: "template failed", e, template: t, cwd });
          return [];
        }
      }),
    )
  ).flat();
};
