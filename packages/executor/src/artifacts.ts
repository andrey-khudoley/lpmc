import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";

/**
 * Хранилище артефактов с непрозрачной адресацией.
 *
 * Имя файла — сам идентификатор ссылки и ничего больше: ни владельца, ни задачи,
 * ни типа. Знание пути доступа не даёт, знание ссылки не выдаёт контекста.
 * Соответствие «ссылка → что это» лежит в базе исполнителя, недоступной соседям.
 */
export interface StoredArtifact {
  artifactRef: string;
  kind: string;
  mediaType: string;
  bytes: number;
}

export class Artifacts {
  constructor(
    private readonly pool: pg.Pool,
    private readonly root: string,
  ) {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  async put(
    runId: string, kind: string, mediaType: string, data: Buffer | string,
  ): Promise<StoredArtifact> {
    const artifactRef = randomUUID();
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const path = join(this.root, artifactRef);
    writeFileSync(path, buf, { mode: 0o600 });
    await this.pool.query(
      `INSERT INTO artifacts (artifact_ref, run_id, kind, media_type, bytes, path)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [artifactRef, runId, kind, mediaType, buf.length, path],
    );
    return { artifactRef, kind, mediaType, bytes: buf.length };
  }
}
