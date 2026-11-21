import { createRequire as __larkCreateRequire } from 'node:module'; import { fileURLToPath as __larkFileURLToPath } from 'node:url'; import { dirname as __larkPathDirname } from 'node:path'; const require = __larkCreateRequire(import.meta.url); const __filename = __larkFileURLToPath(import.meta.url); const __dirname = __larkPathDirname(__filename);
import {
  ManagedWorkspaceStorageError,
  assertDenyOnlyWorkspaceAcls,
  assertProtectedWorkspacePath,
  loadWorkspaceDependencyWriteGuard,
  managedRunDirectoryPath,
  managedRunOwnerSchema,
  mkdirTemporaryInsidePinnedRoot,
  parseManagedWorkspaceRecord,
  pinWorkspacePath,
  readManagedWorkspaceRoots,
  readWorkspaceDependencyMountPolicy,
  require_lib,
  resolveManagedGitSelection,
  sameWorkspaceProject,
  validateManagedRunDirectory
} from "./chunks/chunk-6ZXOA5GM.js";
import {
  __toESM,
  assertSupportedNodeVersion,
  continuationRuntimeDir,
  managedWorkspaceConfigPath,
  readConfigValues,
  require_main,
  runtimeConfigDir
} from "./chunks/chunk-Y3Y2TSPS.js";

// src/configure-doctor-cli.ts
var Lark = __toESM(require_lib(), 1);
var import_dotenv2 = __toESM(require_main(), 1);
import os from "node:os";
import path5 from "node:path";
import { readFile as readFile2 } from "node:fs/promises";

// src/configure-doctor.ts
var import_dotenv = __toESM(require_main(), 1);
import { readFile } from "node:fs/promises";
var REQUIRED_PERMISSIONS = [
  {
    capability: "receive direct messages",
    scopes: ["im:message.p2p_msg:readonly"]
  },
  {
    capability: "receive group @bot messages",
    scopes: ["im:message.group_at_msg:readonly"]
  },
  {
    capability: "send messages as the bot",
    scopes: ["im:message:send_as_bot"]
  },
  {
    capability: "download message resources",
    scopes: ["im:resource"]
  },
  {
    capability: "write message reactions",
    scopes: ["im:message.reactions:write_only", "im:message.reactions:write"]
  },
  {
    capability: "read document comments",
    scopes: ["docs:document.comment:read"]
  },
  {
    capability: "create document comments",
    scopes: ["docs:document.comment:create"]
  },
  {
    capability: "read document metadata",
    scopes: ["drive:drive.metadata:readonly"]
  }
];
var RECOMMENDED_PERMISSIONS = [
  {
    capability: "resolve outbound @mentions from chat members",
    scopes: ["im:chat:readonly"]
  },
  {
    capability: "receive message reaction events",
    scopes: ["im:message.reactions:read"]
  }
];
var REQUIRED_EVENTS = [
  "im.message.receive_v1",
  "im.message.reaction.created_v1",
  "drive.notice.comment_add_v1"
];
function check(id, status, detail, remediation) {
  return { id, status, detail, ...remediation ? { remediation } : {} };
}
function missingPermissions(grantedScopes, requirements) {
  return requirements.filter(
    (requirement) => !requirement.scopes.some((scope) => grantedScopes.has(scope))
  );
}
function formatMissingPermissions(requirements) {
  return requirements.map((requirement) => `${requirement.capability} (${requirement.scopes.join(" or ")})`).join("; ");
}
function remoteErrorCode(error) {
  if (!error || typeof error !== "object") return void 0;
  const record = error;
  const code = record.response?.data?.code ?? record.code;
  if (typeof code === "string" || typeof code === "number") return String(code);
  return void 0;
}
function configFailureDetail(error) {
  if (error && typeof error === "object" && error.code === "ENOENT") {
    return "Configuration file does not exist.";
  }
  if (error instanceof Error) {
    const safeMessage = error.message.replace(
      /(LARK_APP_SECRET\s*[:=]\s*)\S+/gi,
      "$1[REDACTED]"
    );
    return safeMessage;
  }
  return "Configuration could not be read or validated.";
}
function compactDiagnosticValue(value, maximum = 120) {
  const compacted = value.replace(/\s+/g, " ").trim();
  return compacted.length <= maximum ? compacted : `${compacted.slice(0, maximum - 3)}...`;
}
async function runConfigureDoctor(options) {
  const checks = [];
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  let appId;
  let appSecret;
  try {
    let fileEnv = {};
    let configFilePresent = true;
    try {
      fileEnv = (0, import_dotenv.parse)(await readFile(options.configPath, "utf8"));
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") {
        throw error;
      }
      configFilePresent = false;
    }
    const values = readConfigValues({
      env: { ...fileEnv, ...options.env ?? process.env },
      homeDir: options.homeDir,
      systemTimezone: options.systemTimezone
    });
    appId = values.LARK_APP_ID;
    appSecret = values.LARK_APP_SECRET;
    if (!/^cli_[A-Za-z0-9]+$/.test(appId)) {
      throw new Error("Invalid LARK_APP_ID: expected a Feishu/Lark app ID beginning with cli_.");
    }
    checks.push(
      check(
        "configuration",
        "PASS",
        configFilePresent ? `Validated ${options.configPath}.` : "Validated credentials from the process environment; no .env file is present."
      )
    );
  } catch (error) {
    checks.push(
      check(
        "configuration",
        "FAIL",
        configFailureDetail(error),
        "Run $lark:configure setup and verify the generated .env file."
      )
    );
  }
  try {
    assertSupportedNodeVersion(nodeVersion);
    checks.push(check("runtime", "PASS", `Node.js ${nodeVersion} satisfies >=24.15.0.`));
  } catch {
    checks.push(
      check(
        "runtime",
        "FAIL",
        `Node.js ${nodeVersion} does not satisfy >=24.15.0.`,
        "Upgrade Node.js before starting the plugin."
      )
    );
  }
  if (!appId || !appSecret) {
    return finish(options.configPath, checks);
  }
  let snapshot;
  try {
    snapshot = await options.remoteProbe({ appId, appSecret });
    checks.push(check("credentials", "PASS", "Lark accepted the configured app credentials."));
  } catch (error) {
    const code = remoteErrorCode(error);
    checks.push(
      check(
        "credentials",
        "FAIL",
        `Lark credential/API probe failed${code ? ` (code ${code})` : ""}.`,
        "Verify LARK_APP_ID, rotate LARK_APP_SECRET if needed, and confirm outbound access to open.feishu.cn."
      )
    );
    return finish(options.configPath, checks);
  }
  if (snapshot.appName) {
    checks.push(
      check(
        "app_identity",
        "PASS",
        `Resolved app identity: ${compactDiagnosticValue(snapshot.appName)}.`
      )
    );
  } else {
    checks.push(
      check(
        "app_identity",
        "WARN",
        "Credentials work, but the application API did not return an app name.",
        "Confirm the app is available and published in the Feishu Open Platform console."
      )
    );
  }
  const grantedScopes = new Set(snapshot.grantedScopes);
  const missingRequired = missingPermissions(grantedScopes, REQUIRED_PERMISSIONS);
  const missingRecommended = missingPermissions(grantedScopes, RECOMMENDED_PERMISSIONS);
  if (missingRequired.length > 0) {
    checks.push(
      check(
        "permissions",
        "FAIL",
        `Missing required capabilities: ${formatMissingPermissions(missingRequired)}.`,
        "Grant the listed tenant permissions and publish the app version."
      )
    );
  } else if (missingRecommended.length > 0) {
    checks.push(
      check(
        "permissions",
        "WARN",
        `Required permissions are present; missing recommended capabilities: ${formatMissingPermissions(missingRecommended)}.`,
        "Grant the recommended tenant permissions for the corresponding optional event flows."
      )
    );
  } else {
    checks.push(
      check(
        "permissions",
        "PASS",
        `${REQUIRED_PERMISSIONS.length} required and ${RECOMMENDED_PERMISSIONS.length} recommended capabilities are granted.`
      )
    );
  }
  if (snapshot.callbackType === "websocket") {
    checks.push(check("event_transport", "PASS", "Application callback mode is WebSocket."));
  } else {
    checks.push(
      check(
        "event_transport",
        "FAIL",
        `Application callback mode is ${snapshot.callbackType || "not reported"}, not WebSocket.`,
        "Enable WebSocket mode under Event Subscriptions in the Feishu Open Platform console."
      )
    );
  }
  if (snapshot.subscribedEvents === void 0) {
    checks.push(
      check(
        "event_subscriptions",
        "WARN",
        `The read-only application API does not expose message event subscriptions. Manually verify: ${REQUIRED_EVENTS.join(", ")}.`,
        "Open Event Subscriptions in the Feishu Open Platform console and verify the listed events."
      )
    );
  } else {
    const subscribed = new Set(snapshot.subscribedEvents);
    const missingEvents = REQUIRED_EVENTS.filter((event) => !subscribed.has(event));
    checks.push(
      missingEvents.length === 0 ? check("event_subscriptions", "PASS", `${REQUIRED_EVENTS.length} required events are subscribed.`) : check(
        "event_subscriptions",
        "FAIL",
        `Missing event subscriptions: ${missingEvents.join(", ")}.`,
        "Subscribe to the listed events and publish the app version."
      )
    );
  }
  return finish(options.configPath, checks);
}
function finish(configPath, checks) {
  return {
    configPath,
    checks,
    exitCode: checks.some((item) => item.status === "FAIL") ? 1 : 0
  };
}
function formatConfigureDoctorReport(report) {
  const counts = {
    PASS: report.checks.filter((item) => item.status === "PASS").length,
    WARN: report.checks.filter((item) => item.status === "WARN").length,
    FAIL: report.checks.filter((item) => item.status === "FAIL").length
  };
  const lines = ["codex-lark-plugin doctor"];
  for (const item of report.checks) {
    lines.push(`${item.status.padEnd(4)}  ${item.id}  ${item.detail}`);
    if (item.remediation) lines.push(`      remediation  ${item.remediation}`);
  }
  lines.push(`Summary: ${counts.PASS} PASS, ${counts.WARN} WARN, ${counts.FAIL} FAIL`);
  return lines.join("\n");
}

// src/workspace-storage.ts
import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
function usage() {
  return { entries: 0, apparentBytes: 0, allocatedBytes: 0 };
}
function newInventory(directory, role) {
  return {
    directory,
    roles: [role],
    status: "complete",
    total: null,
    categories: {
      dependencies: usage(),
      gitMetadata: usage(),
      runtimeControl: usage(),
      links: usage(),
      other: usage()
    },
    largestEntries: [],
    duplicateHardLinks: 0,
    issueCount: 0,
    issues: []
  };
}
function errorReason(error) {
  return error?.code ?? "filesystem_error";
}
function issue(inventory, relative, reason) {
  if (inventory.status === "complete") inventory.status = "partial";
  inventory.issueCount++;
  if (inventory.issues.length < 50) inventory.issues.push({ path: relative || ".", reason });
}
function categoryFor(name, parent, depth) {
  if (parent !== "other") return parent;
  if (depth === 1 && (name === ".lark-actions" || name === ".lark-progress")) return "runtimeControl";
  if (name === ".git") return "gitMetadata";
  if (name === "node_modules" || name === "venv" || name === ".venv" || /^\..+-venv$/.test(name)) {
    return "dependencies";
  }
  return "other";
}
function addUsage(target, stats, duplicate) {
  target.entries++;
  if (duplicate) return;
  if (stats.isFile() || stats.isSymbolicLink()) target.apparentBytes += stats.size;
  if (target.allocatedBytes !== null) {
    target.allocatedBytes = Number.isFinite(stats.blocks) && stats.blocks >= 0 ? target.allocatedBytes + stats.blocks * 512 : null;
  }
}
async function scan(inventory, rootStats, { maxEntries = 1e6, maxDepth = 96 }) {
  const total = usage();
  inventory.total = total;
  const seenHardLinks = /* @__PURE__ */ new Set();
  let visited = 0;
  let entryLimit = false;
  async function visit(absolute, relative, category, depth, group, knownStats) {
    if (visited >= maxEntries) {
      entryLimit = true;
      issue(inventory, relative, "entry_limit");
      return;
    }
    visited++;
    try {
      const stats = knownStats ?? await lstat(absolute);
      if (stats.dev !== rootStats.dev) {
        issue(inventory, relative, "other_filesystem");
        return;
      }
      if (stats.isSymbolicLink()) category = "links";
      const hardLink = !stats.isDirectory() && stats.nlink > 1;
      const duplicate = hardLink && seenHardLinks.has(stats.ino);
      if (hardLink) seenHardLinks.add(stats.ino);
      if (duplicate) inventory.duplicateHardLinks++;
      addUsage(total, stats, duplicate);
      addUsage(inventory.categories[category], stats, duplicate);
      if (group) addUsage(group, stats, duplicate);
      if (!stats.isDirectory()) return;
      if (depth >= maxDepth) {
        issue(inventory, relative, "depth_limit");
        return;
      }
      if (await realpath(absolute) !== absolute) {
        issue(inventory, relative, "directory_changed");
        return;
      }
      const entries = await opendir(absolute);
      for await (const entry of entries) {
        const child = path.join(relative, entry.name);
        const childGroup = group ?? usage();
        await visit(
          path.join(absolute, entry.name),
          child,
          categoryFor(entry.name, category, depth + 1),
          depth + 1,
          childGroup
        );
        if (!group && childGroup.entries > 0) {
          inventory.largestEntries.push({ path: child, ...childGroup });
          inventory.largestEntries.sort((a, b) => (b.allocatedBytes ?? b.apparentBytes) - (a.allocatedBytes ?? a.apparentBytes) || b.apparentBytes - a.apparentBytes || a.path.localeCompare(b.path));
          if (inventory.largestEntries.length > 20) inventory.largestEntries.pop();
        }
        if (entryLimit) break;
      }
    } catch (error) {
      issue(inventory, relative, errorReason(error));
    }
  }
  await visit(inventory.directory, "", "other", 0, void 0, rootStats);
}
async function inventoryWorkspaceStorage(roots, options = {}) {
  const results = /* @__PURE__ */ new Map();
  for (const { role, directory } of roots) {
    let canonical = path.resolve(directory);
    try {
      canonical = await realpath(canonical);
      const existing = results.get(canonical);
      if (existing) {
        existing.roles.push(role);
        continue;
      }
      const stats = await lstat(canonical);
      if (!stats.isDirectory()) throw Object.assign(new Error("Not a directory"), { code: "ENOTDIR" });
      const inventory = newInventory(canonical, role);
      results.set(canonical, inventory);
      await scan(inventory, stats, options);
    } catch (error) {
      const existing = results.get(canonical);
      if (existing) {
        existing.roles.push(role);
        continue;
      }
      const inventory = newInventory(canonical, role);
      inventory.status = "unavailable";
      issue(inventory, "", errorReason(error));
      results.set(canonical, inventory);
    }
  }
  return [...results.values()];
}
var categoryLabels = {
  dependencies: "Dependency directories",
  gitMetadata: "Git metadata",
  runtimeControl: "Lark turn-control files",
  links: "Symlinks (targets not scanned)",
  other: "Other / ownership unknown"
};
function formatWorkspaceStorage(roots) {
  const formatBytes = (bytes) => bytes === null ? "unavailable" : `${bytes} B`;
  const formatUsage = (value) => `${formatBytes(value.allocatedBytes)} allocated; ${formatBytes(value.apparentBytes)} apparent; ${value.entries} entries`;
  const lines = [
    "Workspace storage inventory (read-only; no cleanup eligibility inferred).",
    "Sizes are per root, not additive for overlapping roots or a reclaim estimate."
  ];
  for (const root of roots) {
    lines.push("", `${JSON.stringify(root.directory)} [${root.roles.join(", ")}] (${root.status})`);
    if (root.total) {
      lines.push(`  ${formatUsage(root.total)}`);
      for (const [category, value] of Object.entries(root.categories)) {
        if (value.entries > 0) lines.push(`  ${categoryLabels[category]}: ${formatUsage(value)}`);
      }
      if (root.largestEntries.length > 0) lines.push("  Largest entries:");
      for (const entry of root.largestEntries) {
        lines.push(`    ${JSON.stringify(entry.path)}: ${formatUsage(entry)}`);
      }
    }
    if (root.issueCount > 0) lines.push(`  Incomplete scan: ${root.issueCount} issue(s).`);
    for (const entry of root.issues) lines.push(`    ${JSON.stringify(entry.path)}: ${entry.reason}`);
  }
  return lines.join("\n");
}

// src/workspace-cleanup-preview.ts
import fs2 from "node:fs/promises";
import path4 from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// src/durable-run/workspace-cleanup-ledger.ts
import fs from "node:fs/promises";
import path2 from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
var maxSnapshotBytes = 128n * 1024n * 1024n;
var WorkspaceCleanupLedgerError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
  code;
};
function fail(code) {
  throw new WorkspaceCleanupLedgerError(code);
}
function fileStamp(info) {
  return [info.dev, info.ino, info.uid, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(":");
}
async function optionalStat(filename) {
  return fs.lstat(filename, { bigint: true }).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return void 0;
  });
}
async function observe(databasePath) {
  if (!path2.isAbsolute(databasePath) || path2.normalize(databasePath) !== databasePath || !process.geteuid) fail("ledger_unavailable");
  const parentPath = path2.dirname(databasePath);
  const parent = await pinWorkspacePath(parentPath, ".");
  if (parent.directory !== parentPath) fail("ledger_unavailable");
  await assertProtectedWorkspacePath(parent, true);
  const walPath = `${databasePath}-wal`;
  const journalPath = `${databasePath}-journal`;
  const infos = await Promise.all([databasePath, walPath, journalPath].map(optionalStat));
  const [database, wal, journal] = infos;
  if (!database || journal) fail("ledger_unavailable");
  const uid = BigInt(process.geteuid());
  const files = [{ filename: databasePath, info: database }, ...wal ? [{ filename: walPath, info: wal }] : []];
  for (const { info } of files) {
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o022n) !== 0n || info.nlink !== 1n || `${info.dev}` !== parent.device) fail("ledger_unavailable");
  }
  if (files.reduce((total, { info }) => total + info.size, 0n) > maxSnapshotBytes) fail("ledger_snapshot_limit");
  await assertDenyOnlyWorkspaceAcls(files.map(({ filename }) => filename));
  const stamp = createHash("sha256").update(JSON.stringify([parent.device, parent.inode, ...files.map(({ info }) => fileStamp(info))])).digest("hex");
  return { files, stamp };
}
async function verifyWorkspaceCleanupLedger(databasePath, expected) {
  try {
    return (await observe(databasePath)).stamp === expected;
  } catch {
    return false;
  }
}
async function copyObservedFile(filename, expected, destination) {
  const input = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stamp = fileStamp(expected);
    if (fileStamp(await input.stat({ bigint: true })) !== stamp) fail("ledger_changed");
    const output = await fs.open(destination, "wx", 384);
    try {
      const buffer = Buffer.allocUnsafe(128 * 1024);
      for (let remaining = Number(expected.size); remaining > 0; ) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(remaining, buffer.length), null);
        if (bytesRead === 0) fail("ledger_changed");
        for (let offset = 0; offset < bytesRead; ) {
          const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
          if (bytesWritten === 0) fail("ledger_unavailable");
          offset += bytesWritten;
        }
        remaining -= bytesRead;
      }
    } finally {
      await output.close();
    }
    if (fileStamp(await input.stat({ bigint: true })) !== stamp) fail("ledger_changed");
  } finally {
    await input.close();
  }
}
async function readWorkspaceCleanupLedger(databasePath, read, validateTemporaryDestination) {
  try {
    const { files, stamp } = await observe(databasePath);
    const tempParent = await pinWorkspacePath(await fs.realpath("/tmp"), ".");
    const leaf = `lark-cleanup-preview-${randomBytes(12).toString("hex")}`;
    await validateTemporaryDestination(path2.join(tempParent.directory, leaf));
    const temporary = await mkdirTemporaryInsidePinnedRoot(tempParent, leaf);
    try {
      const snapshot = path2.join(temporary.directory, "ledger.sqlite");
      for (const [index, { filename, info }] of files.entries()) {
        await copyObservedFile(filename, info, index === 0 ? snapshot : `${snapshot}-wal`);
      }
      if (!await verifyWorkspaceCleanupLedger(databasePath, stamp)) fail("ledger_changed");
      const database = new DatabaseSync(snapshot, { readOnly: true, timeout: 0 });
      let value;
      try {
        value = read(database);
      } finally {
        database.close();
      }
      if (!await verifyWorkspaceCleanupLedger(databasePath, stamp)) fail("ledger_changed");
      return { stamp, value };
    } finally {
      await assertProtectedWorkspacePath(temporary, true);
      await fs.rm(temporary.directory, { recursive: true, force: true });
    }
  } catch (error) {
    if (error instanceof WorkspaceCleanupLedgerError) throw error;
    return fail("ledger_unavailable");
  }
}

// src/durable-run/workspace-cleanup-references.ts
import path3 from "node:path";
var maxCleanupPreviewRows = 100;
var maxRetryReferences = 4096;
var maxPathReferences = 1024;
function readWorkspaceCleanupReferences(database, root) {
  const retries = database.prepare(`SELECT json_extract(input_json, '$.job.retryOfJobId') AS source
    FROM durable_runs WHERE workload_kind = 'async_task' AND deleted_at IS NULL
      AND json_type(input_json, '$.job.retryOfJobId') = 'text' LIMIT ?`).all(maxRetryReferences + 1);
  const incomplete = retries.length > maxRetryReferences;
  const retrySource = new Set(retries.map(({ source }) => source));
  const prefix = root.directory + path3.sep;
  const upper = root.directory + String.fromCharCode(path3.sep.charCodeAt(0) + 1);
  const selected = database.prepare(`SELECT w.*, r.status AS run_status, r.completed_at AS terminal_at,
    r.retained AS run_retained, (r.lease_owner IS NOT NULL OR r.lease_expires_at IS NOT NULL) AS has_lease,
    r.attempt_count, EXISTS(SELECT 1 FROM durable_attempts a WHERE a.run_id = r.run_id) AS has_attempt,
    EXISTS(SELECT 1 FROM durable_outbox o WHERE o.run_id = r.run_id AND (o.status NOT IN ('sent', 'superseded')
      OR o.lease_expires_at IS NOT NULL OR o.worker_id IS NOT NULL)) AS unsettled_delivery,
    EXISTS(SELECT 1 FROM durable_outbox o WHERE o.run_id = r.run_id AND o.status = 'sent'
      AND o.kind = CASE w.workload_kind WHEN 'async_task' THEN 'terminal' WHEN 'cron_prompt' THEN 'cron_terminal' END
      AND o.message_id IS NOT NULL) AS terminal_delivery_sent,
    EXISTS(SELECT 1 FROM workspace_foreground_artifacts f WHERE w.workload_kind = 'foreground' AND f.run_id = w.run_id
      AND (json_extract(f.batch_json, '$.version') IS NOT 2 OR json_extract(f.batch_json, '$.reply.status') IS NOT 'sent'
      OR json_type(f.batch_json, '$.files') IS NOT 'array' OR EXISTS(SELECT 1 FROM json_each(f.batch_json, '$.files') part
        WHERE json_extract(part.value, '$.status') IS NOT 'sent'))) AS foreground_delivery_pending,
    (EXISTS(SELECT 1 FROM workspace_retry_artifact_stages s WHERE w.workload_kind = 'async_task' AND s.run_id = w.run_id)
      OR EXISTS(SELECT 1 FROM workspace_dependency_installs i WHERE i.workload_kind = w.workload_kind
      AND i.run_id = w.run_id AND i.receipt_json IS NULL)) AS pending_stage
    FROM workspace_run_allocations w LEFT JOIN durable_runs r ON r.run_id = w.run_id AND r.workload_kind = w.workload_kind
    WHERE w.scratch_path >= ? AND w.scratch_path < ? ORDER BY w.scratch_path LIMIT ?`).all(prefix, upper, maxCleanupPreviewRows + 1);
  const references = [];
  let invalidRows = 0;
  for (const row of selected.slice(0, maxCleanupPreviewRows)) {
    const owner = managedRunOwnerSchema.safeParse({ kind: row.workload_kind, runId: row.run_id });
    if (!owner.success || row.scratch_path !== managedRunDirectoryPath(root, owner.data)) {
      invalidRows++;
      continue;
    }
    let record;
    let allocationError;
    try {
      record = parseManagedWorkspaceRecord(owner.data, row);
    } catch (error) {
      allocationError = error instanceof ManagedWorkspaceStorageError && error.code === "allocation_incomplete" ? "allocation_incomplete" : "allocation_invalid";
    }
    references.push({
      leaf: path3.basename(row.scratch_path),
      owner: owner.data,
      record,
      allocationError,
      runStatus: typeof row.run_status === "string" ? row.run_status : null,
      terminalAt: typeof row.terminal_at === "string" ? row.terminal_at : null,
      retained: row.run_retained !== 0,
      lease: row.has_lease === 1,
      attemptExists: row.has_attempt === 1,
      attemptCount: typeof row.attempt_count === "number" || typeof row.attempt_count === "bigint" ? row.attempt_count : null,
      unsettledDelivery: row.unsettled_delivery === 1,
      terminalDeliverySent: row.terminal_delivery_sent === 1,
      foregroundDeliveryPending: row.foreground_delivery_pending === 1,
      retryReference: incomplete || retrySource.has(owner.data.runId),
      pendingStage: row.pending_stage === 1
    });
  }
  return {
    references,
    invalidRows,
    truncated: selected.length > maxCleanupPreviewRows || incomplete,
    paths: readProtectedPathReferences(database)
  };
}
function readProtectedPathReferences(database) {
  const paths = /* @__PURE__ */ new Set();
  let incomplete = false;
  let unresolvedActiveCron = false;
  const add = (value, required = false) => {
    if (value === null && !required) return;
    if (typeof value !== "string" || !path3.isAbsolute(value) || path3.normalize(value) !== value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value) || paths.size >= maxPathReferences) {
      incomplete = true;
      return;
    }
    paths.add(value);
  };
  const saved = database.prepare(`SELECT json_extract(intent_json, '$.project.directory') AS project,
    json_extract(intent_json, '$.fallbackWorkspace.directory') AS fallback, NULL AS legacy
    FROM workspace_run_allocations
    WHERE json_type(intent_json, '$.project') IS NOT NULL OR json_type(intent_json, '$.fallbackWorkspace') IS NOT NULL
    UNION ALL SELECT json_extract(admission_json, '$.project.directory'), NULL, json_extract(admission_json, '$.fallbackCwd')
    FROM workspace_unmanaged_foreground LIMIT ?`).all(maxPathReferences + 1);
  if (saved.length > maxPathReferences) incomplete = true;
  for (const { project, fallback, legacy } of saved.slice(0, maxPathReferences)) {
    if (project === null && fallback === null && legacy === null) incomplete = true;
    add(project);
    add(fallback);
    add(legacy);
  }
  const jobs = database.prepare(`SELECT workload_kind, status, input_version,
    json_extract(input_json, '$.job.workingDirectory') AS cwd,
    json_extract(input_json, '$.job.permissions.filesystem.workspaceProject.directory') AS async_project,
    json_extract(input_json, '$.job.permissions.filesystem.requestedPaths') AS requested_paths,
    json_type(input_json, '$.job.permissions.filesystem.requestedPaths') AS requested_type,
    json_extract(input_json, '$.job.workspaceProject.directory') AS cron_project,
    json_extract(input_json, '$.managedWorkspace.fallbackWorkspace.directory') AS cron_fallback
    FROM durable_runs WHERE deleted_at IS NULL AND workload_kind IN ('async_task', 'cron_prompt')
    LIMIT ?`).all(maxPathReferences + 1);
  if (jobs.length > maxPathReferences) incomplete = true;
  for (const job of jobs.slice(0, maxPathReferences)) {
    if (job.input_version !== 1) {
      incomplete = true;
      continue;
    }
    if (job.workload_kind === "async_task") {
      add(job.cwd, true);
      add(job.async_project);
      if (job.requested_type === "array" && typeof job.requested_paths === "string" && job.requested_paths.length <= 64 * 1024) {
        let parsed;
        try {
          parsed = JSON.parse(job.requested_paths);
        } catch {
          incomplete = true;
        }
        if (Array.isArray(parsed) && parsed.length <= 100) for (const entry of parsed) add(entry, true);
        else incomplete = true;
      } else incomplete = true;
    } else {
      add(job.cron_project);
      add(job.cron_fallback);
      if (job.cron_project === null && job.cron_fallback === null && !["completed", "partial", "blocked", "failed", "cancelled"].includes(String(job.status))) {
        unresolvedActiveCron = true;
      }
    }
  }
  return { paths: [...paths], incomplete, unresolvedActiveCron };
}

// src/workspace-cleanup-preview.ts
var day = 24 * 60 * 60 * 1e3;
var terminalStatuses = /* @__PURE__ */ new Set(["completed", "partial", "blocked", "failed", "cancelled"]);
var runStatuses = /* @__PURE__ */ new Set([...terminalStatuses, "queued", "running", "waiting_retry", "waiting_user", "recovering", "cancel_requested"]);
var maxRootNames = 256;
var exec = promisify(execFile);
async function previewWorkspaceCleanup(request) {
  const report = {
    readOnly: true,
    advisory: true,
    observedAt: request.now.toISOString(),
    minimumAgeDays: request.minimumAgeDays,
    scratchRoot: null,
    status: "complete",
    observations: [],
    entries: [],
    unregisteredObserved: 0
  };
  if (!Number.isSafeInteger(request.minimumAgeDays) || request.minimumAgeDays < 1 || request.minimumAgeDays > 3650) {
    return { ...report, status: "unavailable", observations: ["invalid_retention_policy"] };
  }
  const observeRoots = async () => {
    const roots = await readManagedWorkspaceRoots(request);
    if (!roots) return void 0;
    await resolveManagedGitSelection({ ...request, roots });
    const guard = await loadWorkspaceDependencyWriteGuard(request.configPath, { allowMissingCachesForStorage: true });
    await guard?.assertWrites([roots.scratch.directory]);
    const mounts = await readWorkspaceDependencyMountPolicy();
    if (!mounts.supports(roots.scratch.directory) || !mounts.supports(roots.artifacts.directory)) throw new Error("Unsupported layout.");
    return { roots, mounts, guard };
  };
  try {
    const layout = await observeRoots();
    if (!layout) return { ...report, status: "unavailable", observations: ["managed_storage_disabled"] };
    const { roots, mounts } = layout;
    report.scratchRoot = roots.scratch.directory;
    const snapshot = await readWorkspaceCleanupLedger(request.databasePath, (db) => readWorkspaceCleanupReferences(db, roots.scratch), async (temp) => {
      const authorized = await Promise.all(request.authorizedRoots.map((directory) => fs2.realpath(directory)));
      const protectedPaths = [roots.scratch.directory, roots.artifacts.directory, path4.dirname(request.databasePath), path4.dirname(request.configPath), ...authorized];
      const current = await observeRoots();
      if (!current || !sameWorkspaceProject(roots.scratch, current.roots.scratch) || !sameWorkspaceProject(roots.artifacts, current.roots.artifacts) || !current.mounts.supports(temp) || protectedPaths.some((protectedPath) => pathsOverlap(temp, protectedPath, current.mounts))) {
        throw new WorkspaceCleanupLedgerError("ledger_unavailable");
      }
      await current.guard?.assertNewDirectory(temp);
    });
    const { references, invalidRows, truncated, paths } = snapshot.value;
    const registered = new Set(references.map(({ leaf }) => leaf));
    let seen = 0;
    for await (const entry of await fs2.opendir(roots.scratch.directory)) {
      if (++seen > maxRootNames) {
        report.observations.push("directory_limit");
        break;
      }
      if (!truncated && !invalidRows && !registered.has(entry.name)) report.unregisteredObserved++;
    }
    if (truncated) report.observations.push("ledger_limit");
    if (invalidRows) report.observations.push("invalid_ledger_rows");
    if (report.unregisteredObserved) report.observations.push("unregistered_entries_retained");
    const candidates = /* @__PURE__ */ new Map();
    for (const reference of references) {
      const result = await inspect(reference, request, roots, mounts, truncated || invalidRows > 0);
      report.entries.push(result.entry);
      if (result.candidate) candidates.set(result.entry, result.candidate);
    }
    if (candidates.size > 0) {
      const current = await observeRoots().catch(() => void 0);
      if (!current || !sameWorkspaceProject(roots.scratch, current.roots.scratch) || !sameWorkspaceProject(roots.artifacts, current.roots.artifacts)) report.observations.push("policy_changed");
      const referenced = current && await resolveProtectedPaths(paths, request.authorizedRoots[0]);
      if (!referenced || !referenced.complete) report.observations.push("saved_references_unverified");
      for (const [entry, { binding, stamp }] of candidates) {
        if (!current || !supportsScratch(binding.directory, roots.scratch, current.mounts) || await directoryStamp(binding).catch(() => void 0) !== stamp) demote(entry, "directory_changed");
        if (current && referenced?.directories.some((directory) => pathsOverlap(binding.directory, directory, current.mounts))) {
          demote(entry, "saved_workspace_reference");
        }
      }
    }
    if (!await verifyWorkspaceCleanupLedger(request.databasePath, snapshot.stamp)) report.observations.push("ledger_changed");
    if (report.observations.some((reason) => reason !== "unregistered_entries_retained")) {
      report.status = "partial";
      for (const [entry] of candidates) demote(entry, "incomplete_observation");
    }
    return report;
  } catch (error) {
    return { ...report, status: "unavailable", entries: [], observations: [
      error instanceof WorkspaceCleanupLedgerError ? error.code : "workspace_policy_unavailable"
    ] };
  }
}
async function inspect(reference, request, roots, mounts, incomplete) {
  const entry = {
    leaf: reference.leaf,
    workload: reference.owner.kind,
    disposition: "retain",
    reasons: [],
    runStatus: reference.runStatus && runStatuses.has(reference.runStatus) ? reference.runStatus : "untracked"
  };
  const record = reference.record;
  if (!record) {
    entry.reasons.push(reference.allocationError ?? "allocation_invalid");
    return { entry };
  }
  const { allocation, lastUsedAt } = record;
  entry.lastUsedAt = lastUsedAt;
  if (!sameWorkspaceProject(allocation.roots.scratch, roots.scratch) || !sameWorkspaceProject(allocation.roots.artifacts, roots.artifacts)) {
    entry.reasons.push("historical_root");
    return { entry };
  }
  try {
    const { directory, device } = allocation.scratch;
    if (device !== roots.scratch.device || !supportsScratch(directory, roots.scratch, mounts)) {
      entry.reasons.push("unverified_mount");
      return { entry };
    }
    if (await validateManagedRunDirectory(allocation, "scratch", request.authorizedRoots) !== directory) throw new Error("Displaced scratch.");
    const stamp = await directoryStamp(allocation.scratch);
    const [inventory] = await inventoryWorkspaceStorage([{ role: "continuation", directory }], { maxEntries: 128, maxDepth: 4 });
    if (inventory.total) entry.usage = {
      apparentBytes: inventory.total.apparentBytes,
      allocatedBytes: inventory.total.allocatedBytes,
      complete: inventory.status === "complete"
    };
    if (inventory.status !== "complete") entry.reasons.push("usage_incomplete");
    if (reference.owner.kind === "foreground") {
      entry.reasons.push("foreground_quiescence_untracked");
      if (reference.foregroundDeliveryPending) entry.reasons.push("delivery_not_confirmed");
    } else if (!reference.runStatus) entry.reasons.push("run_missing");
    else if (!terminalStatuses.has(reference.runStatus) || reference.lease) entry.reasons.push("live_or_recoverable_run");
    else {
      if (reference.retained) entry.reasons.push("explicitly_retained");
      if (reference.unsettledDelivery || !reference.terminalDeliverySent) entry.reasons.push("delivery_not_confirmed");
      if (reference.attemptExists || reference.attemptCount !== 0 && reference.attemptCount !== 0n) entry.reasons.push("process_quiescence_unverified");
      const terminalAt = Date.parse(reference.terminalAt ?? "");
      const cutoff = request.now.getTime() - request.minimumAgeDays * day;
      if (!Number.isFinite(terminalAt) || terminalAt > cutoff || Date.parse(lastUsedAt) > cutoff) entry.reasons.push("retention_window");
    }
    if (reference.retryReference || reference.pendingStage) entry.reasons.push("retry_or_staging_reference");
    if (allocation.git || allocation.gitCheckout) entry.reasons.push("git_preservation_unverified");
    if (!entry.reasons.length && !await isPinnedScratchEmpty(allocation.scratch)) entry.reasons.push("scratch_contains_files");
    if (await directoryStamp(allocation.scratch) !== stamp) entry.reasons.push("directory_changed");
    if (incomplete) entry.reasons.push("incomplete_observation");
    if (!entry.reasons.length) {
      entry.disposition = "candidate";
      entry.reasons.push("expired_unused_scratch");
      return { entry, candidate: { binding: allocation.scratch, stamp } };
    }
  } catch {
    entry.reasons.push("directory_unverified");
  }
  return { entry };
}
function supportsScratch(directory, root, mounts) {
  if (!mounts.supports(directory) || path4.dirname(directory) !== root.directory) return false;
  const allowed = new Set(mounts.aliases(root.directory).map((alias) => path4.join(alias, path4.basename(directory))));
  return mounts.aliases(directory).every((alias) => allowed.has(alias));
}
async function directoryStamp(binding) {
  const observe2 = async () => {
    const stat = await fs2.lstat(binding.directory, { bigint: true });
    if (!stat.isDirectory() || `${stat.dev}` !== binding.device || `${stat.ino}` !== binding.inode || !process.geteuid || stat.uid !== BigInt(process.geteuid()) || (stat.mode & 0o022n) !== 0n) throw new Error("Displaced or unprotected directory.");
    return [stat.dev, stat.ino, stat.mode, stat.uid, stat.mtimeNs, stat.ctimeNs].join(":");
  };
  const stamp = await observe2();
  await assertDenyOnlyWorkspaceAcls([binding.directory]);
  if (await observe2() !== stamp) throw new Error("Directory permissions changed while reading.");
  return stamp;
}
async function isPinnedScratchEmpty(binding) {
  const program = `const fs = require('node:fs');
    const stat = fs.statSync('.', { bigint: true });
    if (String(stat.dev) !== process.argv[1] || String(stat.ino) !== process.argv[2] || !process.geteuid
      || stat.uid !== BigInt(process.geteuid()) || (stat.mode & 0o022n) !== 0n) process.exit(2);
    const directory = fs.opendirSync('.');
    try { process.stdout.write(directory.readSync() === null ? 'empty' : 'occupied'); } finally { directory.closeSync(); }`;
  const { stdout } = await exec(
    process.execPath,
    ["--input-type=commonjs", "-e", program, "--", binding.device, binding.inode],
    { cwd: binding.directory, env: {}, maxBuffer: 64, timeout: 5e3 }
  );
  if (stdout !== "empty" && stdout !== "occupied") throw new Error("Directory observation failed.");
  return stdout === "empty";
}
async function resolveProtectedPaths(input, execRoot) {
  let complete = !input.incomplete;
  const directories = new Set(input.paths);
  if (input.unresolvedActiveCron) directories.add(execRoot);
  for (const directory of [...directories]) {
    try {
      directories.add(await fs2.realpath(directory));
    } catch {
      complete = false;
    }
  }
  return { directories: [...directories], complete };
}
function pathsOverlap(left, right, mounts) {
  return mounts.aliases(left).some((a) => mounts.aliases(right).some((b) => mounts.contains(a, b) || mounts.contains(b, a)));
}
function demote(entry, reason) {
  if (entry.disposition === "candidate") entry.reasons = [];
  entry.disposition = "retain";
  entry.reasons.push(reason);
}
function formatWorkspaceCleanupPreview(report) {
  return [
    "Managed workspace cleanup preview (read-only, advisory).",
    `Observed: ${report.observedAt}; minimum age: ${report.minimumAgeDays} days; status: ${report.status}.`,
    `Protected: sources, caches, toolchains, formal artifacts, unknown or unregistered directories.`,
    `Unregistered entries observed: ${report.unregisteredObserved}.`,
    ...report.observations.map((reason) => `Observation: ${reason}`),
    ...report.entries.map(({ disposition, leaf, workload, runStatus, reasons, usage: usage2 }) => `${disposition}: ${leaf} (${workload}, ${runStatus})${usage2 ? `, ${usage2.apparentBytes} bytes${usage2.complete ? "" : " (partial)"}` : ""}: ${reasons.join(", ")}`)
  ].join("\n");
}

// src/configure-doctor-cli.ts
var silentLogger = {
  error: () => void 0,
  warn: () => void 0,
  info: () => void 0,
  debug: () => void 0,
  trace: () => void 0
};
var remoteProbe = async ({ appId, appSecret }) => {
  const client = new Lark.Client({
    appId,
    appSecret,
    logger: silentLogger,
    loggerLevel: Lark.LoggerLevel.error,
    source: "codex-lark-plugin-doctor"
  });
  const [scopeResponse, applicationResponse] = await Promise.all([
    client.application.scope.list({}),
    client.application.application.get({
      params: { lang: "en_us" },
      path: { app_id: appId }
    })
  ]);
  assertApiSuccess(scopeResponse);
  assertApiSuccess(applicationResponse);
  const app = applicationResponse.data?.app;
  return {
    appName: app?.app_name,
    appStatus: app?.status,
    callbackType: app?.callback_info?.callback_type,
    grantedScopes: (scopeResponse.data?.scopes ?? []).filter((scope) => scope.grant_status === 1 && scope.scope_type === "tenant").map((scope) => scope.scope_name),
    ...app?.event?.subscribed_events ? { subscribedEvents: app.event.subscribed_events } : {}
  };
};
function assertApiSuccess(response) {
  if ((response.code ?? 0) === 0) return;
  throw Object.assign(new Error("Lark API request failed."), { code: response.code });
}
async function main(args) {
  const configPath = path5.join(os.homedir(), ".codex", "channels", "lark", ".env");
  if (args.length === 0) {
    const report = await runConfigureDoctor({ configPath, remoteProbe });
    process.stderr.write(`${formatConfigureDoctorReport(report)}
`);
    process.exitCode = report.exitCode;
    return;
  }
  const modes = args.filter((arg) => arg !== "--json");
  if (modes.length !== 1 || args.length > 2 || !["--workspace-storage", "--workspace-cleanup-preview"].includes(modes[0])) {
    process.stderr.write("Usage: npm run doctor -- [(--workspace-storage | --workspace-cleanup-preview) [--json]]\n");
    process.exitCode = 1;
    return;
  }
  try {
    assertSupportedNodeVersion();
    const file = await readFile2(configPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const fileEnv = (0, import_dotenv2.parse)(file);
    const config = readConfigValues({
      env: {
        LARK_CODEX_EXEC_CWD: process.env.LARK_CODEX_EXEC_CWD ?? fileEnv.LARK_CODEX_EXEC_CWD,
        LARK_CONTINUATION_WORKING_ROOT: process.env.LARK_CONTINUATION_WORKING_ROOT ?? fileEnv.LARK_CONTINUATION_WORKING_ROOT,
        ...modes[0] === "--workspace-cleanup-preview" ? { LARK_CONTINUATION_RETENTION_DAYS: process.env.LARK_CONTINUATION_RETENTION_DAYS ?? fileEnv.LARK_CONTINUATION_RETENTION_DAYS } : {}
      },
      dryRun: true
    });
    if (modes[0] === "--workspace-cleanup-preview") {
      const report = await previewWorkspaceCleanup({
        configPath: managedWorkspaceConfigPath,
        sourceRegistryPath: path5.join(runtimeConfigDir, "workspace-projects.json"),
        databasePath: path5.join(continuationRuntimeDir, "jobs.sqlite"),
        authorizedRoots: [config.LARK_CODEX_EXEC_CWD, config.LARK_CONTINUATION_WORKING_ROOT],
        minimumAgeDays: config.LARK_CONTINUATION_RETENTION_DAYS,
        now: /* @__PURE__ */ new Date()
      });
      process.stdout.write(`${args.includes("--json") ? JSON.stringify(report, null, 2) : formatWorkspaceCleanupPreview(report)}
`);
      process.exitCode = report.status === "complete" ? 0 : 1;
      return;
    }
    const roots = await inventoryWorkspaceStorage([
      { role: "exec", directory: config.LARK_CODEX_EXEC_CWD },
      { role: "continuation", directory: config.LARK_CONTINUATION_WORKING_ROOT }
    ]);
    process.stdout.write(`${args.includes("--json") ? JSON.stringify({ readOnly: true, roots }, null, 2) : formatWorkspaceStorage(roots)}
`);
    process.exitCode = roots.every(({ status }) => status === "complete") ? 0 : 1;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(modes[0] === "--workspace-cleanup-preview" ? "Workspace cleanup preview could not read its local configuration.\n" : `Workspace storage inventory failed: ${detail}
`);
    process.exitCode = 1;
  }
}
await main(process.argv.slice(2));
