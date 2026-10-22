# htmlppt deck contract (htmldeck/v1)

A deck is one self-contained HTML document. The editor, validator, and MCP tools
all read and write the same contract.

## Document

- Start with `<!doctype html>` and include a non-empty `<title>`.
- Keep CSS in a `<style>` block or in inline `style` attributes. External
  stylesheets are not required and relative asset URLs are not supported.
- The deck must contain at least one slide.

## Slides

- A slide is an element with `data-slide-id`. When no element carries that
  attribute, the detector also recognizes `.slide`, `.page`, `.slide-page`, and
  groups of `<section>` elements, but explicit ids are required for stable MCP
  and editor addressing.
- Slide ids must be unique and non-empty.
- `data-width` and `data-height` are positive pixel numbers. Omit them to use the
  default 1600x900 canvas; an explicitly invalid value is a validation error.
- `data-ppt-transition` is optional and must be `none`, `fade`, or `slide`.
- With no recognizable slide elements, the body is treated as a single slide
  with the id `body`.

## Objects and elements

- Every top-level object in a slide should carry `data-ppt-el="<id>"`. Ids are
  unique within their slide and stable across edits.
- Nested elements may also carry `data-ppt-el`; ids must still be unique within
  the slide.
- A `data-ppt-group` wrapper groups objects. Nested group wrappers are not
  supported.
- Speaker notes are a direct child of the slide:
  `<aside data-ppt-notes hidden>...</aside>`.

## Runtime

- Multi-slide decks include exactly one runtime marker:
  `<script data-ppt-runtime="1">...</script>`.
- A missing runtime produces a warning, not an error. Multiple markers or a
  marker on another element type are errors.

## Assets, charts, and styles

- Use `data:` or absolute URLs for images and other assets.
- Chart data lives in `data-ppt-chart` and must be valid JSON.
- `position: fixed` and viewport-height layouts produce validation warnings
  because they may not export reliably.

## Editor artifacts

Files written to disk must not contain editor-only attributes:
`data-ppt-editing` and `data-ppt-frame-slide`. MCP serialization and
normalization remove them.

## MCP behavior

- Reads resolve `path` relative to the server working directory and report the
  resolved absolute path.
- Every mutation validates the whole document before writing. Invalid results
  are rejected and the file stays unchanged.
- Writes are atomic and compare against the revision that was last read or
  written. A changed file produces a structured `conflict` error; re-read the
  deck with `get_outline` or `read_slide` and retry.
