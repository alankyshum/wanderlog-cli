#!/usr/bin/env node

/**
 * Wanderlog CLI - Main entrypoint
 * Manages Wanderlog itineraries and calendar subscriptions
 */

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { parseArgs } from './args.mjs';
import { createCommandDispatcher } from '../src/commands.mjs';
import { formatOutput, formatError } from '../src/output.mjs';
import { CLIError } from '../src/errors.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const VERSION = '0.3.9';

async function main() {
  try {
    const { command, subcommand, args, options } = parseArgs(process.argv.slice(2));

    // Handle global flags
    if (options.version) {
      console.log(`wlog version ${VERSION}`);
      process.exit(0);
    }

    if (options.help && !command) {
      printGlobalHelp();
      process.exit(0);
    }

    if (!command) {
      printGlobalHelp();
      process.exit(2);
    }

    // Dispatch to command handler
    const dispatcher = createCommandDispatcher(options);
    const result = await dispatcher.execute(command, subcommand, args);

    // Machine-facing commands (sync) return their exact stdout and exit code. Write, then exit
    // in the callback, so a large document on a pipe is not cut off by process.exit.
    if (result.rawOutput !== undefined) {
      if (result.stderr) console.error(result.stderr);
      await new Promise(resolve => process.stdout.write(result.rawOutput, resolve));
      process.exit(result.exitCode ?? 0);
    }

    if (result.success === false) {
      if (result.exitCode) {
        process.exit(result.exitCode);
      }
      throw new CLIError(result.error || 'Unknown error', 1);
    }

    if (result.data) {
      const output = formatOutput(result.data, options);
      if (output) console.log(output);
    }

    process.exit(0);
  } catch (err) {
    const formatted = formatError(err, { verbose: process.argv.includes('--verbose') });
    console.error(formatted);

    const exitCode = err.exitCode || 1;
    process.exit(exitCode);
  }
}

function printGlobalHelp() {
  const help = `
Wanderlog CLI - Manage travel itineraries and calendar subscriptions

USAGE
  wlog <command> [subcommand] [options]

COMMANDS
  auth          Authentication (recover, login, status, logout)
  trips         Trip management (list, create, get, rename, set-dates, validate, fetch, delete to Trash)
  sections      Itinerary sections (list, add, rename, delete, move)
  places        Place management (search, resolve, add, enrich-add, check-status, update, delete, move)
  lodging       Native hotel cards and lodging entries (add, add-place)
  budget        Budget expenses (list, add, update, remove)
  calendar      Calendar integration (subscribe, unsubscribe, list, url, preview, refresh, render, publish)
  sync          Make managed sections match a desired document (plan, apply, restore)
  debug         Debugging utilities (fetch, inspect)

GLOBAL OPTIONS
  --help        Show this help message
  --version     Show version
  --json        Output JSON format
  --verbose     Enable verbose logging
  --quiet       Suppress non-essential output
  --config-dir <path>  Override config directory (default: ~/.config/wanderlog)
  --token-file <path>  Override token file path

  PLACES CHECK-STATUS
  wlog places check-status <tripKey> [--json] [--show-unknown] [--google-key <key>]
  Shows CLOSED_TEMPORARILY, CLOSED_PERMANENTLY, PLACE_ID_INVALID, and ERR_* rows.
  UNKNOWN rows (no Google businessStatus/business profile) are hidden unless --show-unknown is passed.

PLACES ENRICH-ADD
  wlog places enrich-add <tripKey> <sectionId> --query <text> [--duration <text>] [--cost <text>] [--notes <text>]
  Adds a Google-enriched place and auto-prepends note headers:
    **Plan ~<duration>.**  (only when --duration is provided)
    **What:** <Google displayName> — <human Google type>.
    **Cost:** <cost>.  (only when --cost is provided)

EXAMPLES
  wlog auth login     Open an isolated Chrome/Chromium browser login and save connect.sid
  wlog trips list
  wlog places enrich-add "Jeju" 21652664 --query "Handam Coastal Walk Jeju" --duration "1 h" --start 10:30 --end 12:30
  wlog lodging add "Jeju" --query "RIMBA by AYANA Bali" --check-in 2027-09-22 --check-out 2027-09-24 --room "Resort View Room"
  wlog places check-status "Jeju" --json --show-unknown
  wlog calendar subscribe "Jeju"

For help on a specific command, use: wlog <command> --help
  `;
  console.log(help.trim());
}

main();
