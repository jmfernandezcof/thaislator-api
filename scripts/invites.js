#!/usr/bin/env node
import path from "path";
import { fileURLToPath } from "url";
import { createInviteStore } from "../lib/invite-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ledger = process.env.INVITE_LEDGER || (process.env.NODE_ENV === "production" ? "/data/logs/invites.json" : path.resolve(here, "../logs/invites.json"));
const store = createInviteStore(ledger, { defaultDailyCredits: 30, globalDailyCredits: 250 });
const [command, ...args] = process.argv.slice(2);

if (command === "create") {
  const invite = store.create({ alias: args[0] || "tester", days: Number(args[1] || 14), dailyCredits: Number(args[2] || 30) });
  console.log(`ID: ${invite.id}`);
  console.log(`Caduca: ${invite.expiresAt}`);
  console.log(`Créditos/día: ${invite.dailyCredits}`);
  console.log(`Enlace: https://eurthai.nomadprompters.es/#invite=${invite.token}`);
} else if (command === "list") {
  console.table(store.list().map(i => ({ id: i.id, alias: i.alias, expires: i.expiresAt.slice(0, 10), revoked: !!i.revokedAt, today: i.usage?.day, credits: i.usage?.credits || 0, calls: i.usage?.calls || 0 })));
} else if (command === "revoke" && args[0]) {
  if (!store.revoke(args[0])) { console.error("Invitación no encontrada"); process.exitCode = 1; }
  else console.log(`Invitación ${args[0]} revocada`);
} else {
  console.log("Uso:");
  console.log("  node scripts/invites.js create <alias> [días=14] [créditos/día=30]");
  console.log("  node scripts/invites.js list");
  console.log("  node scripts/invites.js revoke <id>");
}
