import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';

test('작업공간은 저장된 제목과 기존 게임 메시지의 제목을 제공하고 원래 경로와 내용을 유지한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatroom-workspace-'));
  try {
    let store = new Store(root);
    store.applyFileOp({ op: 'write', path: 'activities/old.html', content: '<button>시작</button>' }, 'gpt');
    store.meta['activities/old.html'].activity = 'game';
    store.touchMeta('activities/old.html', 'gpt', true);
    store.addMessage({ from: 'gpt', text: '완성', game: { path: 'activities/old.html', title: '예전 클릭 게임' } });
    store.applyFileOp({ op: 'write', path: 'activities/untitled.html', content: '<button>시작</button>' }, 'claude');
    store.meta['activities/untitled.html'].activity = 'game';
    store.touchMeta('activities/untitled.html', 'claude', true);
    store.applyFileOp({ op: 'write', path: 'activities/picture.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' }, 'claude');
    Object.assign(store.meta['activities/picture.svg'], { activity: 'postcard', title: '<b>우주 소풍</b>' });
    store.touchMeta('activities/picture.svg', 'claude', true);
    store.applyFileOp({ op: 'write', path: 'notes/readme.txt', content: '설명' }, 'gpt');
    store = new Store(root);
    const files = new Map(store.listFiles().map((f) => [f.path, f]));
    assert.equal(files.get('activities/old.html').title, '예전 클릭 게임');
    assert.equal(files.get('activities/old.html').activity, 'game');
    assert.equal(files.get('activities/untitled.html').title, null);
    assert.equal(files.get('activities/picture.svg').title, '<b>우주 소풍</b>');
    assert.equal(files.get('activities/picture.svg').image, true);
    assert.equal(files.get('notes/readme.txt').activity, null);
    assert.equal(files.get('notes/readme.txt').image, false);
    assert.equal(store.readFile('activities/old.html').text, '<button>시작</button>');
    assert.equal(store.readFile('notes/readme.txt').text, '설명');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
