# easyssh

A PuTTY / Termius-inspired desktop SSH client with a Rust backend and a Tauri webview interface.

## Features

- Terminal fills the main window. Saved connections, grouped by folder, live in a collapsible side panel with compact add/edit controls.
- Ctrl+B toggles the panel, Ctrl+K opens connection search, and Ctrl+N adds a connection.
- Saved connections with groups, search, edit and delete.
- Password and OpenSSH/PEM private-key authentication. Saved passwords and passphrases are used automatically without a credentials prompt; stored secrets stay in Rust.
- Native context menus: right-click a saved host to connect, enter replacement credentials, edit, or delete; right-click a terminal or tab for clipboard and session actions.
- WebView browser context menus, autofill, and password-saving prompts are disabled on Windows.
- Passwords and key passphrases saved in Windows Credential Manager, macOS Keychain, or Linux Secret Service. Saving fails if the credential store is unavailable; there is no plaintext fallback.
- Private keys remain in their original files; easyssh saves their paths. Keep the files and their permissions protected. PuTTY `.ppk` files must be converted to OpenSSH format first.
- First-use SHA-256 server fingerprint confirmation. A changed fingerprint blocks authentication; the actual authenticated connection checks the pinned key again.
- Independent terminal tabs, ANSI colors, interactive PTY, resize, scrollback, and UTF-8 output.
- Copy selected text with Ctrl+Shift+C; paste with Ctrl+Shift+V or the terminal right-click menu. Ctrl+C is passed through to the shell.
- Clipboard menu pastes containing line breaks require confirmation. Normal terminal keyboard paste also works according to WebView clipboard support.
- Bottom bar shows session status, user@host:port, connected duration, terminal dimensions, and UTF-8 encoding.
- Up to 16 simultaneous sessions.

## Run on Windows

Install Rust stable (MSVC), Visual Studio C++ Build Tools with the Windows SDK, Node.js, pnpm, and Microsoft Edge WebView2. The SSH backend builds OpenSSL to support modern key types on Windows. Install native Strawberry Perl before the first build:

```powershell
winget install --exact --id StrawberryPerl.StrawberryPerl
```

Open a new terminal after installation, then check `perl -v`. If Perl is still missing from PATH, set its location explicitly in that terminal:

```powershell
$env:OPENSSL_SRC_PERL = "C:\Strawberry\perl\bin\perl.exe"
```

Use native Windows Perl for the MSVC build; Git Bash/MSYS Perl is not a substitute. NASM may also be needed if OpenSSL assembly optimizations are enabled.

```powershell
pnpm install
pnpm tauri dev
```

Build a Windows installer:

```powershell
pnpm tauri build --bundles nsis
```

Output: `src-tauri/target/release/bundle/nsis/`.

## Linux

Install the Tauri 2 platform dependencies for your distro (WebKitGTK 4.1 development libraries, a C/C++ toolchain, pkg-config, OpenSSL development files, and the distro's appindicator/rsvg dependencies). A running Secret Service provider such as GNOME Keyring or KWallet is required to save credentials.

```sh
pnpm install
pnpm tauri dev
# Build a Debian package:
pnpm tauri build --bundles deb
```

## First connection

1. Add a connection, choose password or private key, and optionally save its secret.
2. For private keys, enter the full path to the existing private key file.
3. Open terminal and compare the displayed fingerprint with a trusted source for your server. Trust only after checking it.
4. Saved credentials are used automatically. A missing password is requested once; keep Save for future connections checked to remember it. Unencrypted private keys connect without prompting. For an encrypted key with no saved passphrase, use Connect with credentials from the host context menu.
5. Open more sessions from the connection list; close a tab to disconnect. To replace an expired or incorrect password, right-click the host and choose Connect with credentials or edit its saved password.

Connection metadata and pinned fingerprints are in the Tauri app data directory under `fi.eassh.desktop/connections.json` (the exact root depends on the OS). Metadata is not encrypted. Secrets live in the OS credential store, not this file. Access is tied to the signed-in OS account; easyssh does not currently have a separate master password.

If a server is legitimately reinstalled, verify its new fingerprint independently before removing the corresponding entry from the `hosts` map in `connections.json` while easyssh is closed. Changed keys cannot be silently accepted in the UI.

## Structure

- `src-tauri/src/main.rs`: Rust SSH transport, fingerprint verification, native credential store, metadata persistence, and bounded session input queues.
- `src/main.ts`: connection manager and xterm.js session UI.
- `src/style.css`: desktop interface styling.

## Current validation and limits

Rust source formatting/parsing was checked with `cargo fmt`. Frontend type checking and production bundling pass with `pnpm build`. The refreshed layout could not be visually verified because the preview browser could not reach the local server. Rust compilation checking passes with `cargo check --offline`. Sixteen credential, pane-layout, and clipboard tests pass with `pnpm test`. Installer generation and live SSH/native-menu interaction verification remain unverified.

The first version does not include SFTP, jump hosts, SSH config import, agent authentication, cloud sync, port forwarding, or keyboard-interactive/2FA authentication. Test interactive programs, terminal resize, Unicode, reconnect after authentication failure, and clipboard access on your target OS.

## Tab dragging and split panes

Drag a tab along the tab strip to reorder it. Drag it to the left, right, top, or bottom edge of another terminal to split that pane; the highlighted area previews the drop. Drop in a pane's center to replace its visible tab. Existing SSH sessions and scrollback remain intact. Click a pane to focus it, and drag a divider to resize it. Closing a pane collapses the remaining layout.

Ctrl+C remains the remote interrupt key. Ctrl+Shift+C copies; Ctrl+V, Ctrl+Shift+V, and Shift+Insert paste through one handler. Approving a multiline paste remembers approval for that SSH session. The Always allow multiline pastes in all sessions checkbox saves the preference across app restarts. Use Reset multiline paste approval in the terminal context menu to ask again.

The split-pane and drag interactions have build and logic-test coverage, but have not been manually verified in the desktop WebView.

## Files and local terminals

Use Files (Ctrl+Shift+E) on a connected tab to browse and edit UTF-8 files, up to 1 MiB. Ctrl+S saves. Remote sessions use SFTP; local tabs use the host filesystem. The editor checks file revisions before replacing files and preserves line endings. It cannot elevate permissions with sudo. SFTP servers must support atomic replacement. SFTP has no compare-and-swap operation, so revision checking reduces conflicts but cannot eliminate races with other writers. Extended metadata such as ACLs and xattrs is not currently preserved by atomic replacement.

Local shell opens installed PowerShell 7, Windows PowerShell, CMD, or the default WSL distribution on Windows; Linux/macOS offer the default shell, Bash, Fish, Zsh, or sh when installed. WSL uses its installed distribution's version, including WSL2. Its Files panel browses the Windows host filesystem; enter a WSL UNC path to browse that distribution's files. Kitty is a terminal emulator, so it is not launched inside easyssh. Local terminals use Windows ConPTY or a Unix PTY and participate in the same tabs and splits as SSH.

The public name is now easyssh. The application ID, saved connection locations, and credential-service names remain `fi.eassh.desktop` so existing saved connections continue to work.

## Mobile / Android

The Rust library has Tauri's mobile entry point, with an Android configuration overlay and phone layout: connection drawer, full-screen file editor, safe-area spacing, keyboard-aware viewport, and an extra terminal key row. Native desktop menus are skipped on mobile; editing is available through host buttons and long press.

Install Android Studio and use its SDK Manager to install Android SDK Platform 37, Build-Tools 37.0.0, NDK 28.2.13676358, Platform-Tools, and the command-line tools. Set `ANDROID_HOME` to the SDK directory and `NDK_HOME` to its `ndk/28.2.13676358` directory. Use JDK 21, as in CI, or the Java runtime included with Android Studio.

```powershell
pnpm install --frozen-lockfile
rustup target add aarch64-linux-android
pnpm android:build
```

The build initializes the Gradle project on a fresh checkout and writes the ARM64 APK under `src-tauri/gen/android/app/build/outputs/apk/`. Use `pnpm android:dev` to run on a connected device or emulator. Android saves passwords and private-key passphrases in encrypted storage backed by Android Keystore when Save secret is selected. Existing connections can save their password through Edit or Connect with credentials. Private-key importing through Android's file picker remains pending.

Android local shell code uses `/system/bin/sh` in the app sandbox. Bash is not bundled, and a Termux-style package manager/userland is not included. Modern Android requires executable code to be packaged in the APK; downloaded executables in writable app storage are not used. If you have an Android-compatible Bash executable and required shared libraries for your ABI, run the packaging script after Android initialization:

```powershell
./scripts/package-android-bash.ps1 -Abi arm64-v8a -BashBinary C:/path/to/android/bash
```

The script validates ELF architecture, adds `libbash.so` to the generated native library directory, and configures extraction. Include all required Android shared libraries, runtime assets, source and license notices. Rebuild the APK. The shell picker detects this packaged runtime. This packaging path has not been tested on a device; a complete bundled Bash environment remains a separate deliverable.

## Validation of the editor/local-terminal work

The desktop Rust check passes. Three Rust tests cover binary/size rejection, local save conflict handling, and real Windows ConPTY input/output/resize. All sixteen existing TypeScript logic tests pass. The frontend type check and production bundle passed before the final branding-only edits. A fresh pnpm dependency restore is currently blocked by registry DNS in this environment. Run pnpm install in a normal terminal before building. Linux shell execution, remote SFTP against a live server, and mobile behavior still require device verification.

## Releases

Plain `pnpm tauri build` builds the desktop packages for your OS, then an ARM64 Android APK. Install the Android SDK/NDK and the `aarch64-linux-android` Rust target first. Use `pnpm tauri build-desktop` or `pnpm tauri build-android` for a single platform.

Push `main` to the GitHub repository configured as `origin`. Run the **Release** workflow manually from the Actions tab to check all four builds and download their artifacts. To publish, run `pnpm release` from a clean `main` checkout. It bumps the patch version across the manifests, commits, and pushes `main` and the matching tag together. Pass `minor` or `major` for those increments. The tag triggers Windows, Linux, macOS ARM64, and Android ARM64 builds. GitHub publishes the packages on the repository's Releases page after all four builds pass.

For an installable Android download, set the repository's Actions secrets `ANDROID_KEYSTORE_BASE64` (the base64-encoded keystore), `ANDROID_KEYSTORE_PASSWORD`, and `ANDROID_KEY_ALIAS`. Set `ANDROID_KEY_PASSWORD` if the key has a different password. Keep the same signing key for future upgrades. The release workflow requires these secrets and verifies the APK signature and alignment before uploading it.

## Agent access through MCP

Open Settings and enable the local agent bridge. Keep easyssh open. Copy its JSON configuration into the `EASYSSH_MCP_CONFIG` environment variable in your MCP client configuration. Run the stdio server with Node.js 24:

```json
{
  "mcpServers": {
    "easyssh": {
      "command": "node",
      "args": ["R:/eassh/scripts/mcp-server.mjs"],
      "env": {
        "EASYSSH_MCP_CONFIG": "PASTE_THE_JSON_FROM_SETTINGS_HERE"
      }
    }
  }
}
```

Use an absolute path for your checkout. The environment value is a JSON string, so escape its quotes when editing client configuration manually. A fresh token and port are generated whenever access is enabled. The bridge listens on loopback only and closes when disabled or when easyssh exits. Restart the MCP client after changing the configuration.

Tools list saved connections and sessions, open saved connections, read the last 200 terminal lines, and type terminal input. Passwords remain in easyssh's credential store. Terminal output can contain sensitive information printed by commands. Approved mode asks before every input and connection, including sudo commands. The optional unattended mode permits commands and connection requests until disabled or the app exits. Host fingerprint verification still applies. Only enable unattended mode for agents you trust with your servers. Disable access in Settings to stop further input. This release supplies a local stdio bridge for MCP clients on the same computer.
