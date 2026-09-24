'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
let logDirectory = '';
function dateStamp(now = new Date()) { return now.toISOString().slice(0, 10); }
function ensureDirectory() { if (!logDirectory && app.isReady()) { logDirectory = path.join(app.getPath('userData'), 'logs'); fs.mkdirSync(logDirectory, { recursive: true }); } return logDirectory; }
function sanitize(value) { return String(value ?? '').replace(/[\\r\\n]+/g, ' ').replace(/(SESSDATA|TOKEN_MONITOR_SECRET|cookie|password|token)\\s*[=:]\\s*[^ ]+/ig, '$1=[redacted]').slice(0, 2000); }
function logRuntime(event, detail = '') { const directory = ensureDirectory(); const line = new Date().toISOString() + ' [' + sanitize(event) + ']' + (detail ? ' ' + sanitize(detail) : '') + '\\n'; if (!directory) { process.stderr.write(line); return; } try { fs.appendFileSync(path.join(directory, 'token-' + dateStamp() + '.log'), line, { encoding: 'utf8', mode: 0o600 }); } catch (_) { process.stderr.write(line); } }
function initRuntimeLog() { ensureDirectory(); logRuntime('startup', 'version=' + app.getVersion() + ' platform=' + process.platform); process.on('uncaughtException', (error) => logRuntime('uncaughtException', error?.stack || error)); process.on('unhandledRejection', (reason) => logRuntime('unhandledRejection', reason?.stack || reason)); app.on('render-process-gone', (_event, details) => logRuntime('render-process-gone', JSON.stringify(details))); app.on('before-quit', () => logRuntime('before-quit')); }
module.exports = { initRuntimeLog, logRuntime };
