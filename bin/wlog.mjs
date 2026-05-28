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

const VERSION = '0.3.2';

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
  auth          Authentication (login, status, logout)
  trips         Trip management (list, create, get, rename, set-dates, delete)
  sections      Itinerary sections (list, add, rename, delete, move)
  places        Place management (search, add, enrich-add, update, delete, move)
  calendar      Calendar integration (subscribe, unsubscribe, list, url, preview, refresh)
  debug         Debugging utilities (fetch, inspect)

GLOBAL OPTIONS
  --help        Show this help message
  --version     Show version
  --json        Output JSON format
  --verbose     Enable verbose logging
  --quiet       Suppress non-essential output
  --config-dir <path>  Override config directory (default: ~/.config/wanderlog)
  --token-file <path>  Override token file path

EXAMPLES
  wlog auth login     Open an isolated Chrome/Chromium browser login and save connect.sid
  wlog trips list
  wlog places enrich-add "Jeju" 21652664 --query "Handam Coastal Walk Jeju" --start 10:30 --end 12:30
  wlog calendar subscribe "Jeju"

For help on a specific command, use: wlog <command> --help
  `;
  console.log(help.trim());
}

main();
