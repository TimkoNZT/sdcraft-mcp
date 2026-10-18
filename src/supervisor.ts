import { spawn, spawnSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Config, buildServerArgs, resolveAsset } from './config.js';

const PID_FILE = 'sdcraft-server.pid';
const LOG_FILE = 'sd-server.log';
const ERR_FILE = 'sd-server.err';

export interface ServerStatus {
  running: boolean;
  managed: boolean;
  profile: string | null;
  model: string | null;
  port: number;
  host: string;
  pid: number | null;
  uptimeSec: number | null;
  idleTimeoutSec: number;
  idleMode: 'stop' | 'keep';
}

export class Supervisor {
  private child: ChildProcess | null = null;
  private childPid: number | null = null;
  private managed = false;
  private startedAt: number | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;

  constructor(private cfg: Config) {
    this.adoptPidFile();
  }

  baseUrl(): string {
    return `http://${this.cfg.host}:${this.cfg.port}`;
  }

  private pidFilePath(): string {
    return path.join(this.cfg.logDir, PID_FILE);
  }

  private adoptPidFile(): void {
    try {
      if (fs.existsSync(this.pidFilePath())) {
        const pid = Number(fs.readFileSync(this.pidFilePath(), 'utf8').trim());
        if (pid && isAlive(pid)) {
          this.childPid = pid;
          this.managed = true;
          this.startedAt = Date.now();
        }
      }
    } catch {
      /* ignore */
    }
  }

  touch(): void {
    if (this.cfg.idleMode !== 'stop') return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.managed) {
        try {
          this.stop();
        } catch {
          /* ignore */
        }
      }
    }, Math.max(30, this.cfg.idleTimeoutSec) * 1000);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  async isUp(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl()}/sdcpp/v1/capabilities`, {
        signal: AbortSignal.timeout(2500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensureRunning(profileName?: string): Promise<void> {
    this.touch();
    if (await this.isUp()) return;
    if (this.starting) {
      await this.starting;
      return;
    }
    this.starting = this.spawnServer(profileName);
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async spawnServer(profileName?: string): Promise<void> {
    const profile = profileName || this.cfg.active;
    const args = buildServerArgs(this.cfg, profile);
    fs.mkdirSync(this.cfg.logDir, { recursive: true });
    const outFd = fs.openSync(path.join(this.cfg.logDir, LOG_FILE), 'a');
    const errFd = fs.openSync(path.join(this.cfg.logDir, ERR_FILE), 'a');
    const child = spawn(this.cfg.binPath, args, {
      cwd: this.cfg.workDir,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });
    child.unref();
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    this.child = child;
    this.childPid = child.pid ?? null;
    this.managed = true;
    this.startedAt = Date.now();
    try {
      if (this.childPid) fs.writeFileSync(this.pidFilePath(), String(this.childPid));
    } catch {
      /* ignore */
    }
    await this.waitReady();
  }

  private async waitReady(timeoutMs = 300000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isUp()) return;
      if (this.childPid && !isAlive(this.childPid)) {
        throw new Error('sd-server exited during startup; check logs in ' + this.cfg.logDir);
      }
      await sleep(1000);
    }
    throw new Error('sd-server did not become ready within timeout; check logs in ' + this.cfg.logDir);
  }

  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const pids = new Set<number>();
    if (this.childPid && isAlive(this.childPid)) pids.add(this.childPid);
    const portPid = this.pidOnPort();
    if (portPid) pids.add(portPid);
    for (const pid of pids) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* ignore */
          }
        }
      }
    }
    try {
      if (fs.existsSync(this.pidFilePath())) fs.unlinkSync(this.pidFilePath());
    } catch {
      /* ignore */
    }
    this.child = null;
    this.childPid = null;
    this.managed = false;
    this.startedAt = null;
  }

  private pidOnPort(): number | null {
    try {
      if (process.platform === 'win32') {
        const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }).stdout || '';
        const needle = `:${this.cfg.port}`;
        for (const line of out.split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5 && parts[0] === 'TCP' && parts[1].endsWith(needle) && parts[3] === 'LISTENING') {
            const pid = Number(parts[4]);
            if (pid) return pid;
          }
        }
      } else {
        const out = spawnSync('sh', ['-c', `lsof -ti tcp:${this.cfg.port} -sTCP:LISTEN`], { encoding: 'utf8' }).stdout || '';
        const pid = Number(out.split(/\s+/).filter(Boolean)[0]);
        if (pid) return pid;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  isManaged(): boolean {
    return this.managed;
  }

  async status(): Promise<ServerStatus> {
    const running = await this.isUp();
    let model: string | null = null;
    let profile: string | null = null;
    if (running) {
      try {
        const cap = await fetch(`${this.baseUrl()}/sdcpp/v1/capabilities`, {
          signal: AbortSignal.timeout(2500),
        }).then((r) => r.json());
        model = cap?.model?.name ?? null;
        profile = this.detectProfile(cap?.model?.path);
      } catch {
        /* ignore */
      }
    }
    return {
      running,
      managed: this.managed,
      profile: profile || (running ? null : this.cfg.active),
      model,
      port: this.cfg.port,
      host: this.cfg.host,
      pid: running ? this.childPid : null,
      uptimeSec: running && this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : null,
      idleTimeoutSec: this.cfg.idleTimeoutSec,
      idleMode: this.cfg.idleMode,
    };
  }

  detectProfile(modelPath?: string): string | null {
    if (!modelPath) return null;
    const norm = path.normalize(modelPath).toLowerCase();
    for (const [name, prof] of Object.entries(this.cfg.profiles)) {
      for (const key of ['--diffusion-model', '-m', '--model']) {
        const v = (prof.args || {})[key];
        if (!v) continue;
        const resolved = path.normalize(resolveAsset(this.cfg, v)).toLowerCase();
        if (resolved === norm) return name;
      }
    }
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e && e.code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
