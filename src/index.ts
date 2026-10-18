#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import fs from 'fs';
import path from 'path';
import { loadConfig, saveConfig, getSupports, profilesSupporting, Config, Supports } from './config.js';
import { SdClient, readImageAsBase64 } from './client.js';
import { Supervisor } from './supervisor.js';
import { allJobs, getTracked, track, waitForJob, saveImages, extFor } from './store.js';

let cfg: Config;
try {
  cfg = loadConfig();
} catch (err: any) {
  process.stderr.write(`sdcraft: ${err?.message || err}\n`);
  process.exit(1);
}

const supervisor = new Supervisor(cfg);
const client = new SdClient({ baseUrl: supervisor.baseUrl(), timeoutMs: 30000 });

const MAX_WAIT_SEC = Math.max(5, Number(process.env.SDCRAFT_MAX_WAIT_SEC || 30));
function clampWait(v: any, def: number): number {
  const n = typeof v === 'number' && isFinite(v) ? v : def;
  return Math.max(0, Math.min(n, MAX_WAIT_SEC));
}

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}
function err(s: string) {
  return { content: [{ type: 'text' as const, text: s }], isError: true };
}
function json(v: any) {
  return text(JSON.stringify(v, null, 2));
}

async function ensureProfile(profileName?: string): Promise<string> {
  const wanted = profileName || cfg.active;
  if (!cfg.profiles[wanted]) {
    throw new Error(`unknown profile '${wanted}'. Known: ${Object.keys(cfg.profiles).join(', ')}`);
  }
  const st = await supervisor.status();
  if (st.running) {
    if (st.profile && st.profile !== wanted) {
      supervisor.stop();
      await supervisor.ensureRunning(wanted);
    } else if (!st.profile && st.managed) {
      supervisor.stop();
      await supervisor.ensureRunning(wanted);
    } else {
      supervisor.touch();
    }
  } else {
    await supervisor.ensureRunning(wanted);
  }
  if (cfg.active !== wanted) {
    cfg.active = wanted;
    try {
      saveConfig(cfg);
    } catch {
      /* config file may be read-only; runtime active still switched */
    }
  }
  return wanted;
}

function supportsCheck(profile: string, op: keyof Supports): string | null {
  const s = getSupports(cfg, profile);
  if (s[op]) return null;
  const alt = profilesSupporting(cfg, op);
  const altText = alt.length ? alt.map((n) => `\`${n}\``).join(', ') : '(no profiles support this)';
  return `Profile \`${profile}\` does not support \`${op}\`. Supported by: ${altText}.`;
}

interface GenArgs {
  prompt: string;
  negative_prompt?: string;
  steps?: number;
  cfg_scale?: number;
  width?: number;
  height?: number;
  sampler?: string;
  scheduler?: string;
  seed?: number;
  profile?: string;
  wait_seconds?: number;
  batch_count?: number;
}

function buildGenBody(profile: string, a: GenArgs, extra: Record<string, any> = {}): Record<string, any> {
  const d = cfg.profiles[profile]?.defaults || {};
  const steps = a.steps ?? d.steps ?? 20;
  const cfgScale = a.cfg_scale ?? d.cfg_scale ?? 7.0;
  const sampler = a.sampler ?? d.sampler;
  const scheduler = a.scheduler ?? d.scheduler;
  const width = a.width ?? d.width ?? 512;
  const height = a.height ?? d.height ?? 512;
  const seed = a.seed ?? -1;
  const negative = a.negative_prompt ?? d.negative_prompt ?? '';

  const sample: Record<string, any> = { sample_steps: steps };
  if (sampler) sample.sample_method = sampler;
  if (scheduler) sample.scheduler = scheduler;
  sample.guidance = { txt_cfg: cfgScale };

  const body: Record<string, any> = {
    prompt: a.prompt,
    negative_prompt: negative,
    width,
    height,
    seed,
    batch_count: a.batch_count ?? 1,
    output_format: 'png',
    sample_params: sample,
    ...extra,
  };
  return body;
}

function describeTiming(started: number): string {
  return `${Math.round((Date.now() - started) / 1000)}s`;
}

const TOOLS = [
  {
    name: 'server_status',
    description: 'sd-server state: running, managed, profile/model, port, uptime, queue.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'start_server',
    description: 'Start sd-server (optionally with the given profile). Lazy autostart also happens on demand.',
    inputSchema: {
      type: 'object',
      properties: { profile: { type: 'string', description: 'Profile name (default: active)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'stop_server',
    description: 'Stop sd-server (frees VRAM/RAM). Stops only the instance started by this MCP.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'restart_server',
    description: 'Force-restart sd-server (stop+start). Optionally on another profile.',
    inputSchema: {
      type: 'object',
      properties: { profile: { type: 'string', description: 'Profile to start (default: current active)' } },
      additionalProperties: false,
    },
  },
  {
    name: 'set_profile',
    description: 'Set the active profile (model) — restarts the server if it is running.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_profiles',
    description: 'List profiles: model, defaults, supported operations.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'capabilities',
    description: 'Live server capabilities: model, samplers/schedulers, defaults, limits, upscale availability.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'generate_image',
    description:
      'Asynchronous prompt generation. Waits up to wait_seconds (default 20, capped at ~30s); if done returns the PNG path, otherwise a job_id for get_job.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        negative_prompt: { type: 'string' },
        steps: { type: 'number' },
        cfg_scale: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        sampler: { type: 'string' },
        scheduler: { type: 'string' },
        seed: { type: 'number' },
        batch_count: { type: 'number' },
        profile: { type: 'string' },
        wait_seconds: { type: 'number', minimum: 0, maximum: 30, description: 'Seconds to wait for the result (0..30, default 20)' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_image',
    description:
      'Edit/transform an image: init_image (img2img/inpaint) or ref_images (edit). Asynchronous, like generate_image (waits <= ~30s, otherwise job_id).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        negative_prompt: { type: 'string' },
        init_image: { type: 'string', description: 'Path to the image (or base64/dataURL)' },
        ref_images: { type: 'array', items: { type: 'string' }, description: 'Reference images (edit)' },
        mask: { type: 'string', description: 'Path to the mask (inpaint)' },
        strength: { type: 'number' },
        steps: { type: 'number' },
        cfg_scale: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        sampler: { type: 'string' },
        seed: { type: 'number' },
        profile: { type: 'string' },
        wait_seconds: { type: 'number', minimum: 0, maximum: 30, description: 'Seconds to wait (0..30, default 20)' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'upscale_image',
    description: 'Upscale an image via RGB ESRGAN (requires an upscale model configured on the server).',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Path to the image (or base64/dataURL)' },
        upscaler: { type: 'string' },
        repeats: { type: 'number' },
      },
      required: ['image'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_job',
    description: 'Job status/progress/result (waits <= ~30s). Saves the PNG on completion. Does NOT start the server.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' }, wait_seconds: { type: 'number', minimum: 0, maximum: 30, description: 'Seconds to wait (0..30, default 0)' } },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_job',
    description: 'Cancel a job (queued or running). Does NOT start the server.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_jobs',
    description: 'Jobs known to this MCP in this session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const server = new Server(
  { name: 'sdcraft', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs || {}) as any;
  try {
    switch (name) {
      case 'server_status': {
        const st = await supervisor.status();
        let queue: any = null;
        if (st.running) {
          try {
            const p = await client.progress();
            queue = p?.state ? { job_count: p.state.job_count, job_no: p.state.job_no, sampling_step: p.state.sampling_step, sampling_steps: p.state.sampling_steps } : null;
          } catch {
            /* ignore */
          }
        }
        return json({ ...st, queue, active_profile: cfg.active });
      }

      case 'start_server': {
        const profile = await ensureProfile(args.profile);
        const st = await supervisor.status();
        return text(`Server started. Profile: ${profile}. Model: ${st.model ?? 'n/a'}. Port: ${st.port}.`);
      }

      case 'stop_server': {
        const st = await supervisor.status();
        if (!st.running) return text('Server is not running anyway.');
        const wasManaged = supervisor.isManaged();
        supervisor.stop();
        return text(`Server stopped${wasManaged ? '' : ' (the instance was started externally but occupied our port)'}.`);
      }

      case 'restart_server': {
        const name = args.profile || cfg.active;
        if (!cfg.profiles[name]) return err(`No profile '${name}'. Known: ${Object.keys(cfg.profiles).join(', ')}`);
        supervisor.stop();
        await supervisor.ensureRunning(name);
        if (cfg.active !== name) {
          cfg.active = name;
          try {
            saveConfig(cfg);
          } catch {
            /* ignore */
          }
        }
        const st = await supervisor.status();
        return text(`Server restarted. Profile: ${name}. Model: ${st.model ?? 'n/a'}. PID: ${st.pid ?? 'n/a'}.`);
      }

      case 'set_profile': {
        const name = String(args.name || '');
        if (!cfg.profiles[name]) return err(`No profile '${name}'. Known: ${Object.keys(cfg.profiles).join(', ')}`);
        cfg.active = name;
        try {
          saveConfig(cfg);
        } catch {
          /* ignore */
        }
        const st = await supervisor.status();
        if (st.running) {
          supervisor.stop();
          await supervisor.ensureRunning(name);
        }
        return text(`Active profile: ${name}.`);
      }

      case 'list_profiles': {
        const out = Object.entries(cfg.profiles).map(([pname, p]) => ({
          name: pname,
          active: pname === cfg.active,
          model: p.args['--diffusion-model'] || p.args['-m'] || p.args['--model'] || null,
          defaults: p.defaults || {},
          supports: getSupports(cfg, pname),
        }));
        return json(out);
      }

      case 'capabilities': {
        await supervisor.ensureRunning();
        const cap = await client.capabilities();
        return json({
          model: cap.model,
          current_mode: cap.current_mode,
          supported_modes: cap.supported_modes,
          samplers: cap.samplers,
          schedulers: cap.schedulers,
          defaults: cap.defaults_by_mode?.img_gen || cap.defaults,
          limits: cap.limits,
          upscale_available: cap.upscale,
          upscalers: (cap.upscalers || []).map((u: any) => u.name),
          features: cap.features_by_mode?.img_gen || cap.features,
        });
      }

      case 'generate_image': {
        if (!args.prompt) return err('prompt is required');
        const profile = await ensureProfile(args.profile);
        const waitSeconds = clampWait(args.wait_seconds, 20);
        const body = buildGenBody(profile, args);
        const started = Date.now();
        const sub = await client.submitImgGen(body);
        track({ id: sub.id, kind: sub.kind || 'img_gen', profile, prompt: args.prompt, createdAt: Date.now(), lastStatus: sub.status || 'queued', files: [] });
        const res = await waitForJob(client, cfg, sub.id, profile, waitSeconds);
        if (res.status === 'completed') {
          return text(
            `Done in ${describeTiming(started)}.\nProfile: ${profile}\nFiles:\n${res.files.map((f) => `- ${f}`).join('\n')}\njob_id: ${sub.id}`,
          );
        }
        if (res.status === 'error') {
          const stErr = await supervisor.status();
          return err(
            `Could not get status for job ${sub.id}: ${stErr.running ? 'server is running but not responding' : 'server is not running/crashed (engine failure?)'}.\nCheck: server_status (and restart_server if needed).`,
          );
        }
        if (res.status === 'failed' || res.status === 'cancelled') {
          return err(
            `Job ${sub.id}: status ${res.status}. ${res.job?.error ? JSON.stringify(res.job.error) : ''}\nCheck server state: server_status.`,
          );
        }
        const qp = res.job?.queue_position ?? '?';
        if (waitSeconds === 0) {
          return text(
            `Job submitted (no wait).\njob_id: ${sub.id}\nstatus: ${res.status}, queue_position=${qp}\nFetch: get_job("${sub.id}").`,
          );
        }
        return text(
          `Not finished within ${waitSeconds}s.\njob_id: ${sub.id}\nstatus: ${res.status}, queue_position=${qp}\nCheck: get_job("${sub.id}").`,
        );
      }

      case 'edit_image': {
        if (!args.prompt) return err('prompt is required');
        if (!args.init_image && (!args.ref_images || args.ref_images.length === 0)) {
          return err('init_image (img2img/inpaint) or ref_images (edit) is required.');
        }
        const profile = await ensureProfile(args.profile);
        const op: keyof Supports = args.ref_images && args.ref_images.length ? 'edit' : args.mask ? 'inpaint' : 'img2img';
        const sup = supportsCheck(profile, op);
        if (sup) return err(sup);
        const extra: Record<string, any> = {};
        if (args.init_image) extra.init_image = toImageField(args.init_image);
        if (args.ref_images) extra.ref_images = args.ref_images.map((r: string) => toImageField(r));
        if (args.mask) extra.mask_image = toImageField(args.mask);
        extra.strength = args.strength ?? 0.75;
        const body = buildGenBody(profile, args, extra);
        const started = Date.now();
        const sub = await client.submitImgGen(body);
        track({ id: sub.id, kind: sub.kind || 'img_gen', profile, prompt: args.prompt, createdAt: Date.now(), lastStatus: sub.status || 'queued', files: [] });
        const waitSeconds = clampWait(args.wait_seconds, 20);
        const res = await waitForJob(client, cfg, sub.id, profile, waitSeconds);
        if (res.status === 'completed') {
          return text(`Done in ${describeTiming(started)}.\nProfile: ${profile} (${op})\nFiles:\n${res.files.map((f) => `- ${f}`).join('\n')}\njob_id: ${sub.id}`);
        }
        if (res.status === 'error') {
          const stErr = await supervisor.status();
          return err(
            `Could not get status for job ${sub.id}: ${stErr.running ? 'server is running but not responding' : 'server is not running/crashed (engine failure?)'}.\nCheck: server_status (and restart_server if needed).`,
          );
        }
        if (res.status === 'failed' || res.status === 'cancelled') {
          return err(
            `Job ${sub.id}: status ${res.status}. ${res.job?.error ? JSON.stringify(res.job.error) : ''}\nCheck server state: server_status.`,
          );
        }
        const qp = res.job?.queue_position ?? '?';
        if (waitSeconds === 0) {
          return text(
            `Job submitted (no wait).\njob_id: ${sub.id}\nstatus: ${res.status}, queue_position=${qp}\nFetch: get_job("${sub.id}").`,
          );
        }
        return text(
          `Not finished within ${waitSeconds}s.\njob_id: ${sub.id}\nstatus: ${res.status}, queue_position=${qp}\nCheck: get_job("${sub.id}").`,
        );
      }

      case 'upscale_image': {
        if (!args.image) return err('image is required');
        await supervisor.ensureRunning();
        const cap = await client.capabilities();
        if (!cap.upscale) {
          return err('Server has no RGB-ESRGAN upscaler (capabilities.upscale=false). Add --upscale-model and restart.');
        }
        const body: Record<string, any> = { image: toImageField(args.image), output_format: 'png' };
        if (args.upscaler) body.upscaler = args.upscaler;
        if (args.repeats) body.repeats = args.repeats;
        const res = await client.upscale(body);
        const b64 = res?.images?.[0]?.b64_json;
        if (!b64) return err('Upscale returned no image.');
        const files = saveRaw(cfg.outputDir, 'upscale', res?.output_format || 'png', b64);
        return text(`Upscale done (${res.width}x${res.height}, upscaler=${res.upscaler}, repeats=${res.repeats}).\nFile: ${files}`);
      }

      case 'get_job': {
        const id = String(args.job_id || '');
        if (!id) return err('job_id is required');
        const st0 = await supervisor.status();
        if (!st0.running) {
          return text(
            `Server is not running — status of job ${id} is unavailable (jobs do not survive server stop/restart).\nStart it: start_server.`,
          );
        }
        const srv = `Server: ${st0.model ?? 'n/a'} (profile ${st0.profile ?? cfg.active}, PID ${st0.pid ?? '?'}).`;
        const tracked = getTracked(id);
        const profile = tracked?.profile || cfg.active;
        const res = await waitForJob(client, cfg, id, profile, clampWait(args.wait_seconds, 0));
        if (res.status === 'completed') {
          return text(`Job ${id}: completed.\nFiles:\n${res.files.map((f) => `- ${f}`).join('\n')}\n${srv}`);
        }
        if (res.status === 'failed' || res.status === 'cancelled') {
          return err(
            `Job ${id}: ${res.status}. ${res.job?.error ? JSON.stringify(res.job.error) : ''}\n${srv}\nCheck server state: server_status.`,
          );
        }
        if (res.status === 'error') {
          const st2 = await supervisor.status();
          return err(
            `Could not get status for job ${id}: ${st2.running ? 'server is running but not responding' : 'server is not running/crashed (engine failure?)'}.\nCheck server state: server_status (and restart_server if needed).`,
          );
        }
        const j = res.job || {};
        const pr = j.preview ? ` pass=${j.preview.pass} step=${j.preview.step}/${j.preview.total_steps}` : '';
        return text(`Job ${id}: ${res.status}.${pr} queue_position=${j.queue_position ?? '?'}\n${srv}`);
      }

      case 'cancel_job': {
        const id = String(args.job_id || '');
        if (!id) return err('job_id is required');
        const st0 = await supervisor.status();
        if (!st0.running) return text('Server is not running — nothing to cancel.');
        try {
          await client.cancelJob(id);
          return text(`Job ${id}: cancel sent.`);
        } catch (e: any) {
          return err(`Could not cancel ${id}: ${e?.message || e}`);
        }
      }

      case 'list_jobs': {
        const known = allJobs();
        if (known.length === 0) return text('No jobs this session.');
        return json(known.map((j) => ({ id: j.id, kind: j.kind, profile: j.profile, status: j.lastStatus, created: j.createdAt, files: j.files, prompt: j.prompt.slice(0, 80) })));
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (e: any) {
    if (e instanceof McpError) throw e;
    return err(`Error: ${e?.message || e}`);
  }
});

function toImageField(v: string): string {
  if (!v) return v;
  if (v.startsWith('data:')) return v;
  if (/^[A-Za-z0-9+/=\s]{64,}$/.test(v) && !/[\\/]/.test(v)) return v;
  return readImageAsBase64(v);
}

function saveRaw(dir: string, prefix: string, format: string, b64: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${prefix}_${Date.now()}.${extFor(format)}`);
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  return out;
}

function shutdown(): void {
  try {
    if (supervisor.isManaged()) supervisor.stop();
  } catch {
    /* ignore */
  }
}
process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});
process.on('exit', shutdown);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('sdcraft MCP running (stdio)\n');
}

main().catch((e) => {
  process.stderr.write(`sdcraft fatal: ${e?.stack || e}\n`);
  process.exit(1);
});
