import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIRECTORY, "..");
const FRONTEND_DIRECTORY = join(ROOT, "frontend");
const PUBLIC_DIRECTORY = join(ROOT, "public");
const PUBLIC_ASSET_DIRECTORY = join(PUBLIC_DIRECTORY, "assets");

const SOURCE_PATHS = Object.freeze({
  html: join(FRONTEND_DIRECTORY, "index.html"),
  app: join(FRONTEND_DIRECTORY, "app.js"),
  messageActions: join(FRONTEND_DIRECTORY, "message-actions.js"),
  messageActionStyle: join(FRONTEND_DIRECTORY, "message-actions.css"),
  style: join(FRONTEND_DIRECTORY, "styles.css"),
  zipImportAddon: join(FRONTEND_DIRECTORY, "zip-import-addon.js"),
  math: join(ROOT, "node_modules/katex/dist/katex.mjs"),
  knowledgeImageReferences: join(ROOT, "lib/knowledge-image-references.mjs"),
});

const PLACEHOLDERS = Object.freeze({
  app: "__APP_ASSET__",
  style: "__STYLE_ASSET__",
});

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function replaceExactlyOnce(template, placeholder, replacement) {
  const first = template.indexOf(placeholder);
  if (first < 0 || template.indexOf(placeholder, first + placeholder.length) >= 0) {
    throw new Error(`Frontend template must contain ${placeholder} exactly once`);
  }
  return `${template.slice(0, first)}${replacement}${template.slice(first + placeholder.length)}`;
}

async function expectedBuild() {
  const [template, appSource, baseStyle, zipImportAddon, math, imageReferencesModule, messageActions, actionStyle] = await Promise.all([
    readFile(SOURCE_PATHS.html, "utf8"),
    readFile(SOURCE_PATHS.app),
    readFile(SOURCE_PATHS.style),
    readFile(SOURCE_PATHS.zipImportAddon, "utf8"),
    readFile(SOURCE_PATHS.math),
    readFile(SOURCE_PATHS.knowledgeImageReferences, "utf8"),
    readFile(SOURCE_PATHS.messageActions, "utf8"),
    readFile(SOURCE_PATHS.messageActionStyle),
  ]);
  // Share the inert HTML/Markdown image parser with OA, alongside local math.
  const imageReferencesScript = replaceExactlyOnce(imageReferencesModule,
    "export function knowledgeImageReferences", "function knowledgeImageReferences");
  const zipImportBundle = Buffer.from(`"use strict";\n(() => {\n${imageReferencesScript}\n${zipImportAddon}\n})();\n`, "utf8");
  const mathName = `katex-${digest(math)}.mjs`;
  const app = Buffer.from(`${messageActions}\n${replaceExactlyOnce(appSource.toString("utf8"), "__KATEX_ASSET__", `/assets/${mathName}`)}\nvoid openIncomingSharedAnswer();\n`, "utf8");
  const style = Buffer.concat([baseStyle, Buffer.from("\n"), actionStyle]);
  const appName = `app-${digest(app)}.js`;
  const styleName = `styles-${digest(style)}.css`;
  const withApp = replaceExactlyOnce(template, PLACEHOLDERS.app, `/assets/${appName}`);
  const html = replaceExactlyOnce(withApp, PLACEHOLDERS.style, `/assets/${styleName}`);
  if (html.includes("__APP_ASSET__") || html.includes("__STYLE_ASSET__")) {
    throw new Error("Frontend template contains an unresolved asset placeholder");
  }
  return {
    html: Buffer.from(html, "utf8"),
    rootFiles: new Map([["zip-import-addon.js", zipImportBundle]]),
    assets: new Map([
      [appName, app],
      [mathName, math],
      [styleName, style],
    ]),
  };
}

async function generatedAssetNames() {
  try {
    const entries = await readdir(PUBLIC_ASSET_DIRECTORY, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(?:css|m?js)$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function equalFile(path, expected) {
  try {
    const actual = await readFile(path);
    return actual.equals(expected);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function checkBuild(expected) {
  const problems = [];
  if (!(await equalFile(join(PUBLIC_DIRECTORY, "index.html"), expected.html))) {
    problems.push("public/index.html is stale");
  }
  for (const [name, bytes] of expected.rootFiles) {
    if (!(await equalFile(join(PUBLIC_DIRECTORY, name), bytes))) problems.push(`public/${name} is missing or stale`);
  }
  for (const [name, bytes] of expected.assets) {
    if (!(await equalFile(join(PUBLIC_ASSET_DIRECTORY, name), bytes))) {
      problems.push(`public/assets/${name} is missing or stale`);
    }
  }
  const expectedNames = [...expected.assets.keys()].sort();
  const actualNames = await generatedAssetNames();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    problems.push(
      `generated JS/CSS set differs (expected ${expectedNames.join(", ")}; found ${actualNames.join(", ") || "none"})`,
    );
  }
  if (problems.length) {
    throw new Error(`${problems.join("; ")}. Run npm run build:frontend.`);
  }
}

async function writeBuild(expected) {
  await mkdir(PUBLIC_ASSET_DIRECTORY, { recursive: true });
  for (const [name, bytes] of expected.rootFiles) await writeFile(join(PUBLIC_DIRECTORY, name), bytes);
  for (const [name, bytes] of expected.assets) {
    await writeFile(join(PUBLIC_ASSET_DIRECTORY, name), bytes);
  }
  await writeFile(join(PUBLIC_DIRECTORY, "index.html"), expected.html);
  for (const name of await generatedAssetNames()) {
    if (!expected.assets.has(name)) await unlink(join(PUBLIC_ASSET_DIRECTORY, name));
  }
}

export async function buildFrontend({ check = false } = {}) {
  const expected = await expectedBuild();
  if (check) await checkBuild(expected);
  else await writeBuild(expected);
  return {
    mode: check ? "checked" : "built",
    assets: [...expected.assets.keys()].sort(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.some((argument) => argument !== "--check") || argumentsList.length > 1) {
    throw new Error("Usage: node scripts/build-frontend.mjs [--check]");
  }

  const result = await buildFrontend({ check: argumentsList[0] === "--check" });
  process.stdout.write(`Frontend ${result.mode}: ${result.assets.join(", ")}\n`);
}
