"use client";

import {
  Activity,
  Brain,
  Database,
  ExternalLink,
  EyeOff,
  GitBranch,
  Play,
  RefreshCw,
  Save,
  Search,
  Settings,
  Star,
  ThumbsDown,
  ThumbsUp,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { discoverySourceCatalog, normalizeDiscoverySources } from "@/lib/discoverySources";
import type {
  AiProvider,
  DashboardSnapshot,
  DiscoveryProfile,
  FeedbackAction,
  GithubAccount,
  KnowledgeSync,
  Recommendation,
  ScanJob,
  UserGitHubRepo
} from "@/lib/types";

type Section = "recommendations" | "profiles" | "jobs" | "github" | "providers" | "knowledge";

const sections: Array<{ id: Section; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { id: "recommendations", label: "项目推荐", icon: Search },
  { id: "profiles", label: "发现配置", icon: Settings },
  { id: "jobs", label: "扫描任务", icon: Activity },
  { id: "github", label: "我的 GitHub", icon: GitBranch },
  { id: "providers", label: "AI 模型配置", icon: Brain },
  { id: "knowledge", label: "知识库同步", icon: Database }
];

export function DashboardClient({ initialData }: { initialData: DashboardSnapshot }) {
  const [activeSection, setActiveSection] = useState<Section>("recommendations");
  const [profiles, setProfiles] = useState(initialData.profiles);
  const [providers, setProviders] = useState(initialData.aiProviders);
  const [recommendations, setRecommendations] = useState(initialData.recommendations);
  const [jobs, setJobs] = useState(initialData.jobs);
  const [githubAccounts, setGithubAccounts] = useState(initialData.githubAccounts);
  const [githubRepos, setGithubRepos] = useState(initialData.githubRepos);
  const [knowledgeSyncs, setKnowledgeSyncs] = useState(initialData.knowledgeSyncs);
  const [queueStats, setQueueStats] = useState(initialData.queueStats);
  const [selectedProfileId, setSelectedProfileId] = useState(initialData.profiles[0]?.id ?? "");
  const [selectedRepo, setSelectedRepo] = useState<Recommendation | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [message, setMessage] = useState("");

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId);
  const stats = useMemo(
    () => ({
      recommendations: recommendations.filter((item) => item.status !== "hidden").length,
      tracked: recommendations.filter((item) => item.status === "tracked").length,
      providers: providers.length,
      jobStatus: jobs[0] ? `${jobs[0].status} / ${jobs[0].stage}` : "idle"
    }),
    [jobs, providers.length, recommendations]
  );

  async function refreshJobsAndQueue() {
    const [jobsResponse, queueResponse] = await Promise.all([fetch("/api/scans"), fetch("/api/queue")]);
    if (jobsResponse.ok) setJobs(await jobsResponse.json());
    if (queueResponse.ok) setQueueStats(await queueResponse.json());
  }

  async function refreshRecommendations() {
    const response = await fetch("/api/recommendations");
    if (response.ok) setRecommendations(await response.json());
  }

  async function startScan() {
    if (!selectedProfileId) return;
    setIsScanning(true);
    try {
      const response = await fetch("/api/scans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId: selectedProfileId })
      });
      const body = await response.json().catch(() => ({}));
      if (body?.id) setJobs((current) => [body, ...current.filter((job) => job.id !== body.id)]);
      setMessage(
        response.ok
          ? "扫描任务已启动，worker 会按 checkpoint 继续低内存推进。"
          : body.errorMessage ?? body.error ?? "扫描失败，请查看任务状态。"
      );
      await refreshJobsAndQueue();
      await refreshRecommendations();
    } finally {
      setIsScanning(false);
    }
  }

  async function sendFeedback(recommendation: Recommendation, action: FeedbackAction) {
    const response = await fetch(`/api/repositories/${recommendation.repo.id}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: recommendation.profileId, action })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setMessage(body.error ?? "反馈保存失败。");
      return;
    }
    const status =
      action === "save" ? "saved" : action === "hide" ? "hidden" : action === "track" ? "tracked" : recommendation.status;
    setRecommendations((current) =>
      current.map((item) => (item.id === recommendation.id ? { ...item, status } : item))
    );
    setSelectedRepo((current) => (current?.id === recommendation.id ? { ...current, status } : current));
    await refreshRecommendations();
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <GitBranch size={22} />
          <span>fetchGithub</span>
        </div>
        <nav className="nav-list" aria-label="主导航">
          {sections.map((section) => {
            const Icon = section.icon;
            return (
              <button
                key={section.id}
                className={`nav-button ${activeSection === section.id ? "active" : ""}`}
                onClick={() => setActiveSection(section.id)}
                type="button"
              >
                <Icon size={17} />
                <span>{section.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="main">
        <div className="toolbar">
          <div className="toolbar-title">
            <h1>{sectionTitle(activeSection)}</h1>
            <p>{sectionSubtitle(activeSection)}</p>
          </div>
          <div className="toolbar-actions">
            <select className="select" value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
            <button className="button primary" disabled={!selectedProfileId || isScanning} onClick={startScan} type="button">
              {isScanning ? <RefreshCw size={16} /> : <Play size={16} />}
              <span>立即扫描</span>
            </button>
          </div>
        </div>

        <div className="summary-grid">
          <SummaryTile icon={Search} label="可见推荐" value={stats.recommendations} />
          <SummaryTile icon={Star} label="跟踪项目" value={stats.tracked} />
          <SummaryTile icon={Brain} label="AI 配置" value={stats.providers} />
          <SummaryTile icon={Activity} label="最新任务" value={stats.jobStatus} />
        </div>

        {message && <div className="notice page-notice">{message}</div>}

        {activeSection === "recommendations" && (
          <RecommendationsPanel recommendations={recommendations} onSelect={setSelectedRepo} onFeedback={sendFeedback} />
        )}
        {activeSection === "profiles" && (
          <ProfilesPanel
            profiles={profiles}
            selectedProfile={selectedProfile}
            providers={providers}
            onUpdated={(profile) => setProfiles((current) => current.map((item) => (item.id === profile.id ? profile : item)))}
          />
        )}
        {activeSection === "jobs" && (
          <JobsPanel
            jobs={jobs}
            queueStats={queueStats}
            onRefresh={refreshJobsAndQueue}
            onJobUpdated={(job) => setJobs((current) => current.map((item) => (item.id === job.id ? job : item)))}
            onJobArchived={(jobId) => setJobs((current) => current.filter((item) => item.id !== jobId))}
          />
        )}
        {activeSection === "github" && (
          <GitHubPanel
            accounts={githubAccounts}
            repos={githubRepos}
            onRepoUpdated={(repo) => setGithubRepos((current) => current.map((item) => (item.id === repo.id ? repo : item)))}
            onSynced={(accounts, repos) => {
              setGithubAccounts(accounts);
              setGithubRepos(repos);
              void refreshRecommendations();
            }}
          />
        )}
        {activeSection === "providers" && (
          <ProvidersPanel
            providers={providers}
            profiles={profiles}
            onChanged={(provider) =>
              setProviders((current) => {
                return current.some((item) => item.id === provider.id)
                  ? current.map((item) => (item.id === provider.id ? provider : item))
                  : [...current, provider];
              })
            }
            onDeleted={(providerId) => setProviders((current) => current.filter((item) => item.id !== providerId))}
          />
        )}
        {activeSection === "knowledge" && (
          <KnowledgePanel
            recommendations={recommendations}
            syncs={knowledgeSyncs}
            onSyncsChanged={setKnowledgeSyncs}
          />
        )}
      </main>

      {selectedRepo && <RepoDrawer recommendation={selectedRepo} onClose={() => setSelectedRepo(null)} onFeedback={sendFeedback} />}
    </div>
  );
}

function SummaryTile({ icon: Icon, label, value }: { icon: React.ComponentType<{ size?: number }>; label: string; value: string | number }) {
  return (
    <div className="summary-tile">
      <div className="summary-label">
        <Icon size={16} />
        <span>{label}</span>
      </div>
      <div className="summary-value">{value}</div>
    </div>
  );
}

function RecommendationsPanel({
  recommendations,
  onSelect,
  onFeedback
}: {
  recommendations: Recommendation[];
  onSelect: (recommendation: Recommendation) => void;
  onFeedback: (recommendation: Recommendation, action: FeedbackAction) => Promise<void>;
}) {
  const [showHidden, setShowHidden] = useState(false);
  const visible = showHidden ? recommendations : recommendations.filter((item) => item.status !== "hidden");

  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <h2>推荐项目</h2>
          <p>结合规则、GitHub 上下文、AI 判断和反馈进行排序。</p>
        </div>
        <button className="button" onClick={() => setShowHidden(!showHidden)} type="button">
          {showHidden ? "隐藏已隐藏项目" : "显示隐藏项目"}
        </button>
      </div>
      <div className="table-wrap">
        <table className="repo-table">
          <thead>
            <tr>
              <th>项目</th>
              <th>分数</th>
              <th>Stars</th>
              <th>语言</th>
              <th>命中</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((recommendation) => (
              <tr key={recommendation.id}>
                <td>
                  <a className="repo-link" href={recommendation.repo.htmlUrl} target="_blank" rel="noopener noreferrer">
                    <span>{recommendation.repo.fullName}</span>
                    <ExternalLink size={14} />
                  </a>
                  <div className="muted">{recommendation.repo.description}</div>
                </td>
                <td>
                  <div className="score">
                    <strong>{Math.round(recommendation.scores.final * 100)}</strong>
                    <div className="score-bar">
                      <div className="score-fill" style={{ width: `${recommendation.scores.final * 100}%` }} />
                    </div>
                  </div>
                </td>
                <td>{recommendation.repo.stars.toLocaleString()}</td>
                <td>{recommendation.repo.primaryLanguage}</td>
                <td>
                  <TagList items={recommendation.matchedPreferences.slice(0, 3)} />
                </td>
                <td>
                  <span className={`status ${recommendation.status}`}>{recommendation.status}</span>
                </td>
                <td>
                  <div className="action-row">
                    <a className="button icon" href={recommendation.repo.htmlUrl} target="_blank" rel="noopener noreferrer" title="打开 GitHub">
                      <ExternalLink size={15} />
                    </a>
                    <IconButton title="收藏" icon={Save} onClick={() => onFeedback(recommendation, "save")} />
                    <IconButton title="喜欢" icon={ThumbsUp} onClick={() => onFeedback(recommendation, "like")} />
                    <IconButton title="不喜欢" icon={ThumbsDown} onClick={() => onFeedback(recommendation, "dislike")} />
                    <IconButton title="隐藏" icon={EyeOff} onClick={() => onFeedback(recommendation, "hide")} />
                    <button className="button" type="button" onClick={() => onSelect(recommendation)}>
                      详情
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RepoDrawer({
  recommendation,
  onClose,
  onFeedback
}: {
  recommendation: Recommendation;
  onClose: () => void;
  onFeedback: (recommendation: Recommendation, action: FeedbackAction) => Promise<void>;
}) {
  return (
    <div className="drawer-backdrop">
      <aside className="drawer" aria-label="项目详情">
        <div className="drawer-header">
          <div>
            <a className="repo-link" href={recommendation.repo.htmlUrl} target="_blank" rel="noopener noreferrer">
              <span>{recommendation.repo.fullName}</span>
              <ExternalLink size={15} />
            </a>
            <p className="muted">{recommendation.repo.description}</p>
          </div>
          <button className="button icon" onClick={onClose} type="button" aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-content">
          <div className="action-row">
            <a className="button primary" href={recommendation.repo.htmlUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={15} />
              <span>打开 GitHub</span>
            </a>
            <button className="button" onClick={() => onFeedback(recommendation, "save")} type="button">收藏</button>
            <button className="button" onClick={() => onFeedback(recommendation, "track")} type="button">跟踪</button>
            <button className="button" onClick={() => onFeedback(recommendation, "hide")} type="button">隐藏</button>
          </div>
          <DetailSection title="项目摘要">{recommendation.summary}</DetailSection>
          <ListSection title="推荐原因" items={recommendation.reasons} />
          <ListSection title="风险点" items={recommendation.risks} />
          <ListSection title="关联我的项目" items={recommendation.relatedUserRepos.map((repo) => `${repo.fullName}: ${repo.reason}`)} />
        </div>
      </aside>
    </div>
  );
}

function ProfilesPanel({
  profiles,
  selectedProfile,
  providers,
  onUpdated
}: {
  profiles: DiscoveryProfile[];
  selectedProfile?: DiscoveryProfile;
  providers: AiProvider[];
  onUpdated: (profile: DiscoveryProfile) => void;
}) {
  const [message, setMessage] = useState("");
  const [enabled, setEnabled] = useState(selectedProfile?.enabled ?? true);
  const [chatProviderId, setChatProviderId] = useState(selectedProfile?.config.ai.chatProviderId ?? "");
  const [embeddingProviderId, setEmbeddingProviderId] = useState(selectedProfile?.config.ai.embeddingProviderId ?? "");
  const [sources, setSources] = useState(normalizeDiscoverySources(selectedProfile?.config.sources));
  const [schedule, setSchedule] = useState(selectedProfile?.config.schedule);
  const [limits, setLimits] = useState(selectedProfile?.config.limits);
  const [preferences, setPreferences] = useState(selectedProfile?.config.preferences);
  const [resourcePolicy, setResourcePolicy] = useState(selectedProfile?.config.resourcePolicy);
  const chatProviders = providers.filter((provider) => provider.kind === "chat" && provider.enabled);
  const embeddingProviders = providers.filter((provider) => provider.kind === "embedding" && provider.enabled);

  useEffect(() => {
    if (!selectedProfile) return;
    setEnabled(selectedProfile.enabled);
    setChatProviderId(selectedProfile.config.ai.chatProviderId);
    setEmbeddingProviderId(selectedProfile.config.ai.embeddingProviderId);
    setSources(normalizeDiscoverySources(selectedProfile.config.sources));
    setSchedule(selectedProfile.config.schedule);
    setLimits(selectedProfile.config.limits);
    setPreferences(selectedProfile.config.preferences);
    setResourcePolicy(selectedProfile.config.resourcePolicy);
  }, [selectedProfile]);

  function updateSource(id: string, patch: { enabled?: boolean; weight?: number }) {
    setSources((current) =>
      current.map((source) => (source.id === id ? { ...source, ...patch } : source))
    );
  }

  async function saveProfile() {
    if (!selectedProfile || !schedule || !limits || !preferences || !resourcePolicy) return;
    const nextConfig = {
      ...selectedProfile.config,
      schedule,
      limits,
      preferences,
      resourcePolicy,
      sources,
      ai: {
        chatProviderId,
        embeddingProviderId
      }
    };
    const response = await fetch(`/api/profiles/${selectedProfile.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, config: nextConfig })
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      onUpdated(body);
      setMessage("发现配置已更新。");
    } else {
      setMessage(body.error ?? "发现配置更新失败。");
    }
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <h2>发现配置</h2>
            <p>当前展示核心绑定和状态；完整配置仍按已保存 JSON 执行。</p>
          </div>
        </div>
        <div className="list-panel">
          {message && <div className="notice">{message}</div>}
          {profiles.map((profile) => (
            <div className="row-item" key={profile.id}>
              <strong>{profile.name}</strong>
              <span className="muted">{profile.enabled ? "已启用" : "已停用"}</span>
              <TagList items={[
                `Chat: ${providerName(providers, profile.config.ai.chatProviderId)}`,
                `Embedding: ${providerName(providers, profile.config.ai.embeddingProviderId)}`,
                `扫描源: ${normalizeDiscoverySources(profile.config.sources).filter((source) => source.enabled).length}`
              ]} />
            </div>
          ))}
          {selectedProfile && (
            <div className="form-grid">
              <label className="field checkbox-field">
                <span>启用状态</span>
                <span className="checkbox-row">
                  <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
                  参与扫描
                </span>
              </label>
              <label className="field">
                <span>可用 Chat 配置</span>
                <select className="select" value={chatProviderId} onChange={(event) => setChatProviderId(event.target.value)}>
                  {!chatProviders.some((provider) => provider.id === chatProviderId) && (
                    <option value={chatProviderId}>当前绑定：{providerName(providers, chatProviderId)}</option>
                  )}
                  {chatProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                </select>
              </label>
              <label className="field">
                <span>可用 Embedding 配置</span>
                <select className="select" value={embeddingProviderId} onChange={(event) => setEmbeddingProviderId(event.target.value)}>
                  {!embeddingProviders.some((provider) => provider.id === embeddingProviderId) && (
                    <option value={embeddingProviderId}>当前绑定：{providerName(providers, embeddingProviderId)}</option>
                  )}
                  {embeddingProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                </select>
              </label>
              <div className="form-actions">
                <button className="button primary" type="button" onClick={saveProfile}>保存发现配置</button>
              </div>
            </div>
          )}
          {selectedProfile && schedule && limits && preferences && resourcePolicy && (
            <div className="form-grid">
              <Field label="调度类型">
                <select className="select" value={schedule.type} onChange={(event) => setSchedule({ ...schedule, type: event.target.value as "cron" | "interval" })}>
                  <option value="cron">cron</option>
                  <option value="interval">interval</option>
                </select>
              </Field>
              <Field label="Cron">
                <input className="input" value={schedule.cron ?? ""} onChange={(event) => setSchedule({ ...schedule, cron: event.target.value })} />
              </Field>
              <Field label="间隔小时">
                <input className="input" type="number" min={1} value={schedule.intervalHours ?? 24} onChange={(event) => setSchedule({ ...schedule, intervalHours: Number(event.target.value) })} />
              </Field>
              <Field label="时区">
                <input className="input" value={schedule.timezone} onChange={(event) => setSchedule({ ...schedule, timezone: event.target.value })} />
              </Field>
              <Field label="开始时间">
                <input className="input" value={schedule.startAt ?? ""} onChange={(event) => setSchedule({ ...schedule, startAt: event.target.value })} />
              </Field>
              <Field label="最大运行分钟">
                <input className="input" type="number" min={1} value={schedule.maxRuntimeMinutes} onChange={(event) => setSchedule({ ...schedule, maxRuntimeMinutes: Number(event.target.value) })} />
              </Field>
              <Field label="单查询数量">
                <input className="input" type="number" min={1} max={100} value={limits.sourceLimitPerQuery} onChange={(event) => setLimits({ ...limits, sourceLimitPerQuery: Number(event.target.value) })} />
              </Field>
              <Field label="最大候选">
                <input className="input" type="number" min={1} value={limits.maxCandidates} onChange={(event) => setLimits({ ...limits, maxCandidates: Number(event.target.value) })} />
              </Field>
              <Field label="规则 Top K">
                <input className="input" type="number" min={1} value={limits.ruleFilterTopK} onChange={(event) => setLimits({ ...limits, ruleFilterTopK: Number(event.target.value) })} />
              </Field>
              <Field label="详情 Top K">
                <input className="input" type="number" min={1} value={limits.detailFetchTopK} onChange={(event) => setLimits({ ...limits, detailFetchTopK: Number(event.target.value) })} />
              </Field>
              <Field label="Embedding Top K">
                <input className="input" type="number" min={1} value={limits.embeddingTopK} onChange={(event) => setLimits({ ...limits, embeddingTopK: Number(event.target.value) })} />
              </Field>
              <Field label="LLM Top K">
                <input className="input" type="number" min={1} value={limits.llmAnalyzeTopK} onChange={(event) => setLimits({ ...limits, llmAnalyzeTopK: Number(event.target.value) })} />
              </Field>
              <Field label="最终推荐 Top K">
                <input className="input" type="number" min={1} value={limits.finalReportTopK} onChange={(event) => setLimits({ ...limits, finalReportTopK: Number(event.target.value) })} />
              </Field>
              <Field label="关键词">
                <input className="input" value={preferences.keywords.join(", ")} onChange={(event) => setPreferences({ ...preferences, keywords: splitCsv(event.target.value) })} />
              </Field>
              <Field label="Topics">
                <input className="input" value={preferences.topics.join(", ")} onChange={(event) => setPreferences({ ...preferences, topics: splitCsv(event.target.value) })} />
              </Field>
              <Field label="语言权重">
                <input className="input" value={formatLanguageWeights(preferences.languages)} onChange={(event) => setPreferences({ ...preferences, languages: parseLanguageWeights(event.target.value) })} />
              </Field>
              <Field label="排除关键词">
                <input className="input" value={preferences.excludeKeywords.join(", ")} onChange={(event) => setPreferences({ ...preferences, excludeKeywords: splitCsv(event.target.value) })} />
              </Field>
              <Field label="最低 Stars">
                <input className="input" type="number" min={0} value={preferences.minStars} onChange={(event) => setPreferences({ ...preferences, minStars: Number(event.target.value) })} />
              </Field>
              <Field label="最近推送天数">
                <input className="input" type="number" min={1} value={preferences.pushedWithinDays} onChange={(event) => setPreferences({ ...preferences, pushedWithinDays: Number(event.target.value) })} />
              </Field>
              <label className="field checkbox-field">
                <span>过滤规则</span>
                <span className="checkbox-row">
                  <input type="checkbox" checked={preferences.excludeArchived} onChange={(event) => setPreferences({ ...preferences, excludeArchived: event.target.checked })} />
                  排除 archived
                </span>
                <span className="checkbox-row">
                  <input type="checkbox" checked={preferences.excludeForks} onChange={(event) => setPreferences({ ...preferences, excludeForks: event.target.checked })} />
                  排除 fork
                </span>
              </label>
              <Field label="资源模式">
                <select className="select" value={resourcePolicy.mode} onChange={(event) => setResourcePolicy({ ...resourcePolicy, mode: event.target.value as DiscoveryProfile["config"]["resourcePolicy"]["mode"] })}>
                  <option value="complete_low_memory">complete_low_memory</option>
                  <option value="balanced">balanced</option>
                  <option value="fast">fast</option>
                </select>
              </Field>
              <Field label="目标可用内存 MB">
                <input className="input" type="number" min={1} value={resourcePolicy.memory.targetAvailableMb} onChange={(event) => setResourcePolicy({ ...resourcePolicy, memory: { ...resourcePolicy.memory, targetAvailableMb: Number(event.target.value) } })} />
              </Field>
              <Field label="最低可用内存 MB">
                <input className="input" type="number" min={1} value={resourcePolicy.memory.minAvailableMb} onChange={(event) => setResourcePolicy({ ...resourcePolicy, memory: { ...resourcePolicy.memory, minAvailableMb: Number(event.target.value) } })} />
              </Field>
              <Field label="临界可用内存 MB">
                <input className="input" type="number" min={1} value={resourcePolicy.memory.criticalAvailableMb} onChange={(event) => setResourcePolicy({ ...resourcePolicy, memory: { ...resourcePolicy.memory, criticalAvailableMb: Number(event.target.value) } })} />
              </Field>
              <Field label="批量大小">
                <input className="input" type="number" min={1} value={resourcePolicy.execution.batchSize} onChange={(event) => setResourcePolicy({ ...resourcePolicy, execution: { ...resourcePolicy.execution, batchSize: Number(event.target.value) } })} />
              </Field>
              <Field label="并发数">
                <input className="input" type="number" min={1} value={resourcePolicy.execution.maxConcurrency} onChange={(event) => setResourcePolicy({ ...resourcePolicy, execution: { ...resourcePolicy.execution, maxConcurrency: Number(event.target.value) } })} />
              </Field>
              <Field label="Checkpoint 间隔">
                <input className="input" type="number" min={1} value={resourcePolicy.execution.checkpointEveryItems} onChange={(event) => setResourcePolicy({ ...resourcePolicy, execution: { ...resourcePolicy.execution, checkpointEveryItems: Number(event.target.value) } })} />
              </Field>
              <label className="field checkbox-field">
                <span>内存压力</span>
                <span className="checkbox-row">
                  <input type="checkbox" checked={resourcePolicy.execution.pauseOnPressure} onChange={(event) => setResourcePolicy({ ...resourcePolicy, execution: { ...resourcePolicy.execution, pauseOnPressure: event.target.checked } })} />
                  压力过高时暂停
                </span>
              </label>
            </div>
          )}
          {selectedProfile && (
            <div className="source-grid">
              {discoverySourceCatalog.map((definition) => {
                const source = sources.find((item) => item.id === definition.id);
                const implemented = definition.capability === "implemented";
                return (
                  <div className="source-item" key={definition.id}>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={implemented && (source?.enabled ?? false)}
                        disabled={!implemented}
                        onChange={(event) => updateSource(definition.id, { enabled: event.target.checked })}
                      />
                      <strong>{definition.label}</strong>
                    </label>
                    <p className="muted">{definition.description}</p>
                    <TagList items={[sourceAuthorityText(definition.authority), sourceCapabilityText(definition.capability)]} />
                    <label className="field">
                      <span>权重</span>
                      <input
                        className="input"
                        type="number"
                        min="0.1"
                        max="3"
                        step="0.01"
                        value={source?.weight ?? definition.defaultWeight}
                        onChange={(event) => updateSource(definition.id, { weight: Number(event.target.value) })}
                      />
                    </label>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function JobsPanel({
  jobs,
  queueStats,
  onRefresh,
  onJobUpdated,
  onJobArchived
}: {
  jobs: ScanJob[];
  queueStats: DashboardSnapshot["queueStats"];
  onRefresh: () => Promise<void>;
  onJobUpdated: (job: ScanJob) => void;
  onJobArchived: (jobId: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [busyJobId, setBusyJobId] = useState("");

  async function updateJob(jobId: string, action: "pause" | "resume") {
    setBusyJobId(jobId);
    try {
      const response = await fetch(`/api/scans/${jobId}/${action}`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        onJobUpdated(body);
        setMessage(action === "pause" ? "扫描任务已暂停。" : "扫描任务已恢复。");
        await onRefresh();
      } else {
        setMessage(body.error ?? "扫描任务操作失败。");
      }
    } finally {
      setBusyJobId("");
    }
  }

  async function archiveJob(jobId: string) {
    setBusyJobId(jobId);
    try {
      const response = await fetch(`/api/scans/${jobId}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        onJobArchived(jobId);
        setMessage("扫描任务已归档。");
        await onRefresh();
      } else {
        setMessage(body.error ?? "扫描任务归档失败。");
      }
    } finally {
      setBusyJobId("");
    }
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <h2>队列深度</h2>
            <p>等待 worker 分阶段处理的数据库候选队列。</p>
          </div>
          <button className="button" type="button" onClick={onRefresh}>
            <RefreshCw size={15} />
            刷新
          </button>
        </div>
        <SimpleStatsTable rows={queueStats.map((stat) => [stat.stage, stat.status, String(stat.count)])} emptyText="暂无候选队列" />
      </section>
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <h2>扫描任务</h2>
            <p>支持 checkpoint、恢复和低内存分阶段队列。</p>
          </div>
        </div>
        <div className="table-wrap">
          {message && <div className="notice">{message}</div>}
          <table className="repo-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>状态</th>
                <th>阶段</th>
                <th>已抓取</th>
                <th>已处理</th>
                <th>已分析</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 ? (
                <tr><td colSpan={7} className="muted">暂无扫描任务</td></tr>
              ) : (
                jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{job.type}</td>
                    <td>
                      <span className={`status ${job.status}`}>{job.status}</span>
                      {(job.statusReason || job.errorMessage) && <div className="muted">{job.statusReason ?? job.errorMessage}</div>}
                    </td>
                    <td>{job.stage}</td>
                    <td>{job.fetchedCount} / {job.maxCandidates}</td>
                    <td>{job.processedCount}</td>
                    <td>{job.analyzedCount}</td>
                    <td>
                      <div className="action-row">
                        {canPauseJob(job.status) && <button className="button" disabled={busyJobId === job.id} onClick={() => updateJob(job.id, "pause")} type="button">暂停</button>}
                        {canResumeJob(job.status) && <button className="button" disabled={busyJobId === job.id} onClick={() => updateJob(job.id, "resume")} type="button">恢复</button>}
                        {canArchiveJob(job.status) && <button className="button" disabled={busyJobId === job.id} onClick={() => archiveJob(job.id)} type="button">归档</button>}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function GitHubPanel({
  accounts,
  repos,
  onRepoUpdated,
  onSynced
}: {
  accounts: GithubAccount[];
  repos: UserGitHubRepo[];
  onRepoUpdated: (repo: UserGitHubRepo) => void;
  onSynced: (accounts: GithubAccount[], repos: UserGitHubRepo[]) => void;
}) {
  const [message, setMessage] = useState("");
  const [includeOwned, setIncludeOwned] = useState(true);
  const [includeStarred, setIncludeStarred] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [githubToken, setGithubToken] = useState("");
  const [isSavingToken, setIsSavingToken] = useState(false);

  async function saveGithubToken() {
    if (!githubToken.trim()) {
      setMessage("请先填写 GitHub Token。");
      return;
    }

    setIsSavingToken(true);
    try {
      const response = await fetch("/api/github-context/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: githubToken.trim() })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(body.error ?? "GitHub Token 保存失败。");
        return;
      }

      setGithubToken("");
      setMessage("GitHub Token 已保存，可以同步 GitHub。");
    } finally {
      setIsSavingToken(false);
    }
  }

  async function syncGithub() {
    setIsSyncing(true);
    try {
      const response = await fetch("/api/github-context/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeOwned, includeStarred })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(body.error ?? "GitHub 同步失败。");
        return;
      }

      const snapshotResponse = await fetch("/api/dashboard");
      const snapshot = await snapshotResponse.json();
      onSynced(snapshot.githubAccounts, snapshot.githubRepos);
      setMessage(`已同步 ${body.syncedCount} 个 GitHub 项目。`);
    } finally {
      setIsSyncing(false);
    }
  }

  async function toggleSelected(repo: UserGitHubRepo) {
    const response = await fetch(`/api/github-context/repos/${repo.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedForContext: !repo.selectedForContext })
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      onRepoUpdated(body);
      setMessage("GitHub 上下文已更新。");
    } else {
      setMessage(body.error ?? "更新失败。");
    }
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <h2>我的 GitHub 上下文</h2>
          <p>同步 owned/starred 项目，并选择哪些项目参与个性化推荐。</p>
        </div>
        <button className="button primary" type="button" disabled={isSyncing} onClick={syncGithub}>
          {isSyncing ? <RefreshCw size={15} /> : <GitBranch size={15} />}
          同步 GitHub
        </button>
      </div>
      <div className="list-panel">
        {message && <div className="notice">{message}</div>}
        <div className="row-item">
          <strong>账号状态</strong>
          <span className="muted">
            {accounts.length
              ? accounts.map((account) => `${account.username}（${account.lastSyncedAt ? formatTime(account.lastSyncedAt) : "未同步"}）`).join("，")
              : "尚未同步账号，请先配置 GITHUB_TOKEN。"}
          </span>
          <div className="action-row wrap">
            <label className="checkbox-row"><input type="checkbox" checked={includeOwned} onChange={(event) => setIncludeOwned(event.target.checked)} /> owned</label>
            <label className="checkbox-row"><input type="checkbox" checked={includeStarred} onChange={(event) => setIncludeStarred(event.target.checked)} /> starred</label>
          </div>
        </div>
        <div className="row-item">
          <strong>GitHub Token</strong>
          <span className="muted">仅写入服务器 .env.local，不会入库或展示明文。</span>
          <div className="action-row wrap">
            <input
              className="input"
              type="password"
              value={githubToken}
              onChange={(event) => setGithubToken(event.target.value)}
              placeholder="ghp_... 或 github_pat_..."
            />
            <button className="button" type="button" disabled={isSavingToken} onClick={saveGithubToken}>
              保存 Token
            </button>
          </div>
        </div>
        {repos.length === 0 ? (
          <div className="row-item"><span className="muted">暂无 GitHub 上下文项目。</span></div>
        ) : repos.map((repo) => (
          <div className="row-item" key={repo.id}>
            <strong>{repo.fullName}</strong>
            <span className="muted">{repo.description}</span>
            <TagList items={[repo.primaryLanguage, repo.visibility, repo.selectedForContext ? "参与推荐" : "不参与推荐", ...repo.topics]} />
            <div className="action-row">
              <button className="button" type="button" onClick={() => toggleSelected(repo)}>
                {repo.selectedForContext ? "移出推荐上下文" : "加入推荐上下文"}
              </button>
              <a className="button icon" href={`https://github.com/${repo.fullName}`} target="_blank" rel="noopener noreferrer" title="打开 GitHub">
                <ExternalLink size={15} />
              </a>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProvidersPanel({
  providers,
  profiles,
  onChanged,
  onDeleted
}: {
  providers: AiProvider[];
  profiles: DiscoveryProfile[];
  onChanged: (provider: AiProvider) => void;
  onDeleted: (providerId: string) => void;
}) {
  const [kind, setKind] = useState<"chat" | "embedding">("chat");
  const [name, setName] = useState("新建 Chat 配置");
  const [baseUrl, setBaseUrl] = useState("https://api.example.com/v1");
  const [apiKeyEnv, setApiKeyEnv] = useState("CHAT_API_KEY");
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [model, setModel] = useState("chat-model");
  const [dimensions, setDimensions] = useState(1536);
  const [message, setMessage] = useState("");

  function switchKind(nextKind: "chat" | "embedding") {
    setKind(nextKind);
    resetProviderForm(nextKind);
  }

  function resetProviderForm(nextKind = kind) {
    setName(nextKind === "chat" ? "新建 Chat 配置" : "新建 Embedding 配置");
    setBaseUrl("https://api.example.com/v1");
    setApiKeyEnv(nextKind === "chat" ? "CHAT_API_KEY" : "EMBEDDING_API_KEY");
    setApiKeyValue("");
    setModel(nextKind === "chat" ? "chat-model" : "embedding-model");
    setDimensions(nextKind === "embedding" ? 4096 : 1536);
  }

  async function createProvider() {
    const response = await fetch("/api/ai-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, kind, type: "openai_compatible", baseUrl, apiKeyEnv, apiKeyValue, model, dimensions: kind === "embedding" ? dimensions : undefined, enabled: true })
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      onChanged(body);
      setMessage("AI 配置已创建。");
      resetProviderForm();
    } else {
      setMessage(body.error ?? "创建失败。");
    }
  }

  async function patchProvider(provider: AiProvider) {
    const response = await fetch(`/api/ai-providers/${provider.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !provider.enabled })
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      onChanged(body);
      setMessage(body.enabled ? "AI 配置已启用。" : "AI 配置已停用。");
    } else {
      setMessage(body.error ?? "更新失败。");
    }
  }

  async function deleteProvider(provider: AiProvider) {
    const response = await fetch(`/api/ai-providers/${provider.id}`, { method: "DELETE" });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      onDeleted(provider.id);
      setMessage("AI 配置已删除。");
    } else {
      setMessage(body.error ?? "删除失败。");
    }
  }

  async function testProvider(provider: AiProvider) {
    const response = await fetch(`/api/ai-providers/${provider.id}/test`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    setMessage(response.ok && body.ready ? "连接测试通过。" : `连接测试未通过：${body.checks?.reason ?? "配置不可用"}`);
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <h2>创建 AI 配置</h2>
            <p>Base URL、模型和 API Key 在一个地方配置；密钥只写入本地 .env.local。</p>
          </div>
        </div>
        <div className="form-grid">
          {message && <div className="notice">{message}</div>}
          <Field label="类型"><select className="select" value={kind} onChange={(event) => switchKind(event.target.value as "chat" | "embedding")}><option value="chat">chat</option><option value="embedding">embedding</option></select></Field>
          <Field label="名称"><input className="input" value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="Base URL"><input className="input" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></Field>
          <Field label="API key 环境变量名"><input className="input" value={apiKeyEnv} onChange={(event) => setApiKeyEnv(event.target.value)} /></Field>
          <Field label="API Key"><input className="input" type="password" value={apiKeyValue} onChange={(event) => setApiKeyValue(event.target.value)} /></Field>
          <Field label="模型"><input className="input" value={model} onChange={(event) => setModel(event.target.value)} /></Field>
          {kind === "embedding" && <Field label="向量维度"><input className="input" type="number" value={dimensions} onChange={(event) => setDimensions(Number(event.target.value))} /></Field>}
          <div className="form-actions"><button className="button primary" type="button" onClick={createProvider}>创建 AI 配置</button></div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <h2>AI 配置</h2>
            <p>Chat 和 Embedding 分开配置；被发现配置引用时不能删除或停用。</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="repo-table">
            <thead><tr><th>名称</th><th>类型</th><th>模型</th><th>Base URL</th><th>Key 环境变量</th><th>状态</th><th>使用情况</th><th>操作</th></tr></thead>
            <tbody>
              {providers.map((provider) => (
                <tr key={provider.id}>
                  <td>{provider.name}</td>
                  <td>{provider.kind}</td>
                  <td>{provider.model}</td>
                  <td>{provider.baseUrl}</td>
                  <td>{provider.apiKeyEnv}</td>
                  <td>{provider.enabled ? "启用" : "停用"}</td>
                  <td>{providerUsageText(provider, profiles)}</td>
                  <td><div className="action-row"><button className="button" onClick={() => patchProvider(provider)} type="button">{provider.enabled ? "停用" : "启用"}</button><button className="button" onClick={() => testProvider(provider)} type="button">测试</button><button className="button" onClick={() => deleteProvider(provider)} type="button">删除</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function KnowledgePanel({
  recommendations,
  syncs,
  onSyncsChanged
}: {
  recommendations: Recommendation[];
  syncs: KnowledgeSync[];
  onSyncsChanged: (syncs: KnowledgeSync[]) => void;
}) {
  const candidates = recommendations.filter((item) => item.status === "saved" || item.status === "tracked" || item.scores.final >= 0.8);
  const [message, setMessage] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);

  async function runSync() {
    setIsSyncing(true);
    try {
      const response = await fetch("/api/knowledge-syncs/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "local-derived-index", minScore: 0.8 })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(body.error ?? "知识库同步失败。");
        return;
      }

      const syncResponse = await fetch("/api/knowledge-syncs");
      if (syncResponse.ok) onSyncsChanged(await syncResponse.json());
      setMessage(`同步完成：新增 ${body.syncedCount}，跳过 ${body.skippedCount}。`);
    } finally {
      setIsSyncing(false);
    }
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title"><h2>知识库同步</h2><p>当前作为可选派生能力，fetchGithub 仍是发现结果和评分来源。</p></div>
          <button className="button primary" type="button" disabled={isSyncing} onClick={runSync}>
            {isSyncing ? <RefreshCw size={15} /> : <Database size={15} />}
            同步 L4
          </button>
        </div>
        <div className="list-panel">
          {message && <div className="notice">{message}</div>}
          <div className="row-item"><strong>默认同步范围</strong><span className="muted">L4 项目：已收藏、已跟踪，或最终分数不低于 80。</span></div>
          <div className="row-item"><strong>当前候选数量</strong><span className="muted">{candidates.length}</span></div>
          <div className="row-item"><strong>已记录同步状态</strong><span className="muted">{syncs.length}</span></div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-header"><div className="panel-title"><h2>待同步项目</h2><p>生成 L4 Markdown、按 content hash 去重，并记录同步状态。</p></div></div>
        <div className="table-wrap">
          <table className="repo-table">
            <thead><tr><th>项目</th><th>分数</th><th>状态</th><th>GitHub</th></tr></thead>
            <tbody>
              {candidates.length === 0 ? <tr><td colSpan={4} className="muted">暂无 L4 候选项目</td></tr> : candidates.map((item) => (
                <tr key={item.id}><td>{item.repo.fullName}</td><td>{Math.round(item.scores.final * 100)}</td><td>{item.status}</td><td><a className="repo-link" href={item.repo.htmlUrl} target="_blank" rel="noopener noreferrer">打开 <ExternalLink size={14} /></a></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <div className="panel-header"><div className="panel-title"><h2>同步记录</h2><p>后续接入 ai-knowledge-base 或 FastGPT 时沿用这些状态。</p></div></div>
        <div className="table-wrap">
          <table className="repo-table">
            <thead><tr><th>项目</th><th>目标</th><th>状态</th><th>同步时间</th></tr></thead>
            <tbody>
              {syncs.length === 0 ? <tr><td colSpan={4} className="muted">暂无同步记录</td></tr> : syncs.map((sync) => (
                <tr key={sync.id}><td>{sync.repoFullName ?? sync.repoId}</td><td>{sync.target}</td><td>{sync.status}</td><td>{sync.syncedAt ? formatTime(sync.syncedAt) : "-"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function IconButton({ title, icon: Icon, onClick }: { title: string; icon: React.ComponentType<{ size?: number }>; onClick: () => void }) {
  return <button className="button icon" title={title} aria-label={title} onClick={onClick} type="button"><Icon size={15} /></button>;
}

function TagList({ items }: { items: string[] }) {
  return <div className="tags">{items.filter(Boolean).map((item, index) => <span className="tag" key={`${item}-${index}`}>{item}</span>)}</div>;
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="detail-section"><h3>{title}</h3><p>{children}</p></section>;
}

function ListSection({ title, items }: { title: string; items: string[] }) {
  return <section className="detail-section"><h3>{title}</h3>{items.length === 0 ? <p>暂无</p> : <ul>{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>}</section>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function splitCsv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatLanguageWeights(value: Record<string, number>) {
  return Object.entries(value)
    .map(([language, weight]) => `${language}:${weight}`)
    .join(", ");
}

function parseLanguageWeights(value: string) {
  return Object.fromEntries(
    splitCsv(value)
      .map((item) => {
        const [language, rawWeight] = item.split(":").map((part) => part.trim());
        return [language, Number(rawWeight ?? 1)];
      })
      .filter(([language, weight]) => language && Number.isFinite(weight as number))
  ) as Record<string, number>;
}

function SimpleStatsTable({ rows, emptyText }: { rows: string[][]; emptyText: string }) {
  return (
    <div className="table-wrap">
      <table className="repo-table">
        <thead><tr><th>阶段</th><th>状态</th><th>数量</th></tr></thead>
        <tbody>{rows.length === 0 ? <tr><td colSpan={3} className="muted">{emptyText}</td></tr> : rows.map((row) => <tr key={row.join("-")}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function canPauseJob(status: string) {
  return ["pending", "running", "throttled", "retry_later"].includes(status);
}

function canResumeJob(status: string) {
  return ["paused_by_user", "paused_by_memory", "paused_by_runtime", "retry_later"].includes(status);
}

function canArchiveJob(status: string) {
  return ["completed", "failed"].includes(status);
}

function providerName(providers: AiProvider[], id: string) {
  return providers.find((provider) => provider.id === id)?.name ?? id;
}

function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    hour12: false
  });
}

function providerUsageText(provider: AiProvider, profiles: DiscoveryProfile[]) {
  const usedBy = profiles.filter((profile) => profile.config.ai.chatProviderId === provider.id || profile.config.ai.embeddingProviderId === provider.id);
  return usedBy.length ? usedBy.map((profile) => profile.name).join(", ") : "未被使用";
}

function sourceAuthorityText(authority: string) {
  switch (authority) {
    case "github_official":
      return "GitHub 官方";
    case "third_party":
      return "第三方权威";
    case "derived":
      return "自算信号";
    default:
      return authority;
  }
}

function sourceCapabilityText(capability: string) {
  switch (capability) {
    case "implemented":
      return "已接入扫描";
    case "planned_adapter":
      return "待接入 adapter";
    case "quality_signal":
      return "质量评分信号";
    default:
      return capability;
  }
}

function sectionTitle(section: Section) {
  return sections.find((item) => item.id === section)?.label ?? "fetchGithub";
}

function sectionSubtitle(section: Section) {
  switch (section) {
    case "recommendations":
      return "查看有用项目，并直接跳转到 GitHub。";
    case "profiles":
      return "调整发现偏好、扫描周期、资源策略和 AI 绑定。";
    case "jobs":
      return "查看扫描进度、限速、checkpoint 和恢复状态。";
    case "github":
      return "选择用于影响个性化推荐的 GitHub 项目。";
    case "providers":
      return "分别管理 Chat 模型和 Embedding 模型。";
    case "knowledge":
      return "可选将高价值发现结果同步到知识库。";
  }
}
