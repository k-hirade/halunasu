#!/usr/bin/env node
// 眼科カルテのデモデータ（架空患者・受診履歴・当日の予約・よく使う薬剤）を投入する。
// 既定は dry-run。--apply を付けたときだけ書き込む。何度実行しても重複しない。
//
//   node scripts/seed_eye_demo.mjs --env stg --organization-code halunasu-internal-stg
//   node scripts/seed_eye_demo.mjs --env stg --organization-code halunasu-internal-stg --apply
import { organizationCodePath } from "../packages/firestore-schema/src/index.js";
import { createFirestoreDb, FirestorePlatformStore } from "../services/platform-api/src/store/firestore-store.js";
import { createEyeFirestoreDb, FirestoreEyeStore } from "../services/eye-api/src/store/firestore-store.js";
import { todayInJapan } from "./lib/eye-demo-dataset.mjs";
import { loadEyeDemoData } from "./lib/eye-demo-loader.mjs";

const PROJECTS = Object.freeze({
  stg: { core: "medical-core-stg", eye: "halunasu-eye-stg" },
  prod: { core: "medical-core-497610", eye: "halunasu-eye-prod" }
});

const args = parseArgs(process.argv.slice(2));
const env = args.get("env");
const organizationCode = String(args.get("organization-code") || "").trim().toLowerCase();
const apply = args.get("apply") === "true";
const today = args.get("date") || todayInJapan();

if (!PROJECTS[env] || !organizationCode) {
  console.error("Usage: node scripts/seed_eye_demo.mjs --env stg|prod --organization-code CODE [--date YYYY-MM-DD] [--apply]");
  process.exit(64);
}
if (env === "prod" && process.env.EYE_DEMO_ALLOW_PROD !== "yes") {
  console.error("Refusing to seed demo patients into PROD without EYE_DEMO_ALLOW_PROD=yes");
  process.exit(65);
}

const coreDb = await createFirestoreDb({ projectId: PROJECTS[env].core });
const eyeDb = await createEyeFirestoreDb({ projectId: PROJECTS[env].eye });
const codeDoc = await coreDb.doc(organizationCodePath(organizationCode)).get();
if (!codeDoc.exists) {
  console.error(`Organization code not found in ${PROJECTS[env].core}: ${organizationCode}`);
  process.exit(66);
}
const orgId = codeDoc.data().orgId;
const entitlement = await coreDb.doc(`organizations/${orgId}/product_entitlements/eye`).get();
if (!entitlement.exists) {
  console.error(`The organization does not have the eye product enabled: ${organizationCode}`);
  process.exit(67);
}

console.log(`Eye demo seed ${apply ? "APPLY" : "DRY RUN"}: ${env} ${organizationCode} (${orgId}) date=${today}`);
const summary = await loadEyeDemoData({
  platformStore: new FirestorePlatformStore({ db: coreDb }),
  eyeStore: new FirestoreEyeStore({ db: eyeDb }),
  orgId,
  today,
  apply,
  log: (line) => console.log(`- ${line}`)
});
console.log(JSON.stringify(summary));
if (!apply) console.log("DRY RUN: no documents were written. Add --apply to write.");

function parseArgs(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed.set(key, "true");
    } else {
      parsed.set(key, next);
      index += 1;
    }
  }
  return parsed;
}
