import path from 'node:path';
import { fail } from './task-office-common.mjs';
import { buildDocx, editDocx } from './task-docx.mjs';
import { buildXlsx, editXlsx } from './task-xlsx.mjs';
import { buildPptx, editPptx } from './task-pptx.mjs';

// One entry point for Office documents: render from a spec, edit an existing file, or describe a spec to the model.
export const OFFICE_EXT = ['.docx', '.xlsx', '.pptx'];
const TYPE_OF = { '.docx': 'docx', '.xlsx': 'xlsx', '.pptx': 'pptx' };
export const officeKind = (relative) => TYPE_OF[path.extname(relative).toLowerCase()] || null;

export function renderDocument(relative, spec, { resolveImage } = {}) {
  const kind = officeKind(relative);
  if (!kind) fail('Word(.docx)·Excel(.xlsx)·PowerPoint(.pptx) 파일만 문서 생성을 지원합니다.');
  if (!spec || spec.type !== kind) fail(`document.type은 "${kind}"여야 합니다.`);
  if (kind === 'docx') return buildDocx(spec, { resolveImage });
  if (kind === 'xlsx') return buildXlsx(spec);
  return buildPptx(spec, { resolveImage });
}
export function editDocument(relative, bytes, edit, { resolveImage } = {}) {
  const kind = officeKind(relative);
  if (!kind) fail('Word(.docx)·Excel(.xlsx)·PowerPoint(.pptx) 파일만 문서 수정을 지원합니다.');
  if (!edit || edit.type !== kind) fail(`edit.type은 "${kind}"여야 합니다.`);
  if (kind === 'docx') return editDocx(bytes, edit, { resolveImage });
  if (kind === 'xlsx') return editXlsx(bytes, edit);
  return editPptx(bytes, edit, { resolveImage });
}

// The format the model must follow when it creates or edits a document. Kept short; the server validates every key.
export const OFFICE_PROMPT = [
  'Office 문서는 서버가 JSON 명세로 만듭니다. create 작업에 "document", modify 작업에 "edit"를 쓰고 content는 쓰지 마세요.',
  'DOCX 생성: {"type":"create","path":"보고서.docx","document":{"type":"docx","title":"..","blocks":[{"type":"title","text":".."},{"type":"heading","level":1,"text":".."},{"type":"paragraph","text":".."}|{"type":"paragraph","runs":[{"text":"..","bold":true}]},{"type":"bullets","items":[".."]},{"type":"numbered","items":[".."]},{"type":"table","header":[".."],"rows":[["..",".."]]},{"type":"image","source":"프로젝트 상대경로 또는 att:첨부ID","alt":"..","width":480,"caption":".."},{"type":"pagebreak"}]}}',
  'DOCX 수정: {"type":"modify","path":"a.docx","edit":{"type":"docx","replace":[{"find":"기존 글","replace":"새 글"}],"append":[블록...],"insertAfter":[{"containing":"문단 일부","blocks":[블록...]}]}}',
  'XLSX 생성: {"type":"create","path":"표.xlsx","document":{"type":"xlsx","sheets":[{"name":"시트1","columns":[{"header":"이름","width":16,"format":"text|integer|decimal|percent|currency|date"}],"rows":[["가",10,{"formula":"B2*2"},{"date":"2026-10-08"}]],"freezeHeader":true,"autoFilter":true,"table":false}]}}',
  'XLSX 수정: {"type":"modify","path":"a.xlsx","edit":{"type":"xlsx","setCells":[{"sheet":"시트1","ref":"B2","value":10}|{"sheet":"..","ref":"C2","formula":"SUM(B2:B9)"}],"addSheets":[{"name":"요약","columns":[..],"rows":[..]}]}}',
  'PPTX 생성: {"type":"create","path":"발표.pptx","document":{"type":"pptx","title":"..","slides":[{"layout":"title","title":"..","subtitle":".."},{"layout":"bullets","title":"..","bullets":["..",{"text":"..","level":1}]},{"layout":"two-column","title":"..","left":[".."],"right":[".."]},{"layout":"image","title":"..","image":{"source":"경로 또는 att:ID","alt":".."},"caption":".."},{"layout":"section","title":".."}]}}',
  'PPTX 수정: {"type":"modify","path":"a.pptx","edit":{"type":"pptx","replace":[{"find":"..","replace":".."}],"addSlides":[슬라이드...]}}',
  '슬라이드당 bullets는 최대 12개(권장 3~6개), 한 줄은 짧게. 수식은 = 없이 쓰고 외부 파일·웹 함수는 쓸 수 없습니다. 존재하지 않는 이미지를 쓰지 마세요.',
].join('\n');
