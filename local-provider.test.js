"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildCommand,
  handleRequest,
  parseGrokOutput,
  runGeneration,
  sanitizedEnvironment,
  s3Config,
} = require("./local-provider");

function fakeSpawn({ stdout = "", stderr = "", code = 0 } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      if (stdout) child.stdout.emit("data", stdout);
      if (stderr) child.stderr.emit("data", stderr);
      child.emit("close", code, null);
    });
    child.kill = () => {};
    return child;
  };
  return { calls, spawnImpl };
}

function videoBytes(extra = "video") {
  return Buffer.concat([Buffer.from("00000018667479706d703432", "hex"), Buffer.from(extra)]);
}

function videoSpawn(outputPath, stdout = "") {
  const mock = fakeSpawn({ stdout });
  const spawnImpl = (command, args, options) => {
    fs.writeFileSync(outputPath, videoBytes());
    return mock.spawnImpl(command, args, options);
  };
  return { ...mock, spawnImpl };
}

test("command construction is deterministic and subscription-only", () => {
  const spec = buildCommand("image", { prompt: "a red kite", aspect_ratio: "1:1" }, "C:\\out\\image.png", "grok-test");
  assert.equal(spec.command, "grok-test");
  assert.deepEqual(spec.args.slice(0, 9), ["--output-format", "json", "--no-subagents", "--no-plan", "--always-approve", "--deny", "mcp__*", "--cwd", "C:\\out"]);
  assert.match(spec.args.at(-1), /existing signed-in authentication/);
  assert.match(spec.args.at(-1), /C:\\out\\image\.png/);
  assert.match(spec.args.at(-1), /Do not make raw HTTP calls to provider APIs/);
});

test("API key variables are removed from the child environment", () => {
  const env = sanitizedEnvironment({ XAI_API_KEY: "secret", GROK_API_KEY: "secret", PATH: "safe" });
  assert.deepEqual(env, { PATH: "safe" });
});

test("S3 config discovery merges the two narrowly scoped Grok sections", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "designforyou-grok-config-test-"));
  const configPath = path.join(dir, "config.toml");
  fs.writeFileSync(configPath, [
    "[tools.zdr_video_output_s3]",
    'bucket = "video-bucket"',
    'endpoint = "https://objects.example.test"',
    'region = "us-test-1"',
    'key_prefix = "generated/"',
    "",
    "[tools.zdr_video_output_s3.read_write]",
    'access_key_id = "access-id"',
    'secret_access_key = "secret-value"',
    "",
    "[unrelated]",
    'bucket = "do-not-read"',
  ].join("\n"));
  assert.deepEqual(s3Config({ s3ConfigPath: configPath, env: {} }), {
    bucket: "video-bucket",
    prefix: "generated/",
    region: "us-test-1",
    publicBaseUrl: "",
    endpointUrl: "https://objects.example.test",
    accessKeyId: "access-id",
    secretAccessKey: "secret-value",
    command: "aws",
  });
});

test("JSON and plain text output discovery finds media paths and public URLs", () => {
  const parsed = parseGrokOutput(
    '{"output_path":"C:\\\\tmp\\\\image.png","public_url":"https://cdn.example/image.png"}\nSaved to /tmp/video.mp4',
  );
  assert.ok(parsed.mediaPaths.some((item) => item.endsWith("image.png")));
  assert.ok(parsed.mediaPaths.some((item) => item.endsWith("video.mp4")));
  assert.deepEqual(parsed.publicUrls, ["https://cdn.example/image.png"]);
});

test("generation verifies the requested file and returns the optional URL", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "designforyou-grok-test-"));
  const outputPath = path.join(dir, "image.png");
  const mock = fakeSpawn({ stdout: JSON.stringify({ public_url: "https://cdn.example/image.png" }) });
  const spawnImpl = (command, args, options) => {
    fs.writeFileSync(outputPath, Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("mock image")]));
    return mock.spawnImpl(command, args, options);
  };
  const result = await runGeneration("image", { prompt: "a kite", output_path: outputPath }, { spawnImpl, command: "grok-test" });
  assert.equal(result.provider, "grok-subscription");
  assert.equal(result.output_path, outputPath);
  assert.equal(result.public_url, "https://cdn.example/image.png");
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].command, "grok-test");
});

test("generation surfaces CLI failures and missing output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "designforyou-grok-test-"));
  const failed = fakeSpawn({ stderr: "not logged in", code: 1 });
  await assert.rejects(
    runGeneration("video", { prompt: "animate it", output_path: path.join(dir, "video.mp4") }, { spawnImpl: failed.spawnImpl }),
    /Grok CLI failed.*not logged in/,
  );
  const missing = fakeSpawn({ stdout: JSON.stringify({ public_url: "https://cdn.example/video.mp4" }) });
  await assert.rejects(
    runGeneration("video", { prompt: "animate it", output_path: path.join(dir, "missing.mp4") }, { spawnImpl: missing.spawnImpl }),
    /output verification failed.*file does not exist/,
  );
});

test("generation rejects empty or wrong-type artifacts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "designforyou-grok-test-"));
  const outputPath = path.join(dir, "image.png");
  const mock = fakeSpawn();
  const spawnImpl = (command, args, options) => {
    fs.writeFileSync(outputPath, "not an image");
    return mock.spawnImpl(command, args, options);
  };
  await assert.rejects(
    runGeneration("image", { prompt: "a kite", output_path: outputPath }, { spawnImpl, command: "grok-test" }),
    /output verification failed.*unrecognized image file signature/,
  );
});

test("video S3 discovery correlates one new object by exact size and verifies HTTP", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "designforyou-grok-s3-test-"));
  const outputPath = path.join(dir, "video.mp4");
  const mock = videoSpawn(outputPath);
  let listCalls = 0;
  const result = await runGeneration("video", { prompt: "animate it", image_path: "ref.png", output_path: outputPath }, {
    spawnImpl: mock.spawnImpl,
    command: "grok-test",
    env: { DESIGNFORYOU_GROK_S3_BUCKET: "bucket" },
    s3ConfigPath: path.join(dir, "no-config.toml"),
    s3ListImpl: async () => {
      listCalls += 1;
      return listCalls === 1 ? [{ Key: "old.mp4", Size: 1, LastModified: new Date() }] : [{ Key: "new/video.mp4", Size: fs.statSync(outputPath).size, LastModified: new Date() }];
    },
    s3HeadImpl: async (url) => url.endsWith("new/video.mp4"),
  });
  assert.equal(result.public_url, "https://bucket.s3.us-east-1.amazonaws.com/new/video.mp4");
  assert.equal(result.public_url_diagnostic, undefined);
  assert.equal(listCalls, 2);
});

test("video without S3 configuration retains local success with a diagnostic", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "designforyou-grok-s3-test-"));
  const outputPath = path.join(dir, "video.mp4");
  const mock = videoSpawn(outputPath);
  const result = await runGeneration("video", { prompt: "animate it", image_path: "ref.png", output_path: outputPath }, { spawnImpl: mock.spawnImpl, s3ConfigPath: path.join(dir, "no-config.toml") });
  assert.equal(result.public_url, null);
  assert.match(result.public_url_diagnostic, /not configured/);
});

test("video S3 discovery rejects a size-mismatched object", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "designforyou-grok-s3-test-"));
  const outputPath = path.join(dir, "video.mp4");
  const mock = videoSpawn(outputPath);
  let listCalls = 0;
  const result = await runGeneration("video", { prompt: "animate it", image_path: "ref.png", output_path: outputPath }, {
    spawnImpl: mock.spawnImpl,
    env: { DESIGNFORYOU_GROK_S3_BUCKET: "bucket" },
    s3ConfigPath: path.join(dir, "no-config.toml"),
    s3ListImpl: async () => (++listCalls === 1 ? [] : [{ Key: "wrong.mp4", Size: 999, LastModified: new Date() }]),
    s3HeadImpl: async () => true,
  });
  assert.equal(result.public_url, null);
  assert.match(result.public_url_diagnostic, /no S3 object matched/);
});

test("video S3 discovery fails closed on concurrent ambiguous matches", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "designforyou-grok-s3-test-"));
  const outputPath = path.join(dir, "video.mp4");
  const mock = videoSpawn(outputPath);
  let listCalls = 0;
  const result = await runGeneration("video", { prompt: "animate it", image_path: "ref.png", output_path: outputPath }, {
    spawnImpl: mock.spawnImpl,
    env: { DESIGNFORYOU_GROK_S3_BUCKET: "bucket" },
    s3ConfigPath: path.join(dir, "no-config.toml"),
    s3ListImpl: async () => (++listCalls === 1 ? [] : [
      { Key: "one.mp4", Size: fs.statSync(outputPath).size, LastModified: new Date() },
      { Key: "two.mp4", Size: fs.statSync(outputPath).size, LastModified: new Date() },
    ]),
    s3HeadImpl: async () => true,
  });
  assert.equal(result.public_url, null);
  assert.match(result.public_url_diagnostic, /ambiguous/);
});

test("video S3 discovery retains local success when matched URL is inaccessible", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "designforyou-grok-s3-test-"));
  const outputPath = path.join(dir, "video.mp4");
  const mock = videoSpawn(outputPath);
  let listCalls = 0;
  const result = await runGeneration("video", { prompt: "animate it", image_path: "ref.png", output_path: outputPath }, {
    spawnImpl: mock.spawnImpl,
    env: { DESIGNFORYOU_GROK_S3_BUCKET: "bucket" },
    s3ConfigPath: path.join(dir, "no-config.toml"),
    s3ListImpl: async () => (++listCalls === 1 ? [] : [{ Key: "private.mp4", Size: fs.statSync(outputPath).size, LastModified: new Date() }]),
    s3HeadImpl: async () => false,
  });
  assert.equal(result.public_url, null);
  assert.match(result.public_url_diagnostic, /not HTTP-accessible/);
});

test("MCP tool listing and calls are scoped to the local provider", async () => {
  const listed = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["grok_generate_image", "animate_reference_grok_video"]);
  const invalid = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "generate", arguments: {} } });
  assert.equal(invalid.error.code, -32602);
  const missingReference = await handleRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "animate_reference_grok_video", arguments: { prompt: "animate" } } });
  assert.match(missingReference.error.message, /image_path/);
});
