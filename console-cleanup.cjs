#!/usr/bin/env node
'use strict';

/**
 * console-cleanup.js
 *
 * Removes `console.log(...)` and `console.warn(...)` statements (including
 * ones that span multiple lines) from one or more source files.
 *
 * Usage:
 *   node console-cleanup.cjs <file-or-name> [<file-or-name> ...]
 *
 * Each argument can be either:
 *   - A relative/absolute path to a file (e.g. src/hooks/testHook.ts)
 *   - A bare file name without a path (e.g. HomePage or HomePage.tsx)
 *
 * For bare names, the script searches the current project (recursively,
 * skipping node_modules/.git/dist/build/etc.) for a matching .js/.ts/.jsx/.tsx
 * file. If more than one file matches the given name, the script errors out
 * and asks for a full path instead.
 *
 * Note: this only removes console.log/console.warn when they are used as a
 * standalone statement (e.g. `console.log('x');`), which covers the
 * overwhelming majority of real-world logging calls. It intentionally does
 * NOT remove `console.log` when it's used as a value (e.g.
 * `const fn = console.log;`).
 */

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverseModule = require('@babel/traverse');
const traverse = traverseModule.default || traverseModule;

const VALID_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx'];
const CONSOLE_METHODS = ['log', 'warn'];
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out',
  'coverage', '.next', '.turbo', '.cache', '.vscode', '.idea',
]);

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function walk(dir, results) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return; // unreadable dir, skip
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(path.join(dir, entry.name), results);
    } else if (entry.isFile()) {
      if (VALID_EXTENSIONS.includes(path.extname(entry.name))) {
        results.push(path.join(dir, entry.name));
      }
    }
  }
}

function findAllSourceFiles(root) {
  const results = [];
  walk(root, results);
  return results;
}

// ---------------------------------------------------------------------------
// Argument -> file resolution
// ---------------------------------------------------------------------------

function resolveArgToFile(arg, allFiles) {
  // 1) Does this resolve directly to an existing file (explicit path)?
  const directCandidate = path.resolve(process.cwd(), arg);
  if (fs.existsSync(directCandidate) && fs.statSync(directCandidate).isFile()) {
    const ext = path.extname(directCandidate);
    if (!VALID_EXTENSIONS.includes(ext)) {
      return {
        error: `"${arg}" does not have a supported extension (${VALID_EXTENSIONS.join(', ')}).`,
      };
    }
    return { file: directCandidate };
  }

  const looksLikePath = arg.includes('/') || arg.includes(path.sep);
  if (looksLikePath) {
    return { error: `File not found: "${arg}"` };
  }

  // 2) Treat as a bare name, with or without extension, and search for it.
  const parsedArg = path.parse(arg);
  const hasKnownExt = VALID_EXTENSIONS.includes(parsedArg.ext);
  const baseName = hasKnownExt ? parsedArg.name : arg;

  const matches = allFiles.filter((f) => {
    const fParsed = path.parse(f);
    if (hasKnownExt) {
      return fParsed.name === baseName && fParsed.ext === parsedArg.ext;
    }
    return fParsed.name === baseName;
  });

  if (matches.length === 0) {
    return { error: `No file found matching "${arg}".` };
  }

  if (matches.length > 1) {
    const list = matches
      .map((m) => `    ${path.relative(process.cwd(), m)}`)
      .join('\n');
    return {
      error:
        `Multiple files found matching "${arg}":\n${list}\n` +
        `  Please re-run with the full relative path for this file instead of just its name.`,
    };
  }

  return { file: matches[0] };
}

// ---------------------------------------------------------------------------
// console.log / console.warn removal (AST-based, so multi-line calls,
// nested parens, template literals, etc. are all handled correctly)
// ---------------------------------------------------------------------------

function isConsoleCall(node) {
  return (
    node &&
    node.type === 'CallExpression' &&
    node.callee &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.object &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'console' &&
    node.callee.property &&
    node.callee.property.type === 'Identifier' &&
    CONSOLE_METHODS.includes(node.callee.property.name)
  );
}

// Extend a [start, end) range so that if the statement occupies its own
// line(s) entirely, the surrounding indentation and newline are removed too
// (so we don't leave behind a blank line). If it shares a line with other
// code, only the exact statement text is removed.
function computeRemovalRange(source, start, end) {
  let s = start;
  while (s > 0 && (source[s - 1] === ' ' || source[s - 1] === '\t')) s--;
  const atLineStart = s === 0 || source[s - 1] === '\n';

  let e = end;
  while (e < source.length && (source[e] === ' ' || source[e] === '\t')) e++;
  const atLineEnd = e === source.length || source[e] === '\n' || source[e] === '\r';

  if (atLineStart && atLineEnd) {
    if (source[e] === '\r') e++;
    if (source[e] === '\n') e++;
    return [s, e];
  }
  return [start, end];
}

function stripConsoleStatements(source, filePath) {
  const ext = path.extname(filePath);
  const plugins = [
    'jsx',
    'classProperties',
    'objectRestSpread',
    'optionalChaining',
    'nullishCoalescingOperator',
    'decorators-legacy',
  ];
  if (ext === '.ts' || ext === '.tsx') plugins.push('typescript');

  const ast = parser.parse(source, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins,
  });

  const removals = [];

  traverse(ast, {
    ExpressionStatement(p) {
      if (!isConsoleCall(p.node.expression)) return;

      // If this statement is the sole, brace-less body of an if/else/loop
      // (e.g. `if (!id) console.log('x');`), we can't just delete it -
      // the *next* statement would get swallowed into that body. Replace
      // it with an empty statement instead of removing the line entirely.
      const parent = p.parentPath.node;
      const key = p.key;
      const requiresStatement =
        (parent.type === 'IfStatement' && (key === 'consequent' || key === 'alternate')) ||
        (['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement'].includes(parent.type) &&
          key === 'body') ||
        (parent.type === 'LabeledStatement' && key === 'body');

      removals.push({ start: p.node.start, end: p.node.end, requiresStatement });
    },
  });

  if (removals.length === 0) {
    return { changed: false, source, count: 0 };
  }

  const sorted = removals.slice().sort((a, b) => b.start - a.start); // end of file first

  let result = source;
  for (const r of sorted) {
    if (r.requiresStatement) {
      // Keep it inline and syntactically valid: `if (x) ;`
      result = result.slice(0, r.start) + ';' + result.slice(r.end);
    } else {
      const [s, e] = computeRemovalRange(result, r.start, r.end);
      result = result.slice(0, s) + result.slice(e);
    }
  }

  return { changed: true, source: result, count: removals.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node console-cleanup.cjs <file-or-name> [<file-or-name> ...]');
    process.exit(1);
  }

  const allFiles = findAllSourceFiles(process.cwd());

  const resolved = [];
  const errors = [];

  for (const arg of args) {
    const result = resolveArgToFile(arg, allFiles);
    if (result.error) errors.push(result.error);
    else resolved.push(result.file);
  }

  if (errors.length > 0) {
    console.error('Could not resolve all inputs:\n');
    errors.forEach((e) => console.error('  ' + e + '\n'));
    process.exit(1);
  }

  let totalRemoved = 0;

  for (const file of resolved) {
    const relPath = path.relative(process.cwd(), file);
    const original = fs.readFileSync(file, 'utf8');

    let outcome;
    try {
      outcome = stripConsoleStatements(original, file);
    } catch (err) {
      console.error(`  Skipped ${relPath}: failed to parse (${err.message})`);
      continue;
    }

    if (outcome.changed) {
      fs.writeFileSync(file, outcome.source, 'utf8');
      totalRemoved += outcome.count;
      console.log(
        `Cleaned ${relPath} (removed ${outcome.count} console statement${outcome.count === 1 ? '' : 's'})`
      );
    } else {
      console.log(`No console.log/warn found in ${relPath}`);
    }
  }

  console.log(
    `\nDone. Removed ${totalRemoved} statement${totalRemoved === 1 ? '' : 's'} across ${resolved.length} file${resolved.length === 1 ? '' : 's'}.`
  );
}

main();
