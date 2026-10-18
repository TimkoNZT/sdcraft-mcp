import fs from 'fs';
import path from 'path';
import { Config } from './config.js';
import { SdClient } from './client.js';

export interface TrackedJob {
  id: string;
  kind: string;
  profile: string;
  prompt: string;
  createdAt: number;
  lastStatus: string;
  files: string[];
}

const jobs = new Map<string, TrackedJob>();

export function track(job: TrackedJob): void {
  jobs.set(job.id, job);
}

export function getTracked(id: string): TrackedJob | undefined {
  return jobs.get(id);
}

export function allJobs(): TrackedJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function updateStatus(id: string, status: string): void {
  const j = jobs.get(id);
  if (j) j.lastStatus = status;
}

export function extFor(format?: string): string {
  switch ((format || 'png').toLowerCase()) {
    case 'jpeg':
    case 'jpg':
      return 'jpg';
    case 'webp':
      return 'webp';
    default:
      return 'png';
  }
}

export function saveImages(cfg: Config, jobId: string, format: string, images: any[]): string[] {
  fs.mkdirSync(cfg.outputDir, { recursive: true });
  const ext = extFor(format);
  const safeId = jobId.replace(/[^A-Za-z0-9_.-]/g, '_');
  const files: string[] = [];
  images.forEach((img: any, idx: number) => {
    const b64 = typeof img === 'string' ? img : img?.b64_json;
    if (!b64) return;
    const suffix = images.length > 1 ? `_${Number.isFinite(img?.index) ? img.index : idx}` : '';
    const out = path.join(cfg.outputDir, `${safeId}${suffix}.${ext}`);
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    files.push(out);
  });
  return files;
}

export interface WaitResult {
  status: string;
  job: any;
  files: string[];
}

export async function waitForJob(
  client: SdClient,
  cfg: Config,
  jobId: string,
  profile: string,
  waitSeconds: number,
  onProgress?: (info: { status: string; step?: number; total?: number; queue?: number }) => void,
): Promise<WaitResult> {
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  let last: any = null;
  for (;;) {
    try {
      last = await client.getJob(jobId);
    } catch (err: any) {
      return { status: 'error', job: null, files: [] };
    }
    const status = String(last?.status || 'unknown');
    updateStatus(jobId, status);
    if (status === 'completed') {
      const format = last?.result?.output_format || 'png';
      const images = last?.result?.images || [];
      const tracked = jobs.get(jobId);
      let files = tracked?.files || [];
      if (files.length === 0) {
        files = saveImages(cfg, jobId, format, images);
        if (tracked) tracked.files = files;
      }
      return { status, job: last, files };
    }
    if (status === 'failed' || status === 'cancelled') {
      return { status, job: last, files: [] };
    }
    if (onProgress) {
      onProgress({
        status,
        step: last?.preview?.step,
        total: last?.preview?.total_steps,
        queue: last?.queue_position,
      });
    }
    if (Date.now() >= deadline) {
      return { status, job: last, files: [] };
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}
