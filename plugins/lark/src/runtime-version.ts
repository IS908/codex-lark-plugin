const MINIMUM_NODE_VERSION = [24, 15, 0] as const;
const MINIMUM_NODE_LABEL = MINIMUM_NODE_VERSION.join('.');

function parseNodeVersion(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(
  actual: readonly number[],
  minimum: readonly number[],
): number {
  for (let index = 0; index < Math.max(actual.length, minimum.length); index += 1) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const parsed = parseNodeVersion(version);
  if (!parsed || compareVersion(parsed, MINIMUM_NODE_VERSION) < 0) {
    throw new Error(
      `Node.js >=${MINIMUM_NODE_LABEL} is required; current version is ${version}.`,
    );
  }
}
