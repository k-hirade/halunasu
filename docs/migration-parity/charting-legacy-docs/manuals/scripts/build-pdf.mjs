import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const manualsDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(manualsDir, "../..");

const defaults = {
  input: path.join(manualsDir, "src/user-manual-v1.md"),
  htmlOutput: path.join(manualsDir, "dist/harunas-user-manual-v1.html"),
  pdfOutput: path.join(manualsDir, "dist/harunas-user-manual-v1.pdf")
};

function parseArgs(argv) {
  const options = {
    input: defaults.input,
    htmlOutput: defaults.htmlOutput,
    pdfOutput: defaults.pdfOutput,
    htmlOnly: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--input") {
      options.input = path.resolve(repoRoot, argv[++i]);
    } else if (arg === "--html-output") {
      options.htmlOutput = path.resolve(repoRoot, argv[++i]);
    } else if (arg === "--output") {
      options.pdfOutput = path.resolve(repoRoot, argv[++i]);
    } else if (arg === "--html-only" || arg === "--no-pdf") {
      options.htmlOnly = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function applyScreenshotDirectives(markdown, markdownDir) {
  const pattern = /<!--\s*screenshot:\s+([^\s]+)(?:\s+alt="([^"]*)")?(?:\s+caption="([^"]*)")?\s*-->/g;
  const replacements = [];

  for (const match of markdown.matchAll(pattern)) {
    const [, source, alt = "", caption = ""] = match;
    const absoluteSource = path.resolve(markdownDir, source);

    if (await fileExists(absoluteSource)) {
      const normalizedSource = source.replaceAll("\\", "/");
      const imageMarkdown = caption
        ? `![${alt}](${normalizedSource})\n\n*${caption}*`
        : `![${alt}](${normalizedSource})`;
      replacements.push([match[0], imageMarkdown]);
    } else {
      replacements.push([match[0], ""]);
    }
  }

  return replacements.reduce((current, [from, to]) => current.replace(from, to), markdown);
}

function renderInline(value, baseDir) {
  let html = escapeHtml(value);

  html = html.replace(/`([^`]+)`/g, (_match, code) => `<code>${code}</code>`);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const rawHref = String(href).trim();
    const resolvedHref = rawHref.startsWith("http://") || rawHref.startsWith("https://") || rawHref.startsWith("#")
      ? rawHref
      : pathToFileURL(path.resolve(baseDir, rawHref)).href;
    return `<a href="${escapeAttribute(resolvedHref)}">${label}</a>`;
  });

  return html;
}

function parseTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line) {
  const cells = parseTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderImage(line, baseDir, nextLine) {
  const match = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);

  if (!match) {
    return null;
  }

  const [, alt, source] = match;
  const imageUrl = pathToFileURL(path.resolve(baseDir, source.trim())).href;
  const captionMatch = nextLine?.match(/^\*([^*]+)\*$/);
  const caption = captionMatch ? captionMatch[1] : "";

  return {
    html: [
      "<figure>",
      `  <img alt="${escapeAttribute(alt)}" src="${escapeAttribute(imageUrl)}" />`,
      caption ? `  <figcaption>${renderInline(caption, baseDir)}</figcaption>` : "",
      "</figure>"
    ].filter(Boolean).join("\n"),
    consumedNextLine: Boolean(caption)
  };
}

function renderMarkdown(markdown, baseDir) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    const fenceMatch = trimmed.match(/^```([A-Za-z0-9_-]+)?$/);
    if (fenceMatch) {
      const language = fenceMatch[1] || "";
      const codeLines = [];
      i += 1;

      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }

      i += 1;
      output.push(`<pre><code${language ? ` class="language-${escapeAttribute(language)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      output.push(`<h${level}>${renderInline(headingMatch[2], baseDir)}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      output.push("<hr />");
      i += 1;
      continue;
    }

    const image = renderImage(trimmed, baseDir, lines[i + 1]?.trim());
    if (image) {
      output.push(image.html);
      i += image.consumedNextLine ? 2 : 1;
      continue;
    }

    if (trimmed.startsWith("> ")) {
      const quoteLines = [];

      while (i < lines.length && lines[i].trim().startsWith("> ")) {
        quoteLines.push(lines[i].trim().slice(2));
        i += 1;
      }

      output.push(`<blockquote>${quoteLines.map((quote) => `<p>${renderInline(quote, baseDir)}</p>`).join("\n")}</blockquote>`);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items = [];

      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i += 1;
      }

      output.push(`<ul>\n${items.map((item) => `  <li>${renderInline(item, baseDir)}</li>`).join("\n")}\n</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];

      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i += 1;
      }

      output.push(`<ol>\n${items.map((item) => `  <li>${renderInline(item, baseDir)}</li>`).join("\n")}\n</ol>`);
      continue;
    }

    if (trimmed.includes("|") && lines[i + 1] && isTableSeparator(lines[i + 1])) {
      const headers = parseTableRow(trimmed);
      const rows = [];
      i += 2;

      while (i < lines.length && lines[i].trim().includes("|") && lines[i].trim()) {
        rows.push(parseTableRow(lines[i]));
        i += 1;
      }

      output.push([
        "<table>",
        "  <thead>",
        `    <tr>${headers.map((header) => `<th>${renderInline(header, baseDir)}</th>`).join("")}</tr>`,
        "  </thead>",
        "  <tbody>",
        ...rows.map((row) => `    <tr>${row.map((cell) => `<td>${renderInline(cell, baseDir)}</td>`).join("")}</tr>`),
        "  </tbody>",
        "</table>"
      ].join("\n"));
      continue;
    }

    const paragraphLines = [];

    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().match(/^(#{1,6})\s+/) &&
      !lines[i].trim().match(/^```/) &&
      !lines[i].trim().match(/^[-*]\s+/) &&
      !lines[i].trim().match(/^\d+\.\s+/) &&
      !lines[i].trim().startsWith("> ") &&
      !(lines[i].trim().includes("|") && lines[i + 1] && isTableSeparator(lines[i + 1]))
    ) {
      paragraphLines.push(lines[i].trim());
      i += 1;
    }

    output.push(`<p>${renderInline(paragraphLines.join(" "), baseDir)}</p>`);
  }

  return output.join("\n\n");
}

function extractTitle(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "ハルナス Manual";
}

async function buildHtml({ input }) {
  const markdownDir = path.dirname(input);
  const [template, css, rawMarkdown] = await Promise.all([
    readFile(path.join(manualsDir, "templates/manual.html"), "utf8"),
    readFile(path.join(manualsDir, "templates/manual.css"), "utf8"),
    readFile(input, "utf8")
  ]);

  const markdown = await applyScreenshotDirectives(rawMarkdown, markdownDir);
  const title = extractTitle(markdown);
  const content = renderMarkdown(markdown, markdownDir)
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");

  return template
    .replace("{{TITLE}}", escapeHtml(title))
    .replace("{{CSS}}", css.trimEnd())
    .replace("{{CONTENT}}", content);
}

async function writeHtml(html, outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf8");
}

async function waitForImages(page) {
  await page.evaluate(async () => {
    const images = Array.from(document.images || []);
    await Promise.all(images.map(async (image) => {
      if (image.complete && image.naturalWidth > 0) {
        return;
      }

      try {
        if (typeof image.decode === "function") {
          await image.decode();
          return;
        }
      } catch {
        // Fall back to load/error events below.
      }

      await new Promise((resolve) => {
        const cleanup = () => {
          image.removeEventListener("load", cleanup);
          image.removeEventListener("error", cleanup);
          resolve();
        };

        image.addEventListener("load", cleanup, { once: true });
        image.addEventListener("error", cleanup, { once: true });
      });
    }));
  });
}

async function writePdf(htmlPath, outputPath) {
  let chromium;

  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("Playwright is not installed. Run `npm install --save-dev playwright` and `npx playwright install chromium`.");
  }

  await mkdir(path.dirname(outputPath), { recursive: true });

  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await waitForImages(page);
    await page.pdf({
      path: outputPath,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: [
        '<div style="width:100%;font-size:9px;color:#687574;padding:0 14mm;display:flex;justify-content:space-between;font-family:-apple-system,BlinkMacSystemFont,\'Hiragino Sans\',\'Yu Gothic\',sans-serif;">',
        "<span>ハルナス 利用マニュアル v1</span>",
        '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span>',
        "</div>"
      ].join(""),
      margin: {
        top: "14mm",
        right: "14mm",
        bottom: "18mm",
        left: "14mm"
      }
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const html = await buildHtml(options);

  await writeHtml(html, options.htmlOutput);
  console.log(`Wrote ${path.relative(repoRoot, options.htmlOutput)}`);

  if (!options.htmlOnly) {
    await writePdf(options.htmlOutput, options.pdfOutput);
    console.log(`Wrote ${path.relative(repoRoot, options.pdfOutput)}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
