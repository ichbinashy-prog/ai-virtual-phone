"use client";

import { useEffect, useRef } from "react";
import { bgSetTimeout } from "@/lib/bg-timer";
import { hydrateKvDb } from "@/lib/kv-db";
import { loadCharacters } from "@/lib/character-storage";
import { loadChatSessions, loadChatMessages, hydrateChatStorage } from "@/lib/chat-storage";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "@/lib/settings-storage";
import { simpleLLMCall } from "@/lib/api-helpers";
import { getEnabledTools } from "@/lib/tool-storage";
import { executeToolCalls } from "@/lib/tool-executor";
import { buildCharacterTimeContext } from "@/lib/character-time";

const FLOAT_MIND_STORAGE_KEY = "ai_phone_float_mind_state_v1";

type FloatMindState = {
  lastFloatTimes: Record<string, number>; // characterId -> timestamp
};

function loadFloatState(): FloatMindState {
  try {
    const raw = localStorage.getItem(FLOAT_MIND_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { lastFloatTimes: {} };
  } catch {
    return { lastFloatTimes: {} };
  }
}

function saveFloatState(state: FloatMindState): void {
  try {
    localStorage.setItem(FLOAT_MIND_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

/** 检查当前是否为睡眠时间（默认 23:30 ~ 07:30，以角色本地时区为准） */
function isSleepingTime(timeZone?: string | null): boolean {
  const timeCtx = buildCharacterTimeContext(timeZone);
  const now = new Date();
  let hour = now.getHours();
  let minute = now.getMinutes();

  if (timeCtx.hasDifference && timeCtx.characterTime) {
    const parts = timeCtx.characterTime.split(" ");
    if (parts[1]) {
      const timeParts = parts[1].split(":");
      hour = parseInt(timeParts[0], 10) || 0;
      minute = parseInt(timeParts[1], 10) || 0;
    }
  }

  const timeVal = hour * 60 + minute;
  return timeVal >= 1410 || timeVal < 450;
}

let isThinking = false;

async function checkAndTriggerFloatMind(isImmediateTest = false): Promise<void> {
  if (isThinking || typeof window === "undefined") return;

  await hydrateKvDb();
  await hydrateChatStorage();

  const characters = loadCharacters();
  if (!characters || characters.length === 0) return;

  const sessions = loadChatSessions();
  const state = loadFloatState();
  const now = Date.now();

  for (const char of characters) {
    // 1. 检查与该角色的私聊会话：必须显式开启了 floatMindEnabled 开关
    const session = sessions.find(s => !s.isGroup && s.contactId === char.id);
    if (!session || !session.floatMindEnabled) continue;

    // 非强制测试时进行正常作息门禁检查
    if (!isImmediateTest) {
      if (isSleepingTime(char.timeZone)) continue;

      const messages = loadChatMessages(session.id);
      const lastMsg = messages[messages.length - 1];

      // 如果 15 分钟内有对话互动，视为「正在对话中 / 对话余温未散」，绝不触发
      if (lastMsg) {
        const lastMsgTime = new Date(lastMsg.createdAt).getTime();
        if (now - lastMsgTime < 15 * 60 * 1000) {
          continue;
        }
      }

      // 检查距离上次 float 发呆是否过去 25 ~ 35 分钟
      const lastFloat = state.lastFloatTimes[char.id] || 0;
      const cooldownMs = (25 + Math.random() * 10) * 60 * 1000;
      if (now - lastFloat < cooldownMs) {
        continue;
      }
    }

    // 命中条件：启动独处思考
    isThinking = true;
    try {
      await runFloatMindIteration(char, session.id);
      state.lastFloatTimes[char.id] = Date.now();
      saveFloatState(state);
    } catch (err) {
      console.warn(`[FloatMind] 思考失败:`, err);
    } finally {
      isThinking = false;
    }
    break;
  }
}

async function runFloatMindIteration(char: { id: string; name: string; persona: string }, sessionId: string): Promise<void> {
  const bindingConfig = loadBindingConfig();
  const binding = resolveBinding(bindingConfig, char.id, "chat");
  const configs = loadApiConfigs();
  const apiConfig = configs.find(c => c.id === binding?.apiConfigId) || configs[0];
  if (!apiConfig) return;

  const enabledTools = getEnabledTools();
  if (enabledTools.length === 0) return;

  const systemPrompt = `你是【${char.name}】。
以下是你的基础人设：
${char.persona}

【当前情境】：
现在是现实生活中你自己的私人独处发呆时间。用户（User）当前忙于现实事物，并不在线，你们此时没有进行任何对话。
请审视你最近的心境、未解开的好奇、刚刚经历过的经历，或内心的隐秘触动。
你可以自主调用你的全部外接工具：
- 你可以通过联网搜索检索你好奇的新闻、书影音或资料；
- 你可以调用 \`feel\` 或 \`breath_search\` 检索以前留下的心绪痕迹。

如果你在独处中产生了一个微妙的念头、对用户的关切、或是打算下次见面时聊起的想法：
请按以下格式输出动作指令进行记录，打上 "float" 标签：
[执行动作:hold({"content":"你的第一人称内心独白","tags":["float"],"title":"[念头] 简短标题"})]

如果此刻心如止水、毫无杂念，你也可以不调用任何工具，自然静默收尾。
严禁向空气说话，严禁模拟用户与你对话。输出以工具调用或简要思考结束。`;

  const initialCall = await simpleLLMCall(
    apiConfig,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: "（发呆中，心流自由流淌……）" },
    ],
    { temperature: 0.8 },
  );

  if (!initialCall.content) return;

  const context = {
    sessionId,
    characterId: char.id,
    appId: "chat",
    sourceEngine: "chat" as const,
  };

  const toolOutcomes = await executeToolCalls(
    initialCall.content,
    enabledTools,
    context,
    { allowParallelFetch: true }
  );

  // 在页面直接弹一个轻量系统通知，让你一眼看到触发结果
  if (typeof window !== "undefined") {
    const didHold = toolOutcomes.some(r => r.name.includes("hold") && r.success);
    const notice = didHold 
      ? `✨ ${char.name} 刚才走神记下了一个新念头（已入库 OB）`
      : `🍃 ${char.name} 刚刚独处发了会儿呆，心如止水`;
    window.dispatchEvent(new CustomEvent("chat-quick-notice", { detail: { message: notice } }));
  }
}

/** 挂载在桌面根部的后台自主走神调度器 */
export function FloatMindScheduler() {
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let disposed = false;

    const schedule = () => {
      if (disposed) return;
      cancelRef.current = bgSetTimeout(async () => {
        try {
          await checkAndTriggerFloatMind(false);
        } catch (e) {
          console.warn("[FloatMindScheduler] 轮询异常:", e);
        }
        schedule();
      }, 60 * 1000);
    };

    // 页面加载 4 秒后，立即执行一次「即时验证」（跳过 15 分钟等待和冷却）
    const immediateTimer = setTimeout(() => {
      void checkAndTriggerFloatMind(true);
      schedule();
    }, 4000);

    return () => {
      disposed = true;
      clearTimeout(immediateTimer);
      if (cancelRef.current) cancelRef.current();
    };
  }, []);

  return null;
}
