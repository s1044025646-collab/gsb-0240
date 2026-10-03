import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildTree, FORMAT_VERSION } from "./merkle";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export interface VersionInfo {
  versionId: number;
  listId: number;
  versionNo: number;
  root: string;
  count: number;
  formatVersion: string;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        list_id INTEGER NOT NULL REFERENCES lists(id),
        version_no INTEGER NOT NULL,
        root TEXT NOT NULL,
        count INTEGER NOT NULL,
        format_version TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(list_id, version_no)
      );
      CREATE TABLE IF NOT EXISTS records (
        version_id INTEGER NOT NULL REFERENCES versions(id),
        idx INTEGER NOT NULL,
        content BLOB NOT NULL,
        PRIMARY KEY(version_id, idx)
      );
    `);
  }

  close() {
    this.db.close();
  }

  createList(name: string): number {
    if (!name || typeof name !== "string") {
      throw new ApiError("INVALID_ARGUMENT", "name 必须是非空字符串");
    }
    const r = this.db
      .prepare("INSERT INTO lists(name) VALUES (?)")
      .run(name);
    return Number(r.lastInsertRowid);
  }

  listLists() {
    return this.db
      .prepare(
        `SELECT l.id, l.name, l.created_at AS createdAt,
                (SELECT COUNT(*) FROM versions v WHERE v.list_id = l.id) AS versionCount
         FROM lists l ORDER BY l.id`
      )
      .all();
  }

  private listExists(listId: number) {
    if (!this.db.prepare("SELECT 1 FROM lists WHERE id=?").get(listId)) {
      throw new ApiError("NOT_FOUND", `清单 ${listId} 不存在`, 404);
    }
  }

  // 批量导入为新版本；任一记录非法则整体回滚。
  addVersion(listId: number, records: string[]): VersionInfo {
    this.listExists(listId);
    if (!Array.isArray(records)) {
      throw new ApiError("INVALID_ARGUMENT", "records 必须是字符串数组");
    }
    for (let i = 0; i < records.length; i++) {
      if (typeof records[i] !== "string") {
        throw new ApiError(
          "IMPORT_FAILED",
          `第 ${i} 条记录不是字符串，批量导入已取消`
        );
      }
    }
    const items = records.map((s) => Buffer.from(s, "utf8"));
    const { root } = buildTree(items);
    this.db.exec("BEGIN");
    try {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(version_no),0)+1 AS no FROM versions WHERE list_id=?")
        .get(listId) as { no: number };
      const r = this.db
        .prepare(
          "INSERT INTO versions(list_id, version_no, root, count, format_version) VALUES (?,?,?,?,?)"
        )
        .run(listId, row.no, root.toString("hex"), items.length, FORMAT_VERSION);
      const versionId = Number(r.lastInsertRowid);
      const ins = this.db.prepare(
        "INSERT INTO records(version_id, idx, content) VALUES (?,?,?)"
      );
      items.forEach((buf, idx) => ins.run(versionId, idx, buf));
      this.db.exec("COMMIT");
      return this.getVersion(versionId);
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw new ApiError(
        "IMPORT_FAILED",
        `批量导入失败已回滚: ${(e as Error).message}`
      );
    }
  }

  getVersion(versionId: number): VersionInfo {
    const v = this.db
      .prepare(
        `SELECT id AS versionId, list_id AS listId, version_no AS versionNo,
                root, count, format_version AS formatVersion, created_at AS createdAt
         FROM versions WHERE id=?`
      )
      .get(versionId) as VersionInfo | undefined;
    if (!v) throw new ApiError("NOT_FOUND", `版本 ${versionId} 不存在`, 404);
    return v;
  }

  listVersions(listId: number): VersionInfo[] {
    this.listExists(listId);
    return this.db
      .prepare(
        `SELECT id AS versionId, list_id AS listId, version_no AS versionNo,
                root, count, format_version AS formatVersion, created_at AS createdAt
         FROM versions WHERE list_id=? ORDER BY version_no`
      )
      .all(listId) as unknown as VersionInfo[];
  }

  getRecords(versionId: number): Buffer[] {
    this.getVersion(versionId);
    const rows = this.db
      .prepare("SELECT content FROM records WHERE version_id=? ORDER BY idx")
      .all(versionId) as unknown as { content: Buffer }[];
    return rows.map((r) => Buffer.from(r.content));
  }

  compareVersions(aId: number, bId: number) {
    const a = this.getRecords(aId).map((b) => b.toString("utf8"));
    const b = this.getRecords(bId).map((x) => x.toString("utf8"));
    const va = this.getVersion(aId);
    const vb = this.getVersion(bId);
    const max = Math.max(a.length, b.length);
    const changes: { index: number; from?: string; to?: string }[] = [];
    for (let i = 0; i < max; i++) {
      if (i >= a.length) changes.push({ index: i, to: b[i] });
      else if (i >= b.length) changes.push({ index: i, from: a[i] });
      else if (a[i] !== b[i]) changes.push({ index: i, from: a[i], to: b[i] });
    }
    return {
      a: { versionId: aId, root: va.root, count: va.count },
      b: { versionId: bId, root: vb.root, count: vb.count },
      sameRoot: va.root === vb.root,
      changes,
    };
  }
}
