import pty from 'node-pty';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const shell = pty.spawn('bash', [], {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd: process.cwd(),
    env: process.env
});

console.log(`Shell PID: ${shell.pid}`);

setTimeout(() => {
    console.log('Running python3...');
    shell.write('python3\n');
}, 1000);

async function getDeepestChild(rootPid) {
    try {
        const { stdout } = await execAsync(`ps -A -o pid,ppid,comm`);
        const lines = stdout.trim().split('\n');
        
        const childrenMap = {};
        const commMap = {};

        lines.forEach(line => {
            // ps output might have leading spaces
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[0], 10);
            const ppid = parseInt(parts[1], 10);
            const comm = parts.slice(2).join(' '); // comm might have spaces? usually not for command name but args yes. ps -o comm gives command name.

            if (!childrenMap[ppid]) childrenMap[ppid] = [];
            childrenMap[ppid].push(pid);
            commMap[pid] = comm;
        });

        let currentPid = rootPid;
        while (true) {
            const children = childrenMap[currentPid];
            if (!children || children.length === 0) {
                break;
            }
            // Pick the child with the largest PID (most recent)
            // Or maybe we should filter out known shells if possible?
            // For now, just max PID.
            currentPid = Math.max(...children);
        }

        if (currentPid === rootPid) return null; // No children
        return commMap[currentPid];

    } catch (e) {
        console.error(e);
        return null;
    }
}

const interval = setInterval(async () => {
    const deepest = await getDeepestChild(shell.pid);
    console.log(`Deepest: ${deepest}`);
}, 2000);

setTimeout(() => {
    clearInterval(interval);
    shell.kill();
    process.exit(0);
}, 6000);
