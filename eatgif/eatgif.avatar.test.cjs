const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { createRequire } = require("node:module");

const projectRequire = createRequire("/root/telebox/package.json");
const esbuild = projectRequire("esbuild");
const { Api } = projectRequire("teleproto");
const sourcePath = path.join(__dirname, "eatgif.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = esbuild.transformSync(source, {
  loader: "ts",
  format: "cjs",
  target: "node20",
  sourcefile: sourcePath,
}).code;

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@utils/pluginBase") return { Plugin: class Plugin {} };
  if (request === "@utils/pathHelpers") {
    return {
      createDirectoryInAssets: () => "/tmp/eatgif-test-assets",
      createDirectoryInTemp: () => "/tmp/eatgif-test-temp",
    };
  }
  if (request === "@utils/pluginManager") return { getPrefixes: () => ["."] };
  if (request === "@utils/safeGetMessages") return { safeGetReplyMessage: async () => undefined };
  if (request === "axios") return { get: async () => ({ data: {} }) };
  return originalLoad.call(this, request, parent, isMain);
};

const pluginModule = new Module(sourcePath, module);
pluginModule.filename = sourcePath;
pluginModule.paths = Module._nodeModulePaths("/root/telebox");
try {
  pluginModule._compile(compiled, sourcePath);
} finally {
  Module._load = originalLoad;
}

async function main() {
  assert.equal(
    typeof pluginModule.exports.downloadAvatarDirect,
    "function",
    "eatgif must export downloadAvatarDirect for direct, scheduler-free avatar downloads",
  );

  const entity = new Api.User({
    id: 123,
    accessHash: 456,
    firstName: "Private User",
    photo: new Api.UserProfilePhoto({
      photoId: 789,
      dcId: 5,
    }),
  });
  const expected = Buffer.from("avatar-bytes");
  let invokedDc;
  let invokedRequest;
  const client = {
    getEntity: async () => entity,
    downloadProfilePhoto: async () => {
      throw new Error("Media request deadline exceeded");
    },
    invoke: async (request, dcId) => {
      invokedRequest = request;
      invokedDc = dcId;
      return new Api.upload.File({
        type: new Api.storage.FileJpeg(),
        mtime: 0,
        bytes: expected,
      });
    },
  };

  const actual = await pluginModule.exports.downloadAvatarDirect(client, entity.id);
  assert.deepEqual(actual, expected);
  assert.equal(invokedDc, 5, "avatar request must use the photo DC");
  assert.ok(invokedRequest instanceof Api.upload.GetFile);
  assert.ok(invokedRequest.location instanceof Api.InputPeerPhotoFileLocation);
  assert.equal(invokedRequest.location.photoId.toString(), "789");
  assert.equal(invokedRequest.location.big, false);

  const privateEntityBytes = Buffer.from("privacy-preserved-avatar");
  const privacyClient = {
    getEntity: async () => {
      throw new Error("full message entity must not be re-resolved");
    },
    invoke: async () => new Api.upload.File({
      type: new Api.storage.FileJpeg(),
      mtime: 0,
      bytes: privateEntityBytes,
    }),
  };
  const privacyResult = await pluginModule.exports.downloadAvatarDirect(privacyClient, entity);
  assert.deepEqual(
    privacyResult,
    privateEntityBytes,
    "message-carried entity must retain the visible private-group avatar",
  );
  console.log("eatgif direct avatar download regression test: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
