# Blender MCP: setup and upgrades

Two MCP servers drive the user's Blender. Each one is a pair: a server Claude Code starts from `.mcp.json`, and an add-on inside Blender that the server talks to over a localhost socket. A server and its add-on speak a versioned protocol, so they are pinned and moved together. `.mcp.json` holds the only pins; `mcp.sh` reads them.

| | `blender` | `blender-lab` |
|---|---|---|
| What | MCP for Blender (ahujasid, MIT, third party) | Blender Lab's official server (GPL) |
| Used for | All scene work: `execute_blender_code` (screened by the crash hook), `look`, Sketchfab / Poly Haven search and import | Reference only: `search_api_docs`, `get_python_api_docs`, `search_manual_docs` before guessing a `bpy` call; window and area screenshots |
| Server pin | `mcp-for-blender@<version>` (PyPI) | `git+…/blender_mcp.git@<40-char commit>#subdirectory=mcp` (not on PyPI) |
| Add-on in Blender | "MCP for Blender", legacy add-on `scripts/addons/blender_mcp.py` | "MCP", extension `extensions/user_default/mcp/` |
| Port | 9876 (default) | 9877 (`BLENDER_MCP_PORT` in `.mcp.json` and Port in the add-on's preferences) |
| Settings | `DISABLE_TELEMETRY=true` | `BLENDER_PATH` for its headless `*_for_cli` tools |

Never write scene code through `blender-lab`'s `execute_blender_code`: the PreToolUse hook only matches `mcp__blender__execute_blender_code`.

## The script

`.claude/skills/blender/mcp.sh` (`status` is the default):

- `status`: pins vs the latest releases, whether each installed add-on matches its pin, stray add-on copies, and which ports listen with the fix for a closed one. Run it first whenever an MCP call fails to connect.
- `install`: installs both add-ons at the pinned versions (community through `uvx mcp-for-blender@<pin> install-addon`, Lab from the pinned commit of the repo), then restart Blender.
- `upgrade`: moves both pins to the latest releases in `.mcp.json`, then installs. Restart Claude Code and Blender afterwards.

## First setup on a machine

1. `brew install uv`; Blender 5.1 or newer at `/Applications/Blender.app` (or set `BLENDER`).
2. `.claude/skills/blender/mcp.sh install`.
3. In Blender, Preferences:
   - System → Network → **Allow Online Access** on. The Lab add-on refuses to start without it, even on localhost. Time Out and Connection Limit only affect extension downloads; leave them at the defaults.
   - Add-ons: enable **MCP for Blender**. Enable **MCP**, set its Port to 9877, turn on Auto Start. Save preferences.
   - Optional: the Sketchfab API key goes in MCP for Blender's add-on preferences (it persists there).
4. Restart Blender, start Claude Code in the repo (approve both servers if asked), run `mcp.sh status`: both ports listening.

The add-on steps in 3 can also be done live through `blender` once it connects:
`addon_utils.enable('bl_ext.user_default.mcp', default_set=True, persistent=True)`, then set `port` and `use_autostart` on `bpy.context.preferences.addons['bl_ext.user_default.mcp'].preferences`, `bpy.ops.wm.save_userpref()`. Online Access is the user's call; ask them.

## Upgrading

1. `mcp.sh status` shows whether a newer release exists. Upgrade on purpose (a new feature or a fix you need), not on every release.
2. Skim the release notes and commits it prints for renamed tools or changed settings.
3. `mcp.sh upgrade`, restart Blender, restart Claude Code, `mcp.sh status`.
4. Check the tools this repo names still exist: `execute_blender_code` and `look` on `blender` (the hook matcher in `.claude/settings.json`, SKILL.md), the doc search tools on `blender-lab`. A rename means updating the hook matcher and the skills in the same change.
5. Commit `.mcp.json` alone with a subject like "Blender MCP: mcp-for-blender 2.3.0, Lab abc1234".

To roll back, revert `.mcp.json` and run `mcp.sh install`.

## Daily use

- Both add-ons auto start their servers with Blender. If one is closed, `mcp.sh status` names the fix.
- The Sketchfab switch is a scene property (`bpy.context.scene.blendermcp_use_sketchfab`), off in every new file even though the key persists. Turn it on in the viewport N panel → MCP for Blender, or with that one line through `blender`; File → Defaults → Save Startup File with it on keeps it on for new files. Licensing rules for what may be imported are in memory (third-party model licensing).
- Editing `.mcp.json` only takes effect in a new Claude Code session.

## Traps (each cost time when this was set up, 2026-10-22)

- **Package names.** `blender-mcp` on PyPI is now a wrapper that installs the latest `mcp-for-blender`, so pinning `blender-mcp@x` pins nothing. Blender Lab's server is also named `blender-mcp` but is not on PyPI; `uvx blender-mcp` never gets it.
- **Don't run `mcp-for-blender setup` or `update`.** They rewrite MCP client configs and jump to the latest release, past the pin. Use `mcp.sh`.
- **Duplicate add-ons.** A copy installed by hand (`addon.py`) next to `blender_mcp.py` shows as two "MCP for Blender" entries; `install-addon` updates both, but only one can be enabled. Keep `blender_mcp.py`, remove the other in Add-ons; `status` flags strays. `*.bak` files are `install-addon`'s backups and are inert.
- **The Lab add-on from the website.** blender.org/lab/mcp-server offers a release zip whose version can differ from the pinned server commit, and its "MCP" entry is easy to miss next to "MCP for Blender". `mcp.sh install` installs the add-on from the same commit as the server instead.
- **`bpy.ops.extensions.package_install_files` through the live MCP** reloads add-ons and drops the connection mid-call; install by copying files (what `mcp.sh` does) or through the Blender UI.
- **projects.blender.org pages** sit behind a bot check, so WebFetch and curl get nothing; `git ls-remote` and `git fetch` of the repo work.
- **Blender downloads.** A new Blender build is unrelated to MCP upgrades. Compare a download's hash with `Blender --version` (`build hash`) before installing it.
