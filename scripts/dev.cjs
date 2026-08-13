const { spawn } = require('child_process');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const processes = [
  spawn(process.execPath, ['server.cjs'], { stdio: 'inherit' }),
  spawn(npm, ['run', 'dev'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];

function stop() {
  for (const child of processes) child.kill();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
processes.forEach((child) => child.on('exit', (code) => {
  if (code && code !== 0) process.exitCode = code;
}));
