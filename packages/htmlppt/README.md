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
npx htmlppt export deck.html --format html
npx htmlppt export deck.html --format pdf
npx htmlppt export deck.html --format png --out dist/png
```

`htmlppt open` starts a local editor on `127.0.0.1` with a capability token
recorded for that deck. Later `open` calls for the same deck reuse the recorded
port and token, so the printed tokenized URL keeps working across a host
restart; `htmlppt stop` rotates the token, and replacing a stale-build host
rotates it too because `open` stops the broken host first, so a URL bookmarked
before the replacement needs the newly printed one. The first tokenized visit
exchanges the token for an HttpOnly, `SameSite=Strict` session cookie with a
30-day `Max-Age`, so the browser stays signed in to that deck. Add
`--no-browser` to only print the URL. The editor's
Export menu writes HTML, PDF, or PNG next to the deck; unsaved edits are also
mirrored to IndexedDB so a crash can offer recovery. Without a host, the editor
falls back to upload/download mode. PDF and PNG export use a locally installed
Chrome, Edge, or Chromium; set `HTMLPPT_CHROMIUM` to choose one explicitly. The
CLI refuses to overwrite the source deck.

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
