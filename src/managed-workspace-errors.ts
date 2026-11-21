const diagnostic = {
  invalid_config: 'The operator managed workspace configuration is invalid or unreadable.',
  unprotected_root: 'Managed storage roots must be owned by the plugin account and not group- or world-writable.',
  unisolated_source: 'Managed storage requires a separate source project for workspace-write and is not available with unrestricted filesystem access.',
  overlapping_roots: 'Managed scratch, artifacts, and the selected source project must use disjoint directories.',
  overlapping_runs: 'The managed workspace would overlap an existing or reserved run directory.',
  allocation_conflict: 'The managed run directory already exists without a matching stored allocation.',
  allocation_failed: 'The managed run directories could not be allocated.',
  allocation_incomplete: 'The stored managed workspace allocation is incomplete.',
  allocation_transaction: 'Managed workspace provisioning requires a committed database context.',
  invalid_binding: 'The managed workspace allocation is invalid.',
  artifact_invalid: 'The managed artifact is missing, outside its registered directory, oversized, or no longer matches its checksum.',
} as const;

export class ManagedWorkspaceStorageError extends Error {
  constructor(readonly code: keyof typeof diagnostic) {
    super(diagnostic[code]);
    this.name = 'ManagedWorkspaceStorageError';
  }
}
