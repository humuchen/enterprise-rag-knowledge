// src/generator.ts
import axios from 'axios';
import { config } from './config';
import { SearchResult } from './retriever';

export interface Citation {
  chunkId: string;
  source: string;
  content: string;
  score: number;
}

export interface GenerationResult {
  answer: string;
  citations: Citation[];
  model: string;
  usage?: Record<string, number>;
}

function buildMessages(
  query: string,
  results: SearchResult[],
  history: Array<{ role: string; content: string }> = [],
): Array<{ role: string; content: string }> {
  const contextParts = results.map((r, i) =>
    `[${i + 1}] (来源: ${r.source} | 相关度: ${r.score.toFixed(3)})\n${r.content}`,
  );

  const contextStr = contextParts.join('\n\n');
  const historyStr = history.length
    ? history.map(h => `${h.role}: ${h.content}`).join('\n')
    : '（无）';

  const systemPrompt = `
你是一个企业知识库助手。请根据提供的文档内容回答用户问题。

要求：
1. 只能使用提供的文档内容回答；如果无法确定，请说"抱歉，我在知识库中没有找到相关信息。"
2. 每个引用的内容请用 【来源N】 格式标注，放在相关段落末尾
3. 回答应简洁、专业、准确
4. 如果文档存在矛盾，请指出矛盾点并说明优先参考的依据

当前检索到的文档（共 ${results.length} 条）：
---
${contextStr}
---
历史对话：
${historyStr}

当前问题：${query}
`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: query },
  ];
}

export class LLMClient {
  private baseUrl = config.LLM_BASE_URL;
  private modelName = config.LLM_MODEL_NAME;

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.LLM_API_KEY) {
      headers.Authorization = `Bearer ${config.LLM_API_KEY}`;
    }
    return headers;
  }

  async generate(
    query: string,
    results: SearchResult[],
    history: Array<{ role: string; content: string }> = [],
    temperature = 0.1,
    maxTokens = 2048,
  ): Promise<GenerationResult> {
    const messages = buildMessages(query, results, history);

    const res = await axios.post(
      `${this.baseUrl}/chat/completions`,
      {
        model: this.modelName,
        messages,
        temperature,
        max_tokens: maxTokens,
      },
      {
        headers: this.headers(),
        timeout: 60000,
      },
    );

    const data = res.data as {
      choices: Array<{ message: { content: string } }>;
      usage?: Record<string, number>;
    };

    const answer = data.choices[0].message.content;

    const citations: Citation[] = results.map(r => ({
      chunkId: r.chunkId,
      source: r.source,
      content: r.content.slice(0, 200),
      score: r.score,
    }));

    return {
      answer,
      citations,
      model: this.modelName,
      usage: data.usage,
    };
  }

  async *stream(
    query: string,
    results: SearchResult[],
    history: Array<{ role: string; content: string }> = [],
    temperature = 0.1,
    maxTokens = 2048,
    shouldAbort?: () => boolean,
  ): AsyncGenerator<string> {
    const messages = buildMessages(query, results, history);

    const res = await axios.post(
      `${this.baseUrl}/chat/completions`,
      {
        model: this.modelName,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: true,
      },
      {
        headers: this.headers(),
        responseType: 'stream',
        timeout: 60000,
      },
    );

    const stream = res.data as NodeJS.ReadableStream & { destroy?: () => void };
    let buffer = '';

    for await (const chunk of stream) {
      if (shouldAbort?.()) {
        stream.destroy?.();
        return;
      }
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') return;
          try {
            const data = JSON.parse(jsonStr) as {
              choices: Array<{ delta: { content: string } }>;
            };
            const delta = data.choices[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await axios.get(`${this.baseUrl}/models`, {
        timeout: 5000,
        headers: config.LLM_API_KEY ? { Authorization: `Bearer ${config.LLM_API_KEY}` } : {},
      });
      return true;
    } catch {
      return false;
    }
  }
}
