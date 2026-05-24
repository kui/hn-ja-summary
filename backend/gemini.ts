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

function articleContentForPrompt(article: ArticleInput): string {
  if (article.status === "no_url") {
    return "（この記事にはURLがなく本文は存在しません。HNコメントのみを基に要約してください。）";
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
以下のHTML形式のみで出力する。マークダウンのコードブロック不要。{{}}でくくくったところは命令でありプレースホルダ。適宜HTMLエスケープをすることを忘れないこと。
\`\`\`html
<h2>{{記事タイトル（日本語）}}</h2>
<ul><li><a href="${articleUrl}">${articleUrl}</a></li></ul>
<p>{{記事の内容・背景・意義を3〜5文で簡潔に説明。必要に応じてtable要素やol,ul要素など構造化などを用いる。}}</p>

<h2>HNコミュニティの反応</h2>
<ul><li><a href="${hnUrl}">${hnUrl}</a></li></ul>
<p>{{HNコメントの総括}}</p>

{{以下では主要な観点・議論の軸をまとめてその数だけ繰り返す、返信の多いリンク付きコメントのリンクは必ず取り上げる}}

<h3>{{主要な観点・議論の軸1}}</h3>
<ul>
  <li><strong>{{観点ラベル1-1}}</strong>: {{観点の説明1-1}}</li>
  <li><strong>{{観点ラベル1-2}}</strong>: {{観点の説明1-2}}</li>
  <li><strong>{{観点ラベル1-3}}</strong>: {{観点の説明1-3}}</li>
  {{必要に応じて追加の「観点」を繰り返す}}
</ul>

<h3>{{主要な観点・議論の軸2}}</h3>
<ul>
  <li><strong>{{観点ラベル2-1}}</strong>: {{観点の説明2-1}}</li>
  <li><strong>{{観点ラベル2-2}}</strong>: {{観点の説明2-2}}</li>
  <li><strong>{{観点ラベル2-3}}</strong>: {{観点の説明2-3}}</li>
  {{必要に応じて追加の「観点」を繰り返す}}
</ul>

{{「主要な観点・議論の軸」の数だけ繰り返す}}
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

  const data = (await resp.json()) as GeminiResponse;
  return {
    summaryHtml: (data.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim(),
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}
