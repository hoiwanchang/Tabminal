import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import AnsiParser from 'node-ansiparser';

const execAsync = promisify(exec);
const WS_STATE_OPEN = 1;
const DEFAULT_HISTORY_LIMIT = 512 * 1024; // chars

export class TerminalSession {
    constructor(pty, options = {}) {
        this.pty = pty;
        this.id = options.id;
        this.manager = options.manager; // Store a reference to the manager
        this.createdAt = options.createdAt ?? new Date();
        this.shell = options.shell;
        this.initialCwd = options.initialCwd;
        this.title = this.shell ? this.shell.split('/').pop() : 'Terminal';
        this.cwd = this.initialCwd;
        this.historyLimit = Math.max(
            1,
            options.historyLimit ?? DEFAULT_HISTORY_LIMIT
        );
        this.history = '';
        this.clients = new Set();
        this.closed = false;
        this.pollingInterval = null;

        this.ansiParser = new AnsiParser({
            inst_p: (_s) => {},
            inst_o: (s) => {
                // OSC Handler
                // s is the content of the OSC sequence
                if (s.startsWith('0;') || s.startsWith('2;')) {
                    // Title change: "0;Title" or "2;Title"
                    const newTitle = s.substring(2);
                    if (newTitle && newTitle !== this.title) {
                        this.title = newTitle;
                        this._broadcast({ type: 'meta', title: this.title, cwd: this.cwd });
                    }
                } else if (s.startsWith('7;')) {
                    // CWD change: "7;file://hostname/path"
                    try {
                        const urlStr = s.substring(2);
                        const url = new URL(urlStr);
                        if (url.pathname) {
                            const newCwd = decodeURIComponent(url.pathname);
                            if (newCwd !== this.cwd) {
                                this.cwd = newCwd;
                                this._broadcast({ type: 'meta', title: this.title, cwd: this.cwd });
                            }
                        }
                    } catch (_e) {
                        // ignore invalid URLs
                    }
                }
            },
            inst_x: (_flag) => {},
            inst_c: (_collected, _params, _flag) => {},
            inst_e: (_collected, _flag) => {},
            inst_d: (_collected, _params, _flag) => {},
        });

        this._handleData = (chunk) => {
            if (typeof chunk !== 'string') {
                chunk = chunk.toString('utf8');
            }
            // Update the raw history
            this._appendHistory(chunk);
            
            // Parse for metadata updates
            this.ansiParser.parse(chunk);

            // Broadcast the raw output to active clients
            this._broadcast({ type: 'output', data: chunk });
        };

        this._handleExit = (details) => {
            this.closed = true;
            this.stopTitlePolling();
            this._broadcast({
                type: 'status',
                status: 'terminated',
                code: details?.exitCode ?? 0,
                signal: details?.signal ?? null
            });
        };

        this.dataSubscription = this.pty.onData(this._handleData);
        this.exitSubscription = this.pty.onExit(this._handleExit);
        
        this.startTitlePolling();
    }

    startTitlePolling() {
        if (this.pollingInterval) return;
        
        // Poll every 2 seconds
        this.pollingInterval = setInterval(async () => {
            if (this.closed) return;
            try {
                let currentPid = this.pty.pid;
                
                // Traverse down the process tree to find the deepest child (foreground process)
                while (true) {
                    try {
                        // pgrep -P <ppid> lists child PIDs
                        const { stdout } = await execAsync(`pgrep -P ${currentPid}`);
                        const pids = stdout.trim().split('\n').filter(Boolean).map(p => parseInt(p, 10));
                        
                        if (pids.length === 0) break;
                        
                        // Assume the child with the highest PID is the most recent/foreground one
                        currentPid = Math.max(...pids);
                    } catch (e) {
                        // pgrep returns exit code 1 if no processes found, which throws an error
                        break;
                    }
                }

                // If we found a descendant
                if (currentPid !== this.pty.pid) {
                    const { stdout: argsOut } = await execAsync(`ps -o args= -p ${currentPid}`);
                    let newTitle = argsOut.trim();
                    
                    // If the command starts with a path, use the basename
                    // e.g. "/usr/bin/vim file.txt" -> "vim file.txt"
                    const firstSpaceIndex = newTitle.indexOf(' ');
                    if (firstSpaceIndex > 0) {
                        const cmd = newTitle.substring(0, firstSpaceIndex);
                        const args = newTitle.substring(firstSpaceIndex);
                        if (cmd.includes('/')) {
                            newTitle = cmd.split('/').pop() + args;
                        }
                    } else if (newTitle.includes('/')) {
                        newTitle = newTitle.split('/').pop();
                    }
                    
                    if (newTitle && newTitle !== this.title) {
                        this.title = newTitle;
                        this._broadcast({ type: 'meta', title: this.title, cwd: this.cwd });
                    }
                } else {
                    // Revert to shell name if no children found
                    const shellName = this.shell ? this.shell.split('/').pop() : 'Terminal';
                    if (this.title !== shellName) {
                        this.title = shellName;
                        this._broadcast({ type: 'meta', title: this.title, cwd: this.cwd });
                    }
                }
            } catch (_err) {
                // Ignore polling errors
            }
        }, 2000);
    }

    stopTitlePolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    attach(ws) {
        if (!ws) {
            throw new Error('WebSocket instance required');
        }

        this.clients.add(ws);
        ws.once('close', () => {
            this.clients.delete(ws);
        });
        ws.on('message', (raw) => this._routeIncoming(raw, ws));
        ws.on('error', () => {
            ws.close();
        });

        this._send(ws, { type: 'snapshot', data: this.history });
        this._send(ws, { type: 'meta', title: this.title, cwd: this.cwd });
        if (this.closed) {
            this._send(ws, { type: 'status', status: 'terminated' });
        } else {
            this._send(ws, { type: 'status', status: 'ready' });
        }
    }

    dispose() {
        this.clients.clear();
        this.dataSubscription?.dispose?.();
        this.exitSubscription?.dispose?.();
    }

    // Public method for the manager to call
    resize(cols, rows) {
        if (this.closed) {
            return;
        }
        this.pty.resize(cols, rows);
    }

    _routeIncoming(raw, ws) {
        let payload;
        try {
            const text = typeof raw === 'string'
                ? raw
                : raw.toString('utf8');
            payload = JSON.parse(text);
        } catch (_err) {
            return;
        }

        switch (payload.type) {
        case 'input':
            this._handleInput(payload.data);
            break;
        case 'resize':
            this._handleResize(payload.cols, payload.rows);
            break;
        case 'ping':
            this._send(ws, { type: 'pong' });
            break;
        default:
            break;
        }
    }

    _handleInput(data) {
        if (this.closed || typeof data !== 'string') {
            return;
        }
        this.pty.write(data);
    }

    // Internal handler that delegates to the manager
    _handleResize(cols, rows) {
        if (this.closed) {
            return;
        }
        const safeCols = clampDimension(cols);
        const safeRows = clampDimension(rows);
        if (safeCols && safeRows) {
            this.resize(safeCols, safeRows);
            if (this.manager) {
                this.manager.updateDefaultSize(safeCols, safeRows);
            }
        }
    }

    _appendHistory(chunk) {
        this.history += chunk;
        if (this.history.length > this.historyLimit) {
            this.history = this.history.slice(
                this.history.length - this.historyLimit
            );
        }
    }

    _broadcast(message) {
        const data = JSON.stringify(message);
        for (const client of this.clients) {
            this._send(client, message, data);
        }
    }

    _send(ws, message, preEncoded) {
        if (!ws || ws.readyState !== WS_STATE_OPEN) {
            return;
        }
        const payload = preEncoded ?? JSON.stringify(message);
        ws.send(payload);
    }
}

function clampDimension(value) {
    const num = Number.parseInt(value, 10);
    if (Number.isNaN(num) || num <= 0) {
        return null;
    }
    return Math.min(500, num);
}