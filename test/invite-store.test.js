import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createInviteStore } from "../lib/invite-store.js";

const execFileAsync = promisify(execFile);
const makeLedger = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eurthai-invites-"));
  return { dir, file: path.join(dir, "invites.json") };
};

test("create, charge and revoke preserve token secrecy", () => {
  const { dir, file } = makeLedger();
  try {
    const store = createInviteStore(file, { defaultDailyCredits: 10, globalDailyCredits: 20 });
    const created = store.create({ alias: "Tester", days: 7, dailyCredits: 10 });
    assert.equal(store.status(created.token).remaining, 10);
    assert.equal(store.charge(created.token, 3, "menu").remaining, 7);
    assert.equal(fs.readFileSync(file, "utf8").includes(created.token), false);
    assert.equal(store.revoke(created.id), true);
    assert.equal(store.status(created.token).reason, "revoked");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("corrupt ledger fails closed and is never overwritten", () => {
  const { dir, file } = makeLedger();
  try {
    fs.writeFileSync(file, "not-json", { mode: 0o600 });
    const store = createInviteStore(file);
    assert.throws(() => store.list(), /unavailable/);
    assert.throws(() => store.create({ alias: "blocked" }), /unavailable/);
    assert.equal(fs.readFileSync(file, "utf8"), "not-json");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent processes cannot lose quota updates", async () => {
  const { dir, file } = makeLedger();
  try {
    const store = createInviteStore(file, { defaultDailyCredits: 100, globalDailyCredits: 100 });
    const created = store.create({ alias: "Concurrent", dailyCredits: 100 });
    const moduleUrl = new URL("../lib/invite-store.js", import.meta.url).href;
    const code = `import {createInviteStore} from ${JSON.stringify(moduleUrl)};const s=createInviteStore(process.argv[1],{defaultDailyCredits:100,globalDailyCredits:100});const r=s.charge(process.argv[2],1,'test');if(!r.ok)process.exit(2);`;
    await Promise.all(Array.from({ length: 25 }, () => execFileAsync(process.execPath,
      ["--input-type=module", "--eval", code, file, created.token], { timeout: 10000 })));
    const status = store.status(created.token);
    assert.equal(status.remaining, 75);
    assert.equal(status.globalRemaining, 75);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
