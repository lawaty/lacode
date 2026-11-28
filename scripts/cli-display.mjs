/**
 * Zero-dependency shared CLI presentation infrastructure used by scorer,
 * refresher, host sync, retention tools, CLIs, build, and benchmark.
 * ES2019 / Node 12 safe for deployed retention scripts. Animation is TTY-gated
 * and writes only to stderr; callers keep ownership of their stdout result
 * lines.
 */

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export const isTTY = Boolean(process.stderr && process.stderr.isTTY);

export const colorEnabled = hasOwn(process.env, "FORCE_COLOR") && process.env.FORCE_COLOR !== "0"
  ? true
  : hasOwn(process.env, "NO_COLOR")
    ? false
    : isTTY && process.env.TERM !== "dumb";

export const progressEnabled = isTTY;

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

function sgr(code) {
  return (s) => {
    const text = String(s);
    return colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  };
}

const grey = sgr(90);

export const color = {
  red: sgr(31),
  green: sgr(32),
  yellow: sgr(33),
  blue: sgr(34),
  magenta: sgr(35),
  cyan: sgr(36),
  grey,
  gray: grey,
  white: sgr(37),
  bold: sgr(1),
  dim: sgr(2),
  underline: sgr(4),
};

export const c = color;

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

export const symbols = {
  ok: "✔",
  fail: "✖",
  warn: "⚠",
  info: "ℹ",
  bullet: "•",
  arrow: "›",
  bar: "█",
  barEmpty: "░",
};

export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ---------------------------------------------------------------------------
// Formatting utilities
// ---------------------------------------------------------------------------

export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export function visibleLength(s) {
  return stripAnsi(String(s)).length;
}

function oneDecimal(value) {
  return value.toFixed(1).replace(/\.0$/, "");
}

export function humanMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "0ms";
  if (value < 1000) return `${value}ms`;
  if (value < 60000) return `${oneDecimal(value / 1000)}s`;

  const seconds = Math.floor(value / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function humanBytes(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;

  const units = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${oneDecimal(scaled)} ${units[unit]}`;
}

function normalizeWidth(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : fallback;
}

function progressRatio(value, total) {
  const target = Number(total);
  if (!Number.isFinite(target) || target <= 0) return 1;
  const current = Number(value);
  if (!Number.isFinite(current)) return 0;
  return Math.min(target, Math.max(0, current)) / target;
}

export function bar(value, total, width = 24) {
  const cells = normalizeWidth(width, 24);
  const filled = Math.min(cells, Math.max(0, Math.round(progressRatio(value, total) * cells)));
  return symbols.bar.repeat(filled) + symbols.barEmpty.repeat(cells - filled);
}

function truncateVisible(s, width) {
  const text = String(s);
  const limit = normalizeWidth(width, 0);
  if (visibleLength(text) <= limit) return text;
  if (limit === 0) return "";

  const tokens = text.match(/\x1b\[[0-9;]*[a-zA-Z]|[\s\S]/gu) || [];
  const keep = limit - 1;
  let output = "";
  let used = 0;
  let truncating = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (/^\x1b\[[0-9;]*[a-zA-Z]$/.test(token)) {
      output += token;
    } else if (!truncating && used + token.length <= keep) {
      output += token;
      used += token.length;
    } else {
      truncating = true;
    }
  }
  return `${output}…`;
}

// Padding uses visible width. Overlong values are truncated with one ellipsis
// so table cells stay within their allotted width; CSI color codes are kept.
export function padRight(s, width) {
  const text = String(s);
  const target = normalizeWidth(width, 0);
  const fitted = truncateVisible(text, target);
  return fitted + " ".repeat(Math.max(0, target - visibleLength(fitted)));
}

export function padLeft(s, width) {
  const text = String(s);
  const target = normalizeWidth(width, 0);
  const fitted = truncateVisible(text, target);
  return " ".repeat(Math.max(0, target - visibleLength(fitted))) + fitted;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export function formatTable(options) {
  const settings = options || {};
  const headers = Array.isArray(settings.headers) ? settings.headers : [];
  const rows = Array.isArray(settings.rows) ? settings.rows : [];
  let columnCount = headers.length;

  for (let i = 0; i < rows.length; i += 1) {
    if (Array.isArray(rows[i])) columnCount = Math.max(columnCount, rows[i].length);
  }
  if (columnCount === 0) return "";

  const widths = new Array(columnCount).fill(0);
  for (let i = 0; i < headers.length; i += 1) {
    widths[i] = Math.max(widths[i], visibleLength(headers[i]));
  }
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [];
    for (let i = 0; i < row.length; i += 1) {
      widths[i] = Math.max(widths[i], visibleLength(row[i]));
    }
  }

  const separatorWidth = (columnCount - 1) * 2;
  const maxWidth = settings.maxWidth === undefined || settings.maxWidth === null
    ? Infinity
    : normalizeWidth(settings.maxWidth, Infinity);
  if (maxWidth < separatorWidth) return "";

  let naturalWidth = separatorWidth;
  for (let i = 0; i < widths.length; i += 1) naturalWidth += widths[i];
  let overflow = Math.max(0, naturalWidth - maxWidth);

  // Repeatedly shrink the current widest column, keeping the reduction fair.
  while (overflow > 0) {
    let widest = 0;
    for (let i = 1; i < widths.length; i += 1) {
      if (widths[i] > widths[widest]) widest = i;
    }
    if (widths[widest] === 0) break;
    widths[widest] -= 1;
    overflow -= 1;
  }

  const align = Array.isArray(settings.align) ? settings.align : [];
  const renderRow = (row) => {
    const cells = [];
    for (let i = 0; i < columnCount; i += 1) {
      const value = i < row.length && row[i] !== undefined && row[i] !== null
        ? String(row[i])
        : "";
      cells.push(align[i] === "right" ? padLeft(value, widths[i]) : padRight(value, widths[i]));
    }
    return cells.join("  ");
  };

  const lines = [];
  if (headers.length > 0) lines.push(renderRow(headers));
  for (let i = 0; i < rows.length; i += 1) {
    lines.push(renderRow(Array.isArray(rows[i]) ? rows[i] : []));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

const PROGRESS_INTERVAL_MS = 80;

function streamWidth(stream) {
  const columns = Number(stream && stream.columns);
  return Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
}

function writeStream(stream, text) {
  if (stream && typeof stream.write === "function") stream.write(text);
}

function countText(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(numeric) : "0";
}

export class Progress {
  constructor(options) {
    const settings = options || {};
    this.total = Number(settings.total);
    if (!Number.isFinite(this.total)) this.total = 0;
    this.label = settings.label === undefined || settings.label === null ? "" : String(settings.label);
    this.stream = settings.stream || process.stderr;
    this.width = normalizeWidth(settings.width === undefined ? 24 : settings.width, 24);
    this.showPercent = settings.showPercent !== false;
    this.showEta = settings.showEta !== false;
    this.tty = Boolean(this.stream && this.stream.isTTY);
    this.value = 0;
    this.extra = "";
    this.startedAt = Date.now();
    this.lastRenderAt = null;
    this.rendered = false;
    this.finished = false;
  }

  _line() {
    const parts = [];
    if (this.label) parts.push(this.label);
    parts.push(bar(this.value, this.total, this.width));
    parts.push(`${countText(this.value)}/${countText(this.total)}`);
    if (this.showPercent) parts.push(`${Math.round(progressRatio(this.value, this.total) * 100)}%`);

    if (this.showEta && this.total > 0 && this.value > 0 && this.value < this.total) {
      const elapsed = Math.max(0, Date.now() - this.startedAt);
      if (elapsed > 0) {
        const eta = Math.ceil(((this.total - this.value) / this.value) * elapsed);
        parts.push(`ETA ${humanMs(eta)}`);
      }
    }
    if (this.extra) parts.push(this.extra);
    return parts.join("  ");
  }

  _render(now) {
    if (!this.tty || this.finished) return;
    const line = truncateVisible(this._line(), streamWidth(this.stream));
    writeStream(this.stream, `\r\x1b[2K${line}`);
    this.lastRenderAt = now;
    this.rendered = true;
  }

  _clear() {
    if (this.tty && this.rendered) writeStream(this.stream, "\r\x1b[2K");
    this.rendered = false;
  }

  _summary() {
    const parts = [];
    if (this.label) parts.push(this.label);
    parts.push(`${countText(this.total)}/${countText(this.total)}`);
    parts.push(`(${humanMs(Math.max(0, Date.now() - this.startedAt))})`);
    return parts.join("  ");
  }

  _finish(message, failed) {
    if (this.finished) return;
    this.finished = true;

    const hasMessage = message !== undefined && message !== null;
    const text = hasMessage ? String(message) : this._summary();
    const finalText = failed ? color.red(`${symbols.fail} ${text}`) : text;

    if (this.tty) {
      this._clear();
      writeStream(this.stream, `${finalText}\n`);
    } else if (hasMessage) {
      writeStream(this.stream, `${finalText}\n`);
    }

    this.extra = "";
    this.lastRenderAt = null;
    this.startedAt = null;
  }

  update(value, extra) {
    if (this.finished) return;
    const numeric = Number(value);
    this.value = Number.isFinite(numeric) ? numeric : 0;
    this.extra = extra === undefined || extra === null ? "" : String(extra);
    if (!this.tty) return;

    const now = Date.now();
    const reachedEnd = this.total <= 0 || this.value >= this.total;
    if (this.lastRenderAt === null || now - this.lastRenderAt >= PROGRESS_INTERVAL_MS || reachedEnd) {
      this._render(now);
    }
  }

  tick(extra) {
    this.update(this.value + 1, extra);
  }

  done(message) {
    this._finish(message, false);
  }

  fail(message) {
    this._finish(message, true);
  }
}

export function createProgress(options) {
  return new Progress(options);
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

function statusText(symbol, text, colorize) {
  const suffix = text === undefined || text === null || text === "" ? "" : ` ${String(text)}`;
  return colorize(`${symbol}${suffix}`);
}

export class Spinner {
  constructor(options) {
    const settings = options || {};
    this.stream = settings.stream || process.stderr;
    this.label = settings.label === undefined || settings.label === null ? "" : String(settings.label);
    const interval = Number(settings.intervalMs);
    this.intervalMs = Number.isFinite(interval) && interval > 0 ? interval : 80;
    this.tty = Boolean(this.stream && this.stream.isTTY);
    this.running = false;
    this.rendered = false;
    this.timer = null;
    this.frameIndex = 0;
  }

  _render() {
    if (!this.tty || !this.running) return;
    const frame = spinnerFrames[this.frameIndex % spinnerFrames.length];
    const line = this.label ? `${frame} ${this.label}` : frame;
    const fitted = truncateVisible(line, streamWidth(this.stream));
    writeStream(this.stream, `\r\x1b[2K${fitted}`);
    this.rendered = true;
  }

  start(text) {
    if (text !== undefined && text !== null) this.label = String(text);
    if (!this.tty) return;
    if (this.running) {
      this._render();
      return;
    }

    this.running = true;
    this.frameIndex = 0;
    this._render();
    this.timer = setInterval(() => {
      if (!this.running) return;
      this.frameIndex = (this.frameIndex + 1) % spinnerFrames.length;
      this._render();
    }, this.intervalMs);
  }

  update(text) {
    this.label = text === undefined || text === null ? "" : String(text);
    if (this.tty && this.running) this._render();
  }

  stop(finalText) {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const shouldClear = this.tty && this.rendered;
    this.running = false;
    this.rendered = false;
    if (shouldClear) writeStream(this.stream, "\r\x1b[2K");
    if (finalText !== undefined && finalText !== null) {
      writeStream(this.stream, `${String(finalText)}\n`);
    }
  }

  succeed(text) {
    this.stop(statusText(symbols.ok, text, color.green));
  }

  fail(text) {
    this.stop(statusText(symbols.fail, text, color.red));
  }
}

export function createSpinner(options) {
  return new Spinner(options);
}
