import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import AnsiParser from 'node-ansiparser';

const execAsync = promisify(exec);
const WS_STATE_OPEN = 1;
const DEFAULT_HISTORY_LIMIT = 512 * 1024; // chars
const OSC1337_META_REGEX =
    /\u001b\]1337;(?:ExitCode=(\d+);CommandB64=([a-zA-Z0-9+/=]+)|P_(START|END))\u0007/g;

export class TerminalSession {
    constructor(pty, options = {}) {
        this.pty = pty;
        this.id = options.id;
        this.manager = options.manager;
        this.createdAt = options.createdAt ?? new Date();
        this.shell = options.shell;
        this.initialCwd = options.initialCwd;
        
        this.title = this.shell ? this.shell.split('/').pop() : 'Terminal';
        this.cwd = this.initialCwd;
        
        // Format the initial environment object into a static string
        this.env = Object.entries(options.env || {})
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');
        
        this.historyLimit = Math.max(1, options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
        this.history = '';
        this.clients = new Set();
        this.closed = false;
        this.pollingInterval = null;
        this.captureState = { active: false, buffer: '', startedAt: null };
        this.lastExecution = null;

        this.ansiParser = new AnsiParser({
            inst_o: (s) => {
                if (s.startsWith('0;') || s.startsWith('2;')) {
                    const newTitle = s.substring(2);
                    if (newTitle && newTitle !== this.title) {
                        this.title = newTitle;
                        this._broadcast({ type: 'meta', title: this.title, cwd: this.cwd, env: this.env, cols: this.pty.cols, rows: this.pty.rows });
                    }
                } else if (s.startsWith('7;')) {
                    try {
                        const url = new URL(s.substring(2));
                        if (url.pathname) {
                            const newCwd = decodeURIComponent(url.pathname);
                            if (newCwd !== this.cwd) {
                                this.cwd = newCwd;
                                this._broadcast({ type: 'meta', title: this.title, cwd: this.cwd, env: this.env, cols: this.pty.cols, rows: this.pty.rows });
                            }
                        }
                    } catch (_e) { /* ignore */ }
                }
            },
        });

        this._handleData = (chunk) => {
            if (typeof chunk !== 'string') chunk = chunk.toString('utf8');

            let cleaned = '';
            let lastIndex = 0;
            OSC1337_META_REGEX.lastIndex = 0;

            let match;
            while ((match = OSC1337_META_REGEX.exec(chunk)) !== null) {
                const plain = chunk.slice(lastIndex, match.index);
                if (plain) {
                    cleaned += plain;
                    this._bufferCommandOutput(plain);
                }

                const exitCodeStr = match[1];
                const cmdB64 = match[2];
                const marker = match[3];

                if (exitCodeStr !== undefined) {
                    this._handleExitCodeSequence(exitCodeStr, cmdB64);
                } else if (marker) {
                    this._handlePromptMarker(marker);
                }

                lastIndex = OSC1337_META_REGEX.lastIndex;
            }

            const tail = chunk.slice(lastIndex);
            if (tail) {
                cleaned += tail;
                this._bufferCommandOutput(tail);
            }

            if (!cleaned) return;

            this._appendHistory(cleaned);
            this.ansiParser.parse(cleaned);
            this._broadcast({ type: 'output', data: cleaned });
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

        const poll = async () => {
            if (this.closed) return;
            try {
                let currentPid = this.pty.pid;
                while (true) {
                    try {
                        const { stdout } = await execAsync(`pgrep -P ${currentPid}`);
                        const pids = stdout.trim().split('\n').filter(Boolean).map(p => parseInt(p, 10));
                        if (pids.length === 0) break;
                        currentPid = Math.max(...pids);
                    } catch (e) { break; }
                }

                let newTitle;
                if (currentPid !== this.pty.pid) {
                    const { stdout: argsOut } = await execAsync(`ps -o args= -p ${currentPid}`);
                    newTitle = argsOut.trim();
                    const firstSpace = newTitle.indexOf(' ');
                    const cmd = firstSpace > 0 ? newTitle.substring(0, firstSpace) : newTitle;
                    if (cmd.includes('/')) {
                        newTitle = cmd.split('/').pop() + (firstSpace > 0 ? newTitle.substring(firstSpace) : '');
                    }
                } else {
                    newTitle = this.shell ? this.shell.split('/').pop() : 'Terminal';
                }

                let newEnv = null;
                try {
                    const { stdout: envOut } = await execAsync(`ps -p ${currentPid} -wwE`);
                    const lines = envOut.trim().split('\n');
                    if (lines.length > 1) {
                        const rawLine = lines.slice(1).join(' ');
                        const cmdAndArgs = (await execAsync(`ps -o args= -p ${currentPid}`)).stdout.trim();
                        const envBlock = rawLine.substring(rawLine.indexOf(cmdAndArgs) + cmdAndArgs.length).trim();
                        
                        const regex = /([A-Z_][A-Z0-9_]*=)/g;
                        const indices = [];
                        let match;
                        while ((match = regex.exec(envBlock)) !== null) {
                            indices.push(match.index);
                        }
                        
                        if (indices.length > 0) {
                            const envs = [];
                            for (let i = 0; i < indices.length; i++) {
                                const start = indices[i];
                                const end = (i + 1 < indices.length) ? indices[i + 1] : envBlock.length;
                                envs.push(envBlock.substring(start, end).trim());
                            }
                            newEnv = envs.join('\n');
                        }
                    }
                } catch (e) { /* ignore */ }

                const titleChanged = newTitle && newTitle !== this.title;
                const envChanged = newEnv !== null && newEnv !== this.env;

                if (titleChanged || envChanged) {
                    if (titleChanged) this.title = newTitle;
                    if (envChanged) this.env = newEnv;
                    this._broadcast({ type: 'meta', title: this.title, cwd: this.cwd, env: this.env, cols: this.pty.cols, rows: this.pty.rows });
                }
            } catch (_err) { /* ignore */ }
        };

        poll(); // Run immediately
        this.pollingInterval = setInterval(poll, 2000);
    }

    stopTitlePolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    attach(ws) {
        if (!ws) throw new Error('WebSocket instance required');
        this.clients.add(ws);
        ws.once('close', () => this.clients.delete(ws));
        ws.on('message', (raw) => this._routeIncoming(raw, ws));
        ws.on('error', () => ws.close());

        this._send(ws, { type: 'snapshot', data: this.history });
        this._send(ws, { type: 'meta', title: this.title, cwd: this.cwd, env: this.env, cols: this.pty.cols, rows: this.pty.rows });
        if (this.closed) {
            this._send(ws, { type: 'status', status: 'terminated' });
        } else {
            this._send(ws, { type: 'status', status: 'ready' });
        }
    }

    dispose() {
        this.stopTitlePolling();
        this.clients.clear();
        this.dataSubscription?.dispose?.();
        this.exitSubscription?.dispose?.();
    }

    resize(cols, rows) {
        if (this.closed) return;
        this.pty.resize(cols, rows);
        this._broadcast({ type: 'meta', title: this.title, cwd: this.cwd, env: this.env, cols, rows });
    }

    _routeIncoming(raw, ws) {
        let payload;
        try {
            payload = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
        } catch (_err) { return; }

        switch (payload.type) {
            case 'input': this._handleInput(payload.data); break;
            case 'resize': this._handleResize(payload.cols, payload.rows); break;
            case 'ping': this._send(ws, { type: 'pong' }); break;
        }
    }

    _handleInput(data) {
        if (this.closed || typeof data !== 'string') return;
        this.pty.write(data);
    }

    _handleResize(cols, rows) {
        if (this.closed) return;
        const safeCols = clampDimension(cols);
        const safeRows = clampDimension(rows);
        if (safeCols && safeRows) {
            if (this.manager) {
                this.manager.resizeAll(safeCols, safeRows);
            } else {
                this.resize(safeCols, safeRows);
            }
        }
    }

    _appendHistory(chunk) {
        this.history += chunk;
        if (this.history.length > this.historyLimit) {
            this.history = this.history.slice(this.history.length - this.historyLimit);
        }
    }

    _handlePromptMarker(marker) {
        if (marker !== 'END') return;
        this.captureState.active = true;
        this.captureState.buffer = '';
        this.captureState.startedAt = new Date();
    }

    _bufferCommandOutput(text) {
        if (!this.captureState.active || !text) return;
        this.captureState.buffer += text;
    }

    _handleExitCodeSequence(exitCodeStr, cmdB64) {
        const exitCode = Number.parseInt(exitCodeStr, 10);
        const command = this._decodeCommandSafe(cmdB64);

        if (!Number.isNaN(exitCode) && exitCode !== 0) {
            const printable = command ?? '<unknown>';
            console.log(
                `[Terminal Error] Exit Code: ${exitCode} | Command: "${printable}"`
            );
        }

        this._finalizeCommandCapture(
            Number.isNaN(exitCode) ? null : exitCode,
            command
        );
    }

    _decodeCommandSafe(encoded) {
        if (!encoded) return null;
        try {
            const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim();
            return decoded || null;
        } catch (err) {
            console.error('[Terminal Error] Failed to decode command:', err);
            return null;
        }
    }

    _finalizeCommandCapture(exitCode, command) {
        const hasData =
            this.captureState.active || this.captureState.buffer.length > 0;
        if (!hasData) {
            this.captureState.active = false;
            this.captureState.buffer = '';
            this.captureState.startedAt = null;
            return;
        }

        const completedAt = new Date();
        const entry = {
            command,
            exitCode,
            output: this.captureState.buffer,
            startedAt: this.captureState.startedAt ?? completedAt,
            completedAt,
        };

        this.lastExecution = entry;
        this._logCommandExecution(entry);
        this._resetCaptureState();
    }

    _resetCaptureState() {
        this.captureState.active = false;
        this.captureState.buffer = '';
        this.captureState.startedAt = null;
    }

    _logCommandExecution(entry) {
        const durationMs =
            entry.startedAt && entry.completedAt
                ? entry.completedAt.getTime() - entry.startedAt.getTime()
                : null;
        console.log('[Terminal Execution]', {
            command: entry.command ?? null,
            exitCode: entry.exitCode ?? null,
            startedAt: entry.startedAt?.toISOString() ?? null,
            completedAt: entry.completedAt?.toISOString() ?? null,
            durationMs,
            output: entry.output,
        });
    }

    _broadcast(message) {
        const data = JSON.stringify(message);
        for (const client of this.clients) {
            this._send(client, message, data);
        }
    }

    _send(ws, message, preEncoded) {
        if (!ws || ws.readyState !== WS_STATE_OPEN) return;
        ws.send(preEncoded ?? JSON.stringify(message));
    }
}

function clampDimension(value) {
    const num = Number.parseInt(value, 10);
    if (Number.isNaN(num) || num <= 0) return null;
    return Math.min(500, num);
}
