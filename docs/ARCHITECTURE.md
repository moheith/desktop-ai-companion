# Architecture

## Source Layout

The repository is organized around runtime responsibility.

### `src/main/`

Electron main-process code:

* `index.js`
  Creates windows, owns tray behavior, persists app config, and handles IPC.
* `memory-store.js`
  Owns companion memory persistence and mood state.

### `src/panel/`

Control-panel renderer code:

* `index.js`
  Owns the settings UI, chat UI, microphone flow, wake flow, and provider integrations.

### `src/mascot/`

Desktop mascot renderer code:

* `index.js`
  Owns Live2D rendering, hover behavior, cursor sync, and drag interaction.

### `src/shared/`

Code shared across runtime boundaries:

* `app-defaults.js`
  Shared config defaults, mascot stage sizing, and model-path normalization.
* `chat-history.js`
  Shared sanitization for persisted chat messages.

## Thin Root Entry Files

The repository keeps a few small files in the root:

* `main.js`
* `control.js`
* `renderer.js`
* `memory.js`
* `assistant.js`

These exist only as stable entry wrappers so Electron and the HTML shells can continue to load predictable paths.

## Asset Layout

### `model/`

Runtime Live2D models used by the mascot window and model selector.

Descriptive folders are preferred over generic numbered folders.

### `art/`

Editable source artwork and exports used to create custom mascot models.

### `mic/`

Local speech-to-text runtime assets for `whisper.cpp`.

### `voices/`

Local text-to-speech runtime assets such as Piper.

## Local Runtime Data

User data is stored outside the repo in:

```text
%APPDATA%\desktop-mascot\
```

Key files:

* `config.json` for app config and chat history
* `companion-memory.json` for long-term companion memory

These are runtime database files, not source-controlled assets.
