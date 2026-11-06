import type { MemoryEntry } from "./memory-types";
import { DEFAULT_CORE_MEMORY_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    deleteMemoryEntries,
    getCoreMemoryCounter,
    resetCoreMemoryCounter,
    getLastCoreSummarizedTimestamp,
    setLastCoreSummarizedTimestamp,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";

const coreBuildingSet = new Set<string>();

type CoreTimelineItem = {
    id: string;
    timestamp: string;
    content: string;
    sourceApp: MemoryEntry["sourceApp"];
    sourceSessionIds: string[];
};

function formatCoreTimelineForSummarization(
    entries: CoreTimelineItem[],
): { eventsText: string; earliest: string; latest: string; count: number } | null {
    if (entries.length === 0) return null;
    return {
        eventsText: entries.map(entry => `- ${entry.content}`).join("\n"),
        earliest: entries[0].timestamp,
        latest: entries[entries.length - 1].timestamp,
        count: entries.length,
    };
}

export async function runCoreMemoryPipeline(
    characterId: string,
    characterName: string,
    options?: { force?: boolean },
): Promise<{ success: boolean; error?: string; rebuiltCount?: number }> {
    const config = loadMemoryConfig();
    const allLongTermEntries = await loadMemoryEntriesByType(characterId, "long_term");

    if (allLongTermEntries.length === 0) {
        return { success: false, error: "没有可用于总结核心记忆的长期记忆" };
    }

    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    // 1. 读取该角色现有的所有核心记忆（单例模式下最多一条，若历史有遗留的多条后续会一并清理）
    const existingCoreEntries = await loadMemoryEntriesByType(characterId, "core");
    const existingCore = existingCoreEntries[0];
    const previousSummary = existingCore?.content?.trim() || "暂无历史核心记忆（首次提炼）";

    // 2. 永远取该角色从始至终全部长期记忆进行全貌评估
    const entries = allLongTermEntries
        .map(entry => ({
            id: entry.id,
            timestamp: entry.createdAt,
            content: entry.content,
            sourceApp: entry.sourceApp,
            sourceSessionIds: Array.isArray(entry.metadata?.sourceSessionIds)
                ? entry.metadata.sourceSessionIds.map(String)
                : [],
        }))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const formatted = formatCoreTimelineForSummarization(entries);
    if (!formatted) return { success: false, error: "格式化核心记忆数据失败" };

    const { eventsText, earliest, latest } = formatted;

    // 3. 构造增量演进式核心记忆提炼 Prompt
    const prompt = `你是角色【${characterName}】与用户（User）之间最核心记忆与全局关系的档案管理员。

你的任务是：基于【现有的核心记忆档案】，结合从始至终记录的【全部长期记忆事件】，更新并迭代出唯一一份最新、最凝练的核心记忆。

【现有的核心记忆档案】：
${previousSummary}

【全部长期记忆事件（按时间序）】：
${eventsText}

【更新与整合准则】：
1. 演进与覆写：对比旧档案与新事件，如果关系状态发生跃迁（如从朋友到恋人、产生误会或关系破裂）、重大认知改变，必须更新或覆盖旧档案中的陈旧描述，消除一切前后矛盾。
2. 极端凝练：只保留对双方关系有不可逆影响的里程碑、关键身份定义、彼此最不可动摇的核心认知。剔除一切日常琐事、偶发情绪波动。
3. 篇幅与格式限制：
   - 最终必须且只能输出【一段话】（80 ~ 180 字）。
   - 纯第三人称客观事实陈述。
   - 严禁使用分点列表（如 1. 2. 3. 或 - ）、严禁带标题、严禁 JSON、严禁任何多余解释与客套话。直接输出正文。

最新核心记忆：`;

    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.3 },
    );

    if (!result.content) {
        return { success: false, error: result.error || "核心记忆总结失败" };
    }
    if (result.wasTruncated) {
        return { success: false, error: "核心记忆总结结果疑似被截断，已取消入库，请稍后重试" };
    }

    const summary = result.content.trim();
    if (!summary) {
        return { success: false, error: "核心记忆总结结果为空" };
    }

    const now = new Date().toISOString();
    const sourceCounts = new Map<string, number>();
    for (const entry of entries) {
        sourceCounts.set(entry.sourceApp, (sourceCounts.get(entry.sourceApp) || 0) + 1);
    }
    let dominantSource: MemoryEntry["sourceApp"] = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) {
            dominantSource = src as MemoryEntry["sourceApp"];
            maxCount = count;
        }
    }
    const sourceSessionIds = Array.from(new Set(entries.flatMap(entry => entry.sourceSessionIds)));

    // 4. 清理旧核心记忆，实现单例覆盖
    const oldIds = existingCoreEntries.map(e => e.id);
    if (oldIds.length > 0) {
        await deleteMemoryEntries(oldIds);
    }

    const coreEntry: MemoryEntry = {
        id: `mem_core_${characterId}_singleton`,
        characterId,
        sourceApp: dominantSource,
        type: "core",
        content: summary,
        importance: 1.0,
        createdAt: existingCore?.createdAt || now,
        updatedAt: now,
        metadata: {
            summarizedLongTermEntries: entries.length,
            timeSpan: `${earliest} ~ ${latest}`,
            sourceSessionIds,
        },
    };
    await saveMemoryEntry(coreEntry);

    setLastCoreSummarizedTimestamp(characterId, latest);
    if (!options?.force) {
        resetCoreMemoryCounter(characterId);
    }

    return { success: true, rebuiltCount: 1 };
}

export async function maybeRunCoreMemoryPipeline(
    characterId: string,
    characterName: string,
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoBuildCoreEnabled) return;

    const counter = getCoreMemoryCounter(characterId);
    if (counter < config.coreSummarizationInterval) return;

    if (coreBuildingSet.has(characterId)) return;
    coreBuildingSet.add(characterId);
    try {
        const result = await runCoreMemoryPipeline(characterId, characterName);
        if (!result.success) {
            console.warn("[CoreMemory] Auto summary failed:", result.error);
        }
    } finally {
        coreBuildingSet.delete(characterId);
    }
}
