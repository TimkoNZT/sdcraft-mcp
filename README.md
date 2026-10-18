# sdcraft-mcp

An MCP server for **local image generation and editing** via [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) (`sd-server`).

A thin supervisor plus an asynchronous client: generation goes through the native async API of `sd-server` (`/sdcpp/v1`, jobs with a `job_id`), while the server itself is a managed resource — started lazily, stopped automatically when idle, and never spawned twice on the same port.

## Features

- **Asynchronous jobs.** Submitting returns a `job_id`; status/result is fetched via `get_job`. Client timeouts no longer get in the way.
- **sd-server supervisor:** lazy autostart, readiness checks, single-instance guard (pidfile + port owner), idle-kill, shutdown on exit.
- **Model profiles** with `supports` flags (img2img / inpaint / edit / controlnet) — the config is the source of truth.
- **Clear refusals:** an unsupported operation returns a message listing the profiles that can do it.
- **Hard wait cap** (`wait_seconds` <= ~30s): a call never blocks longer than the MCP client timeout and instead honestly returns a `job_id`.

## Requirements

- Node.js 18+ (uses the global `fetch`).
- An `sd-server` build from stable-diffusion.cpp (Windows/Linux/macOS).
- Model files: a diffusion GGUF (plus a separate VAE and text encoder if the profile needs them).

## Build

```bash
npm install
npm run build
```

The entry point is `build/index.js`.

## Configuration

The main file is `sdcraft.config.json` (the path can be overridden with the `SDCRAFT_CONFIG` environment variable).
Paths inside are **machine-specific** — adjust them for your setup.

```jsonc
{
  "binPath":  "/path/to/sd-server",       // sd-server executable
  "workDir":  "/path/to/sdcpp/bin",
  "modelsDir":"/path/to/models",          // where the GGUF files live
  "assetsDir":"/path/to/assets",          // VAE etc.
  "outputDir":"/path/to/output",          // where PNGs are saved
  "logDir":   "/path/to/logs",
  "host": "127.0.0.1",
  "port": 8080,
  "idleMode": "stop",
  "idleTimeoutSec": 600,
  "commonArgs": ["--vae-tiling"],
  "active": "z-image-turbo",
  "profiles": {
    "z-image-turbo": {
      "args": {
        "--diffusion-model": "diffusion-model-GGUF/diffusion-model-Q4_K.gguf",
        "--vae": "vae.safetensors",
        "--llm": "text-encoder-GGUF/text-encoder-Q4_K_M.gguf"
      },
      "defaults": { "steps": 9, "cfg_scale": 1, "sampler": "euler", "width": 1024, "height": 1024 },
      "supports": { "img2img": true, "inpaint": true, "edit": false, "controlnet": false }
    }
  }
}
```

Path resolution: an absolute path is used as-is, otherwise the value is looked up in `modelsDir`, then in `assetsDir`.

## OpenCode Integration

```jsonc
{
  "mcp": {
    "sdcraft": {
      "type": "local",
      "command": ["node", "path/to/sdcraft-mcp/build/index.js"],
      "environment": { "SDCRAFT_CONFIG": "path/to/sdcraft-mcp/sdcraft.config.json" }
    }
  }
}
```

## Tools (13)

| Tool | Purpose |
|---|---|
| `server_status` | whether the server runs, profile/model, port, uptime |
| `start_server(profile?)` / `stop_server()` / `restart_server(profile?)` | lifecycle control |
| `set_profile(name)` | switch the active profile (restarts the server) |
| `list_profiles` | profiles: model, defaults, `supports` |
| `capabilities` | live server capabilities: samplers/schedulers/limits/features |
| `generate_image(prompt, negative_prompt?, steps?, cfg_scale?, width?, height?, sampler?, seed?, profile?, wait_seconds?)` | txt2img |
| `edit_image(init_image?\|ref_images?, prompt, mask?, strength?, ...)` | img2img / inpaint / edit |
| `upscale_image(image, upscaler?, repeats?)` | upscale (needs an ESRGAN model on the server) |
| `get_job(job_id, wait_seconds?)` | status/progress/result (saves the PNG) |
| `cancel_job(job_id)` / `list_jobs()` | cancel / list jobs for the session |

### Behavior

- `generate_image`/`edit_image` wait up to `wait_seconds` (default 20, capped at ~30): if done, they return the PNG path; otherwise a `job_id` for `get_job`.
- Only `generate_image`, `edit_image`, and `capabilities` start the server lazily. Service tools (`server_status`, `get_job`, `cancel_job`, `list_jobs`) do **not** wake it.
- On engine failure or an unreachable server, tools report it explicitly (pointing to `server_status`/`restart_server`) instead of returning a bare `error`.
- The default size comes from the profile defaults; for img2img **pass `width`/`height` explicitly** if you want to keep the source size.

## Files

- `src/config.ts` — config loading and sd-server argument building.
- `src/client.ts` — HTTP client for sd-server (`/sdcpp/v1`, `/sdapi/v1`).
- `src/supervisor.ts` — process lifecycle.
- `src/store.ts` — jobs and image saving.
- `src/index.ts` — MCP server and tools.

## License

MIT
