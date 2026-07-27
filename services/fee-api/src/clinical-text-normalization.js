const FULLWIDTH_ASCII_PATTERN = /[Ａ-Ｚａ-ｚ０-９]/u;

/**
 * Canonicalizes clinical text while retaining the raw source range represented
 * by every canonical character. Evaluation and runtime must share this exact
 * contract because CRLF folding and outer trimming can move span offsets.
 */
export function canonicalizeClinicalText(value, { trim = true } = {}) {
  const rawText = String(value || "");
  const segments = [];
  for (let index = 0; index < rawText.length;) {
    const rawStart = index;
    let character = rawText[index];
    if (character === "\r") {
      const crlf = rawText[index + 1] === "\n";
      index += crlf ? 2 : 1;
      character = "\n";
    } else {
      index += character.length;
    }
    if (FULLWIDTH_ASCII_PATTERN.test(character)) {
      character = String.fromCharCode(character.charCodeAt(0) - 0xFEE0);
    }
    segments.push({
      character,
      rawStart,
      rawEnd: index
    });
  }

  let first = 0;
  let last = segments.length;
  if (trim) {
    while (first < last && isTrimmedWhitespace(segments[first].character)) {
      first += 1;
    }
    while (last > first && isTrimmedWhitespace(segments[last - 1].character)) {
      last -= 1;
    }
  }
  const retained = segments.slice(first, last);
  return {
    rawText,
    text: retained.map((segment) => segment.character).join(""),
    segments: retained.map((segment, canonicalIndex) => ({
      ...segment,
      canonicalStart: canonicalIndex,
      canonicalEnd: canonicalIndex + segment.character.length
    }))
  };
}

export function normalizeClinicalTextValue(value) {
  return canonicalizeClinicalText(value).text;
}

export function canonicalRangeForRawRange(
  canonicalized,
  rawStartValue,
  rawEndValue
) {
  const rawStart = Math.max(0, Number(rawStartValue || 0));
  const rawEnd = Math.max(rawStart, Number(rawEndValue ?? rawStart));
  const segments = Array.isArray(canonicalized?.segments)
    ? canonicalized.segments
    : [];
  const overlapping = segments.filter((segment) => (
    segment.rawStart < rawEnd && segment.rawEnd > rawStart
  ));
  if (!overlapping.length) {
    return null;
  }
  return {
    charStart: overlapping[0].canonicalStart,
    charEnd: overlapping[overlapping.length - 1].canonicalEnd
  };
}

function isTrimmedWhitespace(character) {
  return character.trim() === "";
}
