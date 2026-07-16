import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertPersistedKeyPolicy } from "../../persisted-key-policy.js";
import { parseSessionRecord } from "../../session/persistence/parse.js";
import { serializeSessionRecordForDisk } from "../../session/persistence/serialize.js";
import type { AcpFileSessionStoreOptions, AcpSessionRecord, AcpSessionStore } from "./contract.js";

function safeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

class FileSessionStore implements AcpSessionStore {
  constructor(private readonly stateDir: string) {}

  private get sessionDir(): string {
    return path.join(this.stateDir, "sessions");
  }

  private filePath(sessionId: string): string {
    return path.join(this.sessionDir, `${safeSessionId(sessionId)}.json`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.sessionDir, 0o700);
  }

  async load(sessionId: string): Promise<AcpSessionRecord | undefined> {
    await this.ensureDir();
    let payload: string;
    try {
      await fs.chmod(this.filePath(sessionId), 0o600);
      payload = await fs.readFile(this.filePath(sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      throw new Error(`Invalid ACP session JSON for ${sessionId}`, { cause: error });
    }
    const record = parseSessionRecord(parsed);
    if (!record) {
      throw new Error(`Invalid ACP session record for ${sessionId}`);
    }
    return record;
  }

  async save(record: AcpSessionRecord): Promise<void> {
    await this.ensureDir();
    const persisted = serializeSessionRecordForDisk(record);
    assertPersistedKeyPolicy(persisted);

    const file = this.filePath(record.acpxRecordId);
    const tempFile = `${file}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(persisted, null, 2);
    try {
      await fs.writeFile(tempFile, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tempFile, file);
      await fs.chmod(file, 0o600);
    } finally {
      await fs.rm(tempFile, { force: true });
    }
  }
}

export function createFileSessionStore(options: AcpFileSessionStoreOptions): AcpSessionStore {
  return new FileSessionStore(path.resolve(options.stateDir));
}
