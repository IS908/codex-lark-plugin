const diagnostic = {
  invalid_config: 'The operator managed workspace configuration is invalid or unreadable.',
  unprotected_root: 'The managed workspace path or its ancestors allow writes outside the trusted plugin account.',
  unisolated_source: 'Managed storage requires a separate source project for workspace-write and is not available with unrestricted filesystem access.',
  overlapping_roots: 'Managed scratch, artifacts, and the selected source project must use disjoint directories.',
  overlapping_runs: 'The managed workspace would overlap an existing or reserved run directory.',
  overlapping_source: 'The managed storage location overlaps a registered source project.',
  overlapping_git_cache: 'The managed storage location overlaps a recorded Git object cache.',
  git_cache_conflict: 'The Git cache key or physical directory already belongs to a different cache identity.',
  git_sandbox_invalid: 'The isolated Git checkout cannot be assigned disjoint sandbox paths.',
  git_sandbox_layers_unsupported: 'Isolated Git execution cannot compose with active Codex project or system configuration or command rules.',
  git_launcher_untrusted: 'A trusted absolute Codex launcher is unavailable for the isolated Git checkout.',
  git_registry_invalid: 'The local Git source registry or its pre-provisioned cache is invalid.',
  git_selection_revoked: 'The selected Git cache is no longer covered by the current operator authorization.',
  git_project_overlap: 'This workspace overlaps a project reserved for isolated Git execution; start a newly admitted run with the exact registered project.',
  allocation_conflict: 'The managed run directory already exists without a matching stored allocation.',
  allocation_failed: 'The managed run directories could not be allocated.',
  allocation_incomplete: 'The stored managed workspace allocation is incomplete.',
  allocation_transaction: 'Managed workspace provisioning requires a committed database context.',
  invalid_binding: 'The managed workspace allocation is invalid.',
  dependency_install_incomplete: 'A dependency install was already started for this run but cannot be adopted or repeated.',
  artifact_invalid: 'The managed artifact is missing, outside its registered directory, oversized, or no longer matches its checksum.',
} as const;

export class ManagedWorkspaceStorageError extends Error {
  constructor(readonly code: keyof typeof diagnostic) {
    super(diagnostic[code]);
    this.name = 'ManagedWorkspaceStorageError';
  }
}
