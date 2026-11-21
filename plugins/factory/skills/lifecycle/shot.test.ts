import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = join(import.meta.dirname, "factory.mjs");
const load = () => import("./shot.mjs");

test("parseShotArgs applies defaults", async () => {
  const { parseShotArgs } = await load();
  const options = parseShotArgs([], { TMPDIR: "/scratch" });
  assert.deepEqual(options.widths, [1280, 390]);
  assert.equal(options.height, 900);
  assert.equal(options.out, "/scratch");
  assert.match(options.data, /factory\.example\.json$/);
});

test("parseShotArgs reads widths, height, and browser", async () => {
  const { parseShotArgs } = await load();
  const options = parseShotArgs(["--widths", "800, 320", "--height", "600", "--browser", "/x/chrome"], {});
  assert.deepEqual(options.widths, [800, 320]);
  assert.equal(options.height, 600);
  assert.equal(options.browser, "/x/chrome");
  assert.equal(parseShotArgs([], { CHROME: "/env/chrome" }).browser, "/env/chrome");
});

test("parseShotArgs rejects bad numbers and unknown flags", async () => {
  const { parseShotArgs } = await load();
  for (const argv of [["--widths", "abc"], ["--widths", "1280,"], ["--widths", "0"], ["--height", "-5"], ["--port", "1"]]) {
    assert.throws(() => parseShotArgs(argv, {}), undefined as never, argv.join(" "));
  }
});

test("the script exits 2 on bad arguments and prints help with 0", () => {
  const bad = spawnSync(process.execPath, [script, "shot", "--widths", "x"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--widths/);
  const help = spawnSync(process.execPath, [script, "shot", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node factory\.mjs shot/);
});
