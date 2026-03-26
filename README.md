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
* Adjustable mascot size and position
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

### OpenAI Whisper

If you prefer cloud transcription:

1. Open `AI Model -> OpenAI`
2. Add your API key
3. In `Voice Settings`, choose `OpenAI Whisper`
4. Save

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
