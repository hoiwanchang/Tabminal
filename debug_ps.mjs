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

// Run a command that lasts a while
setTimeout(() => {
    console.log('Running sleep 10...');
    shell.write('sleep 10\n');
}, 1000);

// Debug polling
const interval = setInterval(async () => {
    try {
        console.log('--- Poll ---');
        
        // 1. Current Logic: Shell's PGID
        const { stdout: pgidOut } = await execAsync(`ps -o pgid= -p ${shell.pid}`);
        const pgid = pgidOut.trim();
        console.log(`Shell PGID: ${pgid}`);
        
        const { stdout: groupMembers } = await execAsync(`ps -o comm= -g ${pgid}`);
        console.log(`Members of Shell PGID: ${groupMembers.trim().split('\n').join(', ')}`);

        // 2. TPGID Logic
        // Get TPGID associated with the shell's PID (since shell is attached to the TTY)
        const { stdout: tpgidOut } = await execAsync(`ps -o tpgid= -p ${shell.pid}`);
        const tpgid = tpgidOut.trim();
        console.log(`TPGID from Shell PID: ${tpgid}`);

        if (tpgid && tpgid !== '0') {
            // Get command for TPGID
            // Note: -p TPGID might fail if the process doesn't exist, but usually TPGID is the group leader.
            try {
                const { stdout: commOut } = await execAsync(`ps -o comm= -p ${tpgid}`);
                console.log(`Command for TPGID ${tpgid}: ${commOut.trim()}`);
            } catch (e) {
                console.log(`Could not get comm for TPGID ${tpgid}`);
            }
        }

    } catch (e) {
        console.error(e.message);
    }
}, 2000);

setTimeout(() => {
    clearInterval(interval);
    shell.kill();
    process.exit(0);
}, 6000);
