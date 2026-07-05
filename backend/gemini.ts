import type { ArticleInput } from "./article";

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";
export const MODEL = "gemini-3.1-flash-lite";

export class GeminiQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiQuotaError";
  }
}

interface GeminiResponse {
  candidates: Array<{
    content: { parts: Array<{ text: string }> };
    finishReason: string;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export interface SummaryResult {
  summaryHtml: string;
  inputTokens: number;
  outputTokens: number;
}

export function stripCodeFence(text: string): string {
  const match = text.match(/^```[\w-]*[ \t]*\n([\s\S]*?)\n?```[ \t]*$/);
  return match ? match[1].trim() : text;
}

function articleContentForPrompt(article: ArticleInput): string {
  if (article.status === "no_url") {
    return "（この記事にはURLがなく本文は存在しません。HNコメントのみを基に要約してください。）";
  }
  if (article.status === "fetch_skipped") {
    return "（このサイトはアクセス制限が厳しいため本文の取得をスキップしています。HNコメントを中心に要約してください。）";
  }
  if (article.status === "fetch_failed") {
    return "（本文の取得に失敗しました。JavaScriptレンダリングやCloudflare等のアクセス制限が原因と考えられます。HNコメントを中心に要約してください。）";
  }
  return article.content;
}

export async function generateSummary(
  apiKey: string,
  itemId: number,
  title: string,
  articleUrl: string,
  article: ArticleInput,
  comments: string[],
): Promise<SummaryResult> {
  const hnUrl = `https://news.ycombinator.com/item?id=${itemId}`;
  const commentsText =
    comments.length > 0 ? comments.join("\n\n") : "（コメントなし）";

  const prompt = `以下のHacker News記事とHNコメントを日本語で要約。

## 記事タイトル
${title}

## 元記事URL
${articleUrl}

## 元記事内容
<blockquote>
${articleContentForPrompt(article)}
</blockquote>

## HNコメント（上位${comments.length}件）
<blockquote>
${commentsText}
</blockquote>

## 出力指示
以下のコードフェンス **内側のHTML形式のみ** を出力。出力結果をそのままHTMLとして扱うので外側のコードフェンス記述は必ず除外する。
{{}}でくくくったところは命令でありプレースホルダ。適宜HTMLエスケープ適用。体言止めを優先。構造体(箇条書き、表)を活用し情報密度を最大化。

\`\`\`html
<h2>{{元記事の日本語訳タイトル}}</h2>
<ul><li><a href="${articleUrl}">${articleUrl}</a></li></ul>
<p>{{記事の内容・背景・意義を3〜5文で簡潔に説明。HNコメントからの補完は厳禁。HNコメントからの内容の混合は厳禁。取得失敗、取得スキップ、内容が不十分の時にはその旨のみを記載。}}</p>

<h2>HNコミュニティの反応</h2>
<ul><li><a href="${hnUrl}">${hnUrl}</a></li></ul>
<p>{{HNコメントの総括。記事の文体・AI生成の疑い・paywall・タイトルの釣りなど、記事の内容そのものではないメタな指摘がコメント中に実在する場合のみ、ここで1文に集約しコメント全体に占めるおおよその割合を添える。該当コメントが無ければメタな指摘には一切言及しない。}}</p>

{{以下では主要な観点・議論の軸ごとにまとめる。観点は記事の内容に関する議論のみで構成し、メタな指摘は観点として立てない。内容に関する実質的な議論が乏しい場合は観点を無理に増やさず、その旨を総括に記載。返信の多いコメントがリンクを含んでいるときは必ずそのリンクを含めて出力。投稿に含まれていないURLをリンクすることは厳禁。}}

<h3>{{主要な観点・議論の軸}}</h3>
<ul>
  <li><strong>{{観点ラベル}}</strong>: {{観点の説明}}</li>
  {{コメント中に実在する観点の数だけ <li> を繰り返す。1つでもよい}}
</ul>

{{この h3 ブロックを、コメント中に実在する議論の軸の数だけ繰り返す。軸が1つしかなければ1つだけ出力し、埋め草のために軸や観点を創作することは厳禁。}}
\`\`\``;

  const resp = await fetch(
    `${GEMINI_API}/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
      }),
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    if (resp.status === 429) {
      throw new GeminiQuotaError(
        `Gemini quota exceeded: ${resp.status} ${body}`,
      );
    }
    throw new Error(`Gemini API error: ${resp.status} ${body}`);
  }

  const data = await resp.json<GeminiResponse>();
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason !== "STOP") {
    throw new Error(
      `Gemini output incomplete or blocked: finishReason=${candidate?.finishReason ?? "no candidate"}`,
    );
  }
  const text = candidate.content?.parts?.map((p) => p.text).join("") ?? "";
  const summaryHtml = stripCodeFence(text.trim());
  if (summaryHtml === "") {
    throw new Error("Gemini returned an empty summary");
  }
  return {
    summaryHtml,
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}
