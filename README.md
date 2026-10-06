# console-cleanup

Removes `console.log(...)` and `console.warn(...)` statements (including ones that span multiple lines, contain nested calls, or use template literals) from `.js`, `.ts`, `.jsx`, and `.tsx` files.

## Installation

```bash
npm install --save-dev console-cleanup
```

## Usage

```bash
npx console-cleanup <file-or-name> [<file-or-name> ...]
```

You can also run it directly from the project root:

```bash
node console-cleanup.cjs <file-or-name> [<file-or-name> ...]
```

Each argument can be:

- A path to a file, for example `src/hooks/testHook.ts`
- A bare file name without a path, such as `HomePage` or `HomePage.tsx`

Example:

```bash
npx console-cleanup src/hooks/testHook.ts CapaDetailView.tsx HomePage.tsx
```

If a bare name matches more than one file in the project, the script exits with an error listing matching files and asks you to rerun using the full relative path.

## How it works

It parses each file into an AST with `@babel/parser` and removes any `console.log` or `console.warn` call used as its own statement. This makes it safe for multi-line calls, nested function calls, and template literals, unlike a regex-only approach.

## Limitations

Only statement-level calls are removed. A `console.log` used as a value such as `const fn = console.log;` or in an arrow function body such as `onClick={() => console.log('x')}` is left alone, because removing that safely would require rewriting surrounding code rather than just deleting a statement.
