import { createRequire as __larkCreateRequire } from 'node:module'; import { fileURLToPath as __larkFileURLToPath } from 'node:url'; import { dirname as __larkPathDirname } from 'node:path'; const require = __larkCreateRequire(import.meta.url); const __filename = __larkFileURLToPath(import.meta.url); const __dirname = __larkPathDirname(__filename);
import {
  require_lib
} from "./chunks/chunk-H4O4G4QK.js";
import {
  __toESM,
  assertSupportedNodeVersion,
  readConfigValues,
  require_main
} from "./chunks/chunk-VT5EWFRM.js";

// src/configure-doctor-cli.ts
var Lark = __toESM(require_lib(), 1);
import os from "node:os";
import path from "node:path";

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
function formatConfigureDoctorReport(report2) {
  const counts = {
    PASS: report2.checks.filter((item) => item.status === "PASS").length,
    WARN: report2.checks.filter((item) => item.status === "WARN").length,
    FAIL: report2.checks.filter((item) => item.status === "FAIL").length
  };
  const lines = ["codex-lark-plugin doctor"];
  for (const item of report2.checks) {
    lines.push(`${item.status.padEnd(4)}  ${item.id}  ${item.detail}`);
    if (item.remediation) lines.push(`      remediation  ${item.remediation}`);
  }
  lines.push(`Summary: ${counts.PASS} PASS, ${counts.WARN} WARN, ${counts.FAIL} FAIL`);
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
var report = await runConfigureDoctor({
  configPath: path.join(os.homedir(), ".codex", "channels", "lark", ".env"),
  remoteProbe
});
process.stderr.write(`${formatConfigureDoctorReport(report)}
`);
process.exitCode = report.exitCode;
