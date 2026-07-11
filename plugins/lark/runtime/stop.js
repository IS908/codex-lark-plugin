import { createRequire as __larkCreateRequire } from 'node:module'; import { fileURLToPath as __larkFileURLToPath } from 'node:url'; import { dirname as __larkPathDirname } from 'node:path'; const require = __larkCreateRequire(import.meta.url); const __filename = __larkFileURLToPath(import.meta.url); const __dirname = __larkPathDirname(__filename);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/dotenv/package.json
var require_package = __commonJS({
  "node_modules/dotenv/package.json"(exports, module) {
    module.exports = {
      name: "dotenv",
      version: "16.6.1",
      description: "Loads environment variables from .env file",
      main: "lib/main.js",
      types: "lib/main.d.ts",
      exports: {
        ".": {
          types: "./lib/main.d.ts",
          require: "./lib/main.js",
          default: "./lib/main.js"
        },
        "./config": "./config.js",
        "./config.js": "./config.js",
        "./lib/env-options": "./lib/env-options.js",
        "./lib/env-options.js": "./lib/env-options.js",
        "./lib/cli-options": "./lib/cli-options.js",
        "./lib/cli-options.js": "./lib/cli-options.js",
        "./package.json": "./package.json"
      },
      scripts: {
        "dts-check": "tsc --project tests/types/tsconfig.json",
        lint: "standard",
        pretest: "npm run lint && npm run dts-check",
        test: "tap run --allow-empty-coverage --disable-coverage --timeout=60000",
        "test:coverage": "tap run --show-full-coverage --timeout=60000 --coverage-report=text --coverage-report=lcov",
        prerelease: "npm test",
        release: "standard-version"
      },
      repository: {
        type: "git",
        url: "git://github.com/motdotla/dotenv.git"
      },
      homepage: "https://github.com/motdotla/dotenv#readme",
      funding: "https://dotenvx.com",
      keywords: [
        "dotenv",
        "env",
        ".env",
        "environment",
        "variables",
        "config",
        "settings"
      ],
      readmeFilename: "README.md",
      license: "BSD-2-Clause",
      devDependencies: {
        "@types/node": "^18.11.3",
        decache: "^4.6.2",
        sinon: "^14.0.1",
        standard: "^17.0.0",
        "standard-version": "^9.5.0",
        tap: "^19.2.0",
        typescript: "^4.8.4"
      },
      engines: {
        node: ">=12"
      },
      browser: {
        fs: false
      }
    };
  }
});

// node_modules/dotenv/lib/main.js
var require_main = __commonJS({
  "node_modules/dotenv/lib/main.js"(exports, module) {
    var fs = __require("fs");
    var path3 = __require("path");
    var os3 = __require("os");
    var crypto = __require("crypto");
    var packageJson = require_package();
    var version = packageJson.version;
    var LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;
    function parse(src) {
      const obj = {};
      let lines = src.toString();
      lines = lines.replace(/\r\n?/mg, "\n");
      let match;
      while ((match = LINE.exec(lines)) != null) {
        const key = match[1];
        let value = match[2] || "";
        value = value.trim();
        const maybeQuote = value[0];
        value = value.replace(/^(['"`])([\s\S]*)\1$/mg, "$2");
        if (maybeQuote === '"') {
          value = value.replace(/\\n/g, "\n");
          value = value.replace(/\\r/g, "\r");
        }
        obj[key] = value;
      }
      return obj;
    }
    function _parseVault(options) {
      options = options || {};
      const vaultPath = _vaultPath(options);
      options.path = vaultPath;
      const result = DotenvModule.configDotenv(options);
      if (!result.parsed) {
        const err = new Error(`MISSING_DATA: Cannot parse ${vaultPath} for an unknown reason`);
        err.code = "MISSING_DATA";
        throw err;
      }
      const keys = _dotenvKey(options).split(",");
      const length = keys.length;
      let decrypted;
      for (let i = 0; i < length; i++) {
        try {
          const key = keys[i].trim();
          const attrs = _instructions(result, key);
          decrypted = DotenvModule.decrypt(attrs.ciphertext, attrs.key);
          break;
        } catch (error) {
          if (i + 1 >= length) {
            throw error;
          }
        }
      }
      return DotenvModule.parse(decrypted);
    }
    function _warn(message) {
      console.log(`[dotenv@${version}][WARN] ${message}`);
    }
    function _debug(message) {
      console.log(`[dotenv@${version}][DEBUG] ${message}`);
    }
    function _log(message) {
      console.log(`[dotenv@${version}] ${message}`);
    }
    function _dotenvKey(options) {
      if (options && options.DOTENV_KEY && options.DOTENV_KEY.length > 0) {
        return options.DOTENV_KEY;
      }
      if (process.env.DOTENV_KEY && process.env.DOTENV_KEY.length > 0) {
        return process.env.DOTENV_KEY;
      }
      return "";
    }
    function _instructions(result, dotenvKey) {
      let uri;
      try {
        uri = new URL(dotenvKey);
      } catch (error) {
        if (error.code === "ERR_INVALID_URL") {
          const err = new Error("INVALID_DOTENV_KEY: Wrong format. Must be in valid uri format like dotenv://:key_1234@dotenvx.com/vault/.env.vault?environment=development");
          err.code = "INVALID_DOTENV_KEY";
          throw err;
        }
        throw error;
      }
      const key = uri.password;
      if (!key) {
        const err = new Error("INVALID_DOTENV_KEY: Missing key part");
        err.code = "INVALID_DOTENV_KEY";
        throw err;
      }
      const environment = uri.searchParams.get("environment");
      if (!environment) {
        const err = new Error("INVALID_DOTENV_KEY: Missing environment part");
        err.code = "INVALID_DOTENV_KEY";
        throw err;
      }
      const environmentKey = `DOTENV_VAULT_${environment.toUpperCase()}`;
      const ciphertext = result.parsed[environmentKey];
      if (!ciphertext) {
        const err = new Error(`NOT_FOUND_DOTENV_ENVIRONMENT: Cannot locate environment ${environmentKey} in your .env.vault file.`);
        err.code = "NOT_FOUND_DOTENV_ENVIRONMENT";
        throw err;
      }
      return { ciphertext, key };
    }
    function _vaultPath(options) {
      let possibleVaultPath = null;
      if (options && options.path && options.path.length > 0) {
        if (Array.isArray(options.path)) {
          for (const filepath of options.path) {
            if (fs.existsSync(filepath)) {
              possibleVaultPath = filepath.endsWith(".vault") ? filepath : `${filepath}.vault`;
            }
          }
        } else {
          possibleVaultPath = options.path.endsWith(".vault") ? options.path : `${options.path}.vault`;
        }
      } else {
        possibleVaultPath = path3.resolve(process.cwd(), ".env.vault");
      }
      if (fs.existsSync(possibleVaultPath)) {
        return possibleVaultPath;
      }
      return null;
    }
    function _resolveHome(envPath2) {
      return envPath2[0] === "~" ? path3.join(os3.homedir(), envPath2.slice(1)) : envPath2;
    }
    function _configVault(options) {
      const debug = Boolean(options && options.debug);
      const quiet = options && "quiet" in options ? options.quiet : true;
      if (debug || !quiet) {
        _log("Loading env from encrypted .env.vault");
      }
      const parsed = DotenvModule._parseVault(options);
      let processEnv = process.env;
      if (options && options.processEnv != null) {
        processEnv = options.processEnv;
      }
      DotenvModule.populate(processEnv, parsed, options);
      return { parsed };
    }
    function configDotenv(options) {
      const dotenvPath = path3.resolve(process.cwd(), ".env");
      let encoding = "utf8";
      const debug = Boolean(options && options.debug);
      const quiet = options && "quiet" in options ? options.quiet : true;
      if (options && options.encoding) {
        encoding = options.encoding;
      } else {
        if (debug) {
          _debug("No encoding is specified. UTF-8 is used by default");
        }
      }
      let optionPaths = [dotenvPath];
      if (options && options.path) {
        if (!Array.isArray(options.path)) {
          optionPaths = [_resolveHome(options.path)];
        } else {
          optionPaths = [];
          for (const filepath of options.path) {
            optionPaths.push(_resolveHome(filepath));
          }
        }
      }
      let lastError;
      const parsedAll = {};
      for (const path4 of optionPaths) {
        try {
          const parsed = DotenvModule.parse(fs.readFileSync(path4, { encoding }));
          DotenvModule.populate(parsedAll, parsed, options);
        } catch (e) {
          if (debug) {
            _debug(`Failed to load ${path4} ${e.message}`);
          }
          lastError = e;
        }
      }
      let processEnv = process.env;
      if (options && options.processEnv != null) {
        processEnv = options.processEnv;
      }
      DotenvModule.populate(processEnv, parsedAll, options);
      if (debug || !quiet) {
        const keysCount = Object.keys(parsedAll).length;
        const shortPaths = [];
        for (const filePath of optionPaths) {
          try {
            const relative = path3.relative(process.cwd(), filePath);
            shortPaths.push(relative);
          } catch (e) {
            if (debug) {
              _debug(`Failed to load ${filePath} ${e.message}`);
            }
            lastError = e;
          }
        }
        _log(`injecting env (${keysCount}) from ${shortPaths.join(",")}`);
      }
      if (lastError) {
        return { parsed: parsedAll, error: lastError };
      } else {
        return { parsed: parsedAll };
      }
    }
    function config2(options) {
      if (_dotenvKey(options).length === 0) {
        return DotenvModule.configDotenv(options);
      }
      const vaultPath = _vaultPath(options);
      if (!vaultPath) {
        _warn(`You set DOTENV_KEY but you are missing a .env.vault file at ${vaultPath}. Did you forget to build it?`);
        return DotenvModule.configDotenv(options);
      }
      return DotenvModule._configVault(options);
    }
    function decrypt(encrypted, keyStr) {
      const key = Buffer.from(keyStr.slice(-64), "hex");
      let ciphertext = Buffer.from(encrypted, "base64");
      const nonce = ciphertext.subarray(0, 12);
      const authTag = ciphertext.subarray(-16);
      ciphertext = ciphertext.subarray(12, -16);
      try {
        const aesgcm = crypto.createDecipheriv("aes-256-gcm", key, nonce);
        aesgcm.setAuthTag(authTag);
        return `${aesgcm.update(ciphertext)}${aesgcm.final()}`;
      } catch (error) {
        const isRange = error instanceof RangeError;
        const invalidKeyLength = error.message === "Invalid key length";
        const decryptionFailed = error.message === "Unsupported state or unable to authenticate data";
        if (isRange || invalidKeyLength) {
          const err = new Error("INVALID_DOTENV_KEY: It must be 64 characters long (or more)");
          err.code = "INVALID_DOTENV_KEY";
          throw err;
        } else if (decryptionFailed) {
          const err = new Error("DECRYPTION_FAILED: Please check your DOTENV_KEY");
          err.code = "DECRYPTION_FAILED";
          throw err;
        } else {
          throw error;
        }
      }
    }
    function populate(processEnv, parsed, options = {}) {
      const debug = Boolean(options && options.debug);
      const override = Boolean(options && options.override);
      if (typeof parsed !== "object") {
        const err = new Error("OBJECT_REQUIRED: Please check the processEnv argument being passed to populate");
        err.code = "OBJECT_REQUIRED";
        throw err;
      }
      for (const key of Object.keys(parsed)) {
        if (Object.prototype.hasOwnProperty.call(processEnv, key)) {
          if (override === true) {
            processEnv[key] = parsed[key];
          }
          if (debug) {
            if (override === true) {
              _debug(`"${key}" is already defined and WAS overwritten`);
            } else {
              _debug(`"${key}" is already defined and was NOT overwritten`);
            }
          }
        } else {
          processEnv[key] = parsed[key];
        }
      }
    }
    var DotenvModule = {
      configDotenv,
      _configVault,
      _parseVault,
      config: config2,
      decrypt,
      parse,
      populate
    };
    module.exports.configDotenv = DotenvModule.configDotenv;
    module.exports._configVault = DotenvModule._configVault;
    module.exports._parseVault = DotenvModule._parseVault;
    module.exports.config = DotenvModule.config;
    module.exports.decrypt = DotenvModule.decrypt;
    module.exports.parse = DotenvModule.parse;
    module.exports.populate = DotenvModule.populate;
    module.exports = DotenvModule;
  }
});

// src/stop.ts
import os2 from "node:os";
import path2 from "node:path";

// src/config.ts
var import_dotenv = __toESM(require_main(), 1);
import path from "node:path";
import os from "node:os";
var envPath = path.join(os.homedir(), ".codex", "channels", "lark", ".env");
(0, import_dotenv.config)({ path: envPath });
var channelHome = path.join(os.homedir(), ".codex", "channels", "lark");
var runtimeConfigDir = path.join(channelHome, "runtime-config");
var logsDir = path.join(channelHome, "logs");
var defaultCodexExecCwd = path.join(channelHome, "codex-exec-workdir");
var isDryRun = process.argv.includes("--dry-run");
function required(key) {
  const val = process.env[key];
  if (!val && isDryRun && (key === "LARK_APP_ID" || key === "LARK_APP_SECRET")) {
    return `dry_run_${key.toLowerCase()}`;
  }
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}
function optional(key, fallback) {
  return process.env[key] || fallback;
}
function optionalAllowEmpty(key, fallback) {
  const val = process.env[key];
  return val === void 0 ? fallback : val;
}
function optionalNumber(key, fallback) {
  const val = process.env[key];
  if (!val) return fallback;
  const parsed = Number(val);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${key}: ${val}. Expected a number.`);
  return parsed;
}
function optionalPositiveNumber(key, fallback) {
  const parsed = optionalNumber(key, fallback);
  if (parsed <= 0) throw new Error(`Invalid ${key}: ${parsed}. Expected a positive number.`);
  return parsed;
}
function optionalNonNegativeNumber(key, fallback) {
  const parsed = optionalNumber(key, fallback);
  if (parsed < 0) throw new Error(`Invalid ${key}: ${parsed}. Expected a non-negative number.`);
  return parsed;
}
function optionalBoolean(key, fallback) {
  const val = process.env[key];
  if (!val) return fallback;
  return ["1", "true", "yes", "on"].includes(val.toLowerCase());
}
function optionalChoice(key, fallback, choices) {
  const val = process.env[key] || fallback;
  if (choices.includes(val)) return val;
  throw new Error(`Invalid ${key}: ${val}. Expected one of: ${choices.join(", ")}`);
}
function rejectRemovedChannelRuntime() {
  const key = "LARK_CHANNEL_RUNTIME";
  const value = process.env[key]?.trim();
  if (!value || value === "sdk") return;
  if (value === "legacy") {
    throw new Error(`${key}=legacy has been removed. The SDK channel runtime is always used; roll back by installing v1.12.3 or earlier.`);
  }
  throw new Error(`Invalid ${key}: ${value}. ${key} is no longer supported; leave it unset or use sdk.`);
}
rejectRemovedChannelRuntime();
function rejectRemovedCodexDeliveryMode() {
  const key = "LARK_CODEX_DELIVERY_MODE";
  const value = process.env[key]?.trim();
  if (!value || value === "exec") return;
  if (value === "notification") {
    throw new Error(`${key}=notification has been removed. Codex exec delivery is always used; roll back by installing v1.12.4 or earlier.`);
  }
  throw new Error(`Invalid ${key}: ${value}. ${key} is no longer supported; leave it unset or use exec.`);
}
rejectRemovedCodexDeliveryMode();
var codexExecTimeoutMs = optionalPositiveNumber("LARK_CODEX_EXEC_TIMEOUT_MS", 10 * 60 * 1e3);
var codexExecReplyBufferMs = 6e4;
function optionalQueueHandlerTimeoutMs() {
  const minimumWithReplyBuffer = codexExecTimeoutMs + codexExecReplyBufferMs;
  const parsed = optionalNonNegativeNumber("LARK_QUEUE_HANDLER_TIMEOUT_MS", minimumWithReplyBuffer);
  if (parsed === 0) return 0;
  return Math.max(parsed, minimumWithReplyBuffer);
}
var appConfig = {
  // Required
  appId: required("LARK_APP_ID"),
  appSecret: required("LARK_APP_SECRET"),
  textChunkLimit: optionalPositiveNumber("LARK_TEXT_CHUNK_LIMIT", 4e3),
  ackEmoji: optional("LARK_ACK_EMOJI", "MeMeMe"),
  docCommentAckEmoji: optionalAllowEmpty("LARK_DOC_COMMENT_ACK_EMOJI", "THUMBSUP"),
  botMessageTrackerSize: optionalNonNegativeNumber("LARK_BOT_MESSAGE_TRACKER_SIZE", 500),
  queueHandlerTimeoutMs: optionalQueueHandlerTimeoutMs(),
  codexExecCommand: optional("LARK_CODEX_EXEC_COMMAND", "codex"),
  codexExecCwd: optional("LARK_CODEX_EXEC_CWD", defaultCodexExecCwd),
  codexExecTimeoutMs,
  codexExecSandbox: optionalChoice(
    "LARK_CODEX_EXEC_SANDBOX",
    "workspace-write",
    ["read-only", "workspace-write", "danger-full-access"]
  ),
  codexExecModel: process.env.LARK_CODEX_EXEC_MODEL || null,
  codexExecProfile: process.env.LARK_CODEX_EXEC_PROFILE || null,
  codexExecIgnoreUserConfig: optionalBoolean("LARK_CODEX_EXEC_IGNORE_USER_CONFIG", true),
  codexExecUseSessions: optionalBoolean("LARK_CODEX_EXEC_USE_SESSIONS", true),
  codexExecProgressEnabled: optionalBoolean("LARK_EXEC_PROGRESS_ENABLED", true),
  codexExecProgressMaxMessages: optionalPositiveNumber("LARK_EXEC_PROGRESS_MAX_MESSAGES", 3),
  codexExecProgressMaxChars: optionalPositiveNumber("LARK_EXEC_PROGRESS_MAX_CHARS", 300),
  codexExecProgressMinIntervalMs: optionalNonNegativeNumber("LARK_EXEC_PROGRESS_MIN_INTERVAL_MS", 15e3),
  codexExecProgressPollIntervalMs: optionalPositiveNumber("LARK_EXEC_PROGRESS_POLL_INTERVAL_MS", 250),
  codexExecToolTraceEnabled: optionalBoolean("LARK_CODEX_EXEC_TOOL_TRACE", false),
  codexExecToolTraceMode: optionalChoice(
    "LARK_CODEX_EXEC_TOOL_TRACE_MODE",
    "compact",
    ["compact", "full", "hidden"]
  ),
  cardFooterMetricsEnabled: optionalBoolean("LARK_CARD_FOOTER_METRICS_ENABLED", true),
  cardFooterMetricsTokenUsageThreshold: optionalNonNegativeNumber(
    "LARK_CARD_FOOTER_METRICS_TOKEN_USAGE_THRESHOLD",
    2e4
  ),
  codexSessionRetentionDays: optionalPositiveNumber("LARK_CODEX_SESSION_RETENTION_DAYS", 14),
  codexSessionRetentionScanIntervalHours: optionalNonNegativeNumber(
    "LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS",
    24
  ),
  codexSessionRetentionDryRun: optionalBoolean("LARK_CODEX_SESSION_RETENTION_DRY_RUN", false),
  sessionHealthEnabled: optionalBoolean("LARK_SESSION_HEALTH_ENABLED", false),
  sessionHealthTurnThreshold: optionalPositiveNumber("LARK_SESSION_HEALTH_TURN_THRESHOLD", 80),
  sessionHealthPromptBytesThreshold: optionalPositiveNumber(
    "LARK_SESSION_HEALTH_PROMPT_BYTES_THRESHOLD",
    512 * 1024
  ),
  sessionHealthTokenThreshold: optionalPositiveNumber("LARK_SESSION_HEALTH_TOKEN_THRESHOLD", 16e4),
  sessionHealthIdleDelayMs: optionalNonNegativeNumber("LARK_SESSION_HEALTH_IDLE_DELAY_MS", 3e4),
  sessionHealthCooldownMs: optionalPositiveNumber("LARK_SESSION_HEALTH_COOLDOWN_MS", 30 * 60 * 1e3),
  sessionHealthMaxCooldownMs: optionalPositiveNumber("LARK_SESSION_HEALTH_MAX_COOLDOWN_MS", 6 * 60 * 60 * 1e3),
  sessionHealthMaxNudges: optionalPositiveNumber("LARK_SESSION_HEALTH_MAX_NUDGES", 3),
  replyObligationTimeoutMs: optionalPositiveNumber(
    "LARK_REPLY_OBLIGATION_TIMEOUT_MS",
    Math.max(6e4, codexExecTimeoutMs + codexExecReplyBufferMs)
  ),
  cronScanInterval: optionalPositiveNumber("LARK_CRON_SCAN_INTERVAL", 60),
  cronTimezone: optional("LARK_CRON_TIMEZONE", Intl.DateTimeFormat().resolvedOptions().timeZone),
  feishuApiTimeoutMs: optionalNonNegativeNumber("LARK_FEISHU_API_TIMEOUT_MS", 3e4),
  feishuApiRetryAttempts: optionalPositiveNumber("LARK_FEISHU_API_RETRY_ATTEMPTS", 3),
  feishuApiRetryBaseDelayMs: optionalNonNegativeNumber("LARK_FEISHU_API_RETRY_BASE_DELAY_MS", 250),
  logMaxBytes: optionalNonNegativeNumber("LARK_LOG_MAX_BYTES", 5 * 1024 * 1024),
  logMaxFiles: optionalNonNegativeNumber("LARK_LOG_MAX_FILES", 5),
  logArchiveRetentionMonths: optionalNonNegativeNumber("LARK_LOG_ARCHIVE_RETENTION_MONTHS", 6),
  // Memory
  minSearchScore: optionalNonNegativeNumber("LARK_MIN_SEARCH_SCORE", 0.3),
  maxSearchResults: optionalPositiveNumber("LARK_MAX_SEARCH_RESULTS", 2),
  inactivityHours: optionalPositiveNumber("LARK_INACTIVITY_HOURS", 3),
  maxEpisodeBytes: optionalNonNegativeNumber("LARK_MAX_EPISODE_BYTES", 64 * 1024),
  maxEpisodeFilesPerScope: optionalNonNegativeNumber("LARK_MAX_EPISODE_FILES_PER_SCOPE", 200),
  maxEpisodeScopeBytes: optionalNonNegativeNumber("LARK_MAX_EPISODE_SCOPE_BYTES", 10 * 1024 * 1024),
  profileDistillationEnabled: optionalBoolean("LARK_PROFILE_DISTILLATION_ENABLED", false),
  profileDistillationMinEpisodes: optionalPositiveNumber("LARK_PROFILE_DISTILLATION_MIN_EPISODES", 3),
  profileDistillationMaxEpisodes: optionalPositiveNumber("LARK_PROFILE_DISTILLATION_MAX_EPISODES", 5),
  profileDistillationCooldownMs: optionalNonNegativeNumber(
    "LARK_PROFILE_DISTILLATION_COOLDOWN_MS",
    24 * 60 * 60 * 1e3
  ),
  memoryDedupWindowMs: optionalNonNegativeNumber("LARK_MEMORY_DEDUP_WINDOW_MS", 30 * 60 * 1e3),
  downloadMaxBytes: optionalPositiveNumber("LARK_DOWNLOAD_MAX_BYTES", 25 * 1024 * 1024),
  downloadTimeoutMs: optionalNonNegativeNumber("LARK_DOWNLOAD_TIMEOUT_MS", 6e4),
  inboxMaxAgeHours: optionalNonNegativeNumber("LARK_INBOX_MAX_AGE_HOURS", 168),
  inboxMaxBytes: optionalNonNegativeNumber("LARK_INBOX_MAX_BYTES", 200 * 1024 * 1024),
  // Identity / privacy
  ownerOpenId: process.env.LARK_OWNER_OPEN_ID || null,
  /**
   * Session entry TTL. Must comfortably exceed the buffer auto-flush window
   * (LARK_INACTIVITY_HOURS) so that save_memory / save_skill calls triggered
   * by a flush still resolve to the last real user of the chat.
   * Default: max(2h, inactivityHours × 2).
   */
  identitySessionTtlMs: optionalPositiveNumber(
    "LARK_IDENTITY_SESSION_TTL_MS",
    Math.max(
      2 * 60 * 60 * 1e3,
      optionalPositiveNumber("LARK_INACTIVITY_HOURS", 3) * 2 * 60 * 60 * 1e3
    )
  ),
  identitySessionMaxEntries: optionalPositiveNumber("LARK_IDENTITY_SESSION_MAX_ENTRIES", 5e3),
  nameCacheSize: optionalNonNegativeNumber("LARK_NAME_CACHE_SIZE", 1e3),
  chatTypeCacheSize: optionalNonNegativeNumber("LARK_CHAT_TYPE_CACHE_SIZE", 1e3),
  latestMessageTrackerSize: optionalNonNegativeNumber("LARK_LATEST_MESSAGE_TRACKER_SIZE", 1e3),
  cardContextCacheSize: optionalNonNegativeNumber("LARK_CARD_CONTEXT_CACHE_SIZE", 200),
  cardContextCacheTtlMs: optionalNonNegativeNumber("LARK_CARD_CONTEXT_CACHE_TTL_MS", 30 * 60 * 1e3),
  quotedContextMaxDepth: optionalPositiveNumber("LARK_QUOTED_CONTEXT_MAX_DEPTH", 4),
  quotedContextMaxBytes: optionalPositiveNumber("LARK_QUOTED_CONTEXT_MAX_BYTES", 12e3),
  quotedCardUserFetchEnabled: optionalBoolean("LARK_QUOTED_CARD_USER_FETCH_ENABLED", true),
  quotedCardUserFetchCommand: optional("LARK_QUOTED_CARD_USER_FETCH_COMMAND", "lark-cli"),
  quotedCardUserFetchTimeoutMs: optionalPositiveNumber("LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS", 1e4),
  quotedCardUserFetchMaxBytes: optionalPositiveNumber("LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES", 256 * 1024),
  // Paths
  memoriesDir: path.join(os.homedir(), ".codex", "channels", "lark", "memories"),
  inboxDir: path.join(os.homedir(), ".codex", "channels", "lark", "inbox"),
  jobsDir: path.join(os.homedir(), ".codex", "channels", "lark", "jobs"),
  codexExecSessionsDir: path.join(os.homedir(), ".codex", "channels", "lark", "codex-sessions"),
  runtimeConfigDir,
  accessControlConfigPath: path.join(runtimeConfigDir, "access-control.json"),
  localCliToolsConfigPath: path.join(runtimeConfigDir, "local-cli-tools.json"),
  privacyRulesPath: path.join(runtimeConfigDir, "privacy-rules.md"),
  debugLogPath: optional("LARK_DEBUG_LOG", path.join(logsDir, "debug.log")),
  auditLogPath: optional("LARK_AUDIT_LOG", path.join(logsDir, "audit.log")),
  codexExecTraceLogPath: optional(
    "LARK_CODEX_EXEC_TRACE_LOG",
    path.join(logsDir, "trace.log")
  )
};

// src/resource-governance.ts
import { execFile } from "node:child_process";
import {
  appendFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var gzipAsync = promisify(gzip);
function currentProcessStartedAt() {
  return Math.floor(Date.now() - process.uptime() * 1e3);
}
function defaultProcessExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function defaultProcessStartedAt(pid) {
  if (pid === process.pid) return currentProcessStartedAt();
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
    const raw = String(stdout).trim();
    if (!raw) return null;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
async function defaultProcessCommand(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(pid)]);
    const raw = String(stdout).trim();
    return raw || null;
  } catch {
    return null;
  }
}
async function defaultKillProcess(pid, signal) {
  process.kill(pid, signal);
}
function parseLock(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    const pid = Number(parsed?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const startedAt = Number(parsed?.startedAt);
    return {
      pid,
      ...Number.isFinite(startedAt) && startedAt > 0 ? { startedAt } : {},
      ...typeof parsed.createdAt === "string" ? { createdAt: parsed.createdAt } : {}
    };
  } catch {
    const pid = Number(trimmed);
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  }
}
function sameStartTime(a, b) {
  return Math.abs(a - b) <= 1e3;
}
function sameLockOwner(a, b) {
  if (!a) return false;
  if (a.pid !== b.pid) return false;
  if (b.startedAt !== void 0) return a.startedAt === b.startedAt;
  return true;
}
async function removeLockIfStillOwned(lockPath2, record) {
  const current = await readLockState(lockPath2);
  if (!current || !sameLockOwner(current.record, record)) return false;
  await removePathIfExists(lockPath2);
  return true;
}
function isCodexLarkProcessCommand(command) {
  const normalized = command.toLowerCase();
  return normalized.includes("codex-lark-plugin") || normalized.includes("scripts/start.sh") || normalized.includes("src/index.ts") && normalized.includes("tsx");
}
async function readLockState(lockPath2) {
  let s;
  try {
    s = await stat(lockPath2);
  } catch {
    return null;
  }
  const raw = await readFile(lockPath2, "utf-8").catch((err) => {
    console.error(`[resource-governance] Failed to read lock ${lockPath2}:`, err?.message ?? String(err));
    return "";
  });
  return { record: parseLock(raw), ageMs: Date.now() - s.mtimeMs };
}
async function removePathIfExists(filePath) {
  await rm(filePath, { recursive: true, force: true }).catch(() => void 0);
}
async function stopSingleInstanceLock(lockPath2, options = {}) {
  const processExists = options.processExists ?? defaultProcessExists;
  const getProcessStartedAt = options.getProcessStartedAt ?? defaultProcessStartedAt;
  const getProcessCommand = options.getProcessCommand ?? defaultProcessCommand;
  const killProcess = options.killProcess ?? defaultKillProcess;
  const isExpectedProcess = options.isExpectedProcess ?? isCodexLarkProcessCommand;
  const waitMs = Math.max(0, Math.floor(options.waitMs ?? 5e3));
  const sleepMs = Math.max(0, Math.floor(options.sleepMs ?? 100));
  const state = await readLockState(lockPath2);
  if (!state) {
    return {
      status: "no_lock",
      lockPath: lockPath2,
      message: `No codex-lark-plugin lock found at ${lockPath2}.`
    };
  }
  const record = state.record;
  if (!record) {
    return {
      status: "invalid_lock",
      lockPath: lockPath2,
      message: `Refusing to stop: lock file ${lockPath2} does not contain a valid PID.`
    };
  }
  const base = {
    lockPath: lockPath2,
    pid: record.pid,
    ...record.startedAt ? { startedAt: record.startedAt } : {}
  };
  const alive = await processExists(record.pid);
  if (!alive) {
    const removed = await removeLockIfStillOwned(lockPath2, record);
    return {
      ...base,
      status: "stale_lock_removed",
      message: removed ? `Removed stale codex-lark-plugin lock for non-running PID ${record.pid}.` : `Stale lock for PID ${record.pid} changed before cleanup; left it untouched.`
    };
  }
  if (record.startedAt) {
    const actualStartedAt = await getProcessStartedAt(record.pid);
    if (actualStartedAt !== null && !sameStartTime(actualStartedAt, record.startedAt)) {
      const removed = await removeLockIfStillOwned(lockPath2, record);
      return {
        ...base,
        status: "stale_lock_removed",
        message: removed ? `Removed stale codex-lark-plugin lock for reused PID ${record.pid}.` : `Stale lock for reused PID ${record.pid} changed before cleanup; left it untouched.`
      };
    }
  }
  const command = await getProcessCommand(record.pid);
  if (!command || !isExpectedProcess(command)) {
    return {
      ...base,
      command,
      status: "unrelated_process",
      message: `Refusing to stop PID ${record.pid}: it does not look like codex-lark-plugin. Command: ${command ?? "<unknown>"}. Lock left intact.`
    };
  }
  try {
    await killProcess(record.pid, "SIGTERM");
  } catch (err) {
    if (err?.code === "ESRCH") {
      const removed = await removeLockIfStillOwned(lockPath2, record);
      return {
        ...base,
        command,
        status: "stale_lock_removed",
        message: removed ? `Removed stale codex-lark-plugin lock after PID ${record.pid} disappeared.` : `PID ${record.pid} disappeared, but the lock changed before cleanup; left it untouched.`
      };
    }
    if (err?.code === "EPERM") {
      return {
        ...base,
        command,
        status: "permission_denied",
        message: `Permission denied while sending SIGTERM to PID ${record.pid}. Lock left intact.`
      };
    }
    throw err;
  }
  const deadline = Date.now() + waitMs;
  do {
    if (!await processExists(record.pid)) {
      const removed = await removeLockIfStillOwned(lockPath2, record);
      return {
        ...base,
        command,
        status: "process_terminated",
        message: removed ? `Stopped codex-lark-plugin PID ${record.pid} and removed its lock.` : `Stopped PID ${record.pid}, but the lock changed before cleanup; left it untouched.`
      };
    }
    if (record.startedAt) {
      const actualStartedAt = await getProcessStartedAt(record.pid);
      if (actualStartedAt !== null && !sameStartTime(actualStartedAt, record.startedAt)) {
        const removed = await removeLockIfStillOwned(lockPath2, record);
        return {
          ...base,
          command,
          status: "process_terminated",
          message: removed ? `Stopped codex-lark-plugin PID ${record.pid} and removed its lock after PID reuse check.` : `PID ${record.pid} changed, but the lock changed before cleanup; left it untouched.`
        };
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(sleepMs);
  } while (true);
  return {
    ...base,
    command,
    status: "process_still_running",
    message: `PID ${record.pid} still appears to be running after SIGTERM. Lock left intact.`
  };
}

// src/stop.ts
var lockPath = path2.join(os2.tmpdir(), `codex-lark-${appConfig.appId}.lock`);
var okStatuses = /* @__PURE__ */ new Set(["no_lock", "stale_lock_removed", "process_terminated"]);
try {
  const result = await stopSingleInstanceLock(lockPath);
  console.error(result.message);
  process.exit(okStatuses.has(result.status) ? 0 : 1);
} catch (err) {
  console.error(`[stop] Failed to stop codex-lark-plugin: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
