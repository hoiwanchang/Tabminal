# Tabminal

Tabminal is a minimalist web terminal service built with Node.js, xterm.js, and node-pty. The backend launches a single persistent terminal process. The browser client occupies the full screen and supports automatic reconnection, status indication, and proportional scaling, ensuring that the session continues even after refreshing the page.

## Features

- 🎯 **Single Persistent Terminal**: A node-pty process is created when the server starts. Any browser connection will take over the same terminal, and refreshing the page will not reset the environment.
- ⚡ **Low Latency Streaming**: WebSocket directly transmits input/output data bi-directionally, and the browser uses xterm.js to render real-time results.
- 🪟 **Adaptive Window**: The terminal occupies the entire browser visible area, automatically adjusting columns and rows via `ResizeObserver` and the xterm fit addon.
- 🔄 **Auto Reconnection**: Automatically reconnects with progressive backoff after network disconnection or browser sleep, and reapplies terminal dimensions.
- 🧠 **Output Caching**: The server saves recent output, and new browser connections will replay cached content before continuing to stream.
- 📋 **Health Check**: The `/healthz` endpoint can be used as a monitoring probe.

## Quick Start

```bash
npm install
npm run dev
```

The default server will be available at `http://localhost:9846`. The `dev` command uses `node --watch` for development; to start in production mode, use `npm start`.

### Prerequisites

- Node.js 18.18 or newer.
- macOS / Linux defaults to `$SHELL`, Windows uses `COMSPEC` (customizable).

### Common Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `9846` | HTTP listening port |
| `HOST` | `0.0.0.0` | Bind address |
| `TABMINAL_CWD` | Current working directory | Initial directory for the terminal |
| `TABMINAL_HISTORY` | `1048576` | Server-side output cache limit (characters) |
| `TABMINAL_COLS` / `TABMINAL_ROWS` | `120` / `30` | Default terminal dimensions on server start |
| `TABMINAL_HEARTBEAT` | `30000` | WebSocket ping interval (ms) |

## Testing

```bash
npm test
```

Tests use Vitest and verify buffering, writing, and resizing behaviors with virtual pty/WS implementations. To continue development, run `npm run test:watch`.

## Project Structure

```text
src/
  server.mjs              # HTTP + WebSocket entry point
  terminal-session.mjs    # Encapsulates persistent terminal session and client protocol
public/
  index.html              # xterm.js UI & entry page
  app.js                  # Frontend logic: reconnection, resizing, status display
  styles.css              # Full-screen terminal styles
```

## Future Directions

1. Multi-user / Multi-session support, distinguishing different ptys by token.
2. Add access control and TLS deployment scripts.
3. Log audit logs or operation history on the server side.

Feel free to adjust settings or integrate deployment tools (systemd, Docker, etc.) as needed.
