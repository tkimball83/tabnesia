# Tabnesia

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
npx --yes web-ext run \
  --ignore-files test.mjs background.test.mjs README.md
```

### Test with existing extensions and settings

To test alongside configured extensions such as FoxyProxy, clone the normal
profile into a dedicated test profile.

#### Find the default profile

On macOS, Firefox records installation default profiles in `profiles.ini`.
This command continues only when they resolve to one profile:

```sh
FIREFOX_HOME="${HOME}/Library/Application Support/Firefox"
PROFILE_PATH=$(awk \
  '/^\[Install/ { active = 1; next }
   /^\[/ { active = 0 }
   active && /^Default=/ { sub(/^Default=/, ""); print }' \
  "${FIREFOX_HOME}/profiles.ini" | sort -u)
PROFILE_COUNT=$(printf '%s\n' "${PROFILE_PATH}" | awk \
  'NF { count++ } END { print count }')

if test "${PROFILE_COUNT}" -ne 1; then
  echo "Could not identify one Firefox installation profile"
  echo "Choose the correct Default= entry from profiles.ini"
  exit 1
fi

case "${PROFILE_PATH}" in
  /*) SOURCE="${PROFILE_PATH}" ;;
  *) SOURCE="${FIREFOX_HOME}/${PROFILE_PATH}" ;;
esac

printf 'Default profile: %s\n' "${SOURCE}"
```

#### Create the test profile

Quit Firefox before copying. Create the clone once:

```sh
TEST="${FIREFOX_HOME}/Profiles/tabnesia"

if ! test -f "${SOURCE}/prefs.js"; then
  echo "Default Firefox profile not found"
  exit 1
fi

if test -e "${TEST}"; then
  echo "Test profile already exists; skip this copy step"
  exit 1
fi

ditto "${SOURCE}" "${TEST}"
```

Reuse the clone on later runs:

```sh
TEST_PROFILE="${HOME}/Library/Application Support/Firefox/Profiles"
TEST_PROFILE="${TEST_PROFILE}/tabnesia"

npx --yes web-ext run \
  --firefox /opt/homebrew/bin/firefox \
  --firefox-profile "${TEST_PROFILE}" \
  --keep-profile-changes \
  --ignore-files test.mjs background.test.mjs README.md
```

Use `--keep-profile-changes` only with the dedicated test clone. It changes
browser security and update preferences and is unsafe for a daily profile.

## Checks and packaging

```sh
node --test test.mjs background.test.mjs
npx --yes web-ext lint \
  --ignore-files test.mjs background.test.mjs README.md
npx --yes web-ext build \
  --overwrite-dest \
  --ignore-files test.mjs background.test.mjs README.md
```

The unsigned archive is written to `web-ext-artifacts/`. Permanent installation
in standard Firefox requires Mozilla signing.
