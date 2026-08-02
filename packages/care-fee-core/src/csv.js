import { createHash } from "node:crypto";
import iconv from "iconv-lite";
import {
  CARE_EMERGENCY_INPUT_COLUMNS,
  CARE_EMERGENCY_OUTPUT_COLUMNS
} from "../../care-fee-contracts/src/index.js";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export class CareFeeCsvError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CareFeeCsvError";
    this.code = code;
    this.statusCode = 400;
    this.details = Object.freeze({ ...details });
  }
}

export function decodeCareEmergencyCsv(input) {
  if (typeof input === "string") {
    return Object.freeze({
      bytes: Buffer.from(input, "utf8"),
      text: stripLeadingBom(input),
      encoding: "utf8",
      hadBom: input.charCodeAt(0) === 0xfeff
    });
  }

  const bytes = Buffer.isBuffer(input) ? Buffer.from(input) : Buffer.from(input || []);
  if (bytes.length === 0) {
    throw new CareFeeCsvError("empty_file", "CSV file is empty");
  }
  const hasUtf8Bom = bytes.subarray(0, 3).equals(UTF8_BOM);
  const payload = hasUtf8Bom ? bytes.subarray(3) : bytes;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    return Object.freeze({ bytes, text: stripLeadingBom(text), encoding: "utf8", hadBom: hasUtf8Bom });
  } catch {
    const text = iconv.decode(payload, "cp932");
    if (text.includes("\u0000") || text.includes("\ufffd")) {
      throw new CareFeeCsvError(
        "unsupported_encoding",
        "CSV must be UTF-8, UTF-8 BOM, or CP932"
      );
    }
    return Object.freeze({ bytes, text, encoding: "cp932", hadBom: false });
  }
}

export function parseCareEmergencyCsv(input) {
  const decoded = decodeCareEmergencyCsv(input);
  const records = parseRfc4180(decoded.text);
  if (records.length === 0 || records.every((record) => record.every((cell) => cell === ""))) {
    throw new CareFeeCsvError("empty_file", "CSV file contains no records");
  }

  const headers = records[0].map((header) => String(header).trim());
  if (headers.length === 0 || headers.every((header) => !header)) {
    throw new CareFeeCsvError("missing_header", "CSV header is missing");
  }
  const duplicateHeaders = duplicates(headers.filter(Boolean));
  if (duplicateHeaders.length > 0) {
    throw new CareFeeCsvError("duplicate_header", "CSV headers must be unique", {
      headers: duplicateHeaders
    });
  }
  if (headers.some((header) => !header)) {
    throw new CareFeeCsvError("blank_header", "CSV headers must not be blank");
  }

  const missingHeaders = CARE_EMERGENCY_INPUT_COLUMNS.filter((column) => !headers.includes(column));
  if (missingHeaders.length > 0) {
    throw new CareFeeCsvError("missing_required_headers", "CSV is missing fixed input columns", {
      headers: missingHeaders
    });
  }
  const outputHeaderConflicts = CARE_EMERGENCY_OUTPUT_COLUMNS.filter((column) => headers.includes(column));
  if (outputHeaderConflicts.length > 0) {
    throw new CareFeeCsvError("output_header_conflict", "Input CSV already contains result columns", {
      headers: outputHeaderConflicts
    });
  }

  const rows = [];
  for (let index = 1; index < records.length; index += 1) {
    const cells = records[index];
    if (index === records.length - 1 && cells.every((cell) => cell === "")) continue;
    if (cells.length !== headers.length) {
      throw new CareFeeCsvError("column_count_mismatch", "CSV row has a different column count", {
        rowNumber: index + 1,
        expected: headers.length,
        actual: cells.length
      });
    }
    rows.push(Object.freeze({
      rowNumber: index + 1,
      values: Object.freeze(Object.fromEntries(headers.map((header, columnIndex) => [header, cells[columnIndex]])))
    }));
  }
  if (rows.length === 0) {
    throw new CareFeeCsvError("no_data_rows", "CSV file contains no data rows");
  }

  return Object.freeze({
    bytes: decoded.bytes,
    encoding: decoded.encoding,
    hadBom: decoded.hadBom,
    headers: Object.freeze(headers),
    rows: Object.freeze(rows),
    sourceFileSha256: sha256Hex(decoded.bytes)
  });
}

export function serializeCareEmergencyCsv(headers, rows, options = {}) {
  if (!Array.isArray(headers) || headers.length === 0) {
    throw new TypeError("headers must not be empty");
  }
  const records = [headers, ...(Array.isArray(rows) ? rows : []).map((row) => (
    headers.map((header) => scalarCsvValue(row?.[header]))
  ))];
  const text = records.map((record) => record.map(quoteCsvCell).join(",")).join("\r\n") + "\r\n";
  return options.bom === false ? Buffer.from(text, "utf8") : Buffer.concat([UTF8_BOM, Buffer.from(text, "utf8")]);
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  return JSON.stringify(sortRecursively(value));
}

function parseRfc4180(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (afterQuote && character !== "," && character !== "\r" && character !== "\n") {
      throw new CareFeeCsvError("invalid_quote", "Unexpected character after a closing quote", {
        offset: index
      });
    }
    if (character === '"') {
      if (field !== "") {
        throw new CareFeeCsvError("invalid_quote", "Quote must begin at the start of a field", {
          offset: index
        });
      }
      quoted = true;
      afterQuote = false;
    } else if (character === ",") {
      record.push(field);
      field = "";
      afterQuote = false;
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      afterQuote = false;
    } else {
      field += character;
    }
  }

  if (quoted) {
    throw new CareFeeCsvError("unclosed_quote", "CSV contains an unclosed quoted field");
  }
  if (field !== "" || record.length > 0 || afterQuote) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function quoteCsvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function scalarCsvValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function stripLeadingBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function duplicates(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value);
}

function sortRecursively(value) {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortRecursively(value[key])]));
}
