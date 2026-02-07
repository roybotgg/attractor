import { mkdirSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const FILE_BACKING_THRESHOLD = 102_400; // 100KB

export interface ArtifactInfo {
  id: string;
  name: string;
  sizeBytes: number;
  storedAt: Date;
  isFileBacked: boolean;
}

export class ArtifactStore {
  private artifacts = new Map<string, { info: ArtifactInfo; data: unknown }>();
  private readonly baseDir: string | undefined;

  constructor(options?: { baseDir?: string }) {
    this.baseDir = options?.baseDir;
  }

  private artifactsDir(): string | undefined {
    if (!this.baseDir) return undefined;
    return join(this.baseDir, "artifacts");
  }

  private artifactPath(artifactId: string): string | undefined {
    const dir = this.artifactsDir();
    if (!dir) return undefined;
    return join(dir, `${artifactId}.json`);
  }

  async store(artifactId: string, name: string, data: unknown): Promise<ArtifactInfo> {
    const serialized = JSON.stringify(data);
    const sizeBytes = new TextEncoder().encode(serialized).length;
    const shouldFileBack = sizeBytes > FILE_BACKING_THRESHOLD && this.baseDir !== undefined;

    const info: ArtifactInfo = {
      id: artifactId,
      name,
      sizeBytes,
      storedAt: new Date(),
      isFileBacked: shouldFileBack,
    };

    if (shouldFileBack) {
      const dir = this.artifactsDir();
      if (dir) {
        mkdirSync(dir, { recursive: true });
        const filePath = join(dir, `${artifactId}.json`);
        await Bun.write(filePath, serialized);
      }
      this.artifacts.set(artifactId, { info, data: undefined });
    } else {
      this.artifacts.set(artifactId, { info, data });
    }

    return info;
  }

  async retrieve(artifactId: string): Promise<unknown> {
    const entry = this.artifacts.get(artifactId);
    if (!entry) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }
    if (entry.info.isFileBacked) {
      const filePath = this.artifactPath(artifactId);
      if (!filePath) {
        throw new Error(`File-backed artifact has no base dir: ${artifactId}`);
      }
      const text = await Bun.file(filePath).text();
      return JSON.parse(text) as unknown;
    }
    return entry.data;
  }

  has(artifactId: string): boolean {
    return this.artifacts.has(artifactId);
  }

  list(): ArtifactInfo[] {
    return [...this.artifacts.values()].map((e) => e.info);
  }

  remove(artifactId: string): void {
    const entry = this.artifacts.get(artifactId);
    if (entry?.info.isFileBacked) {
      const filePath = this.artifactPath(artifactId);
      if (filePath && existsSync(filePath)) {
        unlinkSync(filePath);
      }
    }
    this.artifacts.delete(artifactId);
  }

  clear(): void {
    const dir = this.artifactsDir();
    if (dir && existsSync(dir)) {
      const files = readdirSync(dir);
      files.forEach((file) => unlinkSync(join(dir, file)));
    }
    this.artifacts.clear();
  }
}
