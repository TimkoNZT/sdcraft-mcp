import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface Supports {
  img2img: boolean;
  inpaint: boolean;
  edit: boolean;
  controlnet: boolean;
}

export interface ProfileDefaults {
  steps?: number;
  cfg_scale?: number;
  sampler?: string;
  scheduler?: string;
  width?: number;
  height?: number;
  negative_prompt?: string;
}

export interface Profile {
  args: Record<string, string>;
  defaults?: ProfileDefaults;
  supports?: Partial<Supports>;
}

export interface Config {
  binPath: string;
  workDir: string;
  modelsDir: string;
  assetsDir: string;
  outputDir: string;
  logDir: string;
  host: string;
  port: number;
  idleMode: 'stop' | 'keep';
  idleTimeoutSec: number;
  commonArgs: string[];
  active: string;
  profiles: Record<string, Profile>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function configPath(): string {
  return process.env.SDCRAFT_CONFIG || path.resolve(__dirname, '..', 'sdcraft.config.json');
}

export function loadConfig(): Config {
  const p = configPath();
  if (!fs.existsSync(p)) {
    throw new Error(`sdcraft: config not found at ${p} (set SDCRAFT_CONFIG)`);
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const cfg: Config = {
    binPath: raw.binPath,
    workDir: raw.workDir,
    modelsDir: raw.modelsDir,
    assetsDir: raw.assetsDir || raw.modelsDir,
    outputDir: raw.outputDir || path.join(raw.workDir || '.', 'out'),
    logDir: raw.logDir || path.join(raw.workDir || '.', 'logs'),
    host: raw.host || '127.0.0.1',
    port: Number(process.env.SDCRAFT_PORT || raw.port || 8080),
    idleMode: raw.idleMode === 'keep' ? 'keep' : 'stop',
    idleTimeoutSec: Number(process.env.SDCRAFT_IDLE_SEC || raw.idleTimeoutSec || 600),
    commonArgs: Array.isArray(raw.commonArgs) ? raw.commonArgs : [],
    active: raw.active,
    profiles: raw.profiles || {},
  };
  if (!cfg.profiles[cfg.active]) {
    throw new Error(`sdcraft: active profile '${cfg.active}' not found in config`);
  }
  return cfg;
}

export function saveConfig(cfg: Config): void {
  const p = configPath();
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
}

const MODEL_ARG_KEYS = new Set([
  '--model', '-m',
  '--diffusion-model',
  '--high-noise-diffusion-model',
  '--uncond-diffusion-model',
  '--vae',
  '--clip_l', '--clip_g', '--clip_vision',
  '--t5xxl', '--llm', '--llm_vision', '--qwen2vl', '--qwen2vl_vision',
  '--control-net', '--ip-adapter', '--upscale-model', '--photo-maker',
  '--taesd', '--tae', '--embd-dir', '--lora-model-dir', '--hires-upscalers-dir',
  '--motion-module', '--audio-vae', '--audio-encoder',
]);

export function resolveAsset(cfg: Config, p: string): string {
  if (!p) return p;
  if (path.isAbsolute(p)) return p;
  const inModels = path.join(cfg.modelsDir, p);
  if (fs.existsSync(inModels)) return inModels;
  const inAssets = path.join(cfg.assetsDir, p);
  if (fs.existsSync(inAssets)) return inAssets;
  return inModels;
}

export function buildServerArgs(cfg: Config, profileName: string): string[] {
  const prof = cfg.profiles[profileName];
  if (!prof) throw new Error(`sdcraft: unknown profile '${profileName}'`);
  const args: string[] = [];
  for (const [key, value] of Object.entries(prof.args || {})) {
    const resolved = MODEL_ARG_KEYS.has(key) ? resolveAsset(cfg, value) : value;
    args.push(key, resolved);
  }
  for (const extra of cfg.commonArgs) args.push(extra);
  args.push('--listen-ip', cfg.host, '--listen-port', String(cfg.port));
  return args;
}

export function getSupports(cfg: Config, profileName: string): Supports {
  const prof = cfg.profiles[profileName];
  const s = (prof && prof.supports) || {};
  return {
    img2img: !!s.img2img,
    inpaint: !!s.inpaint,
    edit: !!s.edit,
    controlnet: !!s.controlnet,
  };
}

export function profilesSupporting(cfg: Config, op: keyof Supports): string[] {
  return Object.keys(cfg.profiles).filter((n) => getSupports(cfg, n)[op]);
}
