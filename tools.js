// tools.js — 工具定义（给模型看的 schema）+ 工具实现（真正干活的函数）
// 关键认知：每个工具的 description 写得越清楚，模型选工具越准——这是 Function Calling 的第一课。

import fs from 'node:fs';
import path from 'node:path';

// ---------- 工具 schema（OpenAI 格式，模型靠它决定何时调用、传什么参数） ----------
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前的日期和时间。当用户想知道现在几点、今天日期时调用。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: '计算四则运算表达式的值。当用户问数学计算结果时调用。',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: '四则运算表达式，如 345*23 或 (12+8)/4' },
        },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_weather',
      description: '查询指定城市的实时天气（温度/湿度/风速/天气现象）。当用户询问某地天气时调用。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名，如 深圳、北京、Shanghai' },
        },
        required: ['city'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge_base',
      description: '在公司制度知识库中检索。当用户询问公司规章、考勤、请假、报销、远程办公等制度问题时调用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词，如 年假 报销' },
        },
        required: ['query'],
      },
    },
  },
];

// ---------- 计算器：白名单校验 + 受控求值（不用裸 eval，防代码注入） ----------
function safeCalc(expr) {
  if (!/^[\d\s+\-*/().%]+$/.test(String(expr))) throw new Error('表达式含非法字符');
  const val = Function(`"use strict";return (${expr})`)();
  if (typeof val !== 'number' || !isFinite(val)) throw new Error('计算结果无效');
  return val;
}

// ---------- 天气：Open-Meteo 免费真实 API（无需 key） ----------
const WMO = { 0: '晴', 1: '大致晴', 2: '局部多云', 3: '阴', 45: '雾', 48: '雾凇', 51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 80: '阵雨', 81: '强阵雨', 82: '暴雨', 95: '雷暴', 96: '雷暴伴冰雹' };

async function getWeather(city) {
  // 第一步：城市名 → 经纬度（地理编码）
  const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`);
  const geoData = await geoRes.json();
  if (!geoData.results || geoData.results.length === 0) return `未找到城市：${city}`;
  const { latitude, longitude, name } = geoData.results[0];
  // 第二步：经纬度 → 实时天气
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=Asia%2FShanghai`);
  const data = await res.json();
  const c = data.current;
  return `${name} 当前天气：${WMO[c.weather_code] || '未知'}，气温 ${c.temperature_2m}°C，湿度 ${c.relative_humidity_2m}%，风速 ${c.wind_speed_10m}km/h（观测时间 ${c.time}）`;
}

// ---------- 知识库检索：本地 JSON 关键词计分（RAG 检索环节的最小演示版） ----------
function searchKB(query) {
  const kbPath = path.join(process.cwd(), 'knowledge.json');
  const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  const terms = String(query).toLowerCase().split(/[\s,，。?？!！]+/).filter(Boolean);
  const scored = kb
    .map(item => {
      const title = item.title.toLowerCase();
      const hay = (title + ' ' + item.keywords.join(' ') + ' ' + item.content).toLowerCase();
      // 简单计分：标题命中权重 2，其他位置命中权重 1
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? (title.includes(t) ? 2 : 1) : 0), 0);
      return { item, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3); // 只取 Top3，控制喂给模型的上下文长度
  if (scored.length === 0) return `知识库中没有找到与「${query}」相关的制度。`;
  return scored.map(x => `【${x.item.title}】${x.item.content}`).join('\n---\n');
}

// ---------- 工具路由：模型点名哪个工具，就执行哪个 ----------
export async function executeTool(name, args) {
  try {
    switch (name) {
      case 'get_current_time':
        return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
      case 'calculate':
        return String(safeCalc(args.expression));
      case 'get_current_weather':
        return await getWeather(args.city);
      case 'search_knowledge_base':
        return searchKB(args.query);
      default:
        return `未知工具：${name}`;
    }
  } catch (e) {
    // 设计要点：工具失败不向上抛，把失败信息回传给模型，让它自己决定重试/换工具/向用户澄清
    return `工具执行失败：${e.message}`;
  }
}
