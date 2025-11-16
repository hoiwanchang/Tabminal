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
        // Get all processes
        const { stdout } = await execAsync(`ps -A -o pid,ppid,comm`);
        const lines = stdout.trim().split('\n');
        
        // Build tree
        const tree = {};
        lines.forEach(line => {
            const [pid, ppid, ...commParts] = line.trim().split(/\s+/);
            const comm = commParts.join(' ');
            if (!tree[ppid]) tree[ppid] = [];
            tree[ppid].push({ pid, comm });
        });

        function printTree(pid, indent = 0) {
            const children = tree[pid] || [];
            for (const child of children) {
                console.log(`${' '.repeat(indent)}PID ${child.pid}: ${child.comm}`);
                printTree(child.pid, indent + 2);
            }
        }

        printTree(shell.pid.toString());

    } catch (e) {
        console.error(e);
    }
}, 2000);

setTimeout(() => {
    clearInterval(interval);
    shell.kill();
    process.exit(0);
}, 6000);
