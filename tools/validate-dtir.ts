/**
 * validate-dtir — DTIR の「意味検査」リンタ
 *
 * JSON Schema（schema/dtir-0.1.schema.json）は構造を縛るが、
 * フィールド間の整合性までは縛れない。本リンタはその穴を埋める。
 * dtir-ooxml-reader-mcp / pdf-reader のテストにそのまま流用する想定。
 *
 * 検査項目:
 *  - id の一意性
 *  - stats（segmentCount / translatableCount / groupCount）の整合
 *  - text.runs のオフセット境界・連続性・source 全域被覆（UTF-16 半開区間）
 *  - skipReason="non-linguistic-zxx" のとき language.value は null か "zxx"
 *  - translatable=true は group 必須、false は group=null
 *  - context.{prev,next,parent} が実在 id を指す（dangling 検出）
 *  - order の重複・欠番チェック（0..n-1 の連番）
 *
 * 構造（必須プロパティ等）は別途 JSON Schema で検査すること。本関数は
 * 構造的に妥当な IRDocument を前提に、意味的な不整合のみを返す。
 *
 * 使い方（ライブラリ）:
 *   import { validateDtir } from './validate-dtir.js';
 *   const issues = validateDtir(doc);
 *   if (issues.length) throw new Error(issues.join('\n'));
 *
 * 使い方（CLI）:
 *   tsx tools/validate-dtir.ts examples/docx-multilang.dtir.json
 */

import { readFileSync } from 'node:fs';
import type { IRDocument } from '../src/types.js';

export interface DtirIssue {
  /** 問題のあるセグメント id（文書レベルの問題は null）。 */
  segmentId: string | null;
  /** 機械可読なコード。 */
  code:
    | 'duplicate-id'
    | 'stats-segment-count'
    | 'stats-translatable-count'
    | 'stats-group-count'
    | 'run-out-of-bounds'
    | 'run-not-contiguous'
    | 'run-incomplete-coverage'
    | 'zxx-has-language'
    | 'translatable-without-group'
    | 'non-translatable-with-group'
    | 'context-dangling'
    | 'order-not-sequential';
  message: string;
}

/** UTF-16 コードユニット長（String.length と一致）。 */
function u16len(s: string): number {
  return s.length;
}

/**
 * IRDocument の意味的整合を検査し、問題の配列を返す（空配列 = 健全）。
 */
export function validateDtir(doc: IRDocument): DtirIssue[] {
  const issues: DtirIssue[] = [];
  const push = (segmentId: string | null, code: DtirIssue['code'], message: string) =>
    issues.push({ segmentId, code, message });

  const ids = doc.segments.map((s) => s.id);
  const idSet = new Set(ids);

  // id 一意性
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) push(id, 'duplicate-id', `重複した id: ${id}`);
    seen.add(id);
  }

  // stats 整合
  if (doc.stats.segmentCount !== doc.segments.length) {
    push(
      null,
      'stats-segment-count',
      `stats.segmentCount=${doc.stats.segmentCount} != segments.length=${doc.segments.length}`,
    );
  }
  const translatableCount = doc.segments.filter((s) => s.translatable).length;
  if (doc.stats.translatableCount !== translatableCount) {
    push(
      null,
      'stats-translatable-count',
      `stats.translatableCount=${doc.stats.translatableCount} != actual=${translatableCount}`,
    );
  }
  const groups = new Set(
    doc.segments.map((s) => s.group).filter((g): g is string => g !== null),
  );
  if (doc.stats.groupCount !== groups.size) {
    push(
      null,
      'stats-group-count',
      `stats.groupCount=${doc.stats.groupCount} != distinct groups=${groups.size}`,
    );
  }

  // order が 0..n-1 の連番か
  const orders = [...doc.segments].map((s) => s.order).sort((a, b) => a - b);
  for (let i = 0; i < orders.length; i++) {
    if (orders[i] !== i) {
      push(null, 'order-not-sequential', `order が 0..${orders.length - 1} の連番でない（${orders.join(',')}）`);
      break;
    }
  }

  for (const s of doc.segments) {
    // runs 境界・連続性・全域被覆
    if (s.text.runs && s.text.runs.length > 0) {
      const len = u16len(s.text.source);
      let prevEnd = 0;
      for (const r of s.text.runs) {
        if (r.start < 0 || r.end > len || r.start > r.end) {
          push(
            s.id,
            'run-out-of-bounds',
            `run ${r.runId} のオフセット [${r.start},${r.end}) が source(len=${len}) を逸脱`,
          );
        }
        if (r.start !== prevEnd) {
          push(
            s.id,
            'run-not-contiguous',
            `run ${r.runId} が不連続（start=${r.start}, 期待=${prevEnd}）`,
          );
        }
        prevEnd = r.end;
      }
      if (prevEnd !== len) {
        push(
          s.id,
          'run-incomplete-coverage',
          `runs が source 全域を被覆していない（末尾=${prevEnd}, len=${len}）`,
        );
      }
    }

    // zxx / 非言語は言語値を持たない
    if (
      s.skipReason === 'non-linguistic-zxx' &&
      s.language.value !== null &&
      s.language.value !== 'zxx'
    ) {
      push(s.id, 'zxx-has-language', `非言語(zxx)なのに language.value=${s.language.value}`);
    }

    // translatable ↔ group
    if (s.translatable && (s.group === null || s.group === '')) {
      push(s.id, 'translatable-without-group', 'translatable=true だが group 未設定');
    }
    if (!s.translatable && s.group !== null) {
      push(s.id, 'non-translatable-with-group', `translatable=false だが group=${s.group}`);
    }

    // context 参照解決
    for (const key of ['prev', 'next', 'parent'] as const) {
      const v = s.context[key];
      if (v !== null && !idSet.has(v)) {
        push(s.id, 'context-dangling', `context.${key}=${v} が実在 id を指していない`);
      }
    }
  }

  return issues;
}

// --- CLI ---------------------------------------------------------------
// tsx tools/validate-dtir.ts <file.dtir.json> [...]
// 構造検査は行わない（JSON Schema 側の責務）。意味検査のみ。
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  /validate-dtir\.[tj]s$/.test(process.argv[1]);

if (isMain) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: tsx tools/validate-dtir.ts <file.dtir.json> [...]');
    process.exit(2);
  }
  let failed = 0;
  for (const f of files) {
    const doc = JSON.parse(readFileSync(f, 'utf8')) as IRDocument;
    const issues = validateDtir(doc);
    if (issues.length === 0) {
      console.error(`PASS  ${f}`);
    } else {
      failed++;
      console.error(`ISSUES  ${f}`);
      for (const i of issues) {
        console.error(`   - [${i.code}] ${i.segmentId ?? '(doc)'}: ${i.message}`);
      }
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}
