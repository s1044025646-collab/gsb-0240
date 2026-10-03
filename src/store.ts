
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  FORMAT_VERSION,
  buildLayers,
  makeProof,
  rootOf,
  toHex,
  type MerkleProof,
} from './merkle.js';

export interface VersionRow {
  id: number;
  listId: number;
  listName: string;
  version: number;
  total: number;
  rootHex: string;
  formatVersion: string;
  createdAt: string;
  parentVersionId: number | null;
  changeNote: string | null;
}

export interface VersionDetail extends VersionRow {
  layers: string[][];
  records: { position: number; content: string }[];
}

export interface BatchFailure {
  line: number;
  reason: string;
}

/**
 * SQLite 持久层。
 * 每个版本是不可变快照：原记录顺序、格式版本、分层摘要与根一并保存。
 * 新增/调整记录总是产生新版本，旧根与旧证明永远可查。
 */
export class MerkleStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        list_id INTEGER NOT NULL REFERENCES lists(id),
        version INTEGER NOT NULL,
        root_hex TEXT NOT NULL,
        format_version TEXT NOT NULL,
        total INTEGER NOT NULL,
        parent_version_id INTEGER REFERENCES versions(id),
        change_note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(list_id, version)
      );
      CREATE TABLE IF NOT EXISTS records (
        version_id INTEGER NOT NULL REFERENCES versions(id),
        position INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (version_id, position)
      );
      CREATE TABLE IF NOT EXISTS layers (
        version_id INTEGER NOT NULL REFERENCES versions(id),
        level INTEGER NOT NULL,
        position INTEGER NOT NULL,
        digest_hex TEXT NOT NULL,
        PRIMARY KEY (version_id, level, position)
      );
    `);
  }

  private requireList(name: string): { id: number; name: string } {
    const row = this.db.prepare('SELECT id, name FROM lists WHERE name = ?').get(name) as
      | { id: number; name: string }
      | undefined;
    if (!row) {
      const err = new Error(`清单不存在：${name}`);
      (err as Error & { code?: string }).code = 'NOT_FOUND';
      throw err;
    }
    return row;
  }

  private listExists(name: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM lists WHERE name = ?').get(name));
  }

  /** 在一个事务里写入不可变版本快照。 */
  private insertVersion(listId: number, records: string[], note: string | null): VersionRow {
    const nextVersion = (
      this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM versions WHERE list_id = ?').get(listId) as { v: number }
    ).v + 1;
    const parent = this.db
      .prepare('SELECT id FROM versions WHERE list_id = ? ORDER BY version DESC LIMIT 1')
      .get(listId) as { id: number } | undefined;

    const layers = buildLayers(records);
    const rootHex = records.length === 0 ? toHex(rootOf([])) : toHex(layers[layers.length - 1]![0]!);

    const insertVersion = this.db.prepare(
      `INSERT INTO versions (list_id, version, root_hex, format_version, total, parent_version_id, change_note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertRecord = this.db.prepare(
      'INSERT INTO records (version_id, position, content) VALUES (?, ?, ?)',
    );
    const insertDigest = this.db.prepare(
      'INSERT INTO layers (version_id, level, position, digest_hex) VALUES (?, ?, ?, ?)',
    );

    const tx = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    const rollback = this.db.prepare('ROLLBACK');
    tx.run();
    try {
      const info = insertVersion.run(
        listId,
        nextVersion,
        rootHex,
        FORMAT_VERSION,
        records.length,
        parent?.id ?? null,
        note,
      );
      const versionId = Number(info.lastInsertRowid);
      records.forEach((content, position) => insertRecord.run(versionId, position, content));
      if (records.length === 0) {
        insertDigest.run(versionId, 0, 0, rootHex);
      } else {
        layers.forEach((layer, level) =>
          layer.forEach((digest, position) => insertDigest.run(versionId, level, position, toHex(digest))),
        );
      }
      commit.run();
      return this.getVersionRow(listId, nextVersion)!;
    } catch (err) {
      rollback.run();
      throw err;
    }
  }

  private getVersionRow(listId: number, version: number): VersionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT v.id AS id, l.id AS listId, l.name AS listName, v.version AS version,
                v.total AS total, v.root_hex AS rootHex, v.format_version AS formatVersion,
                v.created_at AS createdAt, v.parent_version_id AS parentVersionId,
                v.change_note AS changeNote
         FROM versions v JOIN lists l ON l.id = v.list_id
         WHERE v.list_id = ? AND v.version = ?`,
      )
      .get(listId, version) as VersionRow | undefined;
    return row;
  }

  /** 新建清单（不存在则创建）并写入 v1。name 冲突时返回 CONFLICT。 */
  createList(name: string, records: string[], note: string | null = '初始版本'): VersionRow {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.\-一-龥]{1,64}$/.test(name)) {
      const err = new Error('清单名只允许 1-64 个字母、数字、下划线、点、减号或中文字符');
      (err as Error & { code?: string }).code = 'BAD_PARAM';
      throw err;
    }
    if (this.listExists(name)) {
      const err = new Error(`清单已存在：${name}，请用 append/new-version 追加新版本`);
      (err as Error & { code?: string }).code = 'CONFLICT';
      throw err;
    }
    const info = this.db.prepare('INSERT INTO lists (name) VALUES (?)').run(name);
    return this.insertVersion(Number(info.lastInsertRowid), records, note);
  }

  /** 基于上一版本追加/调整记录，生成新版本快照。 */
  appendVersion(
    name: string,
    records: string[],
    note: string | null = null,
    mode: 'append' | 'replace' = 'append',
  ): VersionRow {
    const list = this.requireList(name);
    let base: string[] = [];
    if (mode === 'append') {
      base = this.getRecords(this.latestVersionId(list.id)!);
    }
    return this.insertVersion(list.id, [...base, ...records], note);
  }

  private latestVersionId(listId: number): number | undefined {
    const row = this.db
      .prepare('SELECT id FROM versions WHERE list_id = ? ORDER BY version DESC LIMIT 1')
      .get(listId) as { id: number } | undefined;
    return row?.id;
  }

  private getRecords(versionId: number): string[] {
    const rows = this.db
      .prepare('SELECT content FROM records WHERE version_id = ? ORDER BY position')
      .all(versionId) as { content: string }[];
    return rows.map((r) => r.content);
  }

  listVersions(name: string): VersionRow[] {
    const list = this.requireList(name);
    return this.db
      .prepare(
        `SELECT v.id AS id, l.id AS listId, l.name AS listName, v.version AS version,
                v.total AS total, v.root_hex AS rootHex, v.format_version AS formatVersion,
                v.created_at AS createdAt, v.parent_version_id AS parentVersionId,
                v.change_note AS changeNote
         FROM versions v JOIN lists l ON l.id = v.list_id
         WHERE v.list_id = ? ORDER BY v.version`,
      )
      .all(list.id) as unknown as VersionRow[];
  }

  listAll(): { name: string; latestVersion: number; latestRootHex: string }[] {
    return this.db
      .prepare(
        `SELECT l.name AS name, v.version AS latestVersion, v.root_hex AS latestRootHex
         FROM lists l JOIN versions v ON v.list_id = l.id
         WHERE v.version = (SELECT MAX(version) FROM versions WHERE list_id = l.id)
         ORDER BY l.name`,
      )
      .all() as { name: string; latestVersion: number; latestRootHex: string }[];
  }

  getVersion(name: string, version: number | 'latest'): VersionDetail {
    const list = this.requireList(name);
    const ver =
      version === 'latest'
        ? (this.db
            .prepare('SELECT MAX(version) AS v FROM versions WHERE list_id = ?')
            .get(list.id) as { v: number | null }).v
        : version;
    if (ver === null) {
      const err = new Error(`清单 ${name} 尚无版本`);
      (err as Error & { code?: string }).code = 'NOT_FOUND';
      throw err;
    }
    const row = this.getVersionRow(list.id, ver);
    if (!row) {
      const err = new Error(`版本不存在：${name} v${ver}`);
      (err as Error & { code?: string }).code = 'NOT_FOUND';
      throw err;
    }
    const layerRows = this.db
      .prepare('SELECT level, position, digest_hex FROM layers WHERE version_id = ? ORDER BY level, position')
      .all(row.id) as { level: number; position: number; digest_hex: string }[];
    const layers: string[][] = [];
    for (const r of layerRows) {
      (layers[r.level] ??= [])[r.position] = r.digest_hex;
    }
    const records = this.getRecords(row.id).map((content, position) => ({ position, content }));
    return { ...row, layers, records };
  }

  /** 生成指定版本、指定索引的包含证明（持久化版本可复查）。 */
  getProof(name: string, version: number | 'latest', index: number): { version: VersionRow; rootHex: string; proof: MerkleProof } {
    const detail = this.getVersion(name, version);
    if (detail.total === 0) {
      const err = new Error('空清单版本没有叶子可证明');
      (err as Error & { code?: string }).code = 'EMPTY_LIST';
      throw err;
    }
    if (!Number.isInteger(index) || index < 0 || index >= detail.total) {
      const err = new Error(`索引超出范围：0..${detail.total - 1}，实际 ${index}`);
      (err as Error & { code?: string }).code = 'INDEX_OUT_OF_RANGE';
      throw err;
    }
    const records = detail.records.map((r) => r.content);
    const { rootHex, proof } = makeProof(records, index);
    return { version: detail, rootHex, proof };
  }

  /** 比较两个版本的根与记录差异。 */
  compareVersions(name: string, fromVersion: number, toVersion: number): {
    name: string;
    from: { version: number; rootHex: string; total: number };
    to: { version: number; rootHex: string; total: number };
    rootChanged: boolean;
    added: { position: number; content: string }[];
    removed: { position: number; content: string }[];
  } {
    const a = this.getVersion(name, fromVersion);
    const b = this.getVersion(name, toVersion);
    const maxLen = Math.max(a.records.length, b.records.length);
    const added: { position: number; content: string }[] = [];
    const removed: { position: number; content: string }[] = [];
    for (let i = 0; i < maxLen; i++) {
      const left = a.records[i]?.content;
      const right = b.records[i]?.content;
      if (left !== right) {
        if (left !== undefined) removed.push({ position: i, content: left });
        if (right !== undefined) added.push({ position: i, content: right });
      }
    }
    return {
      name,
      from: { version: a.version, rootHex: a.rootHex, total: a.total },
      to: { version: b.version, rootHex: b.rootHex, total: b.total },
      rootChanged: a.rootHex !== b.rootHex,
      added,
      removed,
    };
  }
}
