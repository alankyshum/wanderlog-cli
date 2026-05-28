import { redact } from './errors.mjs';

/**
 * Format output for human consumption or JSON
 */
export function formatOutput(data, options = {}) {
  const { format = 'human', quiet = false, verbose = false } = options;

  if (quiet && format === 'human') {
    return '';
  }

  if (format === 'json') {
    return JSON.stringify(data, (key, value) => {
      // Redact sensitive keys in JSON
      if (typeof value === 'string') {
        return redact(value, key);
      }
      return value;
    }, 2);
  }

  // Human format
  if (typeof data === 'string') {
    return data;
  }

  if (Array.isArray(data)) {
    return formatTable(data);
  }

  if (typeof data === 'object' && data !== null) {
    return formatObject(data);
  }

  return String(data);
}

/**
 * Format errors for the CLI entrypoint.
 */
export function formatError(error, options = {}) {
  const name = error?.name || 'Error';
  const message = redact(error?.message || String(error));
  if (options.verbose && error?.stack) {
    return redact(error.stack);
  }
  return `${name}: ${message}`;
}

/**
 * Format array of objects as ASCII table
 */
function formatTable(rows) {
  if (rows.length === 0) {
    return '(empty)';
  }

  const firstRow = rows[0];
  if (typeof firstRow !== 'object') {
    return rows.join('\n');
  }

  const keys = Object.keys(firstRow);
  const columnWidths = {};

  // Calculate widths
  keys.forEach(key => {
    columnWidths[key] = Math.max(key.length, ...rows.map(r => String(r[key] ?? '').length));
  });

  // Header
  const header = keys.map(k => k.padEnd(columnWidths[k])).join('  ');
  const separator = keys.map(k => ''.padEnd(columnWidths[k], '-')).join('--');

  // Rows
  const tableRows = rows.map(row =>
    keys.map(k => String(row[k] ?? '').padEnd(columnWidths[k])).join('  ')
  );

  return [header, separator, ...tableRows].join('\n');
}

/**
 * Format object as key-value pairs
 */
function formatObject(obj, indent = 0) {
  const prefix = '  '.repeat(indent);
  const lines = [];

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      lines.push(`${prefix}${key}:`);
      lines.push(formatObject(value, indent + 1));
    } else if (Array.isArray(value)) {
      lines.push(`${prefix}${key}:`);
      value.forEach((item, i) => {
        if (typeof item === 'object') {
          lines.push(formatObject(item, indent + 1));
        } else {
          lines.push(`${prefix}  [${i}] ${item}`);
        }
      });
    } else {
      lines.push(`${prefix}${key}: ${redact(String(value), key)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Print to stdout with newline
 */
export function print(message = '') {
  console.log(message);
}

/**
 * Print error to stderr
 */
export function printError(message = '') {
  console.error(message);
}

/**
 * Print formatted output
 */
export function printFormatted(data, options) {
  const formatted = formatOutput(data, options);
  if (formatted) {
    print(formatted);
  }
}
