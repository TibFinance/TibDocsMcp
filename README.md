# TIB Finance documentation server for AI coding agents

`tib-docs-mcp` is an MCP server that lets your AI coding tool (Claude Code, Cursor, VS Code and others) read the
TIB Finance API documentation while it writes your integration: the method pages, the guides, the lists of values,
the request examples for each SDK, and the error codes.

It is one file, `tib-docs-mcp.mjs`, that Node.js runs on your computer. It is **read-only**: it serves the public
documentation of [doc.tib.finance](https://doc.tib.finance) and nothing else. It does not call the TIB Finance API,
does not sign in, holds no key or password, and reads no file of your project.

## Requirements

Node.js 22 or later (tested on Node.js 22 and 24). There is no install step and nothing to download besides the file.

## Get the file

1. Download `tib-docs-mcp.mjs` and `SHA256SUMS.txt` from the [latest release](https://github.com/TibFinance/TibDocsMcp/releases/latest).
2. Check that the file is the one released. Its sha256 must be the one in `SHA256SUMS.txt`:
   - Windows (PowerShell): `Get-FileHash .\tib-docs-mcp.mjs -Algorithm SHA256`
   - macOS: `shasum -a 256 tib-docs-mcp.mjs`
   - Linux: `sha256sum tib-docs-mcp.mjs`
3. Put it in a folder of your own, for example `C:\Users\me\tools\` or `~/tools/`.
4. Check that it reaches the documentation: `node tib-docs-mcp.mjs --check` prints the documentation build it reads,
   the site, and the cache folder.

## Add it to your AI coding tool

Use the full path of the file. The examples use `C:\Users\me\tools\tib-docs-mcp.mjs`; on macOS or Linux, use a normal
path such as `/Users/me/tools/tib-docs-mcp.mjs`.

**Claude Code**, for all your projects:

```
claude mcp add --scope user tib-docs -- node "C:\Users\me\tools\tib-docs-mcp.mjs"
```

**Cursor**: in `~/.cursor/mcp.json` (all your projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "tib-docs": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\me\\tools\\tib-docs-mcp.mjs"]
    }
  }
}
```

**VS Code** (GitHub Copilot): in `.mcp.json` at the root of your workspace:

```json
{
  "mcpServers": {
    "tib-docs": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\me\\tools\\tib-docs-mcp.mjs"]
    }
  }
}
```

For all your workspaces, run the command **MCP: Add Server**, choose **Command (stdio)**, and enter
`node "C:\Users\me\tools\tib-docs-mcp.mjs"`.

## Settings

Two environment variables, both optional:

| Setting | Values | What it does |
|---|---|---|
| `TIB_DOCS_LANGUAGE` | `en` (default) or `fr` | The language of the pages when your agent does not ask for one. Your agent can always ask for the other language. |
| `TIB_DOCS_CACHE` | `off` | Keeps no copy of the pages on disk. |

With Claude Code: `claude mcp add --scope user tib-docs -e TIB_DOCS_LANGUAGE=fr -- node "C:\Users\me\tools\tib-docs-mcp.mjs"`.
In a JSON configuration: add `"env": { "TIB_DOCS_LANGUAGE": "fr" }` beside `"args"`.

## The tools

All five only read the documentation.

- `tib_docs_overview`: what the documentation holds (its build, the SDK versions, every page by section); with a kind, every page of that kind with its summary.
- `tib_docs_search`: finds pages from a few words, a task ("read one payment"), a method or field name, or an error code.
- `tib_docs_get_page`: reads one page: a method (its arguments, response and rules), a guide, or a list of values.
- `tib_docs_get_sample`: the request example of one method for one SDK language: C#, Java, Python, PHP, JavaScript or Node.js.
- `tib_docs_get_error_code`: what an `ErrorCode` means and what to do, from the error guides.

## Privacy

- It talks to one host only, `https://doc.tib.finance`, and asks only for the documentation's text pages
  (`/llms.txt` and `/llms/...`). The site sees what a browser visit shows: the address and the User-Agent
  `tib-docs-mcp/1.0.0`.
- No telemetry, no update check, no crash report.
- It writes only its cache folder, about 3 MB at most: `%LOCALAPPDATA%\TibDocsMcp` on Windows,
  `~/Library/Caches/TibDocsMcp` on macOS, `$XDG_CACHE_HOME/tib-docs-mcp` or `~/.cache/tib-docs-mcp` on Linux.
  With `TIB_DOCS_CACHE=off`, it writes nothing.
- When the site cannot be reached, it answers from its cache and says so.

## Build it yourself

With Node.js 22 or later and npm:

```
npm ci
npm run build
```

The build writes `dist/tib-docs-mcp.mjs` and `dist/THIRD-PARTY-NOTICES.txt`. It is reproducible: the sources of a
release, built with the libraries its `package-lock.json` pins, give the file of that release, byte for byte. Compare
the sha256 of your build with the release's `SHA256SUMS.txt`.

## License

MIT, see `LICENSE`. The libraries inside the file keep their own licences: their texts are at the head of
`tib-docs-mcp.mjs` and in `THIRD-PARTY-NOTICES.txt`.
