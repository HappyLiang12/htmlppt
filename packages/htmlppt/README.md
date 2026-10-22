# htmlppt

Visual editor, CLI, and MCP server for self-contained HTML presentations. A deck
is one HTML file: slides are ordinary DOM elements, styles are ordinary CSS, and
every object keeps a stable id so the editor and AI agents can address it.

This package bundles the editor assets and the `htmlppt` agent skill, so it works
without a build step or extra downloads.

## CLI

```bash
npx htmlppt new deck.html --slides 3
npx htmlppt validate deck.html
npx htmlppt open deck.html
npx htmlppt stop deck.html
```

`htmlppt open` starts a local editor on `127.0.0.1` with a random port and a
per-session token. Add `--no-browser` to only print the URL.

## MCP

Add the server to an MCP client:

```json
{
  "mcpServers": {
    "htmlppt": {
      "command": "htmlppt-mcp"
    }
  }
}
```

The server exposes deck tools (`create_deck`, `validate_deck`, `set_text`,
`open_editor`, and more) plus the `htmlppt://contract` and
`htmlppt://authoring` resources. Reference material ships in `dist/skill/`.

## Requirements

- Node.js 20 or newer.
- No telemetry and no remote calls: the editor and MCP server only touch the
  deck you open.

## License

MIT. See [LICENSE](LICENSE); report vulnerabilities as described in
[SECURITY.md](SECURITY.md).
