const backendRequire = require('./backend-require.cjs');
const { NestFactory } = backendRequire('@nestjs/core');
const { ExpressAdapter } = backendRequire('@nestjs/platform-express');
// Same explicit HTTP adapter as the production entry point; no dependency on root hoisting.
module.exports = (module, options) => NestFactory.create(module, new ExpressAdapter(), options);
