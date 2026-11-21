const diagnostic = {
  invalid_config: 'The operator managed workspace configuration is invalid or unreadable.',
  unprotected_root: 'The managed workspace path or its ancestors allow writes outside the trusted plugin account.',
  unisolated_source: 'Managed storage requires a separate source project for workspace-write and is not available with unrestricted filesystem access.',
  overlapping_roots: 'Managed scratch, artifacts, and the selected source project must use disjoint directories.',
  overlapping_runs: 'The managed workspace would overlap an existing or reserved run directory.',
  overlapping_source: 'The managed storage location overlaps a registered source project.',
  overlapping_git_cache: 'The managed storage location overlaps a recorded Git object cache.',
  git_cache_conflict: 'The Git cache key or physical directory already belongs to a different cache identity.',
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
