// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Suggestion, SuggestionBlob } from "../runtime/model.js";
import { getSuggestions } from "../runtime/runtime.js";
import type { ISTerm, ISTermPatch } from "../isterm/pty.js";
import { renderBox, truncateText, truncateMultilineText } from "./utils.js";
import chalk from "chalk";
import { Shell } from "../utils/shell.js";
import log from "../utils/log.js";
import { getConfig } from "../utils/config.js";
import { calculateReplacement, applyReplacement } from "../runtime/replacement.js";

const getMaxSuggestions = () => getConfig().maxSuggestions ?? 5;
const suggestionWidth = 40;
const descriptionWidth = 30;
const descriptionHeight = 5;
const borderWidth = 2;
const activeSuggestionBackgroundColor = "#7D56F4";
export const getMaxLines = () => borderWidth + Math.max(getMaxSuggestions(), descriptionHeight);

export type KeyPressEvent = [string | null | undefined, KeyPress];

type KeyPress = {
  sequence: string;
  name: string;
  ctrl: boolean;
  shift: boolean;
};

export class SuggestionManager {
  #term: ISTerm;
  #command: string;
  #activeSuggestionIdx: number;
  #suggestBlob?: SuggestionBlob;
  #shell: Shell;
  #hideSuggestions: boolean = false;
  #abortController?: AbortController;

  constructor(terminal: ISTerm, shell: Shell) {
    this.#term = terminal;
    this.#suggestBlob = { suggestions: [] };
    this.#command = "";
    this.#activeSuggestionIdx = 0;
    this.#shell = shell;
  }

  private async _loadSuggestions(): Promise<void> {
    const commandState = this.#term.getCommandState();
    const commandText = commandState.commandText;
    if (!commandText) {
      this.#command = "";
    }
    if (!commandText || this.#hideSuggestions || commandState.hasOutput) {
      this.#abortController?.abort();
      this.#suggestBlob = undefined;
      this.#activeSuggestionIdx = 0;
      return;
    }
    if (commandText == this.#command) {
      return;
    }
    this.#abortController?.abort();
    const controller = new AbortController();
    this.#abortController = controller;
    try {
      const suggestionBlob = await getSuggestions(commandText, this.#term.cwd, this.#shell, controller.signal);
      if (controller.signal.aborted || this.#term.getCommandState().commandText !== commandText) return;
      this.#command = commandText;
      this.#suggestBlob = suggestionBlob;
      this.#activeSuggestionIdx = 0;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        log.debug({ msg: "suggestion generation aborted", commandText, shell: this.#shell });
        return;
      }
      throw e;
    }
  }

  private _renderArgumentDescription(description: string | undefined, width: number) {
    if (!description) return [];
    return renderBox([truncateText(description, width - borderWidth)], width);
  }

  private _renderDescription(description: string | undefined, height: number) {
    if (!description) return "";
    return renderBox(truncateMultilineText(description, descriptionWidth - borderWidth, height), descriptionWidth);
  }

  private _renderSuggestions(suggestions: Suggestion[], activeSuggestionIdx: number, width: number) {
    return renderBox(
      suggestions.map((suggestion, idx) => {
        const suggestionText = `${suggestion.icon} ${suggestion.name}`;
        const truncatedSuggestion = truncateText(suggestionText, width - borderWidth);
        return idx == activeSuggestionIdx ? chalk.bgHex(activeSuggestionBackgroundColor)(truncatedSuggestion) : truncatedSuggestion;
      }),
      width,
    );
  }

  private _calculatePadding(description: string, width: number): { padding: number; swapDescription: boolean } {
    const wrappedPadding = this.#term.getCursorState().cursorX % this.#term.cols;
    const maxPadding = description.length !== 0 ? this.#term.cols - width - descriptionWidth : this.#term.cols - width;
    const swapDescription = wrappedPadding > maxPadding && description.length !== 0;
    const swappedPadding = swapDescription ? Math.max(wrappedPadding - descriptionWidth, 0) : wrappedPadding;
    const padding = Math.min(Math.min(wrappedPadding, swappedPadding), maxPadding);
    return { padding, swapDescription };
  }

  private _calculateRowPadding(padding: number, swapDescription: boolean, width: number, suggestionContent?: string, descriptionContent?: string): number {
    if (swapDescription) {
      return descriptionContent == null ? padding + descriptionWidth : padding;
    }
    return suggestionContent == null ? padding + width : padding;
  }

  async exec(): Promise<void> {
    return await this._loadSuggestions();
  }

  render(direction: "above" | "below", height = getMaxLines()): ISTermPatch[] {
    if (!this.#suggestBlob || height <= borderWidth || this.#term.cols <= borderWidth) {
      return [];
    }
    const { suggestions, argumentDescription } = this.#suggestBlob;

    const width = Math.min(suggestionWidth, this.#term.cols);
    const maxSuggestions = Math.min(getMaxSuggestions(), height - borderWidth);
    const page = Math.min(Math.floor(this.#activeSuggestionIdx / maxSuggestions) + 1, Math.floor(suggestions.length / maxSuggestions) + 1);
    const pagedSuggestions = suggestions.filter((_, idx) => idx < page * maxSuggestions && idx >= (page - 1) * maxSuggestions);
    const activePagedSuggestionIndex = this.#activeSuggestionIdx % maxSuggestions;
    const activeDescription =
      this.#term.cols >= width + descriptionWidth ? pagedSuggestions.at(activePagedSuggestionIndex)?.description || argumentDescription || "" : "";
    const { swapDescription, padding } = this._calculatePadding(activeDescription, width);

    if (suggestions.length <= this.#activeSuggestionIdx) {
      this.#activeSuggestionIdx = Math.max(suggestions.length - 1, 0);
    }

    if (pagedSuggestions.length == 0) {
      if (argumentDescription != null) {
        const argumentWidth = Math.min(descriptionWidth, this.#term.cols);
        return this._renderArgumentDescription(argumentDescription, argumentWidth).map((row) => ({
          startX: Math.min(padding, this.#term.cols - argumentWidth),
          length: argumentWidth,
          data: row,
        }));
      }
      return [];
    }
    const descriptionUI = this._renderDescription(activeDescription, Math.min(descriptionHeight, height - borderWidth));
    const suggestionUI = this._renderSuggestions(pagedSuggestions, activePagedSuggestionIndex, width);
    const ui = [];
    const maxRows = Math.max(descriptionUI.length, suggestionUI.length);
    for (let i = 0; i < maxRows; i++) {
      const [suggestionUIRow, descriptionUIRow] =
        direction == "above"
          ? [suggestionUI[i - maxRows + suggestionUI.length], descriptionUI[i - maxRows + descriptionUI.length]]
          : [suggestionUI[i], descriptionUI[i]];

      const data = swapDescription ? (descriptionUIRow ?? "") + (suggestionUIRow ?? "") : (suggestionUIRow ?? "") + (descriptionUIRow ?? "");
      const rowPadding = this._calculateRowPadding(padding, swapDescription, width, suggestionUIRow, descriptionUIRow);

      ui.push({
        startX: rowPadding,
        length: (suggestionUIRow == null ? 0 : width) + (descriptionUIRow == null ? 0 : descriptionWidth),
        data: data,
      });
    }
    return ui;
  }

  update(keyPress: KeyPress): boolean {
    const { name, shift, ctrl } = keyPress;
    if (name == "return") {
      this.#term.clearCommand(); // clear the current command on enter
    }

    // if suggestions are hidden, keep them hidden until during command navigation
    if (this.#hideSuggestions) {
      this.#hideSuggestions = name == "up" || name == "down";
    }

    if (!this.#suggestBlob) {
      return false;
    }
    const {
      dismissSuggestions: { key: dismissKey, shift: dismissShift, control: dismissCtrl },
      acceptSuggestion: { key: acceptKey, shift: acceptShift, control: acceptCtrl },
      nextSuggestion: { key: nextKey, shift: nextShift, control: nextCtrl },
      previousSuggestion: { key: prevKey, shift: prevShift, control: prevCtrl },
    } = getConfig().bindings;

    if (name == dismissKey && shift == !!dismissShift && ctrl == !!dismissCtrl) {
      this.#suggestBlob = undefined;
      this.#hideSuggestions = true;
    } else if (name == prevKey && shift == !!prevShift && ctrl == !!prevCtrl) {
      this.#activeSuggestionIdx = Math.max(0, this.#activeSuggestionIdx - 1);
    } else if (name == nextKey && shift == !!nextShift && ctrl == !!nextCtrl) {
      this.#activeSuggestionIdx = Math.min(this.#activeSuggestionIdx + 1, (this.#suggestBlob?.suggestions.length ?? 1) - 1);
    } else if (name == acceptKey && shift == !!acceptShift && ctrl == !!acceptCtrl) {
      const suggestion = this.#suggestBlob?.suggestions.at(this.#activeSuggestionIdx);
      if (suggestion == null || this.#suggestBlob?.suggestions.length == 0) {
        return false;
      }
      const action = calculateReplacement(this.#suggestBlob?.activeToken, suggestion);
      if (action == null) {
        return false;
      }
      this.#term.write(applyReplacement(action));
    } else if (name == "return" || (name == "c" && ctrl)) {
      this.#term.clearCommand();
      return false;
    } else {
      return false;
    }
    log.debug({ msg: "handled keypress", ...keyPress });
    return true;
  }
}
