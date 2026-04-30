# Desktop AI Companion

A desktop AI assistant with a Live2D mascot that lives on your desktop.

The mascot runs in a transparent Electron window and can interact with the user through a control panel, AI chat, voice features, and persistent memory.

---

## Features

* Live2D desktop mascot
* Transparent click-through window
* Control panel for mascot settings
* AI chat interface
* Local AI using Ollama
* Local microphone STT with whisper.cpp
* OpenAI Whisper STT fallback
* Persistent memory system
* Adjustable mascot position and scale
* Model selector for multiple Live2D mascots
* Alt-hold drag shortcut for repositioning the mascot
* Always-on-top mode
* Behind-taskbar mode

---

## Technologies Used

* Electron
* PixiJS
* pixi-live2d-display
* Live2D Cubism Core
* Ollama
* whisper.cpp
* JavaScript / HTML / CSS

---

## Installation

### 1. Install Node.js

Download and install Node.js:
https://nodejs.org/

### 2. Install Ollama

Download Ollama:
https://ollama.com/download

Then install a model:

```bash
ollama pull llama3
```

### 3. Clone the Repository

```bash
git clone https://github.com/moheith/desktop-ai-companion.git
cd desktop-ai-companion
```

### 4. Install Dependencies

```bash
npm install
```

### 5. Run the Application

```bash
npm start
```

---

## Microphone Setup

The app supports two speech-to-text modes:

* `Local whisper.cpp` for free offline transcription
* `OpenAI Whisper` as a cloud fallback
* Built-in local wake-word mode with no key required
* Optional `Porcupine` wake-word mode for advanced setups

### Local whisper.cpp

This repository includes the Windows `whisper.cpp` runtime in:

```text
mic/whisper-bin-x64/Release/
```

The model file is intentionally ignored in git, so you need to download it yourself.

Download:

* `ggml-base.bin`
* Source: https://huggingface.co/ggerganov/whisper.cpp

Place it here:

```text
mic/whisper-bin-x64/Release/models/ggml-base.bin
```

Then in the app:

1. Open `Voice Settings`
2. Enable `Microphone`
3. Set `STT Engine` to `Local whisper.cpp`
4. Set `Language` to `Auto detect`
5. Set executable path to:

```text
mic\whisper-bin-x64\Release\whisper-cli.exe
```

6. Set model path to:

```text
mic\whisper-bin-x64\Release\models\ggml-base.bin
```

7. Save Voice Settings

For packaged builds in `dist/`, the app now copies the `mic/` runtime into the packaged app resources automatically. After rebuilding, local STT should work from the packaged `.exe` without needing a dev-only relative path.

### OpenAI Whisper

If you prefer cloud transcription:

1. Open `AI Model -> OpenAI`
2. Add your API key
3. In `Voice Settings`, choose `OpenAI Whisper`
4. Save

### Wake Word Options

The app now supports two wake-word paths:

* `Built-in local wake`  
  No AccessKey required. This is the default path for GitHub users and packaged builds.
* `Porcupine`  
  Optional advanced path if you want to supply a Picovoice `AccessKey` and a `.ppn` keyword file.

### Porcupine Wake Word

For reliable `hey mascot` wake detection, the app now supports Picovoice Porcupine instead of the older browser-based wake listener.

What you need:

* a Picovoice `AccessKey`
* a custom Porcupine keyword file (`.ppn`) for your chosen wake phrase, such as `hey mascot`

Then in the app:

1. Open `Voice Settings`
2. Enable `Microphone`
3. Keep `STT Engine` on `Local whisper.cpp`
4. Turn on `Wake word`
5. Paste your Porcupine `AccessKey`
6. Add the full path to your `.ppn` keyword file
7. Save Voice Settings

Wake-word detection is offline after setup. If you also use Ollama and local TTS, the full voice loop can run offline.

---

## Build the Desktop App

To create an installer:

```bash
npm run build
```

The installer will appear in:

```text
dist/
```

---

## Mascot Controls

The desktop mascot stays click-through by default so it does not block normal desktop use.

Current mascot interactions:

* Hover the mascot to reduce its opacity so you can see behind it
* Hold `Alt`, then left-click and hold the mascot for 3 seconds to drag it
* Release the mouse to drop the mascot in place
* Use the `Mascot` page in the control panel to fine-tune `X`, `Y`, scale, visibility, and model selection

Notes:

* `X` and `Y` in the `Mascot` page represent the mascot window position on the screen
* The app now uses `Scale` as the main size control for the mascot appearance
* Window width and height are handled internally and are no longer exposed as primary user controls

---

## Project Structure

```text
desktop-ai-companion/
|-- main.js
|-- renderer.js
|-- control.html
|-- control.js
|-- assistant.js
|-- memory.js
|-- package.json
|-- mic/
|   `-- whisper.cpp runtime files
|-- model/
|   `-- live2d model files
|-- node_modules/
|-- dist/
`-- .gitignore
```

---

## Future Plans

* Voice interaction with the AI
* Speech bubbles for the mascot
* Emotional animations
* Improved memory system
* More Live2D models
* Custom personality system

---

## License

This project is for educational and experimental purposes.
