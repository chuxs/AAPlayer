'use strict';
// Starts AAPlayer in development. VS Code terminals set ELECTRON_RUN_AS_NODE,
// which would make Electron behave like plain Node, so clear it first.
const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code || 0));
