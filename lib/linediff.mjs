// Line diff for workbench changes. The common head and tail are trimmed first (most edits touch one
// spot), then Myers' algorithm finds the smallest edit on what is left. A very large difference is
// shown as one replaced block instead, so time and memory stay bounded.
export const DIFF_LIMIT = 2000;   // edit distance above which the middle becomes one replaced block
const CONTEXT = 3;                // unchanged lines kept around each change
const MAX_ROWS = 4000;            // rows returned to the browser
const MAX_LINE = 2000;            // characters kept per line

const lines = (text) => {
  if (text === null || text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
};

// Edit script between two line arrays, or null when the distance exceeds DIFF_LIMIT.
function myers(a, b) {
  const n = a.length, m = b.length, max = n + m, offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > DIFF_LIMIT) return null;
    trace.push(v.slice(offset - d, offset + d + 1)); // furthest x per diagonal before step d
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
  }
  return [];
}
function backtrack(a, b, trace, last) {
  const ops = [];
  let x = a.length, y = b.length;
  for (let d = last; d > 0; d--) {
    const at = (k) => trace[d][k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(['=', a[x - 1]]); x--; y--; }
    if (x === prevX) ops.push(['+', b[y - 1]]); else ops.push(['-', a[x - 1]]);
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { ops.push(['=', a[x - 1]]); x--; y--; }
  return ops.reverse();
}

// { added, removed, hunks: [{ oldStart, newStart, rows: [[sign, text, oldNo, newNo]] }], replacedBlock, clipped, eofChanged }
export function lineDiff(before, after) {
  const a = lines(before), b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail), midB = b.slice(head, b.length - tail);
  let mid = myers(midA, midB);
  const replacedBlock = !mid;
  if (!mid) mid = [...midA.map((s) => ['-', s]), ...midB.map((s) => ['+', s])];
  let added = 0, removed = 0;
  for (const [sign] of mid) { if (sign === '+') added++; else if (sign === '-') removed++; }
  // Rows with line numbers: head and tail are unchanged lines.
  const rows = [];
  let oldNo = head, newNo = head;
  for (let i = Math.max(0, head - CONTEXT); i < head; i++) rows.push([' ', a[i], i + 1, i + 1]);
  for (const [sign, text] of mid) {
    if (sign === '=') rows.push([' ', text, ++oldNo, ++newNo]);
    else if (sign === '-') rows.push(['-', text, ++oldNo, null]);
    else rows.push(['+', text, null, ++newNo]);
  }
  for (let i = 0; i < Math.min(CONTEXT, tail); i++) rows.push([' ', a[a.length - tail + i], oldNo + i + 1, newNo + i + 1]);
  // Group changed rows with CONTEXT unchanged rows around them.
  const hunks = [];
  let current = null, shown = 0, clipped = false, lastOld = 0, lastNew = 0;
  rows.forEach((row, i) => {
    const oldAt = row[2] ?? lastOld + 1, newAt = row[3] ?? lastNew + 1;
    if (row[2]) lastOld = row[2];
    if (row[3]) lastNew = row[3];
    const near = row[0] !== ' ' || rows.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((r) => r[0] !== ' ');
    if (!near) { current = null; return; }
    if (shown >= MAX_ROWS) { clipped = true; return; }
    if (!current) { current = { oldStart: oldAt, newStart: newAt, rows: [] }; hunks.push(current); }
    current.rows.push([row[0], row[1].length > MAX_LINE ? `${row[1].slice(0, MAX_LINE)}…` : row[1], row[2], row[3]]);
    shown++;
  });
  const eofChanged = before !== null && before !== '' && after !== '' && before.endsWith('\n') !== after.endsWith('\n');
  return { added, removed, hunks, replacedBlock, clipped, eofChanged };
}
