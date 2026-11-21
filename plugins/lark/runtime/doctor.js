import { createRequire as __larkCreateRequire } from 'node:module'; import { fileURLToPath as __larkFileURLToPath } from 'node:url'; import { dirname as __larkPathDirname } from 'node:path'; const require = __larkCreateRequire(import.meta.url); const __filename = __larkFileURLToPath(import.meta.url); const __dirname = __larkPathDirname(__filename);
import {
  require_lib
} from "./chunks/chunk-BQZ4X75D.js";
import {
  __toESM,
  assertSupportedNodeVersion,
  readConfigValues,
  require_main
} from "./chunks/chunk-WOBAO6HM.js";

// src/configure-doctor-cli.ts
var Lark = __toESM(require_lib(), 1);
var import_dotenv2 = __toESM(require_main(), 1);
import os from "node:os";
import path2 from "node:path";
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
  const configPath = path2.join(os.homedir(), ".codex", "channels", "lark", ".env");
  if (args.length === 0) {
    const report = await runConfigureDoctor({ configPath, remoteProbe });
    process.stderr.write(`${formatConfigureDoctorReport(report)}
`);
    process.exitCode = report.exitCode;
    return;
  }
  if (!args.includes("--workspace-storage") || args.some((arg) => arg !== "--workspace-storage" && arg !== "--json")) {
    process.stderr.write("Usage: npm run doctor -- [--workspace-storage [--json]]\n");
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
        LARK_CONTINUATION_WORKING_ROOT: process.env.LARK_CONTINUATION_WORKING_ROOT ?? fileEnv.LARK_CONTINUATION_WORKING_ROOT
      },
      dryRun: true
    });
    const roots = await inventoryWorkspaceStorage([
      { role: "exec", directory: config.LARK_CODEX_EXEC_CWD },
      { role: "continuation", directory: config.LARK_CONTINUATION_WORKING_ROOT }
    ]);
    process.stdout.write(`${args.includes("--json") ? JSON.stringify({ readOnly: true, roots }, null, 2) : formatWorkspaceStorage(roots)}
`);
    process.exitCode = roots.every(({ status }) => status === "complete") ? 0 : 1;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`Workspace storage inventory failed: ${detail}
`);
    process.exitCode = 1;
  }
}
await main(process.argv.slice(2));
