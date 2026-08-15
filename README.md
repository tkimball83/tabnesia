# tabnesia

Tabnesia maintains a fixed, ordered list of native Firefox pinned tabs.
Managed pins return to their configured URLs when activated and are restored
when closed, unpinned, or moved.

- Firefox 148 or newer
- No runtime dependencies
- No data collected by tabnesia

## Usage

1. Open **Add-ons and themes → Extensions → Tabnesia → Preferences**.
2. Add URLs, drag them into order, and click **Save**.
3. For private windows, grant tabnesia **Run in Private Windows** permission,
   then enable the corresponding option in tabnesia's preferences.

Removing a URL from the list unpins its tab without closing it.

Firefox sync can restore settings to other desktop profiles when add-on sync is
enabled. Export a backup before uninstalling tabnesia or reinstalling Firefox.

## Development

Launch tabnesia in a temporary Firefox profile:

```sh
npx --yes web-ext run
```

Non-extension files are excluded via `ignoreFiles` in `web-ext-config.mjs`,
which web-ext discovers automatically.

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

npx --yes web-ext run \
  --firefox /opt/homebrew/bin/firefox \
  --firefox-profile "${TEST_PROFILE}" \
  --keep-profile-changes
```

Use `--keep-profile-changes` only with the dedicated test clone. It changes
browser security and update preferences and is unsafe for a daily profile.

## Checks and packaging

```sh
node --test
npx --yes web-ext lint
npx --yes web-ext build --overwrite-dest
```

The unsigned archive is written to `web-ext-artifacts/`. Permanent installation
in standard Firefox requires Mozilla signing.
