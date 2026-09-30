'use strict';
const path = require('path');
const data = process.env.QL_DATA_DIR || '/ql/data';
const repo = path.join(data, 'scripts', 'smallfawn_QLScriptPublic');
require(path.join(repo, 'tools', 'wxbridge-bootstrap.js'));
if (process.argv[1] && process.argv[1].endsWith('/jd/jd_fruit_new.js')) {
  require(path.join(data, 'bin', 'jd-fruit-compat.js'));
}
