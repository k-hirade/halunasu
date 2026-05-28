import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(root, "config", "runtime-endpoints.json");
const defaultOutDir = join(root, "dist", "runtime-apps");

const apps = [
  {
    name: "lp",
    path: "apps/lp",
    htmlFiles: ["signup.html"],
    meta: {
      "halunasu-platform-api-base-url": "platformApi"
    }
  },
  {
    name: "core-admin",
    path: "apps/core-admin",
    htmlFiles: ["index.html"],
    meta: {
      "halunasu-platform-api-base-url": "platformApi"
    }
  },
  {
    name: "charting-web",
    path: "apps/charting-web",
    htmlFiles: ["index.html"],
    meta: {
      "halunasu-platform-api-base-url": "platformApi",
      "halunasu-charting-api-base-url": "chartingApi"
    }
  },
  {
    name: "fee-web",
    path: "apps/fee-web",
    htmlFiles: ["index.html"],
    meta: {
      "halunasu-platform-api-base-url": "platformApi",
      "halunasu-fee-api-base-url": "feeApi"
    }
  },
  {
    name: "referral-web",
    path: "apps/referral-web",
    htmlFiles: ["index.html"],
    meta: {
      "halunasu-platform-api-base-url": "platformApi",
      "halunasu-referral-api-base-url": "referralApi"
    }
  }
];

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) {
    throw new Error(`Unknown argument: ${arg}`);
  }
  const key = arg.slice(2);
  const value = process.argv[index + 1]?.startsWith("--") ? "true" : process.argv[index + 1] || "true";
  args.set(key, value);
  if (value !== "true") {
    index += 1;
  }
}

const targetEnv = args.get("env") || "all";
const outDir = args.get("out") ? join(root, args.get("out")) : defaultOutDir;
const config = JSON.parse(await readFile(configPath, "utf8"));
const envs = targetEnv === "all" ? Object.keys(config) : [targetEnv];

for (const env of envs) {
  if (!config[env]) {
    throw new Error(`Unknown runtime environment: ${env}`);
  }
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const env of envs) {
  for (const app of apps) {
    const source = join(root, app.path);
    const destination = join(outDir, env, app.name);
    await cp(source, destination, {
      recursive: true,
      filter: shouldCopyStaticAsset
    });

    for (const htmlFile of app.htmlFiles) {
      const htmlPath = join(destination, htmlFile);
      let html = await readFile(htmlPath, "utf8");
      for (const [metaName, endpointKey] of Object.entries(app.meta)) {
        html = replaceMetaContent(html, metaName, config[env][endpointKey], relative(root, htmlPath));
      }
      await writeFile(htmlPath, html);
    }
  }
}

for (const env of envs) {
  console.log(`${env}: ${relative(root, join(outDir, env))}`);
}

function replaceMetaContent(html, metaName, value, path) {
  if (!value) {
    throw new Error(`Missing value for ${metaName} in ${path}`);
  }

  const pattern = new RegExp(
    `(<meta\\s+name="${escapeRegExp(metaName)}"\\s+content=")[^"]*("\\s*/?>)`,
    "u"
  );
  if (!pattern.test(html)) {
    throw new Error(`Missing meta ${metaName} in ${path}`);
  }

  return html.replace(pattern, `$1${value}$2`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldCopyStaticAsset(sourcePath) {
  const normalized = sourcePath.replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1);
  return !normalized.includes("/node_modules/")
    && !normalized.includes("/scripts/")
    && basename !== "README.md"
    && basename !== "package.json";
}
