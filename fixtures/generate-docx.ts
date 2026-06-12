/**
 * generate-docx — 「意地悪ケース入り」混在言語 docx と groundtruth を同時生成
 *
 * 単一の `cases` モデルから docx 本体と期待値(groundtruth.json)を生成するので、
 * 入力とテスト期待値がドリフトしない。dtir-ooxml-reader-mcp のテスト駆動開発の土台。
 *
 * groundtruth は **実装非依存**: id ハッシュや厳密な anchor パスは reader 実装に
 * 委ね、ここでは「reader が満たすべき意味（言語解決・translatable/skip・ラン数・
 * どの part に居るか）」だけを宣言する。
 *
 * 実行:
 *   tsx fixtures/generate-docx.ts <outDir>
 *   （<outDir> 既定: ./out）。<outDir>/docx/ に .docx と .groundtruth.json を出力。
 *
 * pdf ペア化（任意・別途 LibreOffice 必要）:
 *   soffice --headless --convert-to pdf --outdir <outDir>/pdf <outDir>/docx/*.docx
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';

// ---------------------------------------------------------------------------
// 名前空間・定数
// ---------------------------------------------------------------------------
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CONTAINER_DEFAULT_LANG = 'nl-NL';

/** XML テキストエスケープ。 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// ケースモデル（docx と groundtruth の単一の真実）
// ---------------------------------------------------------------------------
type Part = 'document' | 'header' | 'footer';
type Role =
  | 'heading'
  | 'body'
  | 'toc'
  | 'header'
  | 'footer'
  | 'list-item'
  | 'other';
type SkipReason = 'field' | 'non-linguistic-zxx' | 'numeric' | 'locked' | 'empty' | null;
type LangSource = 'tag' | 'detect' | 'inherit' | 'default';

interface RunSpec {
  text: string;
  /** w:lang。省略でタグ無し（＝コンテナ既定を継承）。 */
  lang?: { val?: string; eastAsia?: string };
  bold?: boolean;
  /** xml:space="preserve" を付ける（前後空白保持）。 */
  preserve?: boolean;
}

interface Case {
  key: string;
  part: Part;
  role: Role;
  kind: 'text' | 'numeric' | 'field';
  /** kind: text|numeric のラン列。 */
  runs?: RunSpec[];
  /** kind: field 用。複合フィールドの命令とキャッシュ表示文字列。 */
  field?: { instr: string; cachedRuns: RunSpec[] };
  /** heading 見出しスタイルを付ける。 */
  heading?: boolean;
  /** reader が満たすべき期待値（実装非依存）。 */
  expect: {
    /** 連結後の原文（reader が抽出すべき翻訳対象テキスト。field は null）。 */
    source: string | null;
    lang: string | null;
    langSource: LangSource;
    translatable: boolean;
    skipReason: SkipReason;
    /** 期待ラン数（ラン分断検証用）。 */
    runCount?: number;
    /** 混在スクリプト検証用。 */
    scripts?: string[];
    note?: string;
  };
}

const cases: Case[] = [
  {
    key: 'heading-nl',
    part: 'document',
    role: 'heading',
    kind: 'text',
    heading: true,
    runs: [{ text: 'Jaarverslag 2025', lang: { val: 'nl-NL' } }],
    expect: {
      source: 'Jaarverslag 2025',
      lang: 'nl-NL',
      langSource: 'tag',
      translatable: true,
      skipReason: null,
      runCount: 1,
    },
  },
  {
    key: 'body-fr-split',
    part: 'document',
    role: 'body',
    kind: 'text',
    // 1文が3ランに分断（先頭ボールド）。hasInlineFormatting=true を誘発。
    runs: [
      { text: 'Les résultats ', lang: { val: 'fr-FR' }, bold: true, preserve: true },
      { text: 'du premier trimestre ', lang: { val: 'fr-FR' }, preserve: true },
      { text: 'dépassent les prévisions.', lang: { val: 'fr-FR' } },
    ],
    expect: {
      source: 'Les résultats du premier trimestre dépassent les prévisions.',
      lang: 'fr-FR',
      langSource: 'tag',
      translatable: true,
      skipReason: null,
      runCount: 3,
      note: 'ラン分断。reader は text.runs にオフセットを埋め、hasInlineFormatting=true にすべき',
    },
  },
  {
    key: 'body-de-notag',
    part: 'document',
    role: 'body',
    kind: 'text',
    // w:lang を付けない → コンテナ既定 nl-NL を継承する＝タグは誤り。
    // reader はローカル判定で de-DE に上書きすべき。
    runs: [{ text: 'Die Produktion wurde im April vollständig automatisiert.' }],
    expect: {
      source: 'Die Produktion wurde im April vollständig automatisiert.',
      lang: 'de-DE',
      langSource: 'detect',
      translatable: true,
      skipReason: null,
      runCount: 1,
      note: 'タグ欠落で既定 nl-NL を継承するが内容は独語。detect が tag/default を覆すべき',
    },
  },
  {
    key: 'body-ja',
    part: 'document',
    role: 'body',
    kind: 'text',
    // 日本語段落。w:eastAsia=ja-JP のみ（ラテン用 w:val は無し）。
    // run-level の明示 val が無いので reader は detect で ja-JP を当てる（CJK 判定）。
    runs: [{ text: '当社は来年、海外市場へ進出します。', lang: { eastAsia: 'ja-JP' } }],
    expect: {
      source: '当社は来年、海外市場へ進出します。',
      lang: 'ja-JP',
      langSource: 'detect',
      translatable: true,
      skipReason: null,
      runCount: 1,
      note: '日本語段落。w:eastAsia=ja-JP のみで w:val 無し → detect が ja-JP を当てる(CJK)',
    },
  },
  {
    key: 'toc-title',
    part: 'document',
    role: 'heading',
    kind: 'text',
    heading: true,
    runs: [{ text: 'Inhoudsopgave', lang: { val: 'nl-NL' } }],
    expect: {
      source: 'Inhoudsopgave',
      lang: 'nl-NL',
      langSource: 'tag',
      translatable: true,
      skipReason: null,
      runCount: 1,
      note: 'TOC の「タイトル見出し」は可視テキスト＝翻訳対象。フィールドとは別物',
    },
  },
  {
    key: 'toc-field-cache',
    part: 'document',
    role: 'toc',
    kind: 'field',
    field: {
      instr: ' TOC \\o "1-3" \\h \\z \\u ',
      cachedRuns: [
        { text: 'Resultaten', lang: { val: 'nl-NL' } },
        { text: '\t3', preserve: true },
      ],
    },
    expect: {
      source: null,
      lang: null,
      langSource: 'default',
      translatable: false,
      skipReason: 'field',
      note: '複合フィールド begin/instrText/separate/キャッシュ/end。命令もキャッシュも翻訳対象外（再生成する）',
    },
  },
  {
    key: 'mixed-script',
    part: 'document',
    role: 'body',
    kind: 'text',
    // ラテン＋漢字の混在。w:val=en-US, w:eastAsia=ja-JP。
    runs: [{ text: 'Overview 概要', lang: { val: 'en-US', eastAsia: 'ja-JP' } }],
    expect: {
      source: 'Overview 概要',
      lang: 'en-US',
      langSource: 'tag',
      translatable: true,
      skipReason: null,
      runCount: 1,
      scripts: ['Latin', 'Han'],
      note: '混在スクリプト。reader は w:val/w:eastAsia の両方を拾えること',
    },
  },
  {
    key: 'numeric',
    part: 'document',
    role: 'body',
    kind: 'numeric',
    runs: [{ text: '€ 1.250.000', preserve: true }],
    expect: {
      source: '€ 1.250.000',
      lang: null,
      langSource: 'detect',
      translatable: false,
      skipReason: 'numeric',
      runCount: 1,
      note: '数値・記号のみ。DeepL は値を変えない前提なので翻訳対象外',
    },
  },
  {
    key: 'header-text',
    part: 'header',
    role: 'header',
    kind: 'text',
    runs: [{ text: 'Vertrouwelijk', lang: { val: 'nl-NL' } }],
    expect: {
      source: 'Vertrouwelijk',
      lang: 'nl-NL',
      langSource: 'tag',
      translatable: true,
      skipReason: null,
      runCount: 1,
      note: 'document.xml 以外（header1.xml）。reader の取りこぼし検証',
    },
  },
  {
    key: 'footer-pagefield',
    part: 'footer',
    role: 'footer',
    kind: 'field',
    field: { instr: ' PAGE ', cachedRuns: [{ text: '1' }] },
    expect: {
      source: null,
      lang: null,
      langSource: 'default',
      translatable: false,
      skipReason: 'field',
      note: 'フッタ内 PAGE フィールド。フィールドは part を問わず skip',
    },
  },
];

// ---------------------------------------------------------------------------
// XML ビルダー
// ---------------------------------------------------------------------------
function buildRprInner(r: RunSpec): string {
  const parts: string[] = [];
  if (r.bold) parts.push('<w:b/>');
  if (r.lang) {
    const attrs: string[] = [];
    if (r.lang.val) attrs.push(`w:val="${r.lang.val}"`);
    if (r.lang.eastAsia) attrs.push(`w:eastAsia="${r.lang.eastAsia}"`);
    parts.push(`<w:lang ${attrs.join(' ')}/>`);
  }
  return parts.length ? `<w:rPr>${parts.join('')}</w:rPr>` : '';
}

function buildTextRun(r: RunSpec): string {
  const space = r.preserve ? ' xml:space="preserve"' : '';
  return `<w:r>${buildRprInner(r)}<w:t${space}>${esc(r.text)}</w:t></w:r>`;
}

function buildParagraph(c: Case): string {
  const pPr = c.heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : '';
  if (c.kind === 'field' && c.field) {
    // 複合フィールド: begin → instrText → separate → cached → end
    const cached = c.field.cachedRuns.map(buildTextRun).join('');
    const seq =
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      `<w:r><w:instrText xml:space="preserve">${esc(c.field.instr)}</w:instrText></w:r>` +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      cached +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
    return `<w:p>${pPr}${seq}</w:p>`;
  }
  const runs = (c.runs ?? []).map(buildTextRun).join('');
  return `<w:p>${pPr}${runs}</w:p>`;
}

function buildParagraphs(part: Part): string {
  return cases
    .filter((c) => c.part === part)
    .map(buildParagraph)
    .join('\n    ');
}

// --- 各 OOXML パート --------------------------------------------------------
const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`;

const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>`;

// コンテナ既定言語は styles.xml の docDefaults/rPrDefault に置く
const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:lang w:val="${CONTAINER_DEFAULT_LANG}" w:eastAsia="ja-JP"/></w:rPr></w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
</w:styles>`;

const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="${W}">
  <w:themeFontLang w:val="${CONTAINER_DEFAULT_LANG}" w:eastAsia="ja-JP"/>
</w:settings>`;

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}">
  <w:body>
    ${buildParagraphs('document')}
    <w:sectPr>
      <w:headerReference w:type="default" r:id="rId3"/>
      <w:footerReference w:type="default" r:id="rId4"/>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417"/>
    </w:sectPr>
  </w:body>
</w:document>`;

const header1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="${W}" xmlns:r="${R}">
  ${buildParagraphs('header')}
</w:hdr>`;

const footer1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="${W}" xmlns:r="${R}">
  ${buildParagraphs('footer')}
</w:ftr>`;

// ---------------------------------------------------------------------------
// groundtruth（実装非依存の期待値）
// ---------------------------------------------------------------------------
function buildGroundtruth(fixtureName: string) {
  const langs = new Set<string>();
  for (const c of cases) if (c.expect.lang) langs.add(c.expect.lang);
  return {
    fixture: fixtureName,
    description: '混在言語 docx の意地悪ケース集。reader が満たすべき意味を実装非依存で宣言。',
    containerDefaultLang: CONTAINER_DEFAULT_LANG,
    expectedMultilingual: true,
    expectedLanguagesPresent: [...langs],
    parts: ['word/document.xml', 'word/header1.xml', 'word/footer1.xml'],
    segments: cases.map((c) => ({
      key: c.key,
      part:
        c.part === 'document'
          ? 'word/document.xml'
          : c.part === 'header'
            ? 'word/header1.xml'
            : 'word/footer1.xml',
      role: c.role,
      expectSource: c.expect.source,
      expectLang: c.expect.lang,
      expectLangSource: c.expect.langSource,
      translatable: c.expect.translatable,
      skipReason: c.expect.skipReason,
      ...(c.expect.runCount !== undefined ? { runCount: c.expect.runCount } : {}),
      ...(c.expect.scripts ? { scripts: c.expect.scripts } : {}),
      ...(c.expect.note ? { note: c.expect.note } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const outDir = process.argv[2] ?? './out';
  const docxDir = join(outDir, 'docx');
  const fixtureName = 'mixed-nl-fr-de-tricky.docx';

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rootRels);
  zip.file('word/_rels/document.xml.rels', documentRels);
  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', styles);
  zip.file('word/settings.xml', settings);
  zip.file('word/header1.xml', header1);
  zip.file('word/footer1.xml', footer1);

  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });

  const docxPath = join(docxDir, fixtureName);
  const gtPath = join(docxDir, `${fixtureName}.groundtruth.json`);
  mkdirSync(dirname(docxPath), { recursive: true });
  writeFileSync(docxPath, buf);
  writeFileSync(gtPath, `${JSON.stringify(buildGroundtruth(fixtureName), null, 2)}\n`);

  // 進捗は stderr へ（stdout を汚さない方針に合わせる）
  console.error(`generated: ${docxPath} (${buf.length} bytes)`);
  console.error(`generated: ${gtPath} (${cases.length} segments)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
