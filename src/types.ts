/**
 * DTIR — Document Translation Intermediate Representation
 *
 * reader → language-resolve → translate(NLP/LLM) → xcomet → writer の
 * 全ステージを素通りする中間表現（セグメント表）。
 *
 * 設計原則:
 *  1. フォーマット非依存（docx / pdf 共通）
 *  2. 翻訳エンジン非依存（DeepL / LLM 差し替え可）
 *  3. ロスレス: writer は元ファイルを基板に `id` でパッチ。書式XML・画像・
 *     sectPr・フィールド命令は IR に乗らない＝原理的に崩れない。
 *  4. 言語は値ではなく {value, confidence, source} で持つ（タグは事実でなくヒント）。
 *  5. 追記式: 各ステージは自分の列だけ埋め、先行ステージの値を破壊しない
 *     （language/translatable の精緻化のみ lang-resolve に許可）。
 *
 * @see ./README.md（設計ドキュメント）
 * @see ./schema/dtir-0.1.schema.json（JSON Schema 2020-12）
 */

/** BCP 47 言語タグ（例: "en-GB", "fr-CA", "ja-JP"）。null は未確定。 */
export type Bcp47 = string;

export const DTIR_VERSION = '0.1' as const;

/** 対応フォーマット。writer/reader 実装ごとに増える。 */
export type DocFormat = 'docx' | 'pdf';

/** 言語情報の出所。信頼度の根拠になる。 */
export type LanguageSource =
  | 'tag' //      docx <w:lang w:val> / pdf 構造要素 /Lang から取得
  | 'detect' //   ローカル言語判定（franc/cld3/fastText 等）
  | 'inherit' //  短すぎる等で周辺・親から継承
  | 'default' //  コンテナ既定（docx settings.xml / pdf catalog /Lang）
  | 'declared'; // ジョブ側で人手指定

/** 翻訳対象外にする理由。null = 翻訳対象。 */
export type SkipReason =
  | 'field' //              目次・相互参照・ページ番号等のフィールド命令/キャッシュ
  | 'non-linguistic-zxx' // BCP47 "zxx"（非言語コンテンツ）
  | 'numeric' //            数値・記号のみ
  | 'locked' //             明示的に翻訳禁止指定
  | 'empty' //              空テキスト
  | null;

/** セグメントの構造的役割。短文継承や文脈付き翻訳のヒントになる。 */
export type SegmentRole =
  | 'heading'
  | 'body'
  | 'caption'
  | 'footnote'
  | 'endnote'
  | 'table-cell'
  | 'header'
  | 'footer'
  | 'toc'
  | 'list-item'
  | 'textbox'
  | 'other';

/** エラー重大度（xCOMET の MQM 準拠）。 */
export type ErrorSeverity = 'minor' | 'major' | 'critical';

/**
 * writer が「どの <w:t> / どのマーク付きコンテンツ」に戻すかを解決するロケータ。
 * reader が書き、writer が読む。
 *
 * **不透明性の範囲は中間ステージ（言語解決/翻訳/xcomet）に限る。**
 * reader と writer は別 MCP・別プロセスなので、`ref` の形には**完全合意が必要**。
 * その形は generic object のままトップ schema に置くが、サブスキーマは
 * `ooxml-spec` / `pdf-spec` が versioned に規定する規範契約とする。
 * 下記の docx ref / pdf ref は**規範例**。
 */
export interface IRAnchor {
  format: DocFormat;
  /**
   * フォーマット固有の参照（spec MCP が規定）。
   * path は part の documentElement 起点で `tag[idx]`（同名兄弟内1始まり）を辿る構造パス。
   * 表セルや脚注などの入れ子も同形式で表す（reader が書き、writer の汎用ナビゲータが解決）。
   * - docx 規範例: { part:'word/document.xml', path:'/w:body[1]/w:p[12]', runIds:['r0','r1'] }
   * - docx 入れ子例: path:'/w:body[1]/w:tbl[1]/w:tr[2]/w:tc[1]/w:p[1]'（表セル）、'/w:footnote[3]/w:p[1]'（脚注）
   * - pdf 規範例:  { page:4, mcid:17, structRef:'...', bbox:[x0,y0,x1,y1] }
   */
  ref: Record<string, unknown>;
}

export interface LanguageCandidate {
  value: Bcp47;
  /** 0–1。判定器の確信度。 */
  confidence: number;
}

export interface SegmentLanguage {
  /** 確定言語。未確定なら null。 */
  value: Bcp47 | null;
  /** 0–1。 */
  confidence: number;
  source: LanguageSource;
  /** 判定器が返す候補分布（任意）。多言語スコア算出に使う。 */
  candidates?: LanguageCandidate[];
}

/**
 * source 内の文字範囲が、元ファイルのどのランに対応していたか（ラン分断問題の解）。
 * オフセットは **UTF-16 コードユニット**・**半開区間 [start, end)**・0 始まり
 * （JS の `String.prototype.slice` と一致。`quality.errors` の start/end と同一規約）。
 */
export interface SegmentRun {
  /** 元ランの識別子。`anchor.ref` のラン参照と対応する。 */
  runId: string;
  /** 開始オフセット（含む）。 */
  start: number;
  /** 終了オフセット（含まない）。 */
  end: number;
}

export interface SegmentText {
  /** 翻訳対象の原文（セグメント内の複数ランを連結したもの）。 */
  source: string;
  /**
   * セグメントが複数ラン/書式にまたがるか。true の場合 writer は
   * 訳文をランへ再配分する必要がある（ラン分断問題）。
   *
   * v0.1 の writer 既定は「collapse」: 段内書式を捨て、優勢ラン（先頭）の
   * rPr を訳文段落全体に適用する（README §3 不変条件参照）。
   */
  hasInlineFormatting: boolean;
  /**
   * 任意・前方互換フィールド。各ランの source 内オフセットを reader が埋めると、
   * v0.2 以降の tag-aware writer がスキーマを壊さず訳文をランへ再配分できる。
   * v0.1 の writer はこれを無視（collapse）してよい。
   */
  runs?: SegmentRun[];
  /** xml:space 相当。前後空白の保持指定。 */
  space: 'default' | 'preserve';
}

export interface SegmentContext {
  /** 直前セグメント id（文脈付き翻訳・短文継承用）。 */
  prev: string | null;
  /** 直後セグメント id。 */
  next: string | null;
  /** 親セグメント id（リスト・表など）。 */
  parent: string | null;
}

/** translate ステージが埋める。未翻訳なら null。 */
export interface SegmentTranslation {
  text: string;
  engine: string; // 'deepl' | 'llm:gpt-4o' など
  /** 翻訳時に実際に使った source_lang（null = エンジン自動判定）。 */
  sourceLangUsed: Bcp47 | null;
  targetLang: Bcp47;
  /** ISO 8601。 */
  at: string;
  /**
   * 任意・前方互換フィールド（v0.2 脱collapse）。`anchor.ref.runIds` の順に整列した
   * **ラン別の訳文**。translate がインラインマーカー翻訳で各ランの訳を復元できたときだけ埋める。
   * 連結（`runTexts.join('')`）は `text` に一致する。tag-aware writer はこれがあり、かつ
   * 段落のテキストラン数と一致するとき各ランの rPr（太字・色・リンク）を保ったまま訳を分配する。
   * 無い／数が合わないときは writer は collapse にフォールバック（fail-safe）。
   */
  runTexts?: string[];
}

export interface QualityError {
  text: string;
  start: number;
  end: number;
  severity: ErrorSeverity;
  suggestion?: string | null;
}

/** xcomet ステージが埋める。未評価なら null。 */
export interface SegmentQuality {
  /** 0–1。高いほど良い。 */
  score: number;
  hasCritical: boolean;
  errors: QualityError[];
}

export interface IRSegment {
  /**
   * 安定アンカーキー。writer のパッチキー。
   * **`anchor` から決定的に導出**し（docx: part＋XPath のハッシュ、pdf: `page+mcid`）、
   * **同一入力で reader を再実行しても不変**であること。
   * 順序依存の連番は禁止（段落が1つ増えると全 id がズレ、増分翻訳・キャッシュが破綻する）。
   * 全ステージで不変。
   */
  id: string;
  /** 読み順インデックス。 */
  order: number;
  anchor: IRAnchor;
  role: SegmentRole;
  text: SegmentText;
  language: SegmentLanguage;
  /** 翻訳対象か。false の原文は writer が一切触らない。 */
  translatable: boolean;
  skipReason: SkipReason;
  /**
   * バッチ集約キー。通常は確定 source_lang。lang-resolve が埋める。
   * 同一 group をまとめて 1 回の翻訳呼び出しに集約しコストを下げる。
   */
  group: string | null;
  context: SegmentContext;
  translation: SegmentTranslation | null;
  quality: SegmentQuality | null;
}

export interface DocumentLanguage {
  /** コンテナ既定言語（docx settings.xml / pdf catalog /Lang）。 */
  default: {
    value: Bcp47 | null;
    source: 'container-default' | 'none';
  };
  /** ジョブの翻訳先言語。 */
  target: Bcp47 | null;
  multilingual: {
    isMultilingual: boolean;
    /** 0–1。多言語度スコア（タグ多様性・スクリプト多様性・判定分布から算出）。 */
    score: number;
    method:
      | 'declared' //          人手宣言
      | 'tag-diversity' //     <w:lang> / /Lang の値の多様性
      | 'script-diversity' //  Unicode スクリプト混在
      | 'whole-doc-detect' //  全文1回判定
      | 'per-segment'; //      段落ごと判定
    /** 観測された原文言語の集合。 */
    languagesPresent: Bcp47[];
  };
}

export interface DocumentSource {
  format: DocFormat;
  fileName: string;
  /** 基板ファイルの同一性検証用（writer がパッチ対象を取り違えないため）。 */
  sha256: string;
  byteSize: number;
}

export interface DocumentStats {
  segmentCount: number;
  translatableCount: number;
  /** バッチ言語グループ数。 */
  groupCount: number;
}

export interface IRDocument {
  irVersion: typeof DTIR_VERSION;
  source: DocumentSource;
  language: DocumentLanguage;
  segments: IRSegment[];
  stats: DocumentStats;
  /** フォーマット固有の不透明拡張バッグ（任意）。 */
  extensions?: Record<string, unknown>;
}
