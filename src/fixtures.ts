/**
 * fixtures — 適合性スイート（conformance suite）への絶対パス解決
 *
 * DTIR の契約に属するテストフィクスチャ（意地悪 docx・groundtruth・reader 出力 DTIR）と
 * JSON Schema を、**パッケージ同梱物として**解決する。各 MCP repo はこれを使えば
 * sibling を相対参照せずに contract だけに依存してテストできる（polyrepo 対応）。
 *
 * import.meta.url 基準なので、インストール先（symlink / node_modules / 公開版）でも
 * 正しく解決される。
 */
import { fileURLToPath } from 'node:url';

const p = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/** JSON Schema（dtir-0.1）。 */
export const schemaPath = p('../schema/dtir-0.1.schema.json');

/** 意地悪ケース入り docx（reader/writer の入力）。 */
export const fixtureDocxPath = p('../fixtures/docx/mixed-nl-fr-de-tricky.docx');

/** 上記 docx の groundtruth（実装非依存の期待値）。 */
export const fixtureGroundtruthPath = p(
  '../fixtures/docx/mixed-nl-fr-de-tricky.docx.groundtruth.json',
);

/**
 * 上記 docx を reader にかけた DTIR 出力サンプル（translation/quality は null）。
 * writer/translate のテストは reader を実行せず、この静的 DTIR を入力に使う。
 */
export const readerDtirPath = p('../fixtures/mixed-nl-fr-de-tricky.reader.dtir.json');

/** 同梱フィクスチャの一覧（デバッグ用）。 */
export const fixturePaths = {
  schemaPath,
  fixtureDocxPath,
  fixtureGroundtruthPath,
  readerDtirPath,
} as const;
