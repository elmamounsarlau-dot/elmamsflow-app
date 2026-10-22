// Resolve the "@/..." imports of the compiled tests.
const Module = require('module');
const path = require('path');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req.startsWith('@/')) req = path.join(__dirname, '..', '.test-build', 'src', req.slice(2));
  return orig.call(this, req, ...rest);
};
