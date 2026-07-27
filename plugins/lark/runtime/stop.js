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

// plugins/lark/node_modules/dotenv/package.json
var require_package = __commonJS({
  "plugins/lark/node_modules/dotenv/package.json"(exports, module) {
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

// plugins/lark/node_modules/dotenv/lib/main.js
var require_main = __commonJS({
  "plugins/lark/node_modules/dotenv/lib/main.js"(exports, module) {
    var fs = __require("fs");
    var path4 = __require("path");
    var os4 = __require("os");
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
        possibleVaultPath = path4.resolve(process.cwd(), ".env.vault");
      }
      if (fs.existsSync(possibleVaultPath)) {
        return possibleVaultPath;
      }
      return null;
    }
    function _resolveHome(envPath2) {
      return envPath2[0] === "~" ? path4.join(os4.homedir(), envPath2.slice(1)) : envPath2;
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
      const dotenvPath = path4.resolve(process.cwd(), ".env");
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
      for (const path5 of optionPaths) {
        try {
          const parsed = DotenvModule.parse(fs.readFileSync(path5, { encoding }));
          DotenvModule.populate(parsedAll, parsed, options);
        } catch (e) {
          if (debug) {
            _debug(`Failed to load ${path5} ${e.message}`);
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
            const relative = path4.relative(process.cwd(), filePath);
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

// plugins/lark/src/config.ts
var import_dotenv = __toESM(require_main(), 1);
import path2 from "node:path";
import os2 from "node:os";

// plugins/lark/src/runtime-version.ts
var MINIMUM_NODE_VERSION = [24, 15, 0];
var MINIMUM_NODE_LABEL = MINIMUM_NODE_VERSION.join(".");
function parseNodeVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function compareVersion(actual, minimum) {
  for (let index = 0; index < Math.max(actual.length, minimum.length); index += 1) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
function assertSupportedNodeVersion(version = process.versions.node) {
  const parsed = parseNodeVersion(version);
  if (!parsed || compareVersion(parsed, MINIMUM_NODE_VERSION) < 0) {
    throw new Error(
      `Node.js >=${MINIMUM_NODE_LABEL} is required; current version is ${version}.`
    );
  }
}

// plugins/lark/src/config-schema.ts
import os from "node:os";
import path from "node:path";
function stringConfig(options) {
  return {
    type: "string",
    required: false,
    sensitive: false,
    ...options
  };
}
function numberConfig(options) {
  return {
    type: "number",
    required: false,
    sensitive: false,
    ...options
  };
}
function booleanConfig(options) {
  return {
    type: "boolean",
    required: false,
    sensitive: false,
    ...options
  };
}
function choiceConfig(choices, options) {
  return {
    type: "choice",
    choices,
    required: false,
    sensitive: false,
    ...options
  };
}
var positive = (message = "Expected a positive number.") => ({
  exclusiveMinimum: true,
  minimum: 0,
  message
});
var nonNegative = (message = "Expected a non-negative number.") => ({
  minimum: 0,
  message
});
var messaging = (en, zh, features = ["messaging"]) => ({
  category: "Messaging",
  description: { en, zh },
  features
});
var reliability = (en, zh) => ({
  category: "Reliability",
  description: { en, zh },
  features: ["lark-api"]
});
var memory = (en, zh) => ({
  category: "Memory",
  description: { en, zh },
  features: ["memory"]
});
var resources = (en, zh) => ({
  category: "Resource governance",
  description: { en, zh },
  features: ["resource-governance"]
});
var configSchema = {
  LARK_APP_ID: stringConfig({
    category: "Credentials",
    required: true,
    sensitive: false,
    defaultDisplay: "-",
    description: { en: "Feishu/Lark application ID.", zh: "\u98DE\u4E66/Lark \u5E94\u7528 ID\u3002" },
    features: ["bootstrap"],
    empty: "error"
  }),
  LARK_APP_SECRET: stringConfig({
    category: "Credentials",
    required: true,
    sensitive: true,
    defaultDisplay: "-",
    description: { en: "Feishu/Lark application secret.", zh: "\u98DE\u4E66/Lark \u5E94\u7528\u5BC6\u94A5\u3002" },
    features: ["bootstrap"],
    empty: "error"
  }),
  LARK_TEXT_CHUNK_LIMIT: numberConfig({
    ...messaging("Maximum characters per text message chunk.", "\u6BCF\u4E2A\u6587\u672C\u6D88\u606F\u5206\u7247\u7684\u6700\u5927\u5B57\u7B26\u6570\u3002"),
    default: 4e3,
    defaultDisplay: "4000",
    number: positive()
  }),
  LARK_QUEUE_HANDLER_TIMEOUT_MS: numberConfig({
    ...messaging(
      "Per-thread queue timeout; zero disables it and positive values are raised above the exec timeout.",
      "\u6BCF\u4E2A\u4F1A\u8BDD\u961F\u5217\u7684\u8D85\u65F6\uFF1B0 \u8868\u793A\u5173\u95ED\uFF0C\u6B63\u503C\u4F1A\u88AB\u63D0\u5347\u5230 exec \u8D85\u65F6\u4EE5\u4E0A\u3002"
    ),
    default: (context) => Number(context.get("LARK_CODEX_EXEC_TIMEOUT_MS")) + 6e4,
    defaultDisplay: "LARK_CODEX_EXEC_TIMEOUT_MS + 60000",
    number: nonNegative(),
    normalize: (value, context) => value === 0 ? 0 : Math.max(value, Number(context.get("LARK_CODEX_EXEC_TIMEOUT_MS")) + 6e4)
  }),
  LARK_REPLY_OBLIGATION_TIMEOUT_MS: numberConfig({
    ...messaging(
      "Maximum wait for a visible reply or defer result.",
      "\u7B49\u5F85\u53EF\u89C1\u56DE\u590D\u6216 defer \u7ED3\u679C\u7684\u6700\u957F\u65F6\u95F4\u3002"
    ),
    default: (context) => Math.max(6e4, Number(context.get("LARK_CODEX_EXEC_TIMEOUT_MS")) + 6e4),
    defaultDisplay: "max(60000, LARK_CODEX_EXEC_TIMEOUT_MS + 60000)",
    number: positive()
  }),
  LARK_CODEX_EXEC_COMMAND: stringConfig({
    ...messaging("Codex CLI command used for exec delivery.", "exec \u6295\u9012\u4F7F\u7528\u7684 Codex CLI \u547D\u4EE4\u3002"),
    default: "codex",
    defaultDisplay: "codex",
    empty: "default"
  }),
  LARK_CODEX_EXEC_CWD: stringConfig({
    ...messaging("Working directory for foreground Codex exec turns.", "\u524D\u53F0 Codex exec \u56DE\u5408\u7684\u5DE5\u4F5C\u76EE\u5F55\u3002"),
    default: ({ homeDir }) => path.join(homeDir, ".codex", "channels", "lark", "codex-exec-workdir"),
    defaultDisplay: "~/.codex/channels/lark/codex-exec-workdir",
    empty: "default"
  }),
  LARK_CODEX_EXEC_TIMEOUT_MS: numberConfig({
    ...messaging("Timeout for one foreground Codex exec run.", "\u5355\u6B21\u524D\u53F0 Codex exec \u8FD0\u884C\u8D85\u65F6\u3002"),
    default: 6e5,
    defaultDisplay: "600000",
    number: positive()
  }),
  LARK_CODEX_EXEC_SANDBOX: choiceConfig(
    ["read-only", "workspace-write", "danger-full-access"],
    {
      ...messaging("Sandbox mode passed to foreground Codex exec.", "\u4F20\u7ED9\u524D\u53F0 Codex exec \u7684\u6C99\u76D2\u6A21\u5F0F\u3002"),
      default: "workspace-write",
      defaultDisplay: "workspace-write"
    }
  ),
  LARK_CODEX_EXEC_MODEL: stringConfig({
    ...messaging("Optional global model override for Codex exec.", "Codex exec \u7684\u53EF\u9009\u5168\u5C40\u6A21\u578B\u8986\u76D6\u3002"),
    default: null,
    defaultDisplay: "(empty)",
    empty: "null",
    nullable: true
  }),
  LARK_CODEX_EXEC_PROFILE: stringConfig({
    ...messaging("Optional Codex configuration profile.", "\u53EF\u9009\u7684 Codex \u914D\u7F6E profile\u3002"),
    default: null,
    defaultDisplay: "(empty)",
    empty: "null",
    nullable: true
  }),
  LARK_CODEX_EXEC_IGNORE_USER_CONFIG: booleanConfig({
    ...messaging("Prevent child exec turns from loading user Codex configuration.", "\u963B\u6B62\u5B50 exec \u56DE\u5408\u52A0\u8F7D\u7528\u6237 Codex \u914D\u7F6E\u3002"),
    default: true,
    defaultDisplay: "true"
  }),
  LARK_CODEX_EXEC_USE_SESSIONS: booleanConfig({
    ...messaging("Resume one Codex session per Feishu chat or thread.", "\u6BCF\u4E2A\u98DE\u4E66\u4F1A\u8BDD\u6216\u8BDD\u9898\u590D\u7528\u4E00\u4E2A Codex session\u3002"),
    default: true,
    defaultDisplay: "true"
  }),
  LARK_EXEC_PROGRESS_ENABLED: booleanConfig({
    ...messaging("Enable bounded progress updates for long foreground turns.", "\u4E3A\u957F\u65F6\u95F4\u524D\u53F0\u56DE\u5408\u542F\u7528\u6709\u754C\u8FC7\u7A0B\u6D88\u606F\u3002"),
    default: true,
    defaultDisplay: "true"
  }),
  LARK_EXEC_PROGRESS_MAX_MESSAGES: numberConfig({
    ...messaging("Maximum progress messages per foreground turn.", "\u6BCF\u4E2A\u524D\u53F0\u56DE\u5408\u6700\u591A\u53D1\u9001\u7684\u8FC7\u7A0B\u6D88\u606F\u6570\u3002"),
    default: 3,
    defaultDisplay: "3",
    number: positive()
  }),
  LARK_EXEC_PROGRESS_MAX_CHARS: numberConfig({
    ...messaging("Maximum characters in one progress message.", "\u5355\u6761\u8FC7\u7A0B\u6D88\u606F\u7684\u6700\u5927\u5B57\u7B26\u6570\u3002"),
    default: 300,
    defaultDisplay: "300",
    number: positive()
  }),
  LARK_EXEC_PROGRESS_MIN_INTERVAL_MS: numberConfig({
    ...messaging("Minimum interval between progress messages.", "\u8FC7\u7A0B\u6D88\u606F\u4E4B\u95F4\u7684\u6700\u5C0F\u95F4\u9694\u3002"),
    default: 15e3,
    defaultDisplay: "15000",
    number: nonNegative()
  }),
  LARK_EXEC_PROGRESS_POLL_INTERVAL_MS: numberConfig({
    ...messaging("Parent-side progress side-channel polling interval.", "\u7236\u8FDB\u7A0B\u8F6E\u8BE2\u8FC7\u7A0B\u6D88\u606F\u4FA7\u901A\u9053\u7684\u95F4\u9694\u3002"),
    default: 250,
    defaultDisplay: "250",
    number: positive()
  }),
  LARK_CODEX_EXEC_TOOL_TRACE: booleanConfig({
    ...messaging("Write sanitized Codex tool execution traces locally.", "\u5728\u672C\u5730\u5199\u5165\u8131\u654F\u540E\u7684 Codex \u5DE5\u5177\u6267\u884C trace\u3002"),
    default: false,
    defaultDisplay: "false"
  }),
  LARK_CODEX_EXEC_TOOL_TRACE_MODE: choiceConfig(["compact", "full", "hidden"], {
    ...messaging("Local Codex tool trace detail level.", "\u672C\u5730 Codex \u5DE5\u5177 trace \u7684\u8BE6\u7EC6\u7A0B\u5EA6\u3002"),
    default: "compact",
    defaultDisplay: "compact"
  }),
  LARK_CODEX_EXEC_TRACE_LOG: stringConfig({
    ...messaging("Path of the local Codex tool trace log.", "\u672C\u5730 Codex \u5DE5\u5177 trace \u65E5\u5FD7\u8DEF\u5F84\u3002"),
    default: ({ homeDir }) => path.join(homeDir, ".codex", "channels", "lark", "logs", "trace.log"),
    defaultDisplay: "~/.codex/channels/lark/logs/trace.log",
    empty: "default"
  }),
  LARK_CARD_FOOTER_METRICS_ENABLED: booleanConfig({
    ...messaging("Append compact runtime metrics to generated card replies.", "\u5728\u751F\u6210\u7684\u5361\u7247\u56DE\u590D\u5E95\u90E8\u9644\u52A0\u7D27\u51D1\u8FD0\u884C\u6307\u6807\u3002"),
    default: true,
    defaultDisplay: "true"
  }),
  LARK_CARD_FOOTER_METRICS_TOKEN_USAGE_THRESHOLD: numberConfig({
    ...messaging("Token threshold for showing usage in card footers.", "\u5728\u5361\u7247\u9875\u811A\u663E\u793A token \u7528\u91CF\u7684\u9608\u503C\u3002"),
    default: 2e4,
    defaultDisplay: "20000",
    number: nonNegative()
  }),
  LARK_CODEX_SESSION_RETENTION_DAYS: numberConfig({
    ...messaging("Retention age for Codex exec session pointers.", "Codex exec session \u6307\u9488\u7684\u4FDD\u7559\u5929\u6570\u3002"),
    default: 14,
    defaultDisplay: "14",
    number: positive()
  }),
  LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS: numberConfig({
    ...messaging("Interval for scanning expired Codex session pointers.", "\u626B\u63CF\u8FC7\u671F Codex session \u6307\u9488\u7684\u95F4\u9694\u3002"),
    default: 24,
    defaultDisplay: "24",
    number: nonNegative()
  }),
  LARK_CODEX_SESSION_RETENTION_DRY_RUN: booleanConfig({
    ...messaging("Preview Codex session cleanup without deleting records.", "\u4EC5\u9884\u89C8 Codex session \u6E05\u7406\u800C\u4E0D\u5220\u9664\u8BB0\u5F55\u3002"),
    default: false,
    defaultDisplay: "false"
  }),
  LARK_CONTINUATION_ENABLED: booleanConfig({
    ...messaging("Enable durable background continuation creation and execution.", "\u542F\u7528\u6301\u4E45\u5316\u540E\u53F0 continuation \u7684\u521B\u5EFA\u4E0E\u6267\u884C\u3002", ["continuation"]),
    default: true,
    defaultDisplay: "true"
  }),
  LARK_CONTINUATION_MAX_CONCURRENCY: numberConfig({
    ...messaging("Maximum concurrent continuation executions.", "continuation \u7684\u6700\u5927\u5E76\u53D1\u6267\u884C\u6570\u3002", ["continuation"]),
    default: 1,
    defaultDisplay: "1",
    number: { integer: true, minimum: 1, maximum: 4, message: "Expected an integer between 1 and 4." }
  }),
  LARK_CONTINUATION_MAX_ATTEMPTS: numberConfig({
    ...messaging("Maximum attempts per continuation Job.", "\u6BCF\u4E2A continuation Job \u7684\u6700\u5927 attempt \u6570\u3002", ["continuation"]),
    default: 5,
    defaultDisplay: "5",
    number: { integer: true, minimum: 1, maximum: 20, message: "Expected an integer between 1 and 20." }
  }),
  LARK_CONTINUATION_MAX_RETRIES: numberConfig({
    ...messaging("Retryable failures allowed within the attempt budget.", "attempt \u9884\u7B97\u5185\u5141\u8BB8\u7684\u53EF\u91CD\u8BD5\u5931\u8D25\u6B21\u6570\u3002", ["continuation"]),
    default: 3,
    defaultDisplay: "3",
    number: { integer: true, minimum: 0, maximum: 10, message: "Expected an integer between 0 and 10." }
  }),
  LARK_CONTINUATION_MAX_TOTAL_MINUTES: numberConfig({
    ...messaging("Maximum lifetime of one continuation Job.", "\u5355\u4E2A continuation Job \u7684\u6700\u957F\u751F\u547D\u5468\u671F\u3002", ["continuation"]),
    default: 30,
    defaultDisplay: "30",
    number: { integer: true, minimum: 5, maximum: 1440, message: "Expected an integer between 5 and 1440." }
  }),
  LARK_CONTINUATION_RETENTION_DAYS: numberConfig({
    ...messaging("Days to retain terminal continuation details and artifacts.", "\u7EC8\u6001 continuation \u8BE6\u60C5\u4E0E\u4EA7\u7269\u7684\u4FDD\u7559\u5929\u6570\u3002", ["continuation"]),
    default: 30,
    defaultDisplay: "30",
    number: { integer: true, minimum: 1, maximum: 3650, message: "Expected an integer between 1 and 3650." }
  }),
  LARK_CONTINUATION_WORKING_ROOT: stringConfig({
    ...messaging("Absolute authorized root for continuation working directories.", "continuation \u5DE5\u4F5C\u76EE\u5F55\u5141\u8BB8\u4F7F\u7528\u7684\u7EDD\u5BF9\u6839\u8DEF\u5F84\u3002", ["continuation"]),
    default: (context) => String(context.get("LARK_CODEX_EXEC_CWD")),
    defaultDisplay: "LARK_CODEX_EXEC_CWD",
    empty: "default",
    absolutePath: true
  }),
  LARK_SESSION_HEALTH_ENABLED: booleanConfig({
    ...messaging("Enable owner nudges for long-running Codex sessions.", "\u542F\u7528\u957F\u65F6\u95F4 Codex session \u7684 owner \u63D0\u9192\u3002"),
    default: false,
    defaultDisplay: "false"
  }),
  LARK_SESSION_HEALTH_TURN_THRESHOLD: numberConfig({
    ...messaging("Session turn threshold for a health nudge.", "\u89E6\u53D1 session \u5065\u5EB7\u63D0\u9192\u7684\u56DE\u5408\u6570\u9608\u503C\u3002"),
    default: 80,
    defaultDisplay: "80",
    number: positive()
  }),
  LARK_SESSION_HEALTH_PROMPT_BYTES_THRESHOLD: numberConfig({
    ...messaging("Prompt-byte threshold for a session health nudge.", "\u89E6\u53D1 session \u5065\u5EB7\u63D0\u9192\u7684 prompt \u5B57\u8282\u6570\u9608\u503C\u3002"),
    default: 512 * 1024,
    defaultDisplay: "524288",
    number: positive()
  }),
  LARK_SESSION_HEALTH_TOKEN_THRESHOLD: numberConfig({
    ...messaging("Reported token threshold for a session health nudge.", "\u89E6\u53D1 session \u5065\u5EB7\u63D0\u9192\u7684\u5DF2\u62A5\u544A token \u9608\u503C\u3002"),
    default: 16e4,
    defaultDisplay: "160000",
    number: positive()
  }),
  LARK_SESSION_HEALTH_IDLE_DELAY_MS: numberConfig({
    ...messaging("Idle delay before checking session health gates.", "\u68C0\u67E5 session \u5065\u5EB7\u95E8\u69DB\u524D\u7684\u7A7A\u95F2\u5EF6\u8FDF\u3002"),
    default: 3e4,
    defaultDisplay: "30000",
    number: nonNegative()
  }),
  LARK_SESSION_HEALTH_COOLDOWN_MS: numberConfig({
    ...messaging("Initial cooldown between session health nudges.", "session \u5065\u5EB7\u63D0\u9192\u7684\u521D\u59CB\u51B7\u5374\u65F6\u95F4\u3002"),
    default: 30 * 60 * 1e3,
    defaultDisplay: "1800000",
    number: positive()
  }),
  LARK_SESSION_HEALTH_MAX_COOLDOWN_MS: numberConfig({
    ...messaging("Maximum exponential session health cooldown.", "session \u5065\u5EB7\u63D0\u9192\u7684\u6700\u5927\u6307\u6570\u51B7\u5374\u65F6\u95F4\u3002"),
    default: 6 * 60 * 60 * 1e3,
    defaultDisplay: "21600000",
    number: positive()
  }),
  LARK_SESSION_HEALTH_MAX_NUDGES: numberConfig({
    ...messaging("Maximum health nudges per session episode.", "\u6BCF\u4E2A session \u9636\u6BB5\u6700\u591A\u53D1\u9001\u7684\u5065\u5EB7\u63D0\u9192\u6570\u3002"),
    default: 3,
    defaultDisplay: "3",
    number: positive()
  }),
  LARK_ACK_EMOJI: stringConfig({
    category: "Acknowledgement",
    description: { en: "Emoji reaction added when a message is received.", zh: "\u6536\u5230\u6D88\u606F\u65F6\u6DFB\u52A0\u7684 emoji reaction\u3002" },
    features: ["acknowledgement"],
    default: "MeMeMe",
    defaultDisplay: "MeMeMe",
    empty: "preserve"
  }),
  LARK_DOC_COMMENT_ACK_EMOJI: stringConfig({
    category: "Acknowledgement",
    description: { en: "Persistent reaction for inbound document-comment mentions.", zh: "\u6587\u6863\u8BC4\u8BBA\u63D0\u53CA\u6D88\u606F\u4F7F\u7528\u7684\u6301\u4E45 reaction\u3002" },
    features: ["acknowledgement", "doc-comment"],
    default: "THUMBSUP",
    defaultDisplay: "THUMBSUP",
    empty: "preserve"
  }),
  LARK_BOT_MESSAGE_TRACKER_SIZE: numberConfig({
    category: "Acknowledgement",
    description: { en: "Maximum bot message IDs retained for routing and mutation guards.", zh: "\u4E3A\u8DEF\u7531\u4E0E\u6D88\u606F\u53D8\u66F4\u4FDD\u62A4\u4FDD\u7559\u7684 bot message ID \u4E0A\u9650\u3002" },
    features: ["reactions", "message-mutation"],
    default: 500,
    defaultDisplay: "500",
    number: nonNegative()
  }),
  LARK_FEISHU_API_TIMEOUT_MS: numberConfig({
    ...reliability("Timeout for one Feishu API call.", "\u5355\u6B21\u98DE\u4E66 API \u8C03\u7528\u8D85\u65F6\u3002"),
    default: 3e4,
    defaultDisplay: "30000",
    number: nonNegative()
  }),
  LARK_FEISHU_API_RETRY_ATTEMPTS: numberConfig({
    ...reliability("Attempts for retryable Feishu API failures.", "\u98DE\u4E66 API \u53EF\u91CD\u8BD5\u5931\u8D25\u7684\u5C1D\u8BD5\u6B21\u6570\u3002"),
    default: 3,
    defaultDisplay: "3",
    number: positive()
  }),
  LARK_FEISHU_API_RETRY_BASE_DELAY_MS: numberConfig({
    ...reliability("Base delay for exponential Feishu API retries.", "\u98DE\u4E66 API \u6307\u6570\u9000\u907F\u91CD\u8BD5\u7684\u57FA\u7840\u5EF6\u8FDF\u3002"),
    default: 250,
    defaultDisplay: "250",
    number: nonNegative()
  }),
  LARK_DOWNLOAD_MAX_BYTES: numberConfig({
    ...reliability("Maximum bytes accepted for one downloaded attachment.", "\u5355\u4E2A\u4E0B\u8F7D\u9644\u4EF6\u5141\u8BB8\u7684\u6700\u5927\u5B57\u8282\u6570\u3002"),
    default: 25 * 1024 * 1024,
    defaultDisplay: "26214400",
    number: positive()
  }),
  LARK_DOWNLOAD_TIMEOUT_MS: numberConfig({
    ...reliability("Attachment and image download timeout.", "\u9644\u4EF6\u548C\u56FE\u7247\u4E0B\u8F7D\u8D85\u65F6\u3002"),
    default: 6e4,
    defaultDisplay: "60000",
    number: nonNegative()
  }),
  LARK_CRON_SCAN_INTERVAL: numberConfig({
    category: "CronJob",
    description: { en: "Cron schedule scan interval in seconds.", zh: "Cron \u8C03\u5EA6\u626B\u63CF\u95F4\u9694\uFF08\u79D2\uFF09\u3002" },
    features: ["cron"],
    default: 60,
    defaultDisplay: "60",
    number: positive()
  }),
  LARK_CRON_TIMEZONE: stringConfig({
    category: "CronJob",
    description: { en: "Default IANA timezone for new CronJobs and local logs.", zh: "\u65B0 CronJob \u4E0E\u672C\u5730\u65E5\u5FD7\u4F7F\u7528\u7684\u9ED8\u8BA4 IANA \u65F6\u533A\u3002" },
    features: ["cron", "logging"],
    default: ({ systemTimezone }) => systemTimezone,
    defaultDisplay: "system timezone",
    empty: "default"
  }),
  LARK_MIN_SEARCH_SCORE: numberConfig({
    ...memory("Minimum relevance score for episode search results.", "episode \u641C\u7D22\u7ED3\u679C\u7684\u6700\u4F4E\u76F8\u5173\u5EA6\u5206\u6570\u3002"),
    default: 0.3,
    defaultDisplay: "0.3",
    number: nonNegative()
  }),
  LARK_MAX_SEARCH_RESULTS: numberConfig({
    ...memory("Maximum episode search results injected into a turn.", "\u5355\u4E2A\u56DE\u5408\u6700\u591A\u6CE8\u5165\u7684 episode \u641C\u7D22\u7ED3\u679C\u6570\u3002"),
    default: 2,
    defaultDisplay: "2",
    number: positive()
  }),
  LARK_INACTIVITY_HOURS: numberConfig({
    ...memory("Inactivity threshold before flushing buffered conversation memory.", "\u5237\u65B0\u7F13\u51B2\u4F1A\u8BDD\u8BB0\u5FC6\u524D\u7684\u7A7A\u95F2\u5C0F\u65F6\u6570\u9608\u503C\u3002"),
    default: 3,
    defaultDisplay: "3",
    number: positive()
  }),
  LARK_MAX_EPISODE_BYTES: numberConfig({
    ...memory("Maximum bytes persisted in one episode file.", "\u5355\u4E2A episode \u6587\u4EF6\u6301\u4E45\u5316\u7684\u6700\u5927\u5B57\u8282\u6570\u3002"),
    default: 64 * 1024,
    defaultDisplay: "65536",
    number: nonNegative()
  }),
  LARK_MAX_EPISODE_FILES_PER_SCOPE: numberConfig({
    ...memory("Maximum episode files retained per chat or thread scope.", "\u6BCF\u4E2A\u4F1A\u8BDD\u6216\u8BDD\u9898\u8303\u56F4\u4FDD\u7559\u7684 episode \u6587\u4EF6\u4E0A\u9650\u3002"),
    default: 200,
    defaultDisplay: "200",
    number: nonNegative()
  }),
  LARK_MAX_EPISODE_SCOPE_BYTES: numberConfig({
    ...memory("Maximum total episode bytes retained per scope.", "\u6BCF\u4E2A\u8303\u56F4\u4FDD\u7559\u7684 episode \u603B\u5B57\u8282\u6570\u4E0A\u9650\u3002"),
    default: 10 * 1024 * 1024,
    defaultDisplay: "10485760",
    number: nonNegative()
  }),
  LARK_PROFILE_DISTILLATION_ENABLED: booleanConfig({
    ...memory("Enable profile distillation from recent episodes.", "\u542F\u7528\u4ECE\u8FD1\u671F episode \u8FDB\u884C profile \u63D0\u70BC\u3002"),
    default: false,
    defaultDisplay: "false"
  }),
  LARK_PROFILE_DISTILLATION_MIN_EPISODES: numberConfig({
    ...memory("Minimum episodes required before profile distillation.", "\u542F\u52A8 profile \u63D0\u70BC\u6240\u9700\u7684\u6700\u5C11 episode \u6570\u3002"),
    default: 3,
    defaultDisplay: "3",
    number: positive()
  }),
  LARK_PROFILE_DISTILLATION_MAX_EPISODES: numberConfig({
    ...memory("Maximum recent episodes included in one distillation prompt.", "\u5355\u6B21\u63D0\u70BC prompt \u5305\u542B\u7684\u8FD1\u671F episode \u4E0A\u9650\u3002"),
    default: 5,
    defaultDisplay: "5",
    number: positive()
  }),
  LARK_PROFILE_DISTILLATION_COOLDOWN_MS: numberConfig({
    ...memory("Per-user cooldown between profile distillation dispatches.", "\u6BCF\u4E2A\u7528\u6237\u4E24\u6B21 profile \u63D0\u70BC\u4E4B\u95F4\u7684\u51B7\u5374\u65F6\u95F4\u3002"),
    default: 24 * 60 * 60 * 1e3,
    defaultDisplay: "86400000",
    number: nonNegative()
  }),
  LARK_MEMORY_DEDUP_WINDOW_MS: numberConfig({
    ...memory("Window for suppressing unchanged memory blocks.", "\u6291\u5236\u672A\u53D8\u5316\u8BB0\u5FC6\u5757\u7684\u65F6\u95F4\u7A97\u53E3\u3002"),
    default: 30 * 60 * 1e3,
    defaultDisplay: "1800000",
    number: nonNegative()
  }),
  LARK_OWNER_OPEN_ID: stringConfig({
    category: "Identity",
    description: { en: "Immutable operator identity and terminal-skill trust root.", zh: "\u4E0D\u53EF\u53D8\u7684 operator \u8EAB\u4EFD\u4E0E\u7EC8\u7AEF skill \u4FE1\u4EFB\u6839\u3002" },
    features: ["identity", "authorization"],
    default: null,
    defaultDisplay: "(empty)",
    empty: "null",
    nullable: true
  }),
  LARK_IDENTITY_SESSION_TTL_MS: numberConfig({
    category: "Identity",
    description: { en: "Lifetime of server-derived caller identity sessions.", zh: "\u670D\u52A1\u7AEF\u6D3E\u751F\u8C03\u7528\u8005\u8EAB\u4EFD session \u7684\u751F\u547D\u5468\u671F\u3002" },
    features: ["identity"],
    default: (context) => Math.max(2 * 60 * 60 * 1e3, Number(context.get("LARK_INACTIVITY_HOURS")) * 2 * 60 * 60 * 1e3),
    defaultDisplay: "max(2h, LARK_INACTIVITY_HOURS x 2h)",
    number: positive()
  }),
  LARK_IDENTITY_SESSION_MAX_ENTRIES: numberConfig({
    category: "Identity",
    description: { en: "Maximum server-derived caller identity session entries.", zh: "\u670D\u52A1\u7AEF\u6D3E\u751F\u8C03\u7528\u8005\u8EAB\u4EFD session \u6761\u76EE\u4E0A\u9650\u3002" },
    features: ["identity"],
    default: 5e3,
    defaultDisplay: "5000",
    number: positive()
  }),
  LARK_AUDIT_LOG: stringConfig({
    category: "Privacy",
    description: { en: "Path of the append-only sensitive-operation audit log.", zh: "\u654F\u611F\u64CD\u4F5C\u8FFD\u52A0\u5F0F\u5BA1\u8BA1\u65E5\u5FD7\u7684\u8DEF\u5F84\u3002" },
    features: ["audit"],
    default: ({ homeDir }) => path.join(homeDir, ".codex", "channels", "lark", "logs", "audit.log"),
    defaultDisplay: "~/.codex/channels/lark/logs/audit.log",
    empty: "default"
  }),
  LARK_CARD_CONTEXT_CACHE_SIZE: numberConfig({
    category: "Quoted cards",
    description: { en: "Maximum cached parent or root card contexts.", zh: "\u7F13\u5B58\u7684\u7236\u7EA7\u6216\u6839\u5361\u7247\u4E0A\u4E0B\u6587\u4E0A\u9650\u3002" },
    features: ["quoted-context"],
    default: 200,
    defaultDisplay: "200",
    number: nonNegative()
  }),
  LARK_CARD_CONTEXT_CACHE_TTL_MS: numberConfig({
    category: "Quoted cards",
    description: { en: "Lifetime of fetched card context cache entries.", zh: "\u5DF2\u62C9\u53D6\u5361\u7247\u4E0A\u4E0B\u6587\u7F13\u5B58\u6761\u76EE\u7684\u751F\u547D\u5468\u671F\u3002" },
    features: ["quoted-context"],
    default: 30 * 60 * 1e3,
    defaultDisplay: "1800000",
    number: nonNegative()
  }),
  LARK_QUOTED_CONTEXT_MAX_DEPTH: numberConfig({
    category: "Quoted cards",
    description: { en: "Maximum quoted-message chain depth hydrated for Codex.", zh: "\u4E3A Codex \u8865\u9F50\u7684\u5F15\u7528\u6D88\u606F\u94FE\u6700\u5927\u6DF1\u5EA6\u3002" },
    features: ["quoted-context"],
    default: 4,
    defaultDisplay: "4",
    number: positive()
  }),
  LARK_QUOTED_CONTEXT_MAX_BYTES: numberConfig({
    category: "Quoted cards",
    description: { en: "UTF-8 byte budget for hydrated quoted-message context.", zh: "\u8865\u9F50\u540E\u7684\u5F15\u7528\u6D88\u606F\u4E0A\u4E0B\u6587 UTF-8 \u5B57\u8282\u9884\u7B97\u3002" },
    features: ["quoted-context"],
    default: 12e3,
    defaultDisplay: "12000",
    number: positive()
  }),
  LARK_QUOTED_CARD_USER_FETCH_ENABLED: booleanConfig({
    category: "Quoted cards",
    description: { en: "Allow user-identity fallback when bot card hydration fails.", zh: "bot \u8EAB\u4EFD\u8865\u9F50\u5361\u7247\u5931\u8D25\u65F6\u5141\u8BB8\u4F7F\u7528 user \u8EAB\u4EFD\u56DE\u9000\u3002" },
    features: ["quoted-context"],
    default: true,
    defaultDisplay: "true"
  }),
  LARK_QUOTED_CARD_USER_FETCH_COMMAND: stringConfig({
    category: "Quoted cards",
    description: { en: "lark-cli command used for quoted-card user fallback.", zh: "\u5F15\u7528\u5361\u7247 user \u8EAB\u4EFD\u56DE\u9000\u4F7F\u7528\u7684 lark-cli \u547D\u4EE4\u3002" },
    features: ["quoted-context"],
    default: "lark-cli",
    defaultDisplay: "lark-cli",
    empty: "default"
  }),
  LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS: numberConfig({
    category: "Quoted cards",
    description: { en: "Timeout for quoted-card user-identity fallback.", zh: "\u5F15\u7528\u5361\u7247 user \u8EAB\u4EFD\u56DE\u9000\u7684\u8D85\u65F6\u3002" },
    features: ["quoted-context"],
    default: 1e4,
    defaultDisplay: "10000",
    number: positive()
  }),
  LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES: numberConfig({
    category: "Quoted cards",
    description: { en: "Maximum output bytes captured from quoted-card user fallback.", zh: "\u5F15\u7528\u5361\u7247 user \u8EAB\u4EFD\u56DE\u9000\u53EF\u6355\u83B7\u7684\u6700\u5927\u8F93\u51FA\u5B57\u8282\u6570\u3002" },
    features: ["quoted-context"],
    default: 256 * 1024,
    defaultDisplay: "262144",
    number: positive()
  }),
  LARK_DEBUG_LOG: stringConfig({
    ...resources("Path of the local runtime debug log.", "\u672C\u5730\u8FD0\u884C\u65F6 debug \u65E5\u5FD7\u8DEF\u5F84\u3002"),
    default: ({ homeDir }) => path.join(homeDir, ".codex", "channels", "lark", "logs", "debug.log"),
    defaultDisplay: "~/.codex/channels/lark/logs/debug.log",
    empty: "default"
  }),
  LARK_LOG_MAX_BYTES: numberConfig({
    ...resources("Log size threshold before rotation.", "\u89E6\u53D1\u65E5\u5FD7\u8F6E\u8F6C\u7684\u6587\u4EF6\u5927\u5C0F\u9608\u503C\u3002"),
    default: 5 * 1024 * 1024,
    defaultDisplay: "5242880",
    number: nonNegative()
  }),
  LARK_LOG_MAX_FILES: numberConfig({
    ...resources("Number of rotated log files retained.", "\u4FDD\u7559\u7684\u8F6E\u8F6C\u65E5\u5FD7\u6587\u4EF6\u6570\u3002"),
    default: 5,
    defaultDisplay: "5",
    number: nonNegative()
  }),
  LARK_LOG_ARCHIVE_RETENTION_MONTHS: numberConfig({
    ...resources("Number of monthly log archive directories retained.", "\u4FDD\u7559\u7684\u6708\u5EA6\u65E5\u5FD7\u5F52\u6863\u76EE\u5F55\u6570\u3002"),
    default: 6,
    defaultDisplay: "6",
    number: nonNegative()
  }),
  LARK_INBOX_MAX_AGE_HOURS: numberConfig({
    ...resources("Maximum age of downloaded inbox files during cleanup.", "\u6E05\u7406\u65F6\u4E0B\u8F7D inbox \u6587\u4EF6\u5141\u8BB8\u4FDD\u7559\u7684\u6700\u5927\u5C0F\u65F6\u6570\u3002"),
    default: 168,
    defaultDisplay: "168",
    number: nonNegative()
  }),
  LARK_INBOX_MAX_BYTES: numberConfig({
    ...resources("LRU byte cap for downloaded inbox files.", "\u4E0B\u8F7D inbox \u6587\u4EF6\u7684 LRU \u5B57\u8282\u4E0A\u9650\u3002"),
    default: 200 * 1024 * 1024,
    defaultDisplay: "209715200",
    number: nonNegative()
  }),
  LARK_NAME_CACHE_SIZE: numberConfig({
    ...resources("Maximum cached user and chat display names.", "\u7F13\u5B58\u7684\u7528\u6237\u4E0E\u4F1A\u8BDD\u663E\u793A\u540D\u79F0\u4E0A\u9650\u3002"),
    default: 1e3,
    defaultDisplay: "1000",
    number: nonNegative()
  }),
  LARK_CHAT_TYPE_CACHE_SIZE: numberConfig({
    ...resources("Maximum cached Feishu chat types.", "\u7F13\u5B58\u7684\u98DE\u4E66\u4F1A\u8BDD\u7C7B\u578B\u4E0A\u9650\u3002"),
    default: 1e3,
    defaultDisplay: "1000",
    number: nonNegative()
  }),
  LARK_LATEST_MESSAGE_TRACKER_SIZE: numberConfig({
    ...resources("Maximum latest-inbound-message tracker entries.", "\u6700\u65B0\u5165\u7AD9\u6D88\u606F\u8FFD\u8E2A\u5668\u7684\u6761\u76EE\u4E0A\u9650\u3002"),
    default: 1e3,
    defaultDisplay: "1000",
    number: nonNegative()
  })
};
var configSchemaKeys = Object.keys(configSchema).sort();
var TRUE_VALUES = /* @__PURE__ */ new Set(["1", "true", "yes", "on"]);
var FALSE_VALUES = /* @__PURE__ */ new Set(["0", "false", "no", "off"]);
function validateNumber(key, value, definition) {
  const rules = definition.number;
  const belowMinimum = rules.minimum !== void 0 && (rules.exclusiveMinimum ? value <= rules.minimum : value < rules.minimum);
  const aboveMaximum = rules.maximum !== void 0 && value > rules.maximum;
  if (rules.integer && !Number.isInteger(value) || belowMinimum || aboveMaximum) {
    throw new Error(`Invalid ${key}: ${value}. ${rules.message}`);
  }
  return value;
}
function readConfigValues(options) {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const systemTimezone = options?.systemTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dryRun = options?.dryRun ?? false;
  const values = /* @__PURE__ */ new Map();
  const resolving = /* @__PURE__ */ new Set();
  const context = {
    homeDir,
    systemTimezone,
    get: (key) => resolve(key)
  };
  function defaultValue(key, definition) {
    const configuredDefault = "default" in definition ? definition.default : void 0;
    if (configuredDefault === void 0) {
      if (dryRun && (key === "LARK_APP_ID" || key === "LARK_APP_SECRET")) {
        return `dry_run_${key.toLowerCase()}`;
      }
      throw new Error(`Missing required env var: ${key}`);
    }
    return typeof configuredDefault === "function" ? configuredDefault(context) : configuredDefault;
  }
  function resolve(key) {
    if (values.has(key)) return values.get(key);
    if (resolving.has(key)) throw new Error(`Circular configuration default dependency: ${key}`);
    resolving.add(key);
    try {
      const definition = configSchema[key];
      const raw = env[key];
      let value;
      if (definition.type === "string") {
        if (raw === void 0 || raw === "" && definition.empty !== "preserve") {
          value = definition.empty === "null" ? null : defaultValue(key, definition);
        } else {
          value = raw;
        }
        if (definition.absolutePath && typeof value === "string" && !path.isAbsolute(value)) {
          throw new Error(`Invalid ${key}: expected an absolute path.`);
        }
      } else if (raw === void 0 || raw === "") {
        value = defaultValue(key, definition);
      } else if (definition.type === "number") {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          throw new Error(`Invalid ${key}: ${raw}. Expected a number.`);
        }
        value = validateNumber(key, parsed, definition);
      } else if (definition.type === "boolean") {
        const normalized = raw.toLowerCase();
        if (TRUE_VALUES.has(normalized)) value = true;
        else if (FALSE_VALUES.has(normalized)) value = false;
        else {
          throw new Error(
            `Invalid ${key}: ${raw}. Expected one of: true, false, 1, 0, yes, no, on, off.`
          );
        }
      } else {
        if (!definition.choices.includes(raw)) {
          throw new Error(
            `Invalid ${key}: ${raw}. Expected one of: ${definition.choices.join(", ")}`
          );
        }
        value = raw;
      }
      if (definition.type === "number") {
        value = validateNumber(key, Number(value), definition);
        if (definition.normalize) value = definition.normalize(Number(value), context);
      }
      values.set(key, value);
      return value;
    } finally {
      resolving.delete(key);
    }
  }
  for (const key of configSchemaKeys) resolve(key);
  return Object.fromEntries(values);
}

// plugins/lark/src/config.ts
assertSupportedNodeVersion();
var envPath = path2.join(os2.homedir(), ".codex", "channels", "lark", ".env");
(0, import_dotenv.config)({ path: envPath });
var channelHome = path2.join(os2.homedir(), ".codex", "channels", "lark");
var runtimeConfigDir = path2.join(channelHome, "runtime-config");
var continuationRuntimeDir = path2.join(channelHome, "runtime", "continuations");
var isDryRun = process.argv.includes("--dry-run");
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
var envValues = readConfigValues({ dryRun: isDryRun });
var codexExecCwd = envValues.LARK_CODEX_EXEC_CWD;
var continuationWorkingRoot = envValues.LARK_CONTINUATION_WORKING_ROOT;
var appConfig = {
  // Required
  appId: envValues.LARK_APP_ID,
  appSecret: envValues.LARK_APP_SECRET,
  textChunkLimit: envValues.LARK_TEXT_CHUNK_LIMIT,
  ackEmoji: envValues.LARK_ACK_EMOJI,
  docCommentAckEmoji: envValues.LARK_DOC_COMMENT_ACK_EMOJI,
  botMessageTrackerSize: envValues.LARK_BOT_MESSAGE_TRACKER_SIZE,
  queueHandlerTimeoutMs: envValues.LARK_QUEUE_HANDLER_TIMEOUT_MS,
  codexExecCommand: envValues.LARK_CODEX_EXEC_COMMAND,
  codexExecCwd,
  codexExecTimeoutMs: envValues.LARK_CODEX_EXEC_TIMEOUT_MS,
  codexExecSandbox: envValues.LARK_CODEX_EXEC_SANDBOX,
  codexExecModel: envValues.LARK_CODEX_EXEC_MODEL,
  codexExecProfile: envValues.LARK_CODEX_EXEC_PROFILE,
  codexExecIgnoreUserConfig: envValues.LARK_CODEX_EXEC_IGNORE_USER_CONFIG,
  codexExecUseSessions: envValues.LARK_CODEX_EXEC_USE_SESSIONS,
  codexExecProgressEnabled: envValues.LARK_EXEC_PROGRESS_ENABLED,
  codexExecProgressMaxMessages: envValues.LARK_EXEC_PROGRESS_MAX_MESSAGES,
  codexExecProgressMaxChars: envValues.LARK_EXEC_PROGRESS_MAX_CHARS,
  codexExecProgressMinIntervalMs: envValues.LARK_EXEC_PROGRESS_MIN_INTERVAL_MS,
  codexExecProgressPollIntervalMs: envValues.LARK_EXEC_PROGRESS_POLL_INTERVAL_MS,
  codexExecToolTraceEnabled: envValues.LARK_CODEX_EXEC_TOOL_TRACE,
  codexExecToolTraceMode: envValues.LARK_CODEX_EXEC_TOOL_TRACE_MODE,
  cardFooterMetricsEnabled: envValues.LARK_CARD_FOOTER_METRICS_ENABLED,
  cardFooterMetricsTokenUsageThreshold: envValues.LARK_CARD_FOOTER_METRICS_TOKEN_USAGE_THRESHOLD,
  codexSessionRetentionDays: envValues.LARK_CODEX_SESSION_RETENTION_DAYS,
  codexSessionRetentionScanIntervalHours: envValues.LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS,
  codexSessionRetentionDryRun: envValues.LARK_CODEX_SESSION_RETENTION_DRY_RUN,
  continuationEnabled: envValues.LARK_CONTINUATION_ENABLED,
  continuationMaxConcurrency: envValues.LARK_CONTINUATION_MAX_CONCURRENCY,
  continuationMaxAttempts: envValues.LARK_CONTINUATION_MAX_ATTEMPTS,
  continuationMaxRetries: envValues.LARK_CONTINUATION_MAX_RETRIES,
  continuationMaxTotalMinutes: envValues.LARK_CONTINUATION_MAX_TOTAL_MINUTES,
  continuationRetentionDays: envValues.LARK_CONTINUATION_RETENTION_DAYS,
  continuationWorkingRoot,
  sessionHealthEnabled: envValues.LARK_SESSION_HEALTH_ENABLED,
  sessionHealthTurnThreshold: envValues.LARK_SESSION_HEALTH_TURN_THRESHOLD,
  sessionHealthPromptBytesThreshold: envValues.LARK_SESSION_HEALTH_PROMPT_BYTES_THRESHOLD,
  sessionHealthTokenThreshold: envValues.LARK_SESSION_HEALTH_TOKEN_THRESHOLD,
  sessionHealthIdleDelayMs: envValues.LARK_SESSION_HEALTH_IDLE_DELAY_MS,
  sessionHealthCooldownMs: envValues.LARK_SESSION_HEALTH_COOLDOWN_MS,
  sessionHealthMaxCooldownMs: envValues.LARK_SESSION_HEALTH_MAX_COOLDOWN_MS,
  sessionHealthMaxNudges: envValues.LARK_SESSION_HEALTH_MAX_NUDGES,
  replyObligationTimeoutMs: envValues.LARK_REPLY_OBLIGATION_TIMEOUT_MS,
  cronScanInterval: envValues.LARK_CRON_SCAN_INTERVAL,
  cronTimezone: envValues.LARK_CRON_TIMEZONE,
  feishuApiTimeoutMs: envValues.LARK_FEISHU_API_TIMEOUT_MS,
  feishuApiRetryAttempts: envValues.LARK_FEISHU_API_RETRY_ATTEMPTS,
  feishuApiRetryBaseDelayMs: envValues.LARK_FEISHU_API_RETRY_BASE_DELAY_MS,
  logMaxBytes: envValues.LARK_LOG_MAX_BYTES,
  logMaxFiles: envValues.LARK_LOG_MAX_FILES,
  logArchiveRetentionMonths: envValues.LARK_LOG_ARCHIVE_RETENTION_MONTHS,
  // Memory
  minSearchScore: envValues.LARK_MIN_SEARCH_SCORE,
  maxSearchResults: envValues.LARK_MAX_SEARCH_RESULTS,
  inactivityHours: envValues.LARK_INACTIVITY_HOURS,
  maxEpisodeBytes: envValues.LARK_MAX_EPISODE_BYTES,
  maxEpisodeFilesPerScope: envValues.LARK_MAX_EPISODE_FILES_PER_SCOPE,
  maxEpisodeScopeBytes: envValues.LARK_MAX_EPISODE_SCOPE_BYTES,
  profileDistillationEnabled: envValues.LARK_PROFILE_DISTILLATION_ENABLED,
  profileDistillationMinEpisodes: envValues.LARK_PROFILE_DISTILLATION_MIN_EPISODES,
  profileDistillationMaxEpisodes: envValues.LARK_PROFILE_DISTILLATION_MAX_EPISODES,
  profileDistillationCooldownMs: envValues.LARK_PROFILE_DISTILLATION_COOLDOWN_MS,
  memoryDedupWindowMs: envValues.LARK_MEMORY_DEDUP_WINDOW_MS,
  downloadMaxBytes: envValues.LARK_DOWNLOAD_MAX_BYTES,
  downloadTimeoutMs: envValues.LARK_DOWNLOAD_TIMEOUT_MS,
  inboxMaxAgeHours: envValues.LARK_INBOX_MAX_AGE_HOURS,
  inboxMaxBytes: envValues.LARK_INBOX_MAX_BYTES,
  // Identity / privacy
  ownerOpenId: envValues.LARK_OWNER_OPEN_ID,
  identitySessionTtlMs: envValues.LARK_IDENTITY_SESSION_TTL_MS,
  identitySessionMaxEntries: envValues.LARK_IDENTITY_SESSION_MAX_ENTRIES,
  nameCacheSize: envValues.LARK_NAME_CACHE_SIZE,
  chatTypeCacheSize: envValues.LARK_CHAT_TYPE_CACHE_SIZE,
  latestMessageTrackerSize: envValues.LARK_LATEST_MESSAGE_TRACKER_SIZE,
  cardContextCacheSize: envValues.LARK_CARD_CONTEXT_CACHE_SIZE,
  cardContextCacheTtlMs: envValues.LARK_CARD_CONTEXT_CACHE_TTL_MS,
  quotedContextMaxDepth: envValues.LARK_QUOTED_CONTEXT_MAX_DEPTH,
  quotedContextMaxBytes: envValues.LARK_QUOTED_CONTEXT_MAX_BYTES,
  quotedCardUserFetchEnabled: envValues.LARK_QUOTED_CARD_USER_FETCH_ENABLED,
  quotedCardUserFetchCommand: envValues.LARK_QUOTED_CARD_USER_FETCH_COMMAND,
  quotedCardUserFetchTimeoutMs: envValues.LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS,
  quotedCardUserFetchMaxBytes: envValues.LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES,
  // Paths
  memoriesDir: path2.join(os2.homedir(), ".codex", "channels", "lark", "memories"),
  inboxDir: path2.join(os2.homedir(), ".codex", "channels", "lark", "inbox"),
  jobsDir: path2.join(os2.homedir(), ".codex", "channels", "lark", "jobs"),
  codexExecSessionsDir: path2.join(os2.homedir(), ".codex", "channels", "lark", "codex-sessions"),
  continuationDbPath: path2.join(continuationRuntimeDir, "jobs.sqlite"),
  continuationArtifactsDir: path2.join(continuationRuntimeDir, "artifacts"),
  runtimeConfigDir,
  accessControlConfigPath: path2.join(runtimeConfigDir, "access-control.json"),
  localCliToolsConfigPath: path2.join(runtimeConfigDir, "local-cli-tools.json"),
  privacyRulesPath: path2.join(runtimeConfigDir, "privacy-rules.md"),
  debugLogPath: envValues.LARK_DEBUG_LOG,
  auditLogPath: envValues.LARK_AUDIT_LOG,
  codexExecTraceLogPath: envValues.LARK_CODEX_EXEC_TRACE_LOG
};

// plugins/lark/src/instance-lock.ts
import os3 from "node:os";
import path3 from "node:path";
import { lstat as lstat2, readdir as readdir2 } from "node:fs/promises";

// plugins/lark/src/resource-governance.ts
import { execFile as execFile2 } from "node:child_process";
import {
  appendFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  futimesSync,
  openSync,
  readFileSync,
  unlinkSync
} from "node:fs";
import { gzip } from "node:zlib";
import { basename, dirname, join } from "node:path";
import { promisify as promisify2 } from "node:util";

// plugins/lark/src/process-identity.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var PROCESS_START_TOLERANCE_MS = 1e3;
var CURRENT_PROCESS_STARTED_AT = Math.floor(Date.now() - process.uptime() * 1e3);
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
async function getProcessStartedAt(pid) {
  if (pid === process.pid) return CURRENT_PROCESS_STARTED_AT;
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
function isSameProcessStart(a, b) {
  return Math.abs(a - b) <= PROCESS_START_TOLERANCE_MS;
}

// plugins/lark/src/resource-governance.ts
var execFileAsync2 = promisify2(execFile2);
var gzipAsync = promisify2(gzip);
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function defaultProcessCommand(pid) {
  try {
    const { stdout } = await execFileAsync2("ps", ["-o", "command=", "-p", String(pid)]);
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
function sameLockOwner(a, b) {
  if (!a) return false;
  if (a.pid !== b.pid) return false;
  if (b.startedAt !== void 0) return a.startedAt === b.startedAt;
  return true;
}
async function removeLockIfStillOwned(lockPath, record, expectedUid) {
  const current = await readLockState(lockPath, expectedUid);
  if (!current || !sameLockOwner(current.record, record)) return false;
  await removePathIfExists(lockPath);
  return true;
}
function isCodexLarkProcessCommand(command) {
  const normalized = command.toLowerCase();
  const tokens = Array.from(
    command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g),
    (match) => match[1] ?? match[2] ?? match[3]
  );
  const executable = tokens[0] ? basename(tokens[0].replaceAll("\\", "/")).toLowerCase() : "";
  const entrypoint = tokens[1]?.replaceAll("\\", "/").toLowerCase();
  const isPackagedRuntime = (executable === "node" || executable === "node.exe") && entrypoint === "runtime/index.js";
  return isPackagedRuntime || normalized.includes("codex-lark-plugin") || normalized.includes("scripts/start.sh") || normalized.includes("src/index.ts") && normalized.includes("tsx");
}
async function readLockState(lockPath, expectedUid) {
  const snapshot = await readOwnedRegularFile(lockPath, expectedUid, "lock");
  if (!snapshot) return null;
  return { record: parseLock(snapshot.raw), ageMs: Date.now() - snapshot.mtimeMs };
}
async function readOwnedRegularFile(filePath, expectedUid, label) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Refusing unsafe ${label} path ${filePath}.`, { cause: error });
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || expectedUid !== void 0 && metadata.uid !== expectedUid) {
      throw new Error(`Refusing ${label} path with unexpected type or owner: ${filePath}.`);
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    return {
      raw,
      mtimeMs: metadata.mtimeMs,
      dev: metadata.dev,
      ino: metadata.ino
    };
  } finally {
    await handle.close();
  }
}
async function removePathIfExists(filePath) {
  await rm(filePath, { recursive: true, force: true }).catch(() => void 0);
}
async function stopSingleInstanceLock(lockPath, options = {}) {
  const processExists = options.processExists ?? isProcessAlive;
  const resolveProcessStartedAt = options.getProcessStartedAt ?? getProcessStartedAt;
  const getProcessCommand = options.getProcessCommand ?? defaultProcessCommand;
  const killProcess = options.killProcess ?? defaultKillProcess;
  const isExpectedProcess = options.isExpectedProcess ?? isCodexLarkProcessCommand;
  const expectedUid = options.expectedUid;
  const waitMs = Math.max(0, Math.floor(options.waitMs ?? 5e3));
  const sleepMs = Math.max(0, Math.floor(options.sleepMs ?? 100));
  const state = await readLockState(lockPath, expectedUid);
  if (!state) {
    return {
      status: "no_lock",
      lockPath,
      message: `No codex-lark-plugin lock found at ${lockPath}.`
    };
  }
  const record = state.record;
  if (!record) {
    return {
      status: "invalid_lock",
      lockPath,
      message: `Refusing to stop: lock file ${lockPath} does not contain a valid PID.`
    };
  }
  const base = {
    lockPath,
    pid: record.pid,
    ...record.startedAt ? { startedAt: record.startedAt } : {}
  };
  const alive = await processExists(record.pid);
  if (!alive) {
    const removed = await removeLockIfStillOwned(lockPath, record, expectedUid);
    return {
      ...base,
      status: "stale_lock_removed",
      message: removed ? `Removed stale codex-lark-plugin lock for non-running PID ${record.pid}.` : `Stale lock for PID ${record.pid} changed before cleanup; left it untouched.`
    };
  }
  if (record.startedAt) {
    const actualStartedAt = await resolveProcessStartedAt(record.pid);
    if (actualStartedAt !== null && !isSameProcessStart(actualStartedAt, record.startedAt)) {
      const removed = await removeLockIfStillOwned(lockPath, record, expectedUid);
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
      const removed = await removeLockIfStillOwned(lockPath, record, expectedUid);
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
      const removed = await removeLockIfStillOwned(lockPath, record, expectedUid);
      return {
        ...base,
        command,
        status: "process_terminated",
        message: removed ? `Stopped codex-lark-plugin PID ${record.pid} and removed its lock.` : `Stopped PID ${record.pid}, but the lock changed before cleanup; left it untouched.`
      };
    }
    if (record.startedAt) {
      const actualStartedAt = await resolveProcessStartedAt(record.pid);
      if (actualStartedAt !== null && !isSameProcessStart(actualStartedAt, record.startedAt)) {
        const removed = await removeLockIfStillOwned(lockPath, record, expectedUid);
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

// plugins/lark/src/instance-lock.ts
var LARK_INSTANCE_LOCK_PATH = path3.join(
  os3.homedir(),
  ".codex",
  "channels",
  "lark",
  "runtime",
  "continuations",
  ".instance.lock"
);
async function stopLarkInstances(appId, stateRoot = path3.dirname(LARK_INSTANCE_LOCK_PATH), legacyLockRoot = os3.tmpdir(), legacyOwnerUid = process.getuid?.()) {
  const results = [];
  const paths = [
    path3.join(stateRoot, path3.basename(LARK_INSTANCE_LOCK_PATH)),
    ...await compatibleLegacyLockPaths(appId, legacyLockRoot, false, legacyOwnerUid)
  ];
  const expectedUid = process.getuid?.();
  for (const lockPath of paths) {
    results.push(await stopSingleInstanceLock(lockPath, { expectedUid }));
  }
  return results;
}
function legacyLarkInstanceLockPath(appId, lockRoot = os3.tmpdir()) {
  return path3.join(lockRoot, `codex-lark-${appId}.lock`);
}
async function compatibleLegacyLockPaths(appId, lockRoot, scanAll, currentUid) {
  const names = await readdir2(lockRoot).catch(() => []);
  const candidates = names.filter((name) => /^codex-lark-.+\.lock$/.test(name)).filter((name) => scanAll || name === path3.basename(legacyLarkInstanceLockPath(appId, lockRoot)));
  const ownedPaths = [];
  for (const name of candidates) {
    const candidate = path3.join(lockRoot, name);
    const metadata = await lstat2(candidate).catch(() => null);
    if (metadata?.isFile() && !metadata.isSymbolicLink() && (currentUid === void 0 || metadata.uid === currentUid)) {
      ownedPaths.push(candidate);
    }
  }
  const currentPath = legacyLarkInstanceLockPath(appId, lockRoot);
  const currentMetadata = await lstat2(currentPath).catch(() => null);
  const foreignOccupiedPath = Boolean(
    currentMetadata && currentUid !== void 0 && currentMetadata.uid !== currentUid
  );
  if (!foreignOccupiedPath) ownedPaths.push(currentPath);
  return [...new Set(ownedPaths.sort())];
}

// plugins/lark/src/stop.ts
var okStatuses = /* @__PURE__ */ new Set(["no_lock", "stale_lock_removed", "process_terminated"]);
try {
  const results = await stopLarkInstances(appConfig.appId);
  for (const result of results) console.error(result.message);
  process.exit(results.every((result) => okStatuses.has(result.status)) ? 0 : 1);
} catch (err) {
  console.error(`[stop] Failed to stop codex-lark-plugin: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
