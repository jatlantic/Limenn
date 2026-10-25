import type { Entity, EntityType } from '../pii/types';

/** A file in the linked vault folder (paths are relative to the folder, with forward slashes). */
export interface VaultFileInfo {
  path: string;
  name: string;
  size: number;
  mtime: number;
}

export type DocStatus = 'ready' | 'error';

/** Per-document review decisions made ahead of time in the side panel. */
export interface DocReview {
  allow: string[];
  manual: [string, EntityType][];
}

/** One prepared document: extracted text + cached detections. Placeholders are assigned per conversation. */
export interface PreparedDoc {
  id: string;
  path: string;
  name: string;
  size: number;
  mtime: number;
  hash: string;
  /** Settings that influence detection; a change re-prepares the doc. */
  settingsKey: string;
  /** settings.allowList at prepare time — applied again at use time, like redact() does. */
  allowList: string[];
  status: DocStatus;
  error?: string;
  text: string;
  meta: string;
  entities: Entity[];
  candidates: number;
  warnings: string[];
  preparedAt: number;
  prepareMs: number;
  review: DocReview;
}

export interface IndexEntry {
  id: string;
  path: string;
  name: string;
  size: number;
  mtime: number;
  hash: string;
  settingsKey: string;
  status: DocStatus;
  error?: string;
  entityCount: number;
  meta: string;
  preparedAt: number;
}

export interface VaultIndex {
  version: 1;
  docs: Record<string, IndexEntry>;
}

/**
 * Storage the vault works on. Implemented with the File System Access API in the extension
 * and with node:fs on the desktop, so both prepare into the same `<folder>/.limenn/` cache.
 */
export interface VaultFs {
  /** All supported files below the folder (recursively, skipping the cache dir and dotfiles). */
  list(): Promise<VaultFileInfo[]>;
  read(path: string): Promise<Uint8Array>;
  readCache(name: string): Promise<string | null>;
  writeCache(name: string, data: string): Promise<void>;
  removeCache(name: string): Promise<void>;
  /** Write the cleaned copy of a document to `<folder>/limenn-prepared/<path>.txt` (needs write access). */
  writePrepared?(path: string, text: string): Promise<void>;
  removePrepared?(path: string): Promise<void>;
}

export const CACHE_DIR = '.limenn';
/** Visible subfolder with the cleaned copy of every prepared document; never scanned itself. */
export const PREPARED_DIR = 'limenn-prepared';
export const preparedName = (path: string) => `${path}.txt`;
export const SUPPORTED_EXT = [
  '.pdf', '.docx', '.xlsx', '.xlsm', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.html', '.htm', '.eml',
  '.txt', '.md', '.csv', '.json', '.xml',
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff',
];
export const isSupported = (name: string) => !name.startsWith('.') && !name.startsWith('~$') && SUPPORTED_EXT.some((e) => name.toLowerCase().endsWith(e));
/** Directories the vault never scans: its own cache and the prepared copies. */
export const isSkippedDir = (name: string, atRoot: boolean) => name.startsWith('.') || (atRoot && name === PREPARED_DIR);
