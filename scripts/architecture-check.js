import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const sourceRoot = path.join(repoRoot, 'src');
const baselinePath = path.join(repoRoot, 'scripts', 'architecture-baseline.json');

function posixPath(value) {
  return value.replace(/\\/g, '/');
}

function collectSourceFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function nodeName(filePath) {
  return posixPath(path.relative(sourceRoot, filePath)).replace(/\.ts$/, '');
}

function resolveLocalImport(fromNode, specifier, knownNodes) {
  if (!specifier.startsWith('.')) return null;
  const withoutExtension = specifier.endsWith('.js') ? specifier.slice(0, -3) : specifier;
  const resolved = posixPath(path.normalize(path.join(path.dirname(fromNode), withoutExtension)));
  return knownNodes.has(resolved) ? resolved : null;
}

function parseLocalImports(filePath, knownNodes) {
  const fromNode = nodeName(filePath);
  const source = fs.readFileSync(filePath, 'utf8');
  const specs = [];
  const fromPatterns = [
    /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
  ];

  for (const pattern of fromPatterns) {
    for (const match of source.matchAll(pattern)) {
      specs.push(match[1]);
    }
  }

  return [...new Set(
    specs
      .map((specifier) => resolveLocalImport(fromNode, specifier, knownNodes))
      .filter(Boolean),
  )].sort();
}

function buildGraph() {
  const files = collectSourceFiles(sourceRoot);
  const knownNodes = new Set(files.map(nodeName));
  const graph = new Map();
  for (const file of files) {
    graph.set(nodeName(file), parseLocalImports(file, knownNodes));
  }
  return graph;
}

function findCycleComponents(graph) {
  let nextIndex = 0;
  const stack = [];
  const onStack = new Set();
  const indexes = new Map();
  const lows = new Map();
  const components = [];

  function visit(node) {
    indexes.set(node, nextIndex);
    lows.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of graph.get(node) ?? []) {
      if (!indexes.has(next)) {
        visit(next);
        lows.set(node, Math.min(lows.get(node), lows.get(next)));
      } else if (onStack.has(next)) {
        lows.set(node, Math.min(lows.get(node), indexes.get(next)));
      }
    }

    if (lows.get(node) !== indexes.get(node)) return;

    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== node);

    if (component.length > 1) components.push(component.sort());
  }

  for (const node of graph.keys()) {
    if (!indexes.has(node)) visit(node);
  }

  return components.sort(compareStringArrays);
}

function restrictedImportRules(from, to) {
  const rules = [];
  if (to === 'channel' && from !== 'index') {
    rules.push('no-channel-contract-import');
  }
  if (from.startsWith('lark-transport-') && to === 'lark-transport') {
    rules.push('transport-api-must-not-import-facade');
  }
  if (
    (from === 'job-store' && to === 'cronjob-diagnostics') ||
    (from === 'cronjob-diagnostics' && to === 'job-store')
  ) {
    rules.push('job-store-diagnostics-cycle');
  }
  if (from.startsWith('domain/') && isInfrastructureNode(to)) {
    rules.push('domain-must-not-import-infrastructure');
  }
  if (from.startsWith('ports/') && isInfrastructureNode(to)) {
    rules.push('ports-must-not-import-infrastructure');
  }
  if (from.startsWith('application/') && to === 'index') {
    rules.push('application-must-not-import-entrypoint');
  }
  if (
    (from === 'domain/continuation' || from === 'ports/continuation')
    && (isInfrastructureNode(to) || to.startsWith('continuation/'))
  ) {
    rules.push('continuation-contracts-must-not-import-infrastructure');
  }
  if (
    from.startsWith('continuation/')
    && (to === 'job-store' || to === 'job-service' || to === 'scheduler')
  ) {
    rules.push('continuation-must-not-import-cronjob-runtime');
  }
  return rules;
}

function isInfrastructureNode(node) {
  return (
    node === 'index' ||
    node === 'config' ||
    node === 'channel' ||
    node.startsWith('sdk-') ||
    node.startsWith('lark-transport') ||
    node.startsWith('codex-exec') ||
    node === 'scheduler' ||
    node === 'resource-governance'
  );
}

function findRestrictedImports(graph) {
  const violations = [];
  for (const [from, deps] of graph) {
    for (const to of deps) {
      for (const rule of restrictedImportRules(from, to)) {
        violations.push({ rule, from, to });
      }
    }
  }
  return dedupeViolations(violations).sort(compareViolations);
}

function loadBaseline() {
  return JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
}

function isAllowedCycle(component, allowedComponents) {
  return allowedComponents.some((allowed) => component.every((node) => allowed.includes(node)));
}

function violationKey(violation) {
  return `${violation.rule}:${violation.from}->${violation.to}`;
}

function dedupeViolations(violations) {
  const seen = new Set();
  const unique = [];
  for (const violation of violations) {
    const key = violationKey(violation);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(violation);
  }
  return unique;
}

function compareStringArrays(a, b) {
  return a.join('\0').localeCompare(b.join('\0'));
}

function compareViolations(a, b) {
  return violationKey(a).localeCompare(violationKey(b));
}

function formatComponent(component) {
  return component.join(', ');
}

function main() {
  const baseline = loadBaseline();
  const allowedComponents = (baseline.allowedCycleComponents ?? []).map((component) => [...component].sort());
  const allowedRestricted = new Set((baseline.allowedRestrictedImports ?? []).map(violationKey));
  const graph = buildGraph();
  const cycleComponents = findCycleComponents(graph);
  const restrictedImports = findRestrictedImports(graph);
  const newCycles = cycleComponents.filter((component) => !isAllowedCycle(component, allowedComponents));
  const newRestrictedImports = restrictedImports.filter((violation) => !allowedRestricted.has(violationKey(violation)));

  if (newCycles.length || newRestrictedImports.length) {
    console.error('Architecture check failed.');
    if (newCycles.length) {
      console.error('\nNew dependency cycle component(s):');
      for (const component of newCycles) console.error(`- ${formatComponent(component)}`);
    }
    if (newRestrictedImports.length) {
      console.error('\nNew restricted import(s):');
      for (const violation of newRestrictedImports) {
        console.error(`- ${violation.rule}: ${violation.from} -> ${violation.to}`);
      }
    }
    console.error('\nIf this is intentional, first update docs/architecture.md and then amend scripts/architecture-baseline.json with a specific reason.');
    process.exit(1);
  }

  console.error(
    `architecture check ok: ${cycleComponents.length} baseline cycle component(s), ${restrictedImports.length} baseline restricted import(s)`,
  );
}

main();
