const path = require('node:path');
module.exports = {
  apps: [{
    name: 'featheral', cwd: __dirname,
    script: 'npm', args: 'start', interpreter: 'none',
    instances: 1, exec_mode: 'fork', autorestart: true,
    kill_timeout: 30000, restart_delay: 5000,
    env: { NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '8080' },
    out_file: path.join(__dirname, '..', '..', 'shared', 'logs', 'app.log'),
    error_file: path.join(__dirname, '..', '..', 'shared', 'logs', 'error.log'),
  }],
};
