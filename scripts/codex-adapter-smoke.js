import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf-8'));
}

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf-8');
}

function readSkillFrontmatter(skillName, base = 'skills') {
  const text = read(path.join(base, skillName, 'SKILL.md'));
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, `skill ${skillName} must have YAML frontmatter`);
  const frontmatter = Object.fromEntries(
    match[1]
      .split('\n')
      .map((line) => line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.replace(/^["']|["']$/g, '')])
  );
  return frontmatter;
}

const plugin = readJson('.codex-plugin/plugin.json');
const pkg = readJson('package.json');
assert.equal(plugin.name, 'lark');
assert.equal(plugin.mcpServers, './.mcp.json');
assert.equal(plugin.skills, './skills/');
assert.equal(plugin.interface.displayName, 'Lark');
assert.match(plugin.description, /Codex/);
assert.equal(plugin.version, pkg.version, 'root plugin manifest version must match package.json');
assert.ok(fs.existsSync(path.join(root, 'PRIVACY.md')));
assert.ok(fs.existsSync(path.join(root, 'TERMS.md')));
assert.equal(
  plugin.interface.privacyPolicyURL,
  'https://github.com/IS908/codex-lark-plugin/blob/main/PRIVACY.md'
);
assert.equal(
  plugin.interface.termsOfServiceURL,
  'https://github.com/IS908/codex-lark-plugin/blob/main/TERMS.md'
);

const marketplace = readJson('.agents/plugins/marketplace.json');
assert.equal(marketplace.name, 'codex-lark-plugin');
const larkEntry = marketplace.plugins.find((entry) => entry.name === 'lark');
assert.ok(larkEntry, 'marketplace must expose the lark plugin');
assert.deepEqual(larkEntry.source, { source: 'local', path: './plugins/lark' });
assert.equal(larkEntry.policy.installation, 'AVAILABLE');
assert.equal(larkEntry.policy.authentication, 'ON_INSTALL');
assert.equal(larkEntry.category, 'Productivity');

assert.equal(readSkillFrontmatter('configure').name, 'configure');
assert.equal(readSkillFrontmatter('jobs').name, 'jobs');

const wrappedPlugin = readJson('plugins/lark/.codex-plugin/plugin.json');
const wrappedPackage = readJson('plugins/lark/package.json');
assert.equal(wrappedPlugin.name, 'lark');
assert.equal(wrappedPlugin.mcpServers, './.mcp.json');
assert.equal(wrappedPlugin.skills, './skills/');
assert.equal(wrappedPlugin.version, pkg.version, 'wrapped plugin manifest version must match package.json');
assert.equal(wrappedPlugin.interface.privacyPolicyURL, plugin.interface.privacyPolicyURL);
assert.equal(wrappedPlugin.interface.termsOfServiceURL, plugin.interface.termsOfServiceURL);
assert.equal(wrappedPackage.version, pkg.version, 'wrapped package version must match package.json');
assert.equal(readSkillFrontmatter('configure', 'plugins/lark/skills').name, 'configure');
assert.equal(readSkillFrontmatter('jobs', 'plugins/lark/skills').name, 'jobs');

const wrappedMcp = readJson('plugins/lark/.mcp.json');
assert.equal(wrappedMcp.mcpServers.lark.command, 'npm');
assert.deepEqual(wrappedMcp.mcpServers.lark.args, ['run', '--silent', 'start']);
assert.equal(wrappedMcp.mcpServers.lark.cwd, '.');

assert.equal(wrappedPackage.type, 'module');
assert.equal(wrappedPackage.main, 'runtime/index.js');
assert.equal(wrappedPackage.scripts.start, 'node runtime/index.js');
assert.equal(wrappedPackage.scripts.stop, 'node runtime/stop.js');
assert.ok(fs.existsSync(path.join(root, 'plugins/lark/src/index.ts')));

const mcp = readJson('.mcp.json');
assert.equal(mcp.mcpServers.lark.command, 'npm');
assert.deepEqual(mcp.mcpServers.lark.args, ['run', '--silent', 'start']);
assert.equal(mcp.mcpServers.lark.cwd, '.');
assert.equal(pkg.scripts.start, 'node --import tsx src/index.ts');

const index = read('src/index.ts');
const wrappedIndex = read('plugins/lark/src/index.ts');
const scheduler = read('src/scheduler.ts');
assert.ok(fs.existsSync(path.join(root, 'scripts/check-release-version.js')));
assert.equal(pkg.scripts['check:release-version'], 'node scripts/check-release-version.js');
assert.match(index, /packageVersion/);
assert.match(wrappedIndex, /packageVersion/);
assert.doesNotMatch(index, /version:\s*['"]\d+\.\d+\.\d+['"]/);
assert.doesNotMatch(wrappedIndex, /version:\s*['"]\d+\.\d+\.\d+['"]/);
assert.doesNotMatch(index, /'Codex\/channel'/);
assert.doesNotMatch(index, /notifications\/Codex\/channel/);
assert.doesNotMatch(scheduler, /notifications\/Codex\/channel/);
assert.doesNotMatch(index, /notifications\/claude\/channel|claude\/channel/);
assert.doesNotMatch(scheduler, /notifications\/claude\/channel|claude\/channel/);

for (const file of [
  'src/config.ts',
  'src/debug-log.ts',
  'src/audit-log.ts',
  'src/privacy-rules.ts',
]) {
  const text = read(file);
  assert.doesNotMatch(text, /\.claude/);
}

const config = read('src/config.ts');
assert.match(config, /\.codex/);
assert.match(config, /debugLogPath/);
assert.match(config, /auditLogPath/);

const debugLog = read('src/debug-log.ts');
assert.match(debugLog, /appendRotatingLine/);
assert.match(debugLog, /console\.error/);
assert.doesNotMatch(debugLog, /console\.log/);

const auditLog = read('src/audit-log.ts');
assert.match(auditLog, /appendRotatingLine/);

console.error('[codex-adapter-smoke] ok');
