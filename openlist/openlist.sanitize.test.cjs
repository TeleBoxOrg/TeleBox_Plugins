const assert = require("node:assert/strict");
const { sanitizeMediaFileName } = require("./sanitizeFileName.ts");

const cases = new Map([
  ["../../etc/passwd", "passwd"],
  ["..\\..\\secret.txt", "secret.txt"],
  ["/tmp/owned.bin", "owned.bin"],
  ["normal report.pdf", "normal report.pdf"],
  ["... ", /^file_\d+$/],
  ["nul\u0000name.txt", "nulname.txt"],
]);

for (const [input, expected] of cases) {
  const actual = sanitizeMediaFileName(input);
  if (expected instanceof RegExp) assert.match(actual, expected);
  else assert.equal(actual, expected);
  assert.equal(actual.includes("/"), false);
  assert.equal(actual.includes("\\"), false);
}

console.log(`SANITIZER_TESTS_OK=${cases.size}`);
