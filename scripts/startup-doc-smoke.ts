import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readme = readFileSync('README.md', 'utf8');
const readmeCn = readFileSync('README_CN.md', 'utf8');

assert.match(
  readme,
  /If installed via the plugin marketplace, the plugin starts automatically when Codex launches\./,
  'English startup docs must state that marketplace installations start with Codex',
);
assert.match(
  readme,
  /# If installed from source:\s+npm start/,
  'English startup docs must scope manual startup to source installations',
);
assert.match(
  readmeCn,
  /通过插件市场安装时，插件会随 Codex 自动启动/,
  'Chinese startup docs must state that marketplace installations start with Codex',
);
assert.match(
  readmeCn,
  /只有从源码安装或开发时才需要手动启动/,
  'Chinese startup docs must scope manual startup to source installations',
);

console.log('startup-doc smoke: PASS');
