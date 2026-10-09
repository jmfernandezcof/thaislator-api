import crypto from "crypto";
import fs from "fs";
import path from "path";

const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
const ID_RE = /^[a-f0-9]{10}$/;
const utcDay = () => new Date().toISOString().slice(0, 10);
const hashToken = token => crypto.createHash("sha256").update(token).digest("hex");
const safeToken = token => typeof token === "string" && TOKEN_RE.test(token);
const emptyStore = () => ({ version: 1, globalUsage: { day: "", credits: 0 }, invites: {} });
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function createInviteStore(filePath, options = {}) {
  const defaultDailyCredits = Number(options.defaultDailyCredits) > 0 ? Number(options.defaultDailyCredits) : 30;
  const globalDailyCredits = Number(options.globalDailyCredits) > 0 ? Number(options.globalDailyCredits) : 250;
  const lockPath = filePath + ".lock";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  function readUnlocked() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!parsed || parsed.version !== 1 || !parsed.invites || typeof parsed.invites !== "object")
        throw new Error("invalid schema");
      parsed.globalUsage ||= { day: "", credits: 0 };
      return parsed;
    } catch (error) {
      if (error.code === "ENOENT") return emptyStore();
      console.error("[invites] ledger read failed");
      throw new Error("invite ledger unavailable");
    }
  }

  function writeUnlocked(data) {
    const tmp = filePath + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, filePath);
      fs.chmodSync(filePath, 0o600);
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  }

  function withLock(fn) {
    const deadline = Date.now() + 3000;
    let fd;
    while (fd === undefined) {
      try { fd = fs.openSync(lockPath, "wx", 0o600); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const age = Date.now() - fs.statSync(lockPath).mtimeMs;
          if (age > 30000) { fs.unlinkSync(lockPath); continue; }
        } catch (statError) { if (statError.code !== "ENOENT") throw statError; }
        if (Date.now() >= deadline) throw new Error("invite ledger busy");
        pause(25);
      }
    }
    try { return fn(); }
    finally {
      try { fs.closeSync(fd); } catch (_) {}
      try { fs.unlinkSync(lockPath); } catch (_) {}
    }
  }

  function resetUsage(data, invite) {
    const day = utcDay();
    if (data.globalUsage.day !== day) data.globalUsage = { day, credits: 0 };
    invite.usage ||= { day, credits: 0, calls: 0 };
    if (invite.usage.day !== day) invite.usage = { day, credits: 0, calls: 0 };
  }

  function resolveIn(data, token) {
    if (!safeToken(token)) return { ok: false, reason: "invalid" };
    const hash = hashToken(token);
    const invite = data.invites[hash];
    if (!invite) return { ok: false, reason: "invalid" };
    if (invite.revokedAt) return { ok: false, reason: "revoked" };
    if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) return { ok: false, reason: "expired" };
    resetUsage(data, invite);
    return { ok: true, hash, invite, data };
  }

  function status(token) {
    if (!safeToken(token)) return { ok: false, reason: "invalid" };
    return withLock(() => {
      const data = readUnlocked();
      const found = resolveIn(data, token);
      if (!found.ok) return found;
      writeUnlocked(data);
      const { invite } = found;
      const daily = invite.dailyCredits || defaultDailyCredits;
      return { ok: true, id: invite.id, alias: invite.alias || "", expiresAt: invite.expiresAt,
        dailyCredits: daily, remaining: Math.max(0, daily - invite.usage.credits),
        globalRemaining: Math.max(0, globalDailyCredits - data.globalUsage.credits) };
    });
  }

  function chargeGlobal(cost) {
    return withLock(() => {
      const amount = Math.max(1, Number(cost) || 1);
      const data = readUnlocked();
      const day = utcDay();
      if (data.globalUsage.day !== day) data.globalUsage = { day, credits: 0 };
      if (data.globalUsage.credits + amount > globalDailyCredits) return { ok: false, reason: "global_quota", remaining: 0 };
      data.globalUsage.credits += amount;
      writeUnlocked(data);
      return { ok: true, globalRemaining: globalDailyCredits - data.globalUsage.credits };
    });
  }

  function charge(token, cost, tool) {
    if (!safeToken(token)) return { ok: false, reason: "invalid" };
    return withLock(() => {
      const amount = Math.max(1, Number(cost) || 1);
      const data = readUnlocked();
      const found = resolveIn(data, token);
      if (!found.ok) return found;
      const { invite, hash } = found;
      const daily = invite.dailyCredits || defaultDailyCredits;
      if (invite.usage.credits + amount > daily) return { ok: false, reason: "invite_quota", remaining: Math.max(0, daily - invite.usage.credits) };
      if (data.globalUsage.credits + amount > globalDailyCredits) return { ok: false, reason: "global_quota", remaining: 0 };
      invite.usage.credits += amount;
      invite.usage.calls += 1;
      invite.lastUsedAt = new Date().toISOString();
      invite.lastTool = String(tool || "unknown").slice(0, 32);
      data.globalUsage.credits += amount;
      data.invites[hash] = invite;
      writeUnlocked(data);
      return { ok: true, remaining: daily - invite.usage.credits,
        globalRemaining: globalDailyCredits - data.globalUsage.credits };
    });
  }

  function create({ alias = "", days = 14, dailyCredits = defaultDailyCredits } = {}) {
    return withLock(() => {
      const token = crypto.randomBytes(24).toString("base64url");
      const hash = hashToken(token);
      const data = readUnlocked();
      const now = new Date();
      const safeDays = Math.min(365, Math.max(1, Number(days) || 14));
      const safeCredits = Math.min(globalDailyCredits, Math.max(1, Number(dailyCredits) || defaultDailyCredits));
      const expires = new Date(now.getTime() + safeDays * 86400000);
      const id = crypto.randomBytes(5).toString("hex");
      const safeAlias = String(alias).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
      data.invites[hash] = { id, alias: safeAlias, createdAt: now.toISOString(),
        expiresAt: expires.toISOString(), revokedAt: null, dailyCredits: safeCredits,
        usage: { day: utcDay(), credits: 0, calls: 0 } };
      writeUnlocked(data);
      return { id, token, expiresAt: expires.toISOString(), dailyCredits: safeCredits };
    });
  }

  function list() {
    return withLock(() => Object.values(readUnlocked().invites)
      .map(invite => ({ ...invite }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  function revoke(id) {
    if (!ID_RE.test(String(id || ""))) return false;
    return withLock(() => {
      const data = readUnlocked();
      const entry = Object.values(data.invites).find(invite => invite.id === id);
      if (!entry) return false;
      entry.revokedAt = new Date().toISOString();
      writeUnlocked(data);
      return true;
    });
  }

  return { create, list, revoke, status, charge, chargeGlobal };
}
