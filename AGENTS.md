# Repository Guidelines

Cloud Bookmark (云端书签) is a WebDAV bookmark manager built as a plain HTML/CSS/JavaScript browser extension — no build step, package manager, or test runner.

## Project Structure & Module Organization

- `background/background.js` — MV3 service worker: WebDAV sync, alarms, context menus, messaging.
- `popup/` — toolbar popup: `popup.html/.css/.js`, `popup.folderNav.js`, `popup.nav.css`.
- `options/` — settings page: `options.html/.css/.js`, `options.popupNavSettings.js`.
- `pages/bookmarks.html|css|js` — full-page bookmark management UI.
- `content/floating-ball.js` — content script for the floating ball.
- `utils/` — shared modules: `storage.js`, `webdav.js`, `bookmarkParser.js`, `lockManager.js`, `lockScreen.js`, `utils.js`.
- `assets/icons/` — 16/32/48/128 PNG icons; `scripts/generate-icons.html` regenerates them.
- `site/` — static project homepage; `0_docs/` — Chinese usage tutorials.

## Build, Test, and Development Commands

- **Chromium:** open `chrome://extensions`, enable Developer mode, click "Load unpacked", select the repository root.
- **Firefox:** open `about:debugging` → This Firefox → Load Temporary Add-on → select `manifest.firefox.json`.
- **After edits:** reload the extension and its pages.
- **Generate icons:** open `scripts/generate-icons.html` and download the four PNGs into `assets/icons/`.

Do not introduce `npm` or a bundler without prior discussion.

## Coding Style & Naming Conventions

- 2-space indentation, single quotes, semicolons, `camelCase`; pair each page's `.html` with matching `.css`/`.js` in the same directory.
- Begin files and sections with short `/** ... */` comments; Chinese is the project's comment and documentation language.
- Use `chrome.*` APIs with the existing `typeof browser !== 'undefined'` fallback for Firefox.
- No linter is configured — match surrounding code; keep logs gated behind the developer-logging setting and never commit stray `console.log` calls.

## Testing Guidelines

Testing is manual: no automated framework; `*.test.js` is gitignored.

1. Follow the checklist in [`TESTING.md`](TESTING.md): install, WebDAV connection, bookmark CRUD, sync, import/export, floating ball.
2. Verify against a real WebDAV server (Nextcloud, ownCloud, or 坚果云).
3. For shared-code changes, smoke-test both browsers, the popup, and `pages/bookmarks.html`.

## Commit & Pull Request Guidelines

- History uses short Chinese messages, e.g. `增加密码设置`, `优化悬浮球样式`, `修复WebDAV路径多余斜杠`; Conventional-Commit prefixes such as `style(bookmarks): ...` are also acceptable.
- Bump `version` in the manifests for user-facing changes.
- PRs explain what and why, link issues, include UI screenshots, and state which `TESTING.md` items were verified. Keep diffs surgical — the main JS files are very large.

## Browser Targets & Manifests

- Chromium (Manifest V3): `manifest.json` (dev), `manifest.default.json`.
- Firefox (Manifest V2): `manifest.firefox.json` (dev), `manifest.firefox_prod.json` (prod).
- Permission, background, or content-script changes require updating all relevant manifests.