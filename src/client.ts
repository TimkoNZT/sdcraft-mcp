import fs from 'fs';
import path from 'path';

export interface ApiOptions {
  baseUrl: string;
  timeoutMs?: number;
}

async function jfetch(url: string, opts: RequestInit, timeoutMs: number): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let data: any = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const msg = typeof data === 'string' ? data : JSON.stringify(data);
      const err: any = new Error(`HTTP ${res.status}: ${msg}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export class SdClient {
  constructor(private opts: ApiOptions) {}

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  private t(): number {
    return this.opts.timeoutMs ?? 30000;
  }

  async ping(timeoutMs = 2500): Promise<boolean> {
    try {
      await jfetch(`${this.baseUrl}/sdcpp/v1/capabilities`, { method: 'GET' }, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  async capabilities(): Promise<any> {
    return jfetch(`${this.baseUrl}/sdcpp/v1/capabilities`, { method: 'GET' }, this.t());
  }

  async submitImgGen(body: Record<string, any>): Promise<any> {
    return jfetch(
      `${this.baseUrl}/sdcpp/v1/img_gen`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      this.t(),
    );
  }

  async getJob(id: string): Promise<any> {
    return jfetch(`${this.baseUrl}/sdcpp/v1/jobs/${encodeURIComponent(id)}`, { method: 'GET' }, this.t());
  }

  async cancelJob(id: string): Promise<any> {
    return jfetch(
      `${this.baseUrl}/sdcpp/v1/jobs/${encodeURIComponent(id)}/cancel`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      this.t(),
    );
  }

  async upscale(body: Record<string, any>): Promise<any> {
    return jfetch(
      `${this.baseUrl}/sdcpp/v1/upscale`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      this.t(),
    );
  }

  async progress(): Promise<any> {
    return jfetch(`${this.baseUrl}/sdapi/v1/progress`, { method: 'GET' }, this.t());
  }
}

export function readImageAsBase64(filePath: string): string {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`image not found: ${abs}`);
  return fs.readFileSync(abs).toString('base64');
}
