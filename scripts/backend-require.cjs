// Resolve fixtures against the API workspace's declared dependencies, independent of npm hoisting.
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
module.exports = createRequire(resolve(__dirname, '../apps/api/package.json'));
