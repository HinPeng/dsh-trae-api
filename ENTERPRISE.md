# macOS TRAE CLI enterprise backend

Verified locally on 2026-09-09 with TRAE CLI 0.120.52 and Claude Code 2.1.233.

## Configuration

Keep the enterprise account logged in through `trae-cli`. In this project's `.env`:

```dotenv
TRAE_BACKEND=enterprise-cli
TRAE_DEFAULT_MODEL=glm-5.3-flash
HOST=127.0.0.1
PORT=9220
API_KEY=<a strong local-only secret>
```

Enterprise mode reads only the `trae_cli` / `auth_info` Keychain entry, in memory on
requests. It does not use or export the IDE tokens in `.env`. The supported upstream
is fixed to `https://console.enterprise.trae.cn`; other/private deployments fail closed.
Expired/revoked credentials require refreshing the login through the official CLI.
No automatic CLI invocation, login or silent model fallback is performed.

## Run

Terminal 1:

```sh
cd /Users/hp/workspace/tools/dsh-trae-api
npm start
```

Terminal 2 (from the repository you want Claude to work in):

```sh
/Users/hp/workspace/tools/dsh-trae-api/scripts/claude-trae
```

The launcher reads the local API key without embedding it in command arguments,
sets the main/Haiku/Sonnet/Opus model choices to `glm-5.3-flash`, and does not change
shell startup files or Claude's global configuration. A private temporary `--settings` file overrides user/project/local gateway,
authentication and model settings for this invocation. Other settings remain available;
managed enterprise policy is not bypassed. The temporary file is deleted on exit.
A regression check loaded the real user settings plus a project settings file with
an intentionally invalid gateway and still successfully returned OK on glm-5.3-flash.
Do not run two proxy instances on port 9220.

## Protocol and verification

- Model discovery: POST `/api/ide/v1/cli/get_config_list`, `{"function":"chat"}`.
- Chat: POST `/api/ide/v2/llm_raw_chat` with `config_name`, `model_name`, structured
  `messages`, `user_input`, `conversation_id`, `session_id`, and streaming enabled.
- The observed public config `glm-5.3-flash` resolved to `glm-5.3-flash__dev`.
  The internal name is discovered per request, not hardcoded or guessed.
- Unknown names fail instead of switching to another model.
- SSE upstream errors, empty answers, and incomplete streams surface as errors.
- Successful checks: plain text and streaming `/v1/messages`; Claude Code plain
  response; a two-turn Claude Code Read tool call returning a file's exact contents.
- Offline regression suite: `npm test`.

## Limitations

This is an unofficial, enterprise-authorized-use-only adapter. It is not a general
API entitlement. Follow the enterprise's applicable data and usage policies.

The existing proxy still encodes tools as text `<tool_call>` instructions, not
native upstream tools. A successful Read test does not guarantee all coding tools,
images, complex schemas, long context, caching, or Codex Responses compatibility.
Usage/token counts and Claude's displayed costs are estimates, not enterprise billing.
Claude may print `unrecognized_model` for its title-generation telemetry; the actual
smoke-test calls still succeeded on `glm-5.3-flash`.

## Four-model launcher selection

Context settings remain unchanged. The default is still `glm-5.3-flash`.
Both DeepSeek choices below use their non-official configurations.

```sh
/Users/hp/workspace/tools/dsh-trae-api/scripts/claude-trae --list-models
/Users/hp/workspace/tools/dsh-trae-api/scripts/claude-trae --model GLM-5.3-Flash
/Users/hp/workspace/tools/dsh-trae-api/scripts/claude-trae --model GLM-5.3
/Users/hp/workspace/tools/dsh-trae-api/scripts/claude-trae --model DeepSeek-V4-Flash
/Users/hp/workspace/tools/dsh-trae-api/scripts/claude-trae --model DeepSeek-V4-Pro
```

Run without arguments and enter `/model` in the session to select:
- GLM-5.3-Flash
- GLM-5.3
- DeepSeek-V4-Flash
- DeepSeek-V4-Pro

Claude's built-in Default entry may also be displayed; it is not an additional
upstream model. The four choices are implemented by independent built-in alias
mappings (Haiku, Sonnet, Fable, Opus), with model names/descriptions overridden.
The allowlist contains only the four concrete IDs. The automatic 1M variant is
disabled; no context limit is increased. Fast auxiliary requests use GLM-5.3-Flash;
subagents are no longer pinned to the startup model by this launcher.

`--model` optionally chooses only the initial model. Menu mappings stay distinct
regardless of that argument. DeepSeek startup uses the non-official configurations.
Use the `s` shortcut in the picker for a session-only change; Enter follows Claude's
normal save-default behavior. The launcher itself does not edit global settings.

Verified by opening the interactive picker, selecting GLM-5.3 within the existing
session, and receiving `SWITCH_OK` with `model=glm-5.3` in the session record.

On 2026-09-09, the three added models each passed a real Claude Code `OK` smoke
test with the expected ID present in `modelUsage`. No 1M context override was set.
