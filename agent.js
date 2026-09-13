// agent.js — 最小 Function Calling Agent（零框架，qwen-plus OpenAI 兼容接口）
// 参考设计：QwenLM/Qwen-Agent（https://github.com/QwenLM/Qwen-Agent）
//
// Agent 的本质是一个循环（agent loop）：
//   用户提问 → 模型判断「直接回答 or 调用工具」→ 调用工具 → 结果喂回模型 → 直到给出最终回答
// 本文件就是这个循环 + 命令行交互，总共不到 120 行。

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { TOOLS, executeTool } from './tools.js';

// ---------- 0. 读取 .env（零依赖，不引 dotenv） ----------
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const API_KEY = process.env.DASHSCOPE_API_KEY;
if (!API_KEY) {
  console.error('❌ 未找到 DASHSCOPE_API_KEY：请把 .env.example 复制为 .env 并填入你的 Key');
  process.exit(1);
}

// 阿里云百炼（DashScope）OpenAI 兼容接口
const BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const MODEL = 'qwen-plus';
const MAX_TOOL_ROUNDS = 5; // 防止模型反复调工具停不下来

// ---------- 1. 调用大模型 ----------
async function chat(messages) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,          // 把工具清单告诉模型
      tool_choice: 'auto',   // 模型自主决定是否用工具（百炼只支持 auto/none）
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices[0].message;
}

// ---------- 2. Agent Loop：核心就在这 20 行 ----------
async function runAgent(userInput, history) {
  history.push({ role: 'user', content: userInput });

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    const assistantMsg = await chat(history);
    history.push(assistantMsg);

    // 情况 A：模型直接给出文本回答 → 循环结束
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      return assistantMsg.content;
    }

    // 情况 B：模型要求调用工具（可能一次要多个）
    for (const call of assistantMsg.tool_calls) {
      const name = call.function.name;
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* 参数不合法按空处理 */ }
      console.log(`  🔧 [工具调用] ${name}(${JSON.stringify(args)})`);
      const result = await executeTool(name, args); // 真正执行工具
      console.log(`  ✅ [工具结果] ${String(result).slice(0, 100)}${String(result).length > 100 ? '…' : ''}`);
      // 关键：工具结果以 role:'tool' 消息回传，tool_call_id 必须与请求一一对应
      history.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }
    // 回到循环顶部：带着工具结果再问模型，直到它给出最终回答
  }
  return '（达到最大工具调用轮数，已停止。请缩小问题再试。）';
}

// ---------- 3. 命令行交互 ----------
async function main() {
  console.log('=== 最小 Function Calling Agent（qwen-plus，零框架） ===');
  console.log('试试问我：现在几点？/ 345*23等于多少？/ 深圳今天天气？/ 年假怎么请？/ 对比北京和深圳的温度 / 退出');
  const history = [
    { role: 'system', content: '你是一个能使用工具的智能助手。回答简洁准确，事实性问题优先使用工具获取数据，不要凭记忆编造。' },
  ];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write('\n你 > ');
  for await (const line of rl) { // 事件驱动读行：交互式逐行响应，管道里缓冲的行也不会丢
    const input = line.trim();
    if (!input) { process.stdout.write('\n你 > '); continue; }
    if (input === '退出' || input === 'exit') break;
    try {
      const answer = await runAgent(input, history);
      console.log(`\n助手 > ${answer}`);
    } catch (e) {
      console.error(`\n[出错] ${e.message}`);
    }
    process.stdout.write('\n你 > ');
  }
  rl.close();
}
main();
