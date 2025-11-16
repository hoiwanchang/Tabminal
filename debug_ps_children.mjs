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

const interval = setInterval(async () => {
    try {
        console.log('--- Poll ---');
        // List all processes with PPID = shell.pid
        // ps -o pid,comm,start -p <children>
        // First get pids
        const { stdout: pgrepOut } = await execAsync(`pgrep -P ${shell.pid}`);
        const pids = pgrepOut.trim().split('\n').filter(Boolean);
        
        if (pids.length > 0) {
            console.log(`Children PIDs: ${pids.join(', ')}`);
            for (const pid of pids) {
                const { stdout: commOut } = await execAsync(`ps -o comm= -p ${pid}`);
                console.log(`  PID ${pid}: ${commOut.trim()}`);
            }
        } else {
            console.log('No children found via pgrep');
        }

    } catch (e) {
        console.log('Error or no children:', e.message);
    }
}, 2000);

setTimeout(() => {
    clearInterval(interval);
    shell.kill();
    process.exit(0);
}, 6000);
