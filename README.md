# desktop-ai-companion
This my desktop mate which has AI memory

# Desktop AI Companion

A desktop AI assistant with a Live2D mascot that lives on your desktop.

The mascot runs in a transparent Electron window and can interact with the user through a control panel and AI chat system.

---

## Features

* Live2D desktop mascot
* Transparent click-through window
* Control panel for mascot settings
* AI chat interface
* Local AI using Ollama
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
* Ollama (local AI)
* JavaScript / HTML / CSS

---

## Installation

### 1. Install Node.js

Download and install Node.js:
https://nodejs.org/

---

### 2. Install Ollama

Download Ollama:
https://ollama.com/download

Then install a model:

```
ollama pull llama3
```

---

### 3. Clone the Repository

```
git clone https://github.com/moheith/desktop-ai-companion.git
cd desktop-ai-companion
```

---

### 4. Install Dependencies

```
npm install
```

---

### 5. Run the Application

```
npm start
```

---

## Build the Desktop App

To create an installer:

```
npm run build
```

The installer will appear in:

```
dist/
```

---

## Project Structure

```
desktop-ai-companion
│
├── main.js
├── renderer.js
├── control.html
├── control.js
├── assistant.js
├── memory.js
├── package.json
│
├── model/
│   └── live2d model files
│
├── node_modules/
├── dist/
└── .gitignore
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
