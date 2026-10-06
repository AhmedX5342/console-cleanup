# clean-console.cjs

Removes `console.log(...)` and `console.warn(...)` statements (including
ones that span multiple lines, contain nested calls, or use template
literals) from `.js`, `.ts`, `.jsx`, and `.tsx` files.

## Setup (one-time, in your project root)

```
npm install --save-dev @babel/parser @babel/traverse
```

## Usage

```
node clean-console.cjs <file-or-name> [<file-or-name> ...]
```

Run it from your project root. Each argument can be:

- A path to a file, e.g. `src/hooks/testHook.ts`
- A bare file name (no path), e.g. `HomePage` or `HomePage.tsx` — the script
  will search the whole project for a matching `.js/.ts/.jsx/.tsx` file.

Example:

```
node clean-console.cjs src/hooks/testHook.ts CapaDetailView.tsx HomePage.tsx
```

If a bare name matches more than one file in the project (e.g. two
`HomePage.tsx` files in different folders), the script exits with an error
listing every match and asks you to re-run using the full relative path for
that one instead.

## How it works

It parses each file into an AST (via `@babel/parser`, with TypeScript/JSX
support) and removes any `console.log`/`console.warn` call that's used as
its own statement — this is what makes it safe with multi-line calls,
nested function calls, and template literals, unlike a regex-based approach.

## Known limitation

Only statement-level calls are removed (e.g. `console.log('x');`). A
`console.log` used as a value (e.g. `const fn = console.log;`) or as the
implicit body of an arrow function (e.g. `onClick={() => console.log('x')}`)
is left alone, since removing those safely would require rewriting
surrounding code rather than just deleting a statement.
