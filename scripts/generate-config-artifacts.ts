import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  configSchema,
  configSchemaKeys,
  type ConfigCategory,
  type ConfigDefinition,
  type ConfigKey,
} from '../src/config-schema.js';

const checkOnly = process.argv.includes('--check');
const categories: ConfigCategory[] = [
  'Credentials',
  'Messaging',
  'Acknowledgement',
  'Reliability',
  'CronJob',
  'Memory',
  'Identity',
  'Privacy',
  'Quoted cards',
  'Resource governance',
];

const categoryZh: Record<ConfigCategory, string> = {
  Credentials: '凭据',
  Messaging: '消息',
  Acknowledgement: '确认反馈',
  Reliability: '可靠性',
  CronJob: '定时任务',
  Memory: '记忆',
  Identity: '身份',
  Privacy: '隐私',
  'Quoted cards': '引用卡片',
  'Resource governance': '资源治理',
};

function definitionsIn(category: ConfigCategory): Array<[ConfigKey, ConfigDefinition]> {
  return configSchemaKeys
    .filter((key) => configSchema[key].category === category)
    .map((key) => [key, configSchema[key] as ConfigDefinition]);
}

function markdown(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function typeLabel(definition: ConfigDefinition): string {
  if (definition.type === 'choice') return `enum(${definition.choices.join(', ')})`;
  if (definition.type === 'string' && definition.absolutePath) return 'absolute path';
  return definition.type;
}

function constraintLabel(definition: ConfigDefinition): string {
  if (definition.type === 'choice') return definition.choices.join(', ');
  if (definition.type === 'boolean') return 'true/false, 1/0, yes/no, on/off';
  if (definition.type === 'string') {
    const rules = [];
    if (definition.absolutePath) rules.push('absolute path');
    if (definition.empty === 'preserve') rules.push('empty allowed');
    return rules.join('; ') || '-';
  }
  return definition.number.message.replace(/^Expected\s+/i, '').replace(/\.$/, '');
}

function renderReference(locale: 'en' | 'zh'): string {
  const title = locale === 'en' ? 'Configuration Reference' : '配置参考';
  const intro =
    locale === 'en'
      ? 'This file is generated from `src/config-schema.ts`. Edit the schema, then run `npm run generate:config`.'
      : '此文件由 `src/config-schema.ts` 生成。请修改 schema，然后运行 `npm run generate:config`。';
  const headers =
    locale === 'en'
      ? '| Key | Type | Required | Default | Sensitive | Constraints | Description | Features |\n|---|---|---:|---|---:|---|---|---|'
      : '| 配置项 | 类型 | 必填 | 默认值 | 敏感 | 约束 | 说明 | 适用功能 |\n|---|---|---:|---|---:|---|---|---|';
  const lines = [`# ${title}`, '', intro, ''];
  for (const category of categories) {
    const entries = definitionsIn(category);
    if (entries.length === 0) continue;
    lines.push(`## ${locale === 'en' ? category : categoryZh[category]}`, '', headers);
    for (const [key, definition] of entries) {
      const required = locale === 'en'
        ? definition.required ? 'yes' : 'no'
        : definition.required ? '是' : '否';
      const sensitive = locale === 'en'
        ? definition.sensitive ? 'yes' : 'no'
        : definition.sensitive ? '是' : '否';
      const defaultDisplay = definition.sensitive ? '-' : definition.defaultDisplay;
      lines.push(
        `| \`${key}\` | ${markdown(typeLabel(definition))} | ${required} | ${markdown(defaultDisplay)} | ${sensitive} | ${markdown(constraintLabel(definition))} | ${markdown(definition.description[locale])} | ${markdown(definition.features.join(', '))} |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function envValue(definition: ConfigDefinition): string {
  if (definition.required || definition.sensitive) return '';
  const display = definition.defaultDisplay;
  if (
    display === '(empty)' ||
    display.startsWith('~') ||
    display.includes('LARK_') ||
    display.includes('system timezone') ||
    display.includes('max(')
  ) {
    return '';
  }
  return display;
}

function renderEnvExample(): string {
  const lines = [
    '# Generated from src/config-schema.ts. Run: npm run generate:config',
    '# Shell environment variables override values loaded from this file.',
    '',
  ];
  for (const category of categories) {
    const entries = definitionsIn(category);
    if (entries.length === 0) continue;
    lines.push(`# === ${category} ===`);
    for (const [key, definition] of entries) {
      const defaultNote =
        definition.required || definition.sensitive
          ? ''
          : ` Default: ${definition.defaultDisplay}.`;
      const line = `${key}=${envValue(definition)}`;
      if (definition.required) {
        lines.push(line, `# ${definition.description.en}`);
      } else {
        lines.push(`# ${line} # ${definition.description.en}${defaultNote}`);
      }
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function renderSkillTable(): string {
  const lines = [
    '## Recognized config keys',
    '',
    '<!-- BEGIN GENERATED CONFIG TABLE -->',
    '| Key | Category | Type | Required | Default | Sensitive |',
    '|-----|----------|------|----------|---------|-----------|',
  ];
  for (const key of configSchemaKeys) {
    const definition = configSchema[key] as ConfigDefinition;
    lines.push(
      `| \`${key}\` | ${definition.category} | ${typeLabel(definition)} | ${definition.required ? 'Yes' : 'No'} | ${definition.sensitive ? '-' : definition.defaultDisplay} | ${definition.sensitive ? 'Yes' : 'No'} |`,
    );
  }
  lines.push('<!-- END GENERATED CONFIG TABLE -->', '');
  return lines.join('\n');
}

function replaceSkillTable(source: string): string {
  const start = source.indexOf('## Recognized config keys');
  const end = source.indexOf('## Notes', start);
  assert.ok(start >= 0 && end > start, 'configure skill recognized-key section is missing');
  return `${source.slice(0, start)}${renderSkillTable()}\n${source.slice(end)}`;
}

const outputs = new Map<string, string>([
  ['.env.example', renderEnvExample()],
  ['plugins/lark/.env.example', renderEnvExample()],
  ['docs/configuration-reference.md', renderReference('en')],
  ['docs/configuration-reference.zh-CN.md', renderReference('zh')],
]);

const rootSkill = readFileSync('skills/configure/SKILL.md', 'utf8');
const generatedSkill = replaceSkillTable(rootSkill);
outputs.set('skills/configure/SKILL.md', generatedSkill);
outputs.set('plugins/lark/skills/configure/SKILL.md', generatedSkill);

const stale: string[] = [];
for (const [file, expected] of outputs) {
  let actual = '';
  try {
    actual = readFileSync(file, 'utf8');
  } catch {
    // A missing generated artifact is stale.
  }
  if (actual === expected) continue;
  stale.push(file);
  if (!checkOnly) writeFileSync(file, expected, 'utf8');
}

if (stale.length > 0 && checkOnly) {
  throw new Error(
    `Generated configuration artifacts are stale: ${stale.join(', ')}. Run npm run generate:config.`,
  );
}

console.log(
  checkOnly
    ? `config artifact check: ${outputs.size} files PASS`
    : `config artifacts generated: ${stale.length} updated`,
);
