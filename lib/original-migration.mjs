// Preserve the pre-restoration data before switching execution engines. Never reset memories.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic.mjs';

export function prepareOriginalData(store, ids) {
  if (store.state.originalRuntimeMigration?.version === 1) return store.state.originalRuntimeMigration;
  const backup = fs.mkdtempSync(path.join(store.dataDir, 'original-runtime-backup-'));
  for (const name of ['state.json', 'messages.jsonl', 'workspace-meta.json', 'world.json', 'house.json', 'activity.json', 'notes']) {
    const source = path.join(store.dataDir, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(backup, name), { recursive: true, errorOnExist: true, force: false });
  }
  if (fs.existsSync(store.wsDir)) fs.cpSync(store.wsDir, path.join(backup, 'workspace'), { recursive: true, errorOnExist: true, force: false });
  for (const id of ids) {
    const legacy = String(store.state.assistant?.memos?.[id] || '').trim();
    const original = store.readNote(id);
    if (legacy && original.trim() !== legacy) {
      // Keep both distinct representations, including notes longer than the normal future write limit.
      writeFileAtomic(path.join(store.notesDir, `${id}.md`), original.trim() ? `${original}\n\n${legacy}\n` : legacy);
    }
  }
  store.state.seen ??= { ...store.state.assistant?.conversation?.seen };
  const result = { version: 1, source: 'Moris-kr/ai-chatroom@abca3104766ca4bbf2624c13636f0220993d0416', backup };
  store.state.originalRuntimeMigration = result;
  store.saveState();
  return result;
}
