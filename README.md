# tabnesia

Tabnesia maintains a fixed, ordered list of native Firefox pinned tabs.
Managed pins are restored when closed, unpinned, or moved, and by default
return to their configured URLs whenever they are activated.

- Firefox 142 or newer (the floor for `data_collection_permissions` on all
  Firefox platforms)
- No runtime dependencies
- No data collected by tabnesia

## Usage

1. Open **Add-ons and themes → Extensions → Tabnesia → Preferences**.
2. Add URLs, drag them into order, and click **Save**. Each URL's ↻ toggle
   controls auto-reload: when it is off, activating that pin leaves its
   current page alone.
3. For private windows, grant tabnesia **Run in Private Windows** permission,
   then enable the corresponding option in tabnesia's preferences.

Removing a URL from the list unpins its tab without closing it. Reordering
moves tabs without reloading them, and editing a URL loads the new address in
its existing tab.

While pins are configured, tabnesia also checks every window once a minute
and repairs any pin a failed update left wrong. Pins that are already correct are left untouched;
pages reload only when you activate a pin with auto-reload on.

Firefox sync can restore settings to other desktop profiles when add-on sync is
enabled. Export a backup before uninstalling tabnesia or reinstalling Firefox.

## Development

Install the pinned tooling once:

```sh
npm ci
```

Launch tabnesia in a temporary Firefox profile:

```sh
npm start
```

Non-extension files are excluded via `ignoreFiles` in `web-ext-config.mjs`,
which web-ext discovers automatically. CI fails if the package contains any
file besides the extension's own.

### Test with existing extensions and settings

To test alongside configured extensions such as FoxyProxy, clone the normal
profile into a dedicated test profile.

#### Find the default profile

Open `about:profiles` in Firefox and copy the root directory of the profile
marked as the default — a stale `default-release` directory on disk may not be
the one in use. Then:

```sh
PROFILES_DIR="${HOME}/Library/Application Support/Firefox/Profiles"
SOURCE_PROFILE="<root directory from about:profiles>"
```

#### Create the test profile

Quit Firefox before copying. Create the clone once:

```sh
TEST_PROFILE="${PROFILES_DIR}/tabnesia"
ditto "${SOURCE_PROFILE}" "${TEST_PROFILE}"
```

Reuse the clone on later runs:

```sh
PROFILES_DIR="${HOME}/Library/Application Support/Firefox/Profiles"
TEST_PROFILE="${PROFILES_DIR}/tabnesia"

npm start -- \
  --firefox /opt/homebrew/bin/firefox \
  --firefox-profile "${TEST_PROFILE}" \
  --keep-profile-changes
```

Use `--keep-profile-changes` only with the dedicated test clone. It changes
browser security and update preferences and is unsafe for a daily profile.

## Checks and packaging

```sh
npm test         # unit tests
npm run lint     # ESLint and web-ext lint
npm run build    # package the extension into web-ext-artifacts/
```

`npm run check` runs the tests and both linters.

### Real-Firefox tests

```sh
npm run test:firefox
```

Runs the extension end to end in Firefox (about three minutes): upgrading
from 1.0.0, configuring, reordering, removing, and editing pins,
auto-reload, background-script suspension, the periodic check, and
clearing the settings. Page loads are counted, so needless reloads fail.

It starts a separate headless Firefox with a throwaway profile, so it
never touches a Firefox you have running. It finds Firefox at the usual
macOS location or on `PATH`; set `FIREFOX` to use another binary.
`BUILD=<git revision>` tests that revision instead of the working tree, and
`UPGRADE_FROM=<git revision>` sets where the upgrade test starts.

A full browser restart is not covered: release Firefox drops unsigned
temporary add-ons when it restarts. CI does not run these tests, since they
need Firefox.

The unsigned archive is written to `web-ext-artifacts/`. Permanent installation
in standard Firefox requires Mozilla signing.
