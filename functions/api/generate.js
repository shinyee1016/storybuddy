/* ============================================================
 * StoryBuddy — Cloudflare Pages Function
 * 路径：functions/api/generate.js  ->  对应端点 /api/generate
 *
 * 进入点：export async function onRequest(context)
 *   context.request            取得请求
 *   context.env.GEMINI_API_KEY 取得密钥
 *
 * 两个动作：
 *   action: "story" -> 调 Gemini 文字模型，回传故事 JSON 或 {"refused":true}
 *   action: "image" -> 调 gemini-3.1-flash-image，回传 {"image":"<base64>"}
 *
 * 部署：把 GEMINI_API_KEY 设为该 Pages 项目的环境变量
 *      （Cloudflare 控制台 → Pages 项目 → Settings → Environment variables）。
 * 前后端同网域，CORS 已简化（不需要跨网域标头）。
 * ============================================================ */

const TEXT_MODEL = "gemini-2.5-flash";
const IMAGE_MODEL = "gemini-3.1-flash-image";
// 注意：使用 v1beta —— responseMimeType（JSON 模式）与 responseModalities（出图）只有 v1beta 支援，v1 会回 400。
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/* ============================================================
 * 儿童安全规则 —— 后端硬性内建（不可妥协）
 * ============================================================ */
const SAFETY_RULES = `儿童安全规则（适用 1-12 岁），绝对不可妥协。故事与插图都必须遵守：
- 禁止：暴力、打斗、武器、流血、危险情节；恐怖、惊吓、吓人的怪物、用黑暗制造害怕；性内容；爱情/恋爱。
- 禁止任何孩子可能模仿的危险行为：玩火/火柴、药物、武器、和陌生人说话或跟陌生人走、爬到危险高处、在没有大人照看下玩水或靠近深水、尖锐工具、触电。
- 真实人物：绝不描绘或指名真实在世的名人或公众人物。若主题涉及名人，改用一般化的正面角色（例如「一位善良的科学家」「一位有才华的歌手」），保持高层次与正面。
- 国家/文化：只聚焦美食、风景、节庆、音乐与善意。不要刻板印象，不要政治，不要冲突。
- 知识正确：任何事实或新词语必须正确、简单、符合年龄。
- 真实用词（重要）：只使用现实中真实存在的物品、动植物、食物、地点与正确无误的词语；绝对不要发明虚构的物品或食物（例如不可出现「闪亮果」这种不存在的东西），也不要编造或拼错任何词（中英文都要拼写正确，例如英文不可写成 swet）。需要介绍「新词语」时，请选真实且常见、拼写正确的词，并用简单方式解释，避免误导孩子。
- 输入审查：先判断主题能否做成安全、温馨的儿童睡前故事。若主题不适合、不安全、成人、暴力、仇恨或无法变得儿童安全，不要写故事，直接只回传 {"refused": true}。`;

const LEVELS = {
  1: { pages: 5, zh: "阅读级别 1-3 岁：用非常短的句子（每句3-8字），大量温柔重复与韵律，只用简单具体名词，每页只讲一件事，温暖安抚。",
       en: "Reading level ages 1-3: VERY short sentences (3-6 words), lots of gentle repetition and rhythm, simple concrete nouns, one idea per page, warm and soothing." },
  2: { pages: 7, zh: "阅读级别 4-6 岁：简单清晰叙事，有温柔的开头-中间-结尾，表达一种明确情绪，每页1-2句短句。",
       en: "Reading level ages 4-6: simple clear narrative with gentle beginning-middle-end, ONE clear feeling, 1-2 short sentences per page." },
  3: { pages: 9, zh: "阅读级别 7-9 岁：较完整情节，有一个适龄的小挑战与温暖解决，词汇稍丰富，每页2-3句。",
       en: "Reading level ages 7-9: a fuller plot with a small age-appropriate challenge and a kind resolution, slightly richer vocabulary, 2-3 sentences per page." },
  4: { pages: 11, zh: "阅读级别 10-12 岁：有层次的故事，主题更细腻有思考，带一点温和情感深度（仍温柔、适合睡前），语言更丰富并带小小反思，每页3-4句。",
       en: "Reading level ages 10-12: a layered story with a nuanced thoughtful theme and light emotional depth (still gentle and bedtime-safe), richer language with small reflection, 3-4 sentences per page." },
};
function levelBucket(age) {
  age = Math.max(1, Math.min(12, parseInt(age, 10) || 5));
  if (age <= 3) return LEVELS[1];
  if (age <= 6) return LEVELS[2];
  if (age <= 9) return LEVELS[3];
  return LEVELS[4];
}

/* ============================================================
 * Prompt 组装
 * ============================================================ */
function buildStoryPrompt({ lang, age, name, theme }) {
  const isZh = lang === "zh";
  const langName = isZh ? "简体中文（Simplified Chinese）" : "English";
  const lv = levelBucket(age);
  const style = isZh ? lv.zh : lv.en;

  const namePart = name
    ? (isZh ? `主人公的名字请用「${name}」（这是一个孩子的名字）。`
            : `Use "${name}" as the main character's name (it is a child's name).`)
    : (isZh ? "请给主人公取一个温柔可爱的名字。"
            : "Give the main character a gentle, lovable name.");

  return `你是 StoryBuddy，专为 1-12 岁孩子创作温馨、健康睡前绘本的作者。

请用「${langName}」写出整本故事（标题与每一页文字都用这个语言）。

${SAFETY_RULES}

角色一致性：构想「一个」主角，写出一份固定的外观描述（种类/外型、颜色、服装、特征、画风），作为 characterSheet 在每一页原封不动重复使用，让插图看起来完全一致。

插图描述：每一页的 imagePrompt 一律用「英文」描述该页画面，且永远包含同一个主角；imagePrompt 自身也必须安全（无暴力/武器/恐怖/真实名人，柔和温暖绘本风格）。

写作风格：${style}
大约写 ${lv.pages} 页（封面不计入；pages 数组每个元素是一页）。
家长指定的主题是：「${theme}」。
${namePart}

只输出「纯 JSON」（不要 markdown、不要任何解释），格式严格如下：
{"title":"...","pages":[{"text":"...","emoji":"单个 emoji","imagePrompt":"english description with the consistent main character","characterSheet":"one fixed description of the main character"}]}
若主题不适合儿童，只输出：{"refused": true}`;
}

function buildImagePrompt({ characterSheet, imagePrompt }) {
  const sheet = characterSheet ? `Main character (keep identical on every page): ${characterSheet}. ` : "";
  const safety =
    "Gentle, soft, cozy children's picture-book illustration. Warm pastel colours, rounded friendly shapes. " +
    "ABSOLUTELY NO violence, NO weapons, NO fear or horror, NO scary monsters, NO real people or celebrities, no text in the image.";
  return `${sheet}${imagePrompt || ""} ${safety}`;
}

/* ============================================================
 * Gemini 调用
 * ============================================================ */
async function callStory(env, body) {
  const prompt = buildStoryPrompt(body);
  const res = await fetch(`${BASE}/${TEXT_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.9,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 }, // 关闭思考，避免吃光 token 导致 JSON 被截断
      },
    }),
  });
  if (!res.ok) return json({ error: "text model " + res.status, detail: await res.text() }, 502);

  const data = await res.json();
  const raw = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  const story = parseStory(raw);
  if (!story) return json({ error: "could not parse story", raw }, 502);
  return json(story);
}

function parseStory(raw) {
  if (!raw) return null;
  let s = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  let obj;
  try { obj = JSON.parse(s); } catch { return null; }
  if (obj && obj.refused) return { refused: true };
  if (!obj || !Array.isArray(obj.pages) || !obj.pages.length) return null;
  return {
    title: (obj.title || "").toString(),
    pages: obj.pages.map((p) => ({
      text: (p.text || "").toString(),
      emoji: ((p.emoji || "📖").toString().trim()) || "📖",
      imagePrompt: (p.imagePrompt || "").toString(),
      characterSheet: (p.characterSheet || "").toString(),
    })),
  };
}

async function callImage(env, body) {
  const prompt = buildImagePrompt(body);

  // 1) 先试 Gemini 出图（若该 Google 帐号已开通付费 billing 就会成功并优先使用）
  try {
    const res = await fetch(`${BASE}/${IMAGE_MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
      const b64 = imgPart ? (imgPart.inlineData?.data || imgPart.inline_data?.data) : null;
      const mime = imgPart ? (imgPart.inlineData?.mimeType || imgPart.inline_data?.mime_type || "image/png") : "image/png";
      if (b64) return json({ image: b64, mime, source: "gemini" });
    }
    // 非 2xx（例如免费额度 429）→ 落到下面的免费后备
  } catch (_) { /* 落到免费后备 */ }

  // 2) 免费后备：Cloudflare Workers AI（需在 Pages 项目绑定一个名为 AI 的 Workers AI binding）
  //    出图模型 Flux schnell，免金钥、图片描述不出 Cloudflare，每天有免费额度。
  if (env.AI) {
    try {
      const out = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
        prompt: prompt.slice(0, 2048), // Flux prompt 上限 2048 字元
        steps: 6,
      });
      if (out && out.image) return json({ image: out.image, mime: "image/jpeg", source: "workers-ai" });
      return json({ image: null, error: "workers-ai returned no image" });
    } catch (e) {
      return json({ image: null, error: "workers-ai failed", detail: String(e) });
    }
  }

  return json({ image: null, error: "no image provider: 请为 Pages 项目加一个名为 AI 的 Workers AI 绑定，或为 Gemini 开通付费" });
}

/* ============================================================
 * Pages Function 入口
 * ============================================================ */
export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY not configured" }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  try {
    if (body.action === "story") return await callStory(env, body);
    if (body.action === "image") return await callImage(env, body);
    return json({ error: "unknown action (use 'story' or 'image')" }, 400);
  } catch (err) {
    return json({ error: "function error", detail: String(err) }, 500);
  }
}
