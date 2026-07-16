const TOKYO_TIME_ZONE = "Asia/Tokyo";

const tokyoDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TOKYO_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

export function tokyoDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const parts = Object.fromEntries(
    tokyoDateFormatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function tokyoClaimMonth(value = new Date()) {
  return tokyoDateKey(value).slice(0, 7);
}
