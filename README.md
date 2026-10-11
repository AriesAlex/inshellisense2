# inshellisense2

Terminal autocomplete for PowerShell, Bash, Zsh, and POSIX sh. Suggestions appear while you type: commands, options, subcommands, files, and directories, backed by Fig completion specifications.

This is an independently maintained MIT-licensed fork of [Microsoft inshellisense](https://github.com/microsoft/inshellisense), based on upstream commit [9c7f5fd](https://github.com/microsoft/inshellisense/commit/9c7f5fd). It focuses on dependable terminal behavior and installation on real desktops, SSH sessions, and small mobile screens.

## Install

Linux / macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/AriesAlex/inshellisense2/main/install.sh | sh
```

Windows, from PowerShell:

```powershell
irm https://raw.githubusercontent.com/AriesAlex/inshellisense2/main/install.ps1 | iex
```

Open a new terminal afterward. The installer downloads a self-contained release, verifies SHA-256, and configures your shell automatically. No Node.js, npm, compiler, administrator account, or interactive installation dialog is required. The default executable location is `~/.local/bin`.

Re-run the same command to update. Existing profile content is preserved; repeated installation updates one managed block rather than adding another.

The Unix installer selects your login shell from `$SHELL`. To select another shell:

```sh
curl -fsSL https://raw.githubusercontent.com/AriesAlex/inshellisense2/main/install.sh | sh -s -- --shell zsh
```

Supported release platforms: Windows, Linux with glibc, and macOS; x64 and ARM64. Automatic startup supports PowerShell 7, Windows PowerShell 5.1, Bash, Zsh, and POSIX sh (including dash). Fish, Nushell, and Xonsh retain the upstream runtime integrations and can be launched explicitly with `inshellisense2 -s <shell>`.

For sh, the installer configures `~/.profile` and its standard `ENV` hook. Start a new login session once to make that hook available to subsequent interactive sh sessions. Existing `ENV` configuration is loaded inside the wrapped shell.

## Why this fork

The changes since the upstream base address several everyday problems:

- Terminal protocol replies stay intact instead of becoming typed text, including OSC color replies from full-screen applications.
- Ctrl+C, alternate-screen applications, ordered output, and completion redraws share a consistent terminal state.
- Menus fit the available width and height. Resizing preserves terminal history without leaving suggestion boxes in scrollback.
- Cursor save/restore works in JetBrains terminals. True-color text stays true-color when an overlay is removed.
- Completion helpers run outside the foreground terminal session, avoiding job-control conflicts and lost input.
- Command suggestions reflect executable commands on PATH and shell builtins, aliases, and functions. Path suggestions handle parent directories, prefixes, hidden files, and both Windows path separators.
- Standalone executables include their native modules and completion specs. Installation does not depend on a global `is` command or the user’s Node version.

The startup integration incorporates the lifecycle fixes developed alongside portable dotfiles: start before prompt frameworks, preserve login mode, load user profiles inside the wrapped shell, prevent recursion through `ISTERM`, and keep interactive UI out of scripts and redirected sessions.

Prompt frameworks must finish rendering before the command-input marker. With Oh My Posh, use a synchronous theme (`async: false`); asynchronous prompt redraws can otherwise move that boundary. Zsh integration installs its ZLE hook after the user’s prompt framework has initialized.

## Use and configure

Tab accepts a suggestion; Up/Down select one; Escape dismisses the menu. Your shell continues to execute commands normally.

Optional configuration lives in `~/.config/inshellisense2/rc.toml`:

```toml
maxSuggestions = 5
useAliases = true
useNerdFont = false

[bindings.acceptSuggestion]
key = "tab"
```

The [configuration schema](src/utils/config.ts) lists the available bindings and custom completion-spec paths. The large AWS, Azure, and Google Cloud spec trees are excluded from the bundled release.

Use `inshellisense2 doctor` to check unpacked resources. For manually managed dotfiles, `inshellisense2 init zsh` prints a source command without changing profiles; `inshellisense2 init zsh --install` installs automatic startup. `--profile <path>` selects a custom startup file.

`inshellisense2 uninstall` removes its managed startup blocks and cache. On Windows, close other inshellisense2 terminals first to release native modules. Delete the executable from `~/.local/bin` afterward. Your existing profile content and optional TOML configuration remain.

## Development

Use Node.js 22.21.1 and npm:

```sh
npm ci
npm run build
npm run verify:terminal
npm run package
npm run verify:terminal -- --binary pkg/inshellisense2-linux-x64
```

The live PTY scenarios cover small screens, resizing, long history, OSC replies, Ctrl+C, alternate screens, and consecutive commands. They print a temporary recording directory. `scripts/ReplayTerminal.java` replays those recordings through an installed JetBrains terminal engine and checks each screen and cursor.

After creating the native release archive and its `SHA256SUMS` in `pkg/`, run `npm run verify:install`. It installs twice with closed stdin into isolated home directories, starts real interactive and login shells, checks profile preservation and consecutive commands, and uninstalls its managed blocks. The release workflow runs both verification scripts on every platform.

Release builds are dispatched manually through GitHub Actions and contain the executable, MIT license, and bundled dependency notices, with a shared SHA256SUMS file. Bug reports should include the OS, shell, terminal client, version, and reproduction steps.

## License

[MIT](LICENSE). Original Microsoft copyright and license notices are retained. This fork is maintained independently and is not a Microsoft product.
