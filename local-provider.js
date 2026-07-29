"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_COMMAND = "grok";
const DEFAULT_S3_COMMAND = "aws";

const TOOLS = [
  {
    name: "grok_generate_image",
    description:
      "Generate an image with the installed Grok Build CLI using its signed-in session. No API key passes through this sidecar, but the CLI's native image tool calls the xAI API and meters the signed-in account's xAI console usage. The result is written to output_path.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1 },
        output_path: {
          type: "string",
          description: "Exact local path where Grok must write the image.",
        },
        aspect_ratio: { type: "string" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "animate_reference_grok_video",
    description:
      "Generate a short image-to-video take with the installed Grok Build CLI's signed-in session. This keeps the LetMeActForYou reference-animation tool name and never handles xAI API keys, but the CLI's native video tool calls the xAI API (api.x.ai/v1/videos/generations) and meters the signed-in account's xAI console usage.",
    inputSchema: {
      type: "object",
      properties: {
        image_path: { type: "string" },
        image_url: { type: "string" },
        image_data_url: { type: "string" },
        prompt: { type: "string", minLength: 1 },
        line: { type: "string" },
        duration: { type: "number", minimum: 1, maximum: 60 },
        aspect_ratio: { type: "string" },
        output_path: {
          type: "string",
          description: "Exact local path where Grok must write the video.",
        },
      },
      anyOf: [
        { required: ["image_path"] },
        { required: ["image_url"] },
        { required: ["image_data_url"] },
      ],
      required: ["prompt"],
    },
  },
];

function defaultOutputPath(kind) {
  return path.join(os.tmpdir(), `designforyou-grok-${kind}-${crypto.randomUUID()}.${kind === "video" ? "mp4" : "png"}`);
}

function sanitizedEnvironment(source = process.env) {
  const env = { ...source };
  // Grok Build authenticates through its own signed-in CLI profile. Never pass
  // provider API keys through this sidecar, even if a parent process has them.
  for (const key of ["XAI_API_KEY", "XAI_API_KEY_ID", "GROK_API_KEY", "OPENAI_API_KEY"]) {
    delete env[key];
  }
  return env;
}

function buildPrompt(kind, input, outputPath) {
  const lines = [
    "Use only this CLI session's existing signed-in authentication and built-in media tools.",
    "Do not make raw HTTP calls to provider APIs, do not ask for an API key, and do not read or copy credentials or config files.",
    `Create a ${kind === "video" ? "short image-to-video MP4" : "single image"} from the user direction below.`,
    `Write the final binary artifact exactly to: ${outputPath}`,
    "Create parent directories if needed. Verify that the file exists before replying.",
    "Reply with compact JSON containing output_path and, when available, public_url.",
    "User direction:",
    input.prompt,
  ];

  if (kind === "image" && input.aspect_ratio) lines.push(`Aspect ratio: ${input.aspect_ratio}`);
  if (kind === "video") {
    if (input.image_path) lines.push(`Reference image path: ${input.image_path}`);
    if (input.image_url) lines.push(`Reference image URL: ${input.image_url}`);
    if (input.image_data_url) lines.push("A reference image data URL was supplied in the request; use it as the source image.");
    if (input.line) lines.push(`Spoken line: ${input.line}`);
    if (input.duration != null) lines.push(`Duration in seconds: ${input.duration}`);
    if (input.aspect_ratio) lines.push(`Aspect ratio: ${input.aspect_ratio}`);
  }
  return lines.join("\n");
}

function buildCommand(kind, input, outputPath, command = DEFAULT_COMMAND) {
  const prompt = buildPrompt(kind, input, outputPath);
  const cwd = path.dirname(outputPath);
  return {
    command,
    args: [
      "--output-format",
      "json",
      "--no-subagents",
      "--no-plan",
      "--always-approve",
      // Subscription-only guarantee: block every MCP tool so generation can
      // never route through a billing server (e.g. hosted DesignForYou),
      // even if one is authenticated in the local Grok CLI profile.
      "--deny",
      "mcp__*",
      "--cwd",
      cwd,
      "--single",
      prompt,
    ],
    cwd,
    prompt,
  };
}

function collectStrings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, output));
  return output;
}

function parseGrokOutput(stdout, stderr = "") {
  const text = `${stdout || ""}\n${stderr || ""}`;
  const strings = [];
  for (const whole of [stdout, stderr]) {
    if (!whole?.trim()) continue;
    try { collectStrings(JSON.parse(whole.trim()), strings); } catch {}
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      collectStrings(JSON.parse(trimmed), strings);
    } catch {
      strings.push(trimmed);
    }
  }
  const mediaPaths = [];
  const publicUrls = [];
  const s3Urls = [];
  const s3Keys = [];
  for (const value of strings) {
    const urls = value.match(/https?:\/\/[^\s"'<>]+/gi) || [];
    for (const url of urls) {
      const cleanUrl = url.replace(/[),.;`]+$/, "");
      if (/\.(?:png|jpe?g|webp|gif|mp4|mov|webm|m4v)(?:[?#].*)?$/i.test(cleanUrl)) publicUrls.push(cleanUrl);
    }
    const s3Matches = value.match(/s3:\/\/[^\s"'<>]+/gi) || [];
    for (const uri of s3Matches) {
      const cleanUri = uri.replace(/[),.;`]+$/, "");
      if (/\.(?:png|jpe?g|webp|gif|mp4|mov|webm|m4v)(?:[?#].*)?$/i.test(cleanUri)) s3Urls.push(cleanUri);
    }
    const matches = value.match(/(?:[A-Za-z]:[\\/]|\/|\.\.?[\\/])[^\r\n"']+\.(?:png|jpe?g|webp|gif|mp4|mov|webm|m4v)/gi) || [];
    mediaPaths.push(...matches.map((item) => item.replace(/[),.;]+$/, "")));
  }
  // Preserve S3 object keys from structured Grok responses without treating
  // arbitrary JSON values (or credentials) as keys. Keys must name media.
  const structured = [];
  for (const whole of [stdout, stderr]) {
    if (!whole?.trim()) continue;
    try { structured.push(JSON.parse(whole.trim())); } catch {}
    for (const line of whole.split(/\r?\n/)) {
      try { structured.push(JSON.parse(line.trim())); } catch {}
    }
  }
  const visit = (value, field = "") => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, field));
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && /^(?:key|storage[_-]?key|s3[_-]?key|object[_-]?key|s3[_-]?uri|s3[_-]?path)$/i.test(key) &&
        /\.(?:mp4|mov|webm|m4v|png|jpe?g|webp|gif)(?:[?#].*)?$/i.test(item)) s3Keys.push(item.replace(/^\/+/, ""));
      visit(item, key);
    }
  };
  structured.forEach((value) => visit(value));
  return {
    mediaPaths: [...new Set(mediaPaths)],
    publicUrls: [...new Set(publicUrls)],
    s3Urls: [...new Set(s3Urls)],
    s3Keys: [...new Set(s3Keys)],
  };
}

function s3Config(options = {}) {
  const env = options.env || process.env;
  // An injected environment is test/isolation state; do not silently reach
  // into the host's Grok config unless the caller explicitly supplies a path.
  const configPath = options.s3ConfigPath || (!options.env ? env.DESIGNFORYOU_GROK_S3_CONFIG : null);
  const configured = options.s3Config || readGrokS3Config(configPath);
  const bucket = options.s3Bucket || env.DESIGNFORYOU_GROK_S3_BUCKET || configured?.bucket;
  if (!bucket) return null;
  return {
    bucket,
    prefix: options.s3Prefix ?? env.DESIGNFORYOU_GROK_S3_PREFIX ?? env.DESIGNFORYOU_GROK_S3_KEY_PREFIX ?? configured?.prefix ?? "",
    region: options.s3Region || env.DESIGNFORYOU_GROK_S3_REGION || configured?.region || "us-east-1",
    publicBaseUrl: options.s3PublicBaseUrl || env.DESIGNFORYOU_GROK_S3_PUBLIC_BASE_URL || configured?.publicBaseUrl || "",
    endpointUrl: options.s3Endpoint || env.DESIGNFORYOU_GROK_S3_ENDPOINT || configured?.endpoint || "",
    accessKeyId: configured?.accessKeyId,
    secretAccessKey: configured?.secretAccessKey,
    command: options.s3Command || env.DESIGNFORYOU_GROK_S3_COMMAND || DEFAULT_S3_COMMAND,
  };
}

// Read only the narrowly scoped ZDR video-output sections. The values are kept
// in memory for the child AWS process and are never logged, returned as a
// diagnostic, or bundled with this package.
function readGrokS3Config(configPath) {
  const filePath = configPath || path.join(os.homedir(), ".grok", "config.toml");
  let text;
  try { text = fs.readFileSync(filePath, "utf8"); } catch { return null; }
  let section = false;
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1] === "tools.zdr_video_output_s3" || sectionMatch[1] === "tools.zdr_video_output_s3.read_write";
      continue;
    }
    if (!section) continue;
    const match = line.match(/^(access_key_id|secret_access_key|bucket|endpoint|region|key_prefix)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*$/);
    if (!match) continue;
    result[match[1] === "access_key_id" ? "accessKeyId" : match[1] === "secret_access_key" ? "secretAccessKey" : match[1] === "key_prefix" ? "prefix" : match[1]] = match[2] ?? match[3];
  }
  return result.bucket ? result : null;
}

function normalizeS3Objects(value) {
  const contents = Array.isArray(value) ? value : value?.Contents;
  if (!Array.isArray(contents)) return [];
  return contents.map((item) => ({
    key: item?.Key ?? item?.key,
    size: Number(item?.Size ?? item?.size),
    lastModified: item?.LastModified ?? item?.lastModified ?? item?.last_modified,
  })).filter((item) => typeof item.key === "string" && Number.isFinite(item.size));
}

async function runS3ListCommand(config, options = {}) {
  const commandImpl = options.s3CommandImpl || options.commandImpl;
  if (typeof commandImpl === "function") {
    const { accessKeyId, secretAccessKey, ...safeConfig } = config;
    return normalizeS3Objects(await commandImpl(safeConfig));
  }
  const spawnImpl = options.spawnImpl || spawn;
  return new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const args = ["s3api", "list-objects-v2", "--bucket", config.bucket, ...(config.prefix ? ["--prefix", config.prefix] : []), "--output", "json"];
    if (config.endpointUrl) args.push("--endpoint-url", config.endpointUrl);
    if (config.region) args.push("--region", config.region);
    const childEnv = sanitizedEnvironment(options.env);
    delete childEnv.AWS_PROFILE;
    if (config.accessKeyId) childEnv.AWS_ACCESS_KEY_ID = config.accessKeyId;
    if (config.secretAccessKey) childEnv.AWS_SECRET_ACCESS_KEY = config.secretAccessKey;
    const child = spawnImpl(config.command, args, {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (error, result) => { if (settled) return; settled = true; error ? reject(error) : resolve(result); };
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.once("error", () => finish(new Error("S3 listing command could not be started")));
    child.once("close", (code) => {
      if (code !== 0) return finish(new Error("S3 listing command failed"));
      try { finish(null, normalizeS3Objects(JSON.parse(stdout))); } catch { finish(new Error("S3 listing returned invalid JSON")); }
    });
  });
}

async function listS3Objects(config, options = {}) {
  const listImpl = options.s3ListImpl || options.listImpl;
  if (typeof listImpl === "function") {
    const { accessKeyId, secretAccessKey, ...safeConfig } = config;
    return normalizeS3Objects(await listImpl(safeConfig, options));
  }
  return runS3ListCommand(config, options);
}

function s3ObjectUrl(config, key) {
  const base = config.publicBaseUrl || `https://${config.bucket}.s3.${config.region}.amazonaws.com`;
  return `${base.replace(/\/+$/, "")}/${String(key).split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

async function verifyPublicUrl(url, options = {}) {
  const headImpl = options.s3HeadImpl || options.headImpl;
  try {
    const result = headImpl ? await headImpl(url, options) : await fetch(url, { method: "HEAD", redirect: "follow" });
    if (typeof result === "boolean") return result;
    if (typeof result === "number") return result >= 200 && result < 400;
    return result?.ok === true || (Number.isFinite(result?.status) && result.status >= 200 && result.status < 400);
  } catch { return false; }
}

function directS3Key(parsed, config) {
  for (const uri of parsed.s3Urls || []) {
    try {
      const parsedUri = new URL(uri);
      if (parsedUri.protocol === "s3:" && parsedUri.hostname === config.bucket) return decodeURIComponent(parsedUri.pathname.replace(/^\//, ""));
    } catch {}
  }
  return parsed.s3Keys?.find((key) => key && !key.includes("\\") && !key.startsWith("/")) || null;
}

async function discoverVideoPublicUrl({ parsed, config, before, after, outputPath, startedAt, finishedAt, options }) {
  const diagnostics = [];
  const directUrl = parsed.publicUrls?.[0] || null;
  // Keep the historical direct URL behavior when no S3 discovery is enabled;
  // configured discovery (and tests) always gets an explicit HTTP check.
  const shouldHead = Boolean(config || options.s3HeadImpl || options.headImpl);
  if (directUrl && (!shouldHead || await verifyPublicUrl(directUrl, options))) return { url: directUrl, diagnostic: null };
  if (directUrl) diagnostics.push("direct public URL was not HTTP-accessible");
  const key = config && directS3Key(parsed, config);
  if (key) {
    const url = s3ObjectUrl(config, key);
    if (await verifyPublicUrl(url, options)) return { url, diagnostic: null };
    diagnostics.push("direct S3 key URL was not HTTP-accessible");
  }
  if (!config) {
    diagnostics.push("S3 public URL discovery is not configured");
    return { url: null, diagnostic: diagnostics.join("; ") };
  }
  if (!before || !after) {
    diagnostics.push("S3 listing was unavailable");
    return { url: null, diagnostic: diagnostics.join("; ") };
  }
  const baseline = new Set(before.map((item) => item.key));
  const expectedSize = fs.statSync(outputPath).size;
  const start = startedAt - 1000;
  const end = finishedAt + 1000;
  const candidates = after.filter((item) => !baseline.has(item.key) && item.size === expectedSize && item.lastModified != null)
    .filter((item) => { const timestamp = new Date(item.lastModified).getTime(); return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end; });
  if (candidates.length !== 1) {
    diagnostics.push(candidates.length === 0 ? "no S3 object matched the generated file size and time window" : `S3 public URL discovery was ambiguous (${candidates.length} matching objects)`);
    return { url: null, diagnostic: diagnostics.join("; ") };
  }
  const candidateUrl = s3ObjectUrl(config, candidates[0].key);
  if (await verifyPublicUrl(candidateUrl, options)) return { url: candidateUrl, diagnostic: null };
  diagnostics.push("matched S3 object URL was not HTTP-accessible");
  return { url: null, diagnostic: diagnostics.join("; ") };
}

function verifyMediaFile(filePath, kind) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return { ok: false, reason: "file does not exist" }; }
  if (!stat.isFile() || stat.size === 0) return { ok: false, reason: "file is empty" };
  const header = fs.readFileSync(filePath).subarray(0, 12);
  const isPng = header.length >= 8 && header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  const isJpeg = header.length >= 3 && header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const isGif = header.subarray(0, 3).toString() === "GIF";
  const isWebp = header.subarray(0, 4).toString() === "RIFF" && header.subarray(8, 12).toString() === "WEBP";
  const isVideo = header.length >= 8 && header.subarray(4, 8).toString() === "ftyp";
  const isWebm = header.length >= 4 && header.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"));
  const valid = kind === "image" ? isPng || isJpeg || isGif || isWebp : isVideo || isWebm;
  return valid ? { ok: true } : { ok: false, reason: `unrecognized ${kind} file signature` };
}

function materializeReferenceDataUrl(input) {
  if (!input.image_data_url || input.image_path || !/^data:[^;]+;base64,/i.test(input.image_data_url)) {
    return { input, cleanup: null };
  }
  const match = input.image_data_url.match(/^data:([^;]+);base64,(.+)$/i);
  const extension = match[1].split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
  const digest = crypto.createHash("sha256").update(input.image_data_url).digest("hex").slice(0, 16);
  const referencePath = path.join(os.tmpdir(), `designforyou-grok-reference-${digest}.${extension}`);
  fs.writeFileSync(referencePath, Buffer.from(match[2], "base64"));
  return {
    input: { ...input, image_path: referencePath },
    cleanup: () => { try { fs.unlinkSync(referencePath); } catch {} },
  };
}

function spawnGrok(commandSpec, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const child = spawnImpl(commandSpec.command, commandSpec.args, {
      cwd: commandSpec.cwd,
      env: sanitizedEnvironment(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ ...result, stdout, stderr });
    };
    timer = setTimeout(() => {
      child.kill?.("SIGTERM");
      finish(new Error(`Grok CLI timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => finish(new Error(`Unable to start Grok CLI: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (code !== 0) {
        finish(new Error(`Grok CLI failed (exit=${code}, signal=${signal || "none"}): ${stderr.trim() || stdout.trim() || "no diagnostic output"}`));
      } else {
        finish(null, { code, signal });
      }
    });
  });
}

async function runGeneration(kind, input, options = {}) {
  const outputPath = path.resolve(input.output_path || defaultOutputPath(kind));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const reference = materializeReferenceDataUrl(input);
  try {
    const config = kind === "video" ? s3Config(options) : null;
    const startedAt = Date.now();
    let before = null;
    let listingDiagnostic = null;
    if (config) {
      try { before = await listS3Objects(config, options); }
      catch { listingDiagnostic = "S3 listing before generation failed"; }
    }
    const commandSpec = buildCommand(kind, reference.input, outputPath, options.command || process.env.DESIGNFORYOU_GROK_COMMAND || DEFAULT_COMMAND);
    const execution = await spawnGrok(commandSpec, options);
    const finishedAt = Date.now();
    const parsed = parseGrokOutput(execution.stdout, execution.stderr);
    if (!fs.existsSync(outputPath)) {
      const discovered = parsed.mediaPaths.find((candidate) => {
        const candidatePath = path.isAbsolute(candidate) ? candidate : path.resolve(commandSpec.cwd, candidate);
        return verifyMediaFile(candidatePath, kind).ok;
      });
      if (discovered) {
        const discoveredPath = path.isAbsolute(discovered) ? discovered : path.resolve(commandSpec.cwd, discovered);
        if (discoveredPath !== outputPath) fs.copyFileSync(discoveredPath, outputPath);
      }
    }
    const verification = verifyMediaFile(outputPath, kind);
    if (!verification.ok) {
      throw new Error(`Grok CLI output verification failed for ${outputPath}: ${verification.reason}`);
    }
    let publicUrl = parsed.publicUrls[0] || null;
    let publicUrlDiagnostic = null;
    if (kind === "video") {
      let after = null;
      if (config && !listingDiagnostic) {
        try { after = await listS3Objects(config, options); }
        catch { listingDiagnostic = "S3 listing after generation failed"; }
      }
      const discovered = await discoverVideoPublicUrl({
        parsed,
        config,
        before,
        after,
        outputPath,
        startedAt,
        finishedAt,
        options,
      });
      publicUrl = discovered.url;
      publicUrlDiagnostic = [listingDiagnostic, discovered.diagnostic].filter(Boolean).join("; ") || null;
    }
    return {
      provider: "grok-subscription",
      media_type: kind,
      output_path: outputPath,
      public_url: publicUrl,
      ...(publicUrlDiagnostic ? { public_url_diagnostic: publicUrlDiagnostic } : {}),
    };
  } finally {
    reference.cleanup?.();
  }
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleRequest(request, options = {}) {
  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion || "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "designforyou-grok-subscription", version: "1.0.0" },
      },
    };
  }
  if (request.method === "ping") return { jsonrpc: "2.0", id: request.id, result: {} };
  if (request.method?.startsWith("notifications/")) return null;
  if (request.method === "tools/list") return { jsonrpc: "2.0", id: request.id, result: { tools: TOOLS } };
  if (request.method !== "tools/call") return jsonRpcError(request.id, -32601, `Unknown method: ${request.method}`);
  const name = request.params?.name;
  if (name !== "grok_generate_image" && name !== "animate_reference_grok_video") return jsonRpcError(request.id, -32602, `Unknown tool: ${name}`);
  const input = request.params?.arguments || {};
  if (typeof input.prompt !== "string" || !input.prompt.trim()) return jsonRpcError(request.id, -32602, "prompt is required");
  if (name === "animate_reference_grok_video" && !input.image_path && !input.image_url && !input.image_data_url) {
    return jsonRpcError(request.id, -32602, "one of image_path, image_url, or image_data_url is required");
  }
  try {
    const result = await runGeneration(name === "animate_reference_grok_video" ? "video" : "image", input, options);
    return { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } };
  } catch (error) {
    return { jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: error.message }] } };
  }
}

function encodeMessage(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function takeUtf8Chars(value, byteLength) {
  let chars = 0;
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > byteLength) break;
    bytes += characterBytes;
    chars += character.length;
  }
  return { body: value.slice(0, chars), chars };
}

function startLocalServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  let buffer = "";
  let chain = Promise.resolve();
  const processBuffer = () => {
    while (true) {
      let lengthEnd = buffer.indexOf("\r\n\r\n");
      let headerLength = 4;
      if (lengthEnd < 0) {
        lengthEnd = buffer.indexOf("\n\n");
        headerLength = 2;
      }
      if (lengthEnd < 0) {
        // A newline-delimited fallback is useful for simple stdio harnesses;
        // framed MCP clients continue to use Content-Length below.
        if (!/^Content-Length:/i.test(buffer) && buffer.includes("\n")) {
          const lineEnd = buffer.indexOf("\n");
          const line = buffer.slice(0, lineEnd).trim();
          buffer = buffer.slice(lineEnd + 1);
          if (line) {
            try {
              const request = JSON.parse(line);
              chain = chain.then(async () => {
                const response = await handleRequest(request, options);
                if (response) output.write(`${JSON.stringify(response)}\n`);
              });
            } catch {
              // Ignore malformed input and continue reading the stdio stream.
            }
          }
          continue;
        }
        return;
      }
      const headers = buffer.slice(0, lengthEnd);
      const match = headers.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd < 0) return;
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (line) {
          try {
            const request = JSON.parse(line);
            chain = chain.then(async () => {
              const response = await handleRequest(request, options);
              if (response) output.write(`${JSON.stringify(response)}\n`);
            });
          } catch {
            // Ignore malformed input and continue reading the stdio stream.
          }
        }
        continue;
      }
      const length = Number(match[1]);
      const start = lengthEnd + headerLength;
      if (Buffer.byteLength(buffer.slice(start)) < length) return;
      const taken = takeUtf8Chars(buffer.slice(start), length);
      const body = taken.body;
      buffer = buffer.slice(start + taken.chars);
      let request;
      try { request = JSON.parse(body); } catch { continue; }
      chain = chain.then(async () => {
        const response = await handleRequest(request, options);
        if (response) output.write(encodeMessage(response));
      });
    }
  };
  input.setEncoding?.("utf8");
  input.on("data", (chunk) => { buffer += chunk; processBuffer(); });
  return { close: () => input.removeAllListeners?.("data") };
}

if (require.main === module) startLocalServer();

module.exports = {
  TOOLS,
  buildCommand,
  buildPrompt,
  handleRequest,
  parseGrokOutput,
  runGeneration,
  sanitizedEnvironment,
  s3Config,
  listS3Objects,
  verifyPublicUrl,
  discoverVideoPublicUrl,
  spawnGrok,
  startLocalServer,
  verifyMediaFile,
};
