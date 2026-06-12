/**
 * generate-torture-docx — 「仕事文書 torture フィクスチャ」生成
 *
 * 既存の適合性フィクスチャ（mixed-nl-fr-de-tricky）とは別に、**実務文書で頻出するが
 * v0.1 reader が取りこぼす構造**を1ファイルに詰めた docx を生成する。
 * 目的: 現状 reader のカバレッジ漏れを「数値で」可視化し、再帰走査の目標を定める。
 *
 *   仕込んだ構造:
 *     - 表（w:tbl）: 混在言語セル ＋ 結合セル（gridSpan）
 *     - ハイパーリンク（w:hyperlink 内 run の表示テキスト）
 *     - 脚注（footnotes.xml ＋ w:footnoteReference）
 *     - 追跡変更（w:ins 内 run）
 *     - 段内太字（collapse で書式喪失する例）
 *
 * 出力: <outDir>/docx/work-doc-torture.docx ＋ work-doc-torture.expected.json
 *   expected.json は「各 probe テキスト・所在・現状 reader で抽出可能と予想されるか」を宣言。
 *
 * 実行: tsx fixtures/generate-torture-docx.ts <outDir>   （既定 ./out）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** ラン（w:val 言語タグつき・太字つき）。 */
const run = (text: string, opts: { lang?: string; bold?: boolean; style?: string; preserve?: boolean } = {}) => {
  const rPr: string[] = [];
  if (opts.bold) rPr.push('<w:b/>');
  if (opts.style) rPr.push(`<w:rStyle w:val="${opts.style}"/>`);
  if (opts.lang) rPr.push(`<w:lang w:val="${opts.lang}"/>`);
  const rPrXml = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';
  const sp = opts.preserve ? ' xml:space="preserve"' : '';
  return `<w:r>${rPrXml}<w:t${sp}>${esc(text)}</w:t></w:r>`;
};

// ---------------------------------------------------------------------------
// probe 定義（docx と expected manifest の単一の真実）
// ---------------------------------------------------------------------------
interface Probe {
  key: string;
  text: string;
  where: string; // 構造上の所在
  /** 現状 v0.1 reader が抽出すると予想されるか。 */
  expectExtractedNow: boolean;
  note?: string;
}
const probes: Probe[] = [
  { key: 'table-cell-nl', text: 'Artikel 1', where: '表セル(1,1)', expectExtractedNow: false, note: 'w:tbl内段落は body直下でないため未走査' },
  { key: 'table-cell-fr', text: 'Conditions générales', where: '表セル(1,2)', expectExtractedNow: false },
  { key: 'table-merged-de', text: 'Zusammenfassung der Bedingungen', where: '表 結合セル(gridSpan=2)', expectExtractedNow: false },
  { key: 'hyperlink-text', text: 'the signed contract', where: 'w:hyperlink 内 run', expectExtractedNow: false, note: 'w:hyperlink内runは段落直下でないため未取得→文が分断される' },
  { key: 'footnote-text', text: 'Vertrouwelijke voetnoot.', where: 'footnotes.xml', expectExtractedNow: false, note: 'footnotes.xml はパート列挙の対象外' },
  { key: 'tracked-ins-text', text: 'is strictly binding', where: 'w:ins 内 run', expectExtractedNow: false, note: 'w:ins内runは段落直下でないため未取得→文が分断される' },
  { key: 'bold-extracted', text: 'Payment is mandatory now.', where: '段内太字(直下run)', expectExtractedNow: true, note: '抽出はされるが writer collapse で "mandatory" の太字が失われる' },
];

// ---------------------------------------------------------------------------
// OOXML パート
// ---------------------------------------------------------------------------
const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
</Types>`;

const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rIdHl1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/contract" TargetMode="External"/>
</Relationships>`;

const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
  <w:docDefaults><w:rPrDefault><w:rPr><w:lang w:val="en-GB" w:eastAsia="ja-JP"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
  <w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>
</w:styles>`;

const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="${W}"><w:themeFontLang w:val="en-GB" w:eastAsia="ja-JP"/></w:settings>`;

const footnotes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="${W}">
  <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
  <w:footnote w:id="1"><w:p>${run('Vertrouwelijke voetnoot.', { lang: 'nl-NL' })}</w:p></w:footnote>
</w:footnotes>`;

// --- document.xml 本体（各構造）---
const tableXml = `<w:tbl>
  <w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr>
  <w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>
  <w:tr>
    <w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr><w:p>${run('Artikel 1', { lang: 'nl-NL' })}</w:p></w:tc>
    <w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/></w:tcPr><w:p>${run('Conditions générales', { lang: 'fr-FR' })}</w:p></w:tc>
  </w:tr>
  <w:tr>
    <w:tc><w:tcPr><w:tcW w:w="9000" w:type="dxa"/><w:gridSpan w:val="2"/></w:tcPr><w:p>${run('Zusammenfassung der Bedingungen', { lang: 'de-DE' })}</w:p></w:tc>
  </w:tr>
</w:tbl>`;

const hyperlinkP = `<w:p>${run('See ', { preserve: true })}<w:hyperlink r:id="rIdHl1">${run('the signed contract', { style: 'Hyperlink' })}</w:hyperlink>${run(' for the full terms.', { preserve: true })}</w:p>`;

const footnoteRefP = `<w:p>${run('Zie de bijgevoegde voorwaarden', { lang: 'nl-NL', preserve: true })}<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>${run('.', {})}</w:p>`;

const insP = `<w:p>${run('The deadline ', { preserve: true })}<w:ins w:id="1" w:author="reviewer" w:date="2026-01-01T00:00:00Z">${run('is strictly binding', {})}</w:ins>${run('.', {})}</w:p>`;

const boldP = `<w:p>${run('Payment is ', { preserve: true })}${run('mandatory', { bold: true })}${run(' now.', { preserve: true })}</w:p>`;

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}">
  <w:body>
    <w:p>${run('Work-document torture fixture', { lang: 'en-GB' })}</w:p>
    ${tableXml}
    ${hyperlinkP}
    ${footnoteRefP}
    ${insP}
    ${boldP}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417"/></w:sectPr>
  </w:body>
</w:document>`;

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const outDir = process.argv[2] ?? './out';
  const docxDir = join(outDir, 'docx');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rootRels);
  zip.file('word/_rels/document.xml.rels', documentRels);
  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', styles);
  zip.file('word/settings.xml', settings);
  zip.file('word/footnotes.xml', footnotes);

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const docxPath = join(docxDir, 'work-doc-torture.docx');
  const expectedPath = join(docxDir, 'work-doc-torture.expected.json');
  mkdirSync(dirname(docxPath), { recursive: true });
  writeFileSync(docxPath, buf);
  writeFileSync(
    expectedPath,
    `${JSON.stringify(
      {
        fixture: 'work-doc-torture.docx',
        description: '実務文書で頻出するが v0.1 reader が取りこぼす構造の集合。再帰走査の目標。',
        probes,
      },
      null,
      2,
    )}\n`,
  );
  console.error(`generated: ${docxPath} (${buf.length} bytes)`);
  console.error(`generated: ${expectedPath} (${probes.length} probes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
