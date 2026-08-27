# Pulse Vote Hub Desktop

Offline Desktop Election App — School & Station Elections Only

## Features

- **Fully Offline** — No internet required, runs entirely on local SQLite database
- **Election Management** — Create elections, positions, and candidates (manual, CSV import, or auto-generate)
- **Voter Management** — Import voters from CSV, auto-generate credentials, print voter cards
- **Voting Kiosk** — Fullscreen locked-down voting interface for polling stations
- **Duplicate Prevention** — Local SQLite checks prevent double voting
- **Results & Reporting** — View results in-app, export to JSON/CSV/PDF, print
- **Multi-Location Merge** — Combine results from multiple polling stations via file export

## Tech Stack

- **Runtime:** Electron
- **Database:** SQLite (better-sqlite3)
- **Frontend:** HTML/CSS/JS
- **Packaging:** electron-builder

## Getting Started

```bash
# Install dependencies
npm install

# Start the app
npm start
```

## Building

```bash
# Build for Windows
npm run build:win

# Build for macOS
npm run build:mac

# Build for both
npm run build:all
```

## Project Structure

```
pulse-vote-hub-desktop/
├── electron/              # Electron main process
│   ├── main.js            # App entry, window creation
│   ├── preload.js         # IPC bridge
│   ├── db.js              # SQLite operations
│   └── ...
├── renderer/              # Frontend (HTML/CSS/JS)
│   ├── index.html         # Login / first-run setup
│   ├── dashboard.html     # Admin dashboard
│   ├── station.html       # Voting kiosk
│   └── ...
├── data/                  # Sample data / templates
├── package.json
└── README.md
```

## License

MIT
