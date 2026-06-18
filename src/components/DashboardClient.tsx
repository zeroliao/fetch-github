"use client";

import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Brain,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Database,
  ExternalLink,
  EyeOff,
  Eye,
  GitBranch,
  LogOut,
  LockKeyhole,
  Play,
  RefreshCw,
  Save,
  Search,
  Settings,
  Star,
  ThumbsDown,
  ThumbsUp,
  ClipboardCheck,
  X
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { discoverySourceCatalog, normalizeDiscoverySources } from "@/lib/discoverySources";
import { sectionDefinitions, sectionFromPath, sectionLabel, sectionPath, type Section } from "@/lib/navigation";
import { normalizeOpportunityProfile, opportunityActionText } from "@/lib/opportunity";
import { getRecommendationSummaryZh } from "@/lib/recommendationText";
import type { GitHubSearchQueryPlan } from "@/server/githubSearch";
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

type GeneratedPreferences = DiscoveryProfile["config"]["preferences"] & {
  notes?: string[];
};

type NaturalLanguagePreview = {
  generated: GeneratedPreferences;
  preview: {
    preferences: DiscoveryProfile["config"]["preferences"];
    queryPlans: GitHubSearchQueryPlan[];
  };
  mode: "merge" | "replace";
};

const sectionIcons: Record<Section, React.ComponentType<{ size?: number }>> = {
  recommendations: Search,
  profiles: Settings,
  jobs: Activity,
  github: GitBranch,
  providers: Brain,
  knowledge: Database,
  operations: BarChart3
};

const sections = sectionDefinitions.map((section) => ({
  ...section,
  icon: sectionIcons[section.id]
}));

export function DashboardClient({
  initialData,
  initialSection = "recommendations"
}: {
  initialData: DashboardSnapshot;
  initialSection?: Section;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const activeSection = sectionFromPath(pathname) ?? initialSection;
  const [profiles, setProfiles] = useState(initialData.profiles);
  const [providers, setProviders] = useState(initialData.aiProviders);
  const [recommendations, setRecommendations] = useState(initialData.recommendations);
  const [jobs, setJobs] = useState(initialData.jobs);
  const [githubAccounts, setGithubAccounts] = useState(initialData.githubAccounts);
  const [githubRepos, setGithubRepos] = useState(initialData.githubRepos);
  const [knowledgeSyncs, setKnowledgeSyncs] = useState(initialData.knowledgeSyncs);
  const [queueStats, setQueueStats] = useState(initialData.queueStats);
  const [operations, setOperations] = useState(initialData.operations);
  const [settings, setSettings] = useState(initialData.settings);
  const [selectedProfileId, setSelectedProfileId] = useState(initialData.profiles[0]?.id ?? "");
  const [selectedRepo, setSelectedRepo] = useState<Recommendation | null>(null);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [message, setMessage] = useState("");

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId);
  const stats = useMemo(
    () => ({
      recommendations: recommendations.filter(
        (item) => item.profileId === selectedProfileId && item.status !== "hidden"
      ).length,
      tracked: recommendations.filter((item) => item.status === "tracked").length,
      providers: providers.length,
      jobStatus: jobs[0] ? `${jobs[0].status} / ${jobs[0].stage}` : "idle"
    }),
    [jobs, providers.length, recommendations, selectedProfileId]
  );

  async function refreshJobsAndQueue() {
    const [jobsResponse, queueResponse] = await Promise.all([fetch("/api/scans"), fetch("/api/queue")]);
    if (jobsResponse.ok) setJobs(await jobsResponse.json());
    if (queueResponse.ok) setQueueStats(await queueResponse.json());
    const dashboardResponse = await fetch("/api/dashboard");
    if (dashboardResponse.ok) {
      const snapshot = await dashboardResponse.json() as DashboardSnapshot;
      setOperations(snapshot.operations);
      setSettings(snapshot.settings);
    }
  }

  async function refreshRecommendations() {
    const response = await fetch("/api/recommendations");
    if (response.ok) setRecommendations(await response.json());
  }

  async function startScan() {
    if (!selectedProfileId || !settings.scanEnabled) return;
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
    const status = statusFromFeedbackAction(action, recommendation.status);
    setRecommendations((current) =>
      current.map((item) => (item.id === recommendation.id ? { ...item, status } : item))
    );
    setSelectedRepo((current) => (current?.id === recommendation.id ? { ...current, status } : current));
    await refreshRecommendations();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  function navigateSection(section: Section) {
    router.push(sectionPath(section));
  }

  async function toggleGlobalScan(enabled: boolean) {
    const previous = settings;
    setSettings({ ...settings, scanEnabled: enabled });
    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scanEnabled: enabled })
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      setSettings(body);
      setMessage(enabled ? "全局扫描任务已开启。" : "全局扫描任务已关闭，不会启动新的扫描任务。");
    } else {
      setSettings(previous);
      setMessage(body.error ?? "全局扫描开关更新失败。");
    }
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
                onClick={() => navigateSection(section.id)}
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
            <label className="switch-row" title="关闭后不会创建、启动或恢复扫描任务">
              <input
                type="checkbox"
                checked={settings.scanEnabled}
                onChange={(event) => void toggleGlobalScan(event.target.checked)}
              />
              <span>全局扫描</span>
            </label>
            <select className="select" value={selectedProfileId} onChange={(event) => setSelectedProfileId(event.target.value)}>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
            <button className="button primary" disabled={!selectedProfileId || isScanning || !settings.scanEnabled} onClick={startScan} type="button">
              {isScanning ? <RefreshCw size={16} /> : <Play size={16} />}
              <span>立即扫描</span>
            </button>
            <button className="button" onClick={() => setShowPasswordDialog(true)} type="button" title="修改密码" aria-label="修改密码">
              <LockKeyhole size={16} />
              <span>修改密码</span>
            </button>
            <button className="button icon" onClick={logout} type="button" title="退出登录" aria-label="退出登录">
              <LogOut size={16} />
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
          <RecommendationsPanel
            recommendations={recommendations}
            selectedProfileId={selectedProfileId}
            onSelect={setSelectedRepo}
            onFeedback={sendFeedback}
            onRefresh={refreshRecommendations}
            onTagsUpdated={(recommendation) =>
              setRecommendations((current) =>
                current.map((item) => (item.id === recommendation.id ? recommendation : item))
              )
            }
          />
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
            settings={settings}
            accounts={githubAccounts}
            repos={githubRepos}
            onSettingsChanged={setSettings}
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
        {activeSection === "operations" && (
          <OperationsPanel operations={operations} queueStats={queueStats} onRefresh={refreshJobsAndQueue} />
        )}
      </main>

      {selectedRepo && (
        <RepoDrawer
          recommendation={selectedRepo}
          recommendations={recommendations}
          onClose={() => setSelectedRepo(null)}
          onFeedback={sendFeedback}
        />
      )}
      {showPasswordDialog && <PasswordDialog onClose={() => setShowPasswordDialog(false)} />}
    </div>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submitPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");

    if (newPassword.length < 8) {
      setMessage("新密码至少需要 8 位。");
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage("两次输入的新密码不一致。");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(body.error ?? "密码修改失败。");
        return;
      }

      setMessage("密码已修改，请退出后使用新密码重新登录。");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal-panel" onSubmit={submitPassword}>
        <div className="panel-header">
          <div className="panel-title">
            <h2>修改管理员密码</h2>
            <p>新密码会更新到服务器 `.env.local` 的 `ADMIN_PASSWORD_HASH`。</p>
          </div>
          <button className="button icon" type="button" onClick={onClose} title="关闭" aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="form-grid password-grid">
          {message && <div className="notice">{message}</div>}
          <Field label="当前密码">
            <input className="input" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
          </Field>
          <Field label="新密码">
            <input className="input" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          </Field>
          <Field label="确认新密码">
            <input className="input" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
          </Field>
          <div className="form-actions">
            <button className="button" type="button" onClick={onClose}>关闭</button>
            <button className="button primary" type="submit" disabled={isSubmitting}>
              {isSubmitting ? "保存中" : "保存密码"}
            </button>
          </div>
        </div>
      </form>
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
  selectedProfileId,
  onSelect,
  onFeedback,
  onRefresh,
  onTagsUpdated
}: {
  recommendations: Recommendation[];
  selectedProfileId: string;
  onSelect: (recommendation: Recommendation) => void;
  onFeedback: (recommendation: Recommendation, action: FeedbackAction) => Promise<void>;
  onRefresh: () => Promise<void>;
  onTagsUpdated: (recommendation: Recommendation) => void;
}) {
  const [opportunityFilter, setOpportunityFilter] = useState<OpportunityFilter>("all");
  const [groupFilter, setGroupFilter] = useState<GroupFilter>("all");
  const [preferenceFilter, setPreferenceFilter] = useState<PreferenceFilter>("unrated");
  const [focusedClusterKey, setFocusedClusterKey] = useState("");
  const [statusFilter, setStatusFilter] = useState<RecommendationStatusFilter>("visible");
  const [tagEditorRepo, setTagEditorRepo] = useState<Recommendation | null>(null);
  const [sortState, setSortState] = useState<RecommendationSortState>({
    key: "rank",
    direction: "asc"
  });
  const [semanticQuery, setSemanticQuery] = useState("");
  const [semanticSearch, setSemanticSearch] = useState<SemanticSearchState | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const searchScores = semanticSearch?.scores ?? {};
  const searchIds = useMemo(
    () => (semanticSearch ? new Set(semanticSearch.ids) : undefined),
    [semanticSearch]
  );
  const focusedClusterLabel = useMemo(() => {
    if (!focusedClusterKey) return "";
    return (
      recommendations.find((item) => item.cluster?.key === focusedClusterKey)?.cluster?.label ??
      focusedClusterKey
    );
  }, [focusedClusterKey, recommendations]);

  const visible = useMemo(() => {
    const filtered = recommendations
      .filter((item) => recommendationMatchesOpportunity(item, opportunityFilter))
      .filter((item) => recommendationMatchesGroup(item, groupFilter, focusedClusterKey))
      .filter((item) => recommendationMatchesPreference(item, preferenceFilter))
      .filter((item) => recommendationMatchesStatus(item, statusFilter))
      .filter((item) => !searchIds || searchIds.has(item.id));

    return [...filtered].sort((left, right) =>
      compareRecommendations(left, right, sortState, searchScores)
    );
  }, [
    focusedClusterKey,
    groupFilter,
    opportunityFilter,
    preferenceFilter,
    recommendations,
    searchIds,
    searchScores,
    sortState,
    statusFilter
  ]);

  async function runSemanticSearch(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const query = semanticQuery.trim();
    if (!query) {
      setSemanticSearch(null);
      setSortState({ key: "rank", direction: "asc" });
      return;
    }

    setIsSearching(true);
    try {
      const params = new URLSearchParams({
        q: query,
        limit: "100"
      });
      if (selectedProfileId) {
        params.set("profileId", selectedProfileId);
      }
      const response = await fetch(`/api/recommendations/search?${params.toString()}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSemanticSearch({
          ids: [],
          scores: {},
          mode: "lexical",
          warning: body.error ?? "语义搜索失败。"
        });
        return;
      }
      const results = Array.isArray(body.results) ? body.results : [];
      setSemanticSearch({
        ids: results.map((item: { id: string }) => item.id),
        scores: Object.fromEntries(
          results.map((item: { id: string; score: number }) => [item.id, Number(item.score) || 0])
        ),
        mode: body.mode ?? "semantic",
        warning: body.warning
      });
      setSortState({ key: "semantic", direction: "desc" });
    } finally {
      setIsSearching(false);
    }
  }

  function clearSemanticSearch() {
    setSemanticQuery("");
    setSemanticSearch(null);
    setSortState({ key: "rank", direction: "asc" });
  }

  function toggleSort(key: RecommendationSortKey) {
    setSortState((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "asc" ? "desc" : "asc"
          }
        : {
            key,
            direction: key === "rank" ? "asc" : "desc"
          }
    );
  }

  function clearFocusedCluster() {
    setFocusedClusterKey("");
  }

  async function sendPreferenceFeedback(recommendation: Recommendation, action: "like" | "dislike") {
    await onFeedback(recommendation, action);
    await onRefresh();
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-title">
          <h2>推荐项目</h2>
          <p>结合规则、GitHub 上下文、AI 判断和反馈进行排序。</p>
        </div>
        <div className="muted">当前 {visible.length} / {recommendations.length} 个</div>
      </div>
      <div className="list-controls">
        <form className="search-row" onSubmit={runSemanticSearch}>
          <Search size={16} />
          <input
            className="input"
            value={semanticQuery}
            onChange={(event) => setSemanticQuery(event.target.value)}
            placeholder="语义搜索：例如 适合做托管 SaaS 的 RAG 工具"
          />
          <button className="button primary" disabled={isSearching} type="submit">
            {isSearching ? "搜索中" : "语义搜索"}
          </button>
          {semanticSearch && (
            <button className="button" onClick={clearSemanticSearch} type="button">
              清除
            </button>
          )}
        </form>
        <div className="filter-row">
          <label className="field inline-field">
            <span>机会</span>
            <select
              className="select"
              value={opportunityFilter}
              onChange={(event) => setOpportunityFilter(event.target.value as OpportunityFilter)}
            >
              {opportunityFilterOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field inline-field">
            <span>分组动作</span>
            <select
              className="select"
              value={groupFilter}
              onChange={(event) => setGroupFilter(event.target.value as GroupFilter)}
            >
              {groupFilterOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field inline-field">
            <span>状态</span>
            <select
              className="select"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as RecommendationStatusFilter)}
            >
              {recommendationStatusFilterOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field inline-field">
            <span>喜好</span>
            <select
              className="select"
              value={preferenceFilter}
              onChange={(event) => setPreferenceFilter(event.target.value as PreferenceFilter)}
            >
              {preferenceFilterOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {focusedClusterKey && (
            <button className="button" onClick={clearFocusedCluster} type="button">
              清除当前分组
            </button>
          )}
          {focusedClusterLabel && <span className="muted">当前分组：{focusedClusterLabel}</span>}
          {semanticSearch?.warning && <span className="muted">{semanticSearch.warning}</span>}
        </div>
      </div>
      <div className="table-wrap">
        <table className="repo-table">
          <thead>
            <tr>
              <th>#</th>
              <th>项目</th>
              <th>
                <button className="sort-button" type="button" onClick={() => toggleSort("score")}>
                  <span>分数</span>
                  {renderSortIcon(sortState, "score")}
                </button>
              </th>
              <th>机会</th>
              <th>
                <button className="sort-button" type="button" onClick={() => toggleSort("stars")}>
                  <span>Stars</span>
                  {renderSortIcon(sortState, "stars")}
                </button>
              </th>
              <th>语言</th>
              <th>分组</th>
              <th>命中</th>
              <th>标签</th>
              <th>解释</th>
              <th>动作</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={13} className="muted">暂无符合当前筛选条件的推荐项目。</td>
              </tr>
            ) : visible.map((recommendation, index) => (
              <tr key={recommendation.id}>
                <td className="row-index">{index + 1}</td>
                <td>
                  <a className="repo-link" href={recommendation.repo.htmlUrl} target="_blank" rel="noopener noreferrer">
                    <span>{recommendation.repo.fullName}</span>
                    <ExternalLink size={14} />
                  </a>
                  <div className="muted">{getRecommendationSummaryZh(recommendation)}</div>
                  {semanticSearch && searchScores[recommendation.id] !== undefined && (
                    <div className="muted">语义相关 {Math.round(searchScores[recommendation.id] * 100)}</div>
                  )}
                </td>
                <td>
                  <div className="score">
                    <strong>{Math.round(recommendation.scores.final * 100)}</strong>
                    <div className="score-bar">
                      <div className="score-fill" style={{ width: `${recommendation.scores.final * 100}%` }} />
                    </div>
                  </div>
                </td>
                <td>
                  <strong>{recommendation.opportunity?.type ?? "机会待分析"}</strong>
                  <div className="muted">机会分 {Math.round((recommendation.scores.opportunity ?? recommendation.scores.final) * 100)}</div>
                  {(() => {
                    const opportunityAction = opportunityFeedbackAction(recommendation);
                    if (!opportunityAction) return null;
                    return (
                    <button
                      className="button compact"
                      type="button"
                      onClick={() => onFeedback(recommendation, opportunityAction.action)}
                    >
                      {opportunityAction.label}
                    </button>
                    );
                  })()}
                </td>
                <td>{recommendation.repo.stars.toLocaleString()}</td>
                <td>{recommendation.repo.primaryLanguage}</td>
                <td>
                  <strong>{recommendation.cluster?.label ?? "未分组"}</strong>
                  {recommendation.cluster?.size ? (
                    <div className="muted">
                      {recommendation.cluster.rankInCluster ?? "-"} / {recommendation.cluster.size}
                    </div>
                  ) : null}
                  {recommendation.cluster?.key && (
                    <button className="button compact" type="button" onClick={() => setFocusedClusterKey(recommendation.cluster?.key ?? "")}>
                      只看本组
                    </button>
                  )}
                </td>
                <td>
                  <TagList items={recommendation.matchedPreferences.slice(0, 3)} />
                </td>
                <td>
                  <TagList items={recommendation.tags ?? []} />
                  <button className="button compact" type="button" onClick={() => setTagEditorRepo(recommendation)}>
                    标签
                  </button>
                </td>
                <td className="explain-cell">
                  <strong>{recommendation.reasons[0] ?? "综合评分较高"}</strong>
                  <div className="muted">
                    {recommendation.opportunity?.monetizationPaths[0]
                      ? `变现方向：${recommendation.opportunity.monetizationPaths[0]}`
                      : `变现分：${Math.round((recommendation.scores.monetization ?? recommendation.scores.final) * 100)}`}
                  </div>
                </td>
                <td>{recommendation.opportunity ? opportunityActionText(recommendation.opportunity.suggestedAction) : "观察"}</td>
                <td>
                  <span className={`status ${recommendation.status}`}>{recommendationStatusText(recommendation.status)}</span>
                </td>
                <td>
                  <div className="action-row">
                    <a className="button icon" href={recommendation.repo.htmlUrl} target="_blank" rel="noopener noreferrer" title="打开 GitHub">
                      <ExternalLink size={15} />
                    </a>
                    <IconButton
                      title={recommendation.status === "liked" ? "已喜欢" : "喜欢"}
                      icon={ThumbsUp}
                      active={recommendation.status === "liked"}
                      tone="positive"
                      onClick={() => void sendPreferenceFeedback(recommendation, "like")}
                    />
                    <IconButton
                      title={recommendation.status === "disliked" ? "已不喜欢" : "不喜欢"}
                      icon={ThumbsDown}
                      active={recommendation.status === "disliked"}
                      tone="danger"
                      onClick={() => void sendPreferenceFeedback(recommendation, "dislike")}
                    />
                    {recommendation.status === "hidden" ? (
                      <IconButton title="恢复展示" icon={Eye} onClick={() => onFeedback(recommendation, "restore")} />
                    ) : (
                      <IconButton title="移出展示" icon={EyeOff} onClick={() => onFeedback(recommendation, "hide")} />
                    )}
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
      {tagEditorRepo && (
        <RecommendationTagDialog
          recommendation={tagEditorRepo}
          recommendations={recommendations}
          onClose={() => setTagEditorRepo(null)}
          onUpdated={(recommendation) => {
            onTagsUpdated(recommendation);
            setTagEditorRepo(null);
          }}
        />
      )}
    </section>
  );
}

function RepoDrawer({
  recommendation,
  recommendations,
  onClose,
  onFeedback
}: {
  recommendation: Recommendation;
  recommendations: Recommendation[];
  onClose: () => void;
  onFeedback: (recommendation: Recommendation, action: FeedbackAction) => Promise<void>;
}) {
  const similarRecommendations = recommendations.filter(
    (item) =>
      item.id !== recommendation.id &&
      item.cluster?.key &&
      item.cluster.key === recommendation.cluster?.key &&
      item.status !== "hidden" &&
      item.status !== "abandoned"
  );

  async function hideSimilarRecommendations() {
    for (const item of similarRecommendations) {
      await onFeedback(item, "hide");
    }
  }

  return (
    <div className="drawer-backdrop">
      <aside className="drawer" aria-label="项目详情">
        <div className="drawer-header">
          <div>
            <a className="repo-link" href={recommendation.repo.htmlUrl} target="_blank" rel="noopener noreferrer">
              <span>{recommendation.repo.fullName}</span>
              <ExternalLink size={15} />
            </a>
            <p className="muted">{getRecommendationSummaryZh(recommendation)}</p>
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
            <button className="button" onClick={() => onFeedback(recommendation, "to_validate")} type="button">
              <ClipboardCheck size={15} />
              待验证
            </button>
            <button className="button" onClick={() => onFeedback(recommendation, "validating")} type="button">验证中</button>
            <button className="button" onClick={() => onFeedback(recommendation, "monetization_ready")} type="button">准备变现</button>
            <button className="button" onClick={() => onFeedback(recommendation, "like")} type="button">
              <ThumbsUp size={15} />
              {recommendation.status === "liked" ? "已喜欢" : "喜欢"}
            </button>
            <button className="button" onClick={() => onFeedback(recommendation, "dislike")} type="button">
              <ThumbsDown size={15} />
              {recommendation.status === "disliked" ? "已不喜欢" : "不喜欢"}
            </button>
            <button className="button" onClick={() => onFeedback(recommendation, "track")} type="button">跟踪</button>
            <button className="button" onClick={() => onFeedback(recommendation, "abandon")} type="button">放弃</button>
            <button className="button" onClick={() => void hideSimilarRecommendations()} disabled={similarRecommendations.length === 0} type="button">
              隐藏类似项目
            </button>
            {recommendation.status === "hidden" ? (
              <button className="button" onClick={() => onFeedback(recommendation, "restore")} type="button">恢复展示</button>
            ) : (
              <button className="button" onClick={() => onFeedback(recommendation, "hide")} type="button">移出展示</button>
            )}
          </div>
          <DetailSection title="当前状态">{recommendationStatusText(recommendation.status)}</DetailSection>
          {recommendation.cluster && (
            <DetailSection title="项目分组">
              {`${recommendation.cluster.label}。${recommendation.cluster.reason} 组内第 ${recommendation.cluster.rankInCluster ?? "-"} / ${recommendation.cluster.size ?? 1}。`}
            </DetailSection>
          )}
          <DetailSection title="项目摘要">{getRecommendationSummaryZh(recommendation)}</DetailSection>
          {recommendation.opportunity && (
            <>
              <DetailSection title="商业机会">
                {`${recommendation.opportunity.type}，建议动作：${opportunityActionText(recommendation.opportunity.suggestedAction)}。机会分 ${Math.round(recommendation.opportunity.score * 100)}，变现潜力 ${Math.round(recommendation.opportunity.monetizationScore * 100)}。`}
              </DetailSection>
              <ListSection title="目标客户" items={recommendation.opportunity.targetCustomers} />
              <ListSection title="变现路径" items={recommendation.opportunity.monetizationPaths} />
              <ChecklistSection title="机会验证清单" items={recommendation.opportunity.validationSteps} />
              <ListSection title="机会依据" items={recommendation.opportunity.evidence} />
            </>
          )}
          {recommendation.repo.description && (
            <DetailSection title="GitHub 原始描述">{recommendation.repo.description}</DetailSection>
          )}
          <ListSection title="推荐原因" items={recommendation.reasons} />
          <ListSection title="匹配信号" items={buildMatchSignals(recommendation)} />
          <ListSection title="风险点" items={recommendation.risks} />
          <ListSection title="关联我的项目" items={recommendation.relatedUserRepos.map((repo) => `${repo.fullName}: ${repo.reason}`)} />
          <ListSection
            title="同组类似项目"
            items={similarRecommendations.slice(0, 8).map((item) => `${item.repo.fullName}：${getRecommendationSummaryZh(item)}`)}
          />
        </div>
      </aside>
    </div>
  );
}

function RecommendationTagDialog({
  recommendation,
  recommendations,
  onClose,
  onUpdated
}: {
  recommendation: Recommendation;
  recommendations: Recommendation[];
  onClose: () => void;
  onUpdated: (recommendation: Recommendation) => void;
}) {
  const existingTags = useMemo(
    () => [...new Set(recommendations.flatMap((item) => item.tags ?? []))].sort((a, b) => a.localeCompare(b)),
    [recommendations]
  );
  const [tags, setTags] = useState<string[]>(recommendation.tags ?? []);
  const [newTag, setNewTag] = useState("");
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  function toggleTag(tag: string) {
    setTags((current) =>
      current.includes(tag)
        ? current.filter((item) => item !== tag)
        : [...current, tag]
    );
  }

  function addTag() {
    const tag = newTag.trim();
    if (!tag || tags.includes(tag)) {
      setNewTag("");
      return;
    }
    setTags((current) => [...current, tag].slice(0, 20));
    setNewTag("");
  }

  async function saveTags(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setMessage("正在保存标签...");
    try {
      const response = await fetch(`/api/recommendations/${recommendation.id}/tags`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(body.error ?? "标签保存失败。");
        return;
      }
      onUpdated(body);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal-panel wide-modal" onSubmit={saveTags}>
        <div className="panel-header">
          <div className="panel-title">
            <h2>项目标签</h2>
            <p>{recommendation.repo.fullName}</p>
          </div>
          <button className="button icon" type="button" onClick={onClose} title="关闭" aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="list-panel">
          {message && <div className="notice">{message}</div>}
          <div className="tag-editor-row">
            <input
              className="input"
              value={newTag}
              onChange={(event) => setNewTag(event.target.value)}
              placeholder="新增标签，例如：SaaS、RAG、待验证"
            />
            <button className="button" type="button" onClick={addTag}>新增</button>
          </div>
          <div className="row-item">
            <strong>已选标签</strong>
            <TagList items={tags} />
          </div>
          <div className="row-item">
            <strong>选择已有标签</strong>
            <div className="tag-choice-list">
              {existingTags.length === 0 ? (
                <span className="muted">暂无已添加过的标签。</span>
              ) : existingTags.map((tag) => (
                <button
                  className={`tag-choice ${tags.includes(tag) ? "active" : ""}`}
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
          <div className="form-actions">
            <button className="button" type="button" onClick={onClose}>关闭</button>
            <button className="button primary" type="submit" disabled={isSaving}>
              {isSaving ? "保存中" : "保存标签"}
            </button>
          </div>
        </div>
      </form>
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
  const [opportunity, setOpportunity] = useState(normalizeOpportunityProfile(selectedProfile?.config.opportunity));
  const [resourcePolicy, setResourcePolicy] = useState(selectedProfile?.config.resourcePolicy);
  const [naturalLanguagePrompt, setNaturalLanguagePrompt] = useState("");
  const [naturalLanguageMode, setNaturalLanguageMode] = useState<"merge" | "replace">("merge");
  const [naturalLanguagePreview, setNaturalLanguagePreview] = useState<NaturalLanguagePreview | null>(null);
  const [isGeneratingPreferences, setIsGeneratingPreferences] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const chatProviders = providers.filter((provider) => provider.kind === "chat" && provider.enabled);
  const embeddingProviders = providers.filter((provider) => provider.kind === "embedding" && provider.enabled);
  const plannedAdapters = discoverySourceCatalog.filter((source) => source.capability === "planned_adapter");

  useEffect(() => {
    if (!selectedProfile) return;
    setEnabled(selectedProfile.enabled);
    setChatProviderId(selectedProfile.config.ai.chatProviderId);
    setEmbeddingProviderId(selectedProfile.config.ai.embeddingProviderId);
    setSources(normalizeDiscoverySources(selectedProfile.config.sources));
    setSchedule(selectedProfile.config.schedule);
    setLimits(selectedProfile.config.limits);
    setPreferences(selectedProfile.config.preferences);
    setOpportunity(normalizeOpportunityProfile(selectedProfile.config.opportunity));
    setResourcePolicy(selectedProfile.config.resourcePolicy);
    setNaturalLanguagePreview(null);
  }, [selectedProfile]);

  function updateSource(id: string, patch: { enabled?: boolean; weight?: number }) {
    setSources((current) =>
      current.map((source) => (source.id === id ? { ...source, ...patch } : source))
    );
  }

  async function saveProfile() {
    if (!selectedProfile || !schedule || !limits || !preferences || !resourcePolicy) return;
    setIsSavingProfile(true);
    setMessage("正在保存发现配置...");
    const nextConfig = {
      ...selectedProfile.config,
      schedule,
      limits,
      preferences,
      opportunity,
      resourcePolicy,
      sources,
      ai: {
        chatProviderId,
        embeddingProviderId
      }
    };
    try {
    const response = await fetch(`/api/profiles/${selectedProfile.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, config: nextConfig })
    });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        onUpdated(body);
        setMessage("发现配置已保存。");
      } else {
        setMessage(body.error ?? "发现配置保存失败。");
      }
    } catch (error) {
      setMessage(error instanceof Error ? `发现配置保存失败：${error.message}` : "发现配置保存失败。");
    } finally {
      setIsSavingProfile(false);
    }
  }

  async function generatePreferencesFromText() {
    if (!selectedProfile || !naturalLanguagePrompt.trim()) return;
    setIsGeneratingPreferences(true);
    setMessage("");
    try {
      const response = await fetch(`/api/profiles/${selectedProfile.id}/natural-language`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: naturalLanguagePrompt,
          mode: naturalLanguageMode
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(body.error ?? "生成发现条件失败。");
        return;
      }
      setNaturalLanguagePreview(body);
      setMessage("已生成发现条件预览，确认后可应用到当前表单。");
    } finally {
      setIsGeneratingPreferences(false);
    }
  }

  function applyGeneratedPreferences(mode: "merge" | "replace") {
    if (!naturalLanguagePreview || !preferences) return;
    const nextPreferences =
      mode === naturalLanguagePreview.mode
        ? naturalLanguagePreview.preview.preferences
        : mergePreferenceState(preferences, naturalLanguagePreview.generated, mode);
    setPreferences(nextPreferences);
    setNaturalLanguageMode(mode);
    setMessage(mode === "merge" ? "已合并生成条件，请保存发现配置。" : "已覆盖为生成条件，请保存发现配置。");
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
                <button className="button primary" type="button" onClick={saveProfile} disabled={isSavingProfile}>
                  {isSavingProfile ? <RefreshCw size={15} /> : <Save size={15} />}
                  {isSavingProfile ? "保存中" : "保存发现配置"}
                </button>
              </div>
            </div>
          )}
          {selectedProfile && schedule && limits && preferences && resourcePolicy && (
            <div className="stack">
            <section className="sub-panel">
              <div className="panel-header compact-header">
                <div className="panel-title">
                  <h3>AI 生成发现条件</h3>
                  <p>用中文描述想找的 GitHub 项目，系统会转换成关键词、topic、语言和过滤条件。</p>
                </div>
              </div>
              <div className="form-grid">
                <Field label="自然语言需求">
                  <textarea
                    className="input textarea"
                    value={naturalLanguagePrompt}
                    onChange={(event) => setNaturalLanguagePrompt(event.target.value)}
                    placeholder="例如：找最近半年活跃、适合做 AI agent 工作流编排的 TypeScript 项目，不要加密货币相关项目，stars 超过 500"
                  />
                </Field>
                <Field label="应用方式">
                  <select className="select" value={naturalLanguageMode} onChange={(event) => setNaturalLanguageMode(event.target.value as "merge" | "replace")}>
                    <option value="merge">合并到当前配置</option>
                    <option value="replace">覆盖当前配置</option>
                  </select>
                </Field>
                <div className="form-actions">
                  <button className="button primary" type="button" disabled={isGeneratingPreferences || !naturalLanguagePrompt.trim()} onClick={generatePreferencesFromText}>
                    {isGeneratingPreferences ? <RefreshCw size={15} /> : <Brain size={15} />}
                    生成条件
                  </button>
                </div>
              </div>
              {naturalLanguagePreview && (
                <div className="preview-block">
                  <PreferencePreview preferences={naturalLanguagePreview.preview.preferences} notes={naturalLanguagePreview.generated.notes ?? []} />
                  <QueryPlanPreview plans={naturalLanguagePreview.preview.queryPlans} />
                  <div className="action-row wrap">
                    <button className="button" type="button" onClick={() => applyGeneratedPreferences("merge")}>合并应用</button>
                    <button className="button" type="button" onClick={() => applyGeneratedPreferences("replace")}>覆盖应用</button>
                  </div>
                </div>
              )}
            </section>
            <section className="sub-panel">
              <div className="panel-header compact-header">
                <div className="panel-title">
                  <h3>变现机会配置</h3>
                  <p>把发现目标从技术兴趣切换为可验证、可交付、可变现的项目机会。</p>
                </div>
              </div>
              <div className="form-grid">
                <Field label="变现目标">
                  <input className="input" value={opportunity.goals.join(", ")} onChange={(event) => setOpportunity({ ...opportunity, goals: splitCsv(event.target.value) })} />
                </Field>
                <Field label="目标客户">
                  <input className="input" value={opportunity.targetCustomers.join(", ")} onChange={(event) => setOpportunity({ ...opportunity, targetCustomers: splitCsv(event.target.value) })} />
                </Field>
                <Field label="变现方式">
                  <input className="input" value={opportunity.monetizationChannels.join(", ")} onChange={(event) => setOpportunity({ ...opportunity, monetizationChannels: splitCsv(event.target.value) })} />
                </Field>
                <Field label="偏好优势">
                  <input className="input" value={opportunity.preferredAdvantages.join(", ")} onChange={(event) => setOpportunity({ ...opportunity, preferredAdvantages: splitCsv(event.target.value) })} />
                </Field>
                <Field label="排除信号">
                  <input className="input" value={opportunity.excludeSignals.join(", ")} onChange={(event) => setOpportunity({ ...opportunity, excludeSignals: splitCsv(event.target.value) })} />
                </Field>
                <Field label="最低机会分">
                  <input className="input" type="number" min={0} max={1} step={0.05} value={opportunity.minOpportunityScore} onChange={(event) => setOpportunity({ ...opportunity, minOpportunityScore: Number(event.target.value) })} />
                </Field>
              </div>
            </section>
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
              <Field label="漏跑策略">
                <select className="select" value={schedule.missedRunPolicy} onChange={(event) => setSchedule({ ...schedule, missedRunPolicy: event.target.value as DiscoveryProfile["config"]["schedule"]["missedRunPolicy"] })}>
                  <option value="skip">跳过漏跑周期</option>
                  <option value="run_once">补跑一次</option>
                  <option value="resume">按漏跑周期补跑</option>
                </select>
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
              <Field label="LLM 语义阈值">
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={limits.semanticFitThreshold ?? 0.42}
                  onChange={(event) => setLimits({ ...limits, semanticFitThreshold: Number(event.target.value) })}
                />
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
            </div>
          )}
          {selectedProfile && (
            <div className="list-panel source-planned-list">
              <strong>待接入 adapter</strong>
              <span className="muted">这些来源可以先保存启用状态和权重，但当前不会生成真实扫描查询。</span>
              <TagList items={plannedAdapters.map((source) => source.label)} />
            </div>
          )}
          {selectedProfile && (
            <div className="source-grid">
              {discoverySourceCatalog.map((definition) => {
                const source = sources.find((item) => item.id === definition.id);
                return (
                  <div className="source-item" key={definition.id}>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={source?.enabled ?? false}
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

  async function updateJob(jobId: string, action: "pause" | "resume" | "complete") {
    setBusyJobId(jobId);
    try {
      const response = await fetch(`/api/scans/${jobId}/${action}`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        onJobUpdated(body);
        setMessage(
          action === "pause"
            ? "扫描任务已暂停。"
            : action === "resume"
              ? "扫描任务已恢复。"
              : "扫描任务已手动完成。"
        );
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
                <th>新增项目</th>
                <th>更新项目</th>
                <th>未变化</th>
                <th>候选项目</th>
                <th>失败项目</th>
                <th>已处理</th>
                <th>已分析</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 ? (
                <tr><td colSpan={12} className="muted">暂无扫描任务</td></tr>
              ) : (
                jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{job.type}</td>
                    <td title={job.statusReason ?? job.errorMessage ?? undefined}>
                      <span className={`status ${job.status}`}>{job.status}</span>
                      {(job.statusReason || job.errorMessage) && <div className="muted">{job.statusReason ?? job.errorMessage}</div>}
                    </td>
                    <td>{job.stage}</td>
                    <td>{job.fetchedCount}</td>
                    <td>{job.newRepoCount}</td>
                    <td>{job.updatedRepoCount}</td>
                    <td>{job.unchangedRepoCount}</td>
                    <td>{job.candidateCount} / {job.maxCandidates}</td>
                    <td>{job.failedCandidateCount}</td>
                    <td>{job.processedCount}</td>
                    <td>{job.analyzedCount}</td>
                    <td>
                      <div className="action-row">
                        {canPauseJob(job.status) && <button className="button" disabled={busyJobId === job.id} onClick={() => updateJob(job.id, "pause")} type="button">暂停</button>}
                        {canResumeJob(job.status) && <button className="button" disabled={busyJobId === job.id} onClick={() => updateJob(job.id, "resume")} type="button">恢复</button>}
                        {canCompleteJob(job.status) && <button className="button" disabled={busyJobId === job.id} onClick={() => updateJob(job.id, "complete")} type="button">完成</button>}
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
  settings,
  accounts,
  repos,
  onSettingsChanged,
  onRepoUpdated,
  onSynced
}: {
  settings: DashboardSnapshot["settings"];
  accounts: GithubAccount[];
  repos: UserGitHubRepo[];
  onSettingsChanged: (settings: DashboardSnapshot["settings"]) => void;
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

  async function toggleAutoSync(enabled: boolean) {
    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubAutoSyncEnabled: enabled })
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      onSettingsChanged(body);
      setMessage(enabled ? "GitHub 每日被动同步已开启。" : "GitHub 每日被动同步已关闭。");
    } else {
      setMessage(body.error ?? "GitHub 自动同步设置更新失败。");
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
          <strong>被动同步</strong>
          <span className="muted">
            每 {settings.githubAutoSyncIntervalHours} 小时最多同步一次
            {settings.githubLastAutoSyncedAt ? `，上次成功：${formatTime(settings.githubLastAutoSyncedAt)}` : "，尚未自动同步"}
          </span>
          <div className="action-row wrap">
            <label className="switch-row">
              <input
                type="checkbox"
                checked={settings.githubAutoSyncEnabled}
                onChange={(event) => void toggleAutoSync(event.target.checked)}
              />
              <span>每日同步 GitHub</span>
            </label>
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
  const [editingProvider, setEditingProvider] = useState<AiProvider | "new" | null>(null);
  const [message, setMessage] = useState("");

  async function saveProvider(input: AiProviderFormValue) {
    const isEditing = input.id !== undefined;
    const response = await fetch(isEditing ? `/api/ai-providers/${input.id}` : "/api/ai-providers", {
      method: isEditing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        kind: input.kind,
        type: "openai_compatible",
        baseUrl: input.baseUrl,
        apiKeyEnv: input.apiKeyEnv,
        apiKeyValue: input.apiKeyValue || undefined,
        model: input.model,
        dimensions: input.kind === "embedding" ? input.dimensions : undefined,
        enabled: input.enabled
      })
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      onChanged(body);
      setMessage(isEditing ? "AI 配置已修改。" : "AI 配置已创建。");
      setEditingProvider(null);
      return;
    }

    throw new Error(body.error ?? (isEditing ? "修改失败。" : "创建失败。"));
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
            <h2>AI 配置</h2>
            <p>Chat 和 Embedding 分开配置；Base URL、模型和 API Key 在一个地方维护。</p>
          </div>
          <button className="button primary" type="button" onClick={() => setEditingProvider("new")}>
            新增 AI 配置
          </button>
        </div>
        <div className="list-panel">
          {message && <div className="notice">{message}</div>}
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
                  <td><div className="action-row"><button className="button" onClick={() => setEditingProvider(provider)} type="button">修改</button><button className="button" onClick={() => patchProvider(provider)} type="button">{provider.enabled ? "停用" : "启用"}</button><button className="button" onClick={() => testProvider(provider)} type="button">测试</button><button className="button" onClick={() => deleteProvider(provider)} type="button">删除</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {editingProvider && (
        <AiProviderDialog
          provider={editingProvider === "new" ? undefined : editingProvider}
          onClose={() => setEditingProvider(null)}
          onSave={saveProvider}
        />
      )}
    </div>
  );
}

interface AiProviderFormValue {
  id?: string;
  name: string;
  kind: "chat" | "embedding";
  baseUrl: string;
  apiKeyEnv: string;
  apiKeyValue: string;
  model: string;
  dimensions: number;
  enabled: boolean;
}

function AiProviderDialog({
  provider,
  onClose,
  onSave
}: {
  provider?: AiProvider;
  onClose: () => void;
  onSave: (input: AiProviderFormValue) => Promise<void>;
}) {
  const [kind, setKind] = useState<"chat" | "embedding">(provider?.kind ?? "chat");
  const [name, setName] = useState(provider?.name ?? "新建 Chat 配置");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "https://api.example.com/v1");
  const [apiKeyEnv, setApiKeyEnv] = useState(provider?.apiKeyEnv ?? "CHAT_API_KEY");
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [model, setModel] = useState(provider?.model ?? "chat-model");
  const [dimensions, setDimensions] = useState(provider?.dimensions ?? 1536);
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const isEditing = Boolean(provider);

  function switchKind(nextKind: "chat" | "embedding") {
    setKind(nextKind);
    if (!isEditing) {
      setName(nextKind === "chat" ? "新建 Chat 配置" : "新建 Embedding 配置");
      setApiKeyEnv(nextKind === "chat" ? "CHAT_API_KEY" : "EMBEDDING_API_KEY");
      setModel(nextKind === "chat" ? "chat-model" : "embedding-model");
      setDimensions(nextKind === "embedding" ? 4096 : 1536);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setMessage(isEditing ? "正在保存 AI 配置..." : "正在创建 AI 配置...");
    try {
      await onSave({
        id: provider?.id,
        name,
        kind,
        baseUrl,
        apiKeyEnv,
        apiKeyValue,
        model,
        dimensions,
        enabled
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "AI 配置保存失败。");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal-panel wide-modal" onSubmit={submit}>
        <div className="panel-header">
          <div className="panel-title">
            <h2>{isEditing ? "修改 AI 配置" : "新增 AI 配置"}</h2>
            <p>API Key 只写入服务器 `.env.local`，不在数据库中保存明文。</p>
          </div>
          <button className="button icon" type="button" onClick={onClose} title="关闭" aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="form-grid provider-dialog-grid">
          {message && <div className="notice">{message}</div>}
          <Field label="类型">
            <select className="select" value={kind} disabled={isEditing} onChange={(event) => switchKind(event.target.value as "chat" | "embedding")}>
              <option value="chat">chat</option>
              <option value="embedding">embedding</option>
            </select>
          </Field>
          <Field label="名称"><input className="input" value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="Base URL"><input className="input" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></Field>
          <Field label="API key 环境变量名"><input className="input" value={apiKeyEnv} onChange={(event) => setApiKeyEnv(event.target.value)} /></Field>
          <Field label={isEditing ? "新 API Key（可不填）" : "API Key"}>
            <input className="input" type="password" value={apiKeyValue} onChange={(event) => setApiKeyValue(event.target.value)} />
          </Field>
          <Field label="模型"><input className="input" value={model} onChange={(event) => setModel(event.target.value)} /></Field>
          {kind === "embedding" && (
            <Field label="向量维度"><input className="input" type="number" min={1} value={dimensions} onChange={(event) => setDimensions(Number(event.target.value))} /></Field>
          )}
          <label className="field checkbox-field">
            <span>状态</span>
            <span className="checkbox-row">
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
              启用
            </span>
          </label>
          <div className="form-actions">
            <button className="button" type="button" onClick={onClose}>关闭</button>
            <button className="button primary" type="submit" disabled={isSaving}>
              {isSaving ? "保存中" : isEditing ? "保存修改" : "创建配置"}
            </button>
          </div>
        </div>
      </form>
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
  const [message, setMessage] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [target, setTarget] = useState("local-derived-index");
  const [minScore, setMinScore] = useState(0.8);
  const candidates = recommendations.filter((item) =>
    ["liked", "tracked", "to_validate", "validating", "monetization_ready"].includes(item.status) ||
    item.scores.final >= minScore
  );

  async function runSync() {
    setIsSyncing(true);
    try {
      const response = await fetch("/api/knowledge-syncs/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, minScore })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(body.error ?? "知识库同步失败。");
        return;
      }

      const syncResponse = await fetch("/api/knowledge-syncs");
      if (syncResponse.ok) onSyncsChanged(await syncResponse.json());
      setMessage(`同步完成：新增 ${body.syncedCount}，跳过 ${body.skippedCount}，失败 ${body.failedCount ?? 0}。`);
    } finally {
      setIsSyncing(false);
    }
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title"><h2>知识库同步</h2><p>当前作为可选派生能力，fetchGithub 仍是发现结果和评分来源。</p></div>
          <div className="action-row wrap">
            <select className="select" value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="local-derived-index">本地派生索引</option>
              <option value="ai-knowledge-base">ai-knowledge-base</option>
            </select>
            <input className="input compact-input" type="number" min={0} max={1} step={0.05} value={minScore} onChange={(event) => setMinScore(Number(event.target.value))} />
            <button className="button primary" type="button" disabled={isSyncing} onClick={runSync}>
              {isSyncing ? <RefreshCw size={15} /> : <Database size={15} />}
              同步 L4
            </button>
          </div>
        </div>
        <div className="list-panel">
          {message && <div className="notice">{message}</div>}
          <div className="row-item"><strong>同步范围</strong><span className="muted">L4 项目：已喜欢、已跟踪，或最终分数不低于 {Math.round(minScore * 100)}。</span></div>
          <div className="row-item"><strong>当前目标</strong><span className="muted">{target === "ai-knowledge-base" ? "写入同级 ai-knowledge-base 派生文档目录" : "仅记录 fetchGithub 派生索引状态"}</span></div>
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
            <thead><tr><th>项目</th><th>目标</th><th>状态</th><th>同步时间</th><th>错误</th></tr></thead>
            <tbody>
              {syncs.length === 0 ? <tr><td colSpan={5} className="muted">暂无同步记录</td></tr> : syncs.map((sync) => (
                <tr key={sync.id}><td>{sync.repoFullName ?? sync.repoId}</td><td>{sync.target}</td><td>{sync.status}</td><td>{sync.syncedAt ? formatTime(sync.syncedAt) : "-"}</td><td className="muted">{sync.errorMessage ?? "-"}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function OperationsPanel({
  operations,
  queueStats,
  onRefresh
}: {
  operations: DashboardSnapshot["operations"];
  queueStats: DashboardSnapshot["queueStats"];
  onRefresh: () => Promise<void>;
}) {
  const [dismissedAlerts, setDismissedAlerts] = useState<string[]>(() => readDismissedOperationAlerts());
  const alerts = buildOperationAlerts(operations, queueStats).filter(
    (alert) => !dismissedAlerts.includes(alert.id)
  );
  function dismissAlert(id: string) {
    setDismissedAlerts((current) => {
      const next = [...new Set([...current, id])];
      writeDismissedOperationAlerts(next);
      return next;
    });
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <h2>运行观测</h2>
            <p>查看低内存调节、候选队列、AI 作业和估算成本。</p>
          </div>
          <button className="button" type="button" onClick={() => void onRefresh()}>
            <RefreshCw size={15} />
            刷新
          </button>
        </div>
        <div className="summary-grid inline-summary">
          <SummaryTile icon={Activity} label="资源事件" value={operations.resourceEvents.length} />
          <SummaryTile icon={Brain} label="AI 作业" value={operations.aiCostSummary.totalJobs} />
          <SummaryTile
            icon={Database}
            label="Token 用量"
            value={formatTokenTotal(operations.aiCostSummary.totalTokens, operations.aiCostSummary.unknownJobCount)}
          />
          <SummaryTile icon={BarChart3} label="估算成本 USD" value={formatUsd(operations.aiCostSummary.estimatedCostUsd)} />
        </div>
        {alerts.length > 0 && (
          <div className="alert-list">
            {alerts.map((alert) => (
              <div className={`alert ${alert.level}`} key={alert.id}>
                <span>{alert.text}</span>
                <button
                  className="alert-close"
                  type="button"
                  onClick={() => dismissAlert(alert.id)}
                  aria-label="关闭提示"
                  title="关闭提示"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <CollapsiblePanel title="资源调节事件" subtitle="ResourceGovernor 记录的批量大小和内存状态。">
        <div className="table-wrap module-scroll">
          <table className="repo-table">
            <thead><tr><th>时间</th><th>任务</th><th>阶段</th><th>状态</th><th>可用 MB</th><th>RSS MB</th><th>批量</th><th>原因</th></tr></thead>
            <tbody>
              {operations.resourceEvents.length === 0 ? <tr><td colSpan={8} className="muted">暂无资源事件</td></tr> : operations.resourceEvents.map((event) => (
                <tr key={event.id}>
                  <td>{formatTime(event.createdAt)}</td>
                  <td>{event.jobId}</td>
                  <td>{event.stage}</td>
                  <td>{event.status}</td>
                  <td>{event.availableMb}</td>
                  <td>{event.rssMb}</td>
                  <td>{event.batchSize}</td>
                  <td className="muted">{event.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CollapsiblePanel>

      <CollapsiblePanel title="AI 作业与成本" subtitle="成本按 provider 可选 pricing 配置估算；未配置价格时为 0。">
        <div className="table-wrap module-scroll">
          <table className="repo-table">
            <thead><tr><th>时间</th><th>项目</th><th>Provider</th><th>模型</th><th>状态</th><th>Prompt</th><th>Completion</th><th>成本</th></tr></thead>
            <tbody>
              {operations.aiJobs.length === 0 ? <tr><td colSpan={8} className="muted">暂无 AI 作业</td></tr> : operations.aiJobs.map((job) => (
                <tr key={job.id}>
                  <td>{formatTime(job.createdAt)}</td>
                  <td>{job.repoFullName ?? job.repoId}</td>
                  <td>{job.providerName ?? job.providerId}</td>
                  <td>{job.model}</td>
                  <td title={job.errorMessage ?? undefined}>
                    <span className={`status ${job.status}`}>{job.status}</span>
                  </td>
                  <td>{formatTokenValue(job.promptTokens, job.tokenUsageKnown)}</td>
                  <td>{formatTokenValue(job.completionTokens, job.tokenUsageKnown)}</td>
                  <td>{job.tokenUsageKnown ? formatUsd(job.estimatedCostUsd) : "未知"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CollapsiblePanel>

      <CollapsiblePanel title="失败原因" subtitle="最近失败的 AI 作业和候选队列原因，便于直接定位配置、限流或模型响应问题。">
        <FailureReasonsTable operations={operations} queueStats={queueStats} />
      </CollapsiblePanel>

      <CollapsiblePanel title="项目 Token 汇总" subtitle="按项目汇总最近 AI 分析 token，用于识别高消耗仓库。">
        <TokenSummaryTable rows={operations.repoTokenSummary} emptyText="暂无项目 Token 统计" />
      </CollapsiblePanel>

      <CollapsiblePanel title="扫描 Token 汇总" subtitle="按扫描任务汇总最近 AI 分析 token，用于查看单次扫描总消耗。">
        <TokenSummaryTable rows={operations.scanTokenSummary} emptyText="暂无扫描 Token 统计" />
      </CollapsiblePanel>

      <CollapsiblePanel title="候选队列" subtitle="扫描任务在各阶段的待处理、运行和重试数量。">
        <SimpleStatsTable
          rows={queueStats.map((stat) => [stat.stage, stat.status, String(stat.count)])}
          rowTitles={queueStats.map((stat) => stat.failureReasons?.join("\n") ?? "")}
          emptyText="暂无候选队列"
        />
      </CollapsiblePanel>
    </div>
  );
}

function CollapsiblePanel({
  title,
  subtitle,
  children,
  defaultOpen = true
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="panel collapsible-panel">
      <button className="panel-header collapsible-header" type="button" onClick={() => setOpen(!open)}>
        <div className="panel-title">
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open && children}
    </section>
  );
}

function IconButton({
  title,
  icon: Icon,
  onClick,
  active = false,
  tone
}: {
  title: string;
  icon: React.ComponentType<{ size?: number }>;
  onClick: () => void;
  active?: boolean;
  tone?: "positive" | "danger";
}) {
  return <button className={`button icon ${active ? "active" : ""} ${active && tone ? tone : ""}`} title={title} aria-label={title} onClick={onClick} type="button"><Icon size={15} /></button>;
}

function TagList({ items }: { items: string[] }) {
  return <div className="tags">{items.filter(Boolean).map((item, index) => <span className="tag" key={`${item}-${index}`}>{item}</span>)}</div>;
}

function PreferencePreview({
  preferences,
  notes
}: {
  preferences: DiscoveryProfile["config"]["preferences"];
  notes: string[];
}) {
  return (
    <div className="preview-grid">
      <PreviewItem label="关键词" value={preferences.keywords.join(", ") || "-"} />
      <PreviewItem label="Topics" value={preferences.topics.join(", ") || "-"} />
      <PreviewItem label="语言权重" value={formatLanguageWeights(preferences.languages) || "-"} />
      <PreviewItem label="排除关键词" value={preferences.excludeKeywords.join(", ") || "-"} />
      <PreviewItem label="最低 Stars" value={String(preferences.minStars)} />
      <PreviewItem label="最近推送天数" value={String(preferences.pushedWithinDays)} />
      <PreviewItem label="过滤" value={`${preferences.excludeArchived ? "排除 archived" : "允许 archived"}；${preferences.excludeForks ? "排除 fork" : "允许 fork"}`} />
      {notes.length > 0 && <PreviewItem label="说明" value={notes.join("；")} />}
    </div>
  );
}

function QueryPlanPreview({ plans }: { plans: GitHubSearchQueryPlan[] }) {
  return (
    <div className="query-preview">
      <div className="preview-heading">
        <strong>GitHub Search 查询计划</strong>
        <span className="muted">同一条 query 中多个普通关键词偏 AND；系统会拆成多条 query 提高召回。</span>
      </div>
      <div className="query-list">
        {plans.length === 0 ? (
          <span className="muted">暂无查询计划</span>
        ) : (
          plans.slice(0, 12).map((plan, index) => (
            <div className="query-row" key={`${plan.sourceId}-${plan.query}-${index}`}>
              <span>{plan.sourceLabel}</span>
              <code>{plan.query}</code>
              <small>{plan.sort} / 权重 {plan.weight}</small>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function PreviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="preview-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="detail-section"><h3>{title}</h3><p>{children}</p></section>;
}

function ListSection({ title, items }: { title: string; items: string[] }) {
  return <section className="detail-section"><h3>{title}</h3>{items.length === 0 ? <p>暂无</p> : <ul>{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>}</section>;
}

function ChecklistSection({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="detail-section">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p>暂无</p>
      ) : (
        <ul className="check-list">
          {items.map((item, index) => (
            <li key={`${item}-${index}`}>
              <input type="checkbox" aria-label={`验证步骤 ${index + 1}`} />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function buildMatchSignals(recommendation: Recommendation) {
  return [
    recommendation.matchedPreferences.length
      ? `命中偏好：${recommendation.matchedPreferences.join("、")}`
      : "",
    `主要语言：${recommendation.repo.primaryLanguage}`,
    `Stars：${recommendation.repo.stars.toLocaleString()}`,
    recommendation.repo.pushedAt
      ? `最近推送：${new Date(recommendation.repo.pushedAt).toLocaleDateString("zh-CN")}`
      : "",
    `机会分：${Math.round((recommendation.scores.opportunity ?? recommendation.scores.final) * 100)}，变现分：${Math.round((recommendation.scores.monetization ?? recommendation.scores.llmMatch) * 100)}，增长信号：${Math.round((recommendation.scores.growth ?? recommendation.scores.rule) * 100)}`,
    `规则分：${Math.round(recommendation.scores.rule * 100)}，上下文分：${Math.round(recommendation.scores.githubContextFit * 100)}，LLM 分：${Math.round(recommendation.scores.llmMatch * 100)}`
    , ...buildQualitySignalItems(recommendation)
  ].filter(Boolean);
}

function buildQualitySignalItems(recommendation: Recommendation) {
  const signals = recommendation.qualitySignals;
  if (!signals) {
    return [];
  }

  const items = [];
  if (signals.openssf?.score !== undefined) {
    items.push(`OpenSSF Scorecard：${signals.openssf.score.toFixed(1)}/10`);
  }
  if (signals.ecosystems) {
    const usages = [
      signals.ecosystems.dependentReposCount
        ? `依赖仓库 ${signals.ecosystems.dependentReposCount.toLocaleString()}`
        : "",
      signals.ecosystems.packagesCount
        ? `关联包 ${signals.ecosystems.packagesCount.toLocaleString()}`
        : "",
      signals.ecosystems.dockerDownloadsCount
        ? `Docker 下载 ${signals.ecosystems.dockerDownloadsCount.toLocaleString()}`
        : ""
    ].filter(Boolean);
    if (usages.length) {
      items.push(`ecosyste.ms：${usages.join("，")}`);
    }
  }

  return items;
}

type RecommendationStatusFilter =
  | "visible"
  | "all"
  | Recommendation["status"];

type OpportunityFilter = "all" | "has_opportunity" | "no_opportunity" | "observe" | "track" | "validate" | "build" | "ignore";
type GroupFilter = "all" | "grouped" | "ungrouped";
type PreferenceFilter = "all" | "liked" | "disliked" | "unrated";
type RecommendationSortKey = "rank" | "score" | "stars" | "semantic";
type SortDirection = "asc" | "desc";

interface RecommendationSortState {
  key: RecommendationSortKey;
  direction: SortDirection;
}

interface SemanticSearchState {
  ids: string[];
  scores: Record<string, number>;
  mode: "semantic" | "hybrid" | "lexical";
  warning?: string;
}

const recommendationStatusFilterOptions: Array<{ value: RecommendationStatusFilter; label: string }> = [
  { value: "visible", label: "可见项目" },
  { value: "all", label: "全部项目" },
  { value: "new", label: "新发现" },
  { value: "viewed", label: "已查看" },
  { value: "liked", label: "已喜欢" },
  { value: "disliked", label: "不喜欢" },
  { value: "tracked", label: "重点跟踪" },
  { value: "to_validate", label: "待验证" },
  { value: "validating", label: "验证中" },
  { value: "monetization_ready", label: "准备变现" },
  { value: "hidden", label: "已隐藏" },
  { value: "abandoned", label: "已放弃" }
];

const opportunityFilterOptions: Array<{ value: OpportunityFilter; label: string }> = [
  { value: "all", label: "全部机会" },
  { value: "has_opportunity", label: "有机会" },
  { value: "no_opportunity", label: "无机会" },
  { value: "observe", label: "观察" },
  { value: "track", label: "跟踪" },
  { value: "validate", label: "待验证" },
  { value: "build", label: "准备变现" },
  { value: "ignore", label: "放弃" }
];

const groupFilterOptions: Array<{ value: GroupFilter; label: string }> = [
  { value: "all", label: "全部分组" },
  { value: "grouped", label: "已分组" },
  { value: "ungrouped", label: "未分组" }
];

const preferenceFilterOptions: Array<{ value: PreferenceFilter; label: string }> = [
  { value: "all", label: "全部喜好" },
  { value: "liked", label: "已喜欢" },
  { value: "disliked", label: "不喜欢" },
  { value: "unrated", label: "未表态" }
];

function recommendationMatchesOpportunity(
  recommendation: Recommendation,
  filter: OpportunityFilter
) {
  const action = recommendation.opportunity?.suggestedAction;
  if (filter === "all") {
    return true;
  }
  if (filter === "has_opportunity") {
    return Boolean(action);
  }
  if (filter === "no_opportunity") {
    return !action;
  }
  return action === filter;
}

function recommendationMatchesGroup(
  recommendation: Recommendation,
  filter: GroupFilter,
  focusedClusterKey: string
) {
  if (focusedClusterKey) {
    return recommendation.cluster?.key === focusedClusterKey;
  }
  if (filter === "all") {
    return true;
  }
  if (filter === "grouped") {
    return Boolean(recommendation.cluster?.key);
  }
  return !recommendation.cluster?.key;
}

function recommendationMatchesStatus(
  recommendation: Recommendation,
  filter: RecommendationStatusFilter
) {
  if (filter === "all") {
    return true;
  }
  if (filter === "visible") {
    return recommendation.status !== "hidden";
  }
  return recommendation.status === filter;
}

function recommendationMatchesPreference(
  recommendation: Recommendation,
  filter: PreferenceFilter
) {
  if (filter === "all") {
    return true;
  }
  if (filter === "unrated") {
    return recommendation.status !== "liked" && recommendation.status !== "disliked";
  }
  return recommendation.status === filter;
}

function compareRecommendations(
  left: Recommendation,
  right: Recommendation,
  sortState: RecommendationSortState,
  semanticScores: Record<string, number>
) {
  const rankFallback = left.rank - right.rank;
  const direction = sortState.direction === "asc" ? 1 : -1;
  switch (sortState.key) {
    case "score":
      return direction * (left.scores.final - right.scores.final) || rankFallback;
    case "stars":
      return direction * (left.repo.stars - right.repo.stars) || rankFallback;
    case "semantic":
      return direction * ((semanticScores[left.id] ?? 0) - (semanticScores[right.id] ?? 0)) || rankFallback;
    case "rank":
      return direction * (left.rank - right.rank) || rankFallback;
  }
}

function opportunityFeedbackAction(recommendation: Recommendation): { action: FeedbackAction; label: string } | null {
  if (recommendation.status === "hidden" || recommendation.status === "abandoned") {
    return null;
  }
  switch (recommendation.opportunity?.suggestedAction) {
    case "validate":
      return recommendation.status === "to_validate" ? null : { action: "to_validate", label: "待验证" };
    case "build":
      return recommendation.status === "monetization_ready" ? null : { action: "monetization_ready", label: "准备变现" };
    case "track":
      return recommendation.status === "tracked" ? null : { action: "track", label: "跟踪" };
    case "ignore":
      return { action: "abandon", label: "放弃" };
    case "observe":
    case undefined:
      return recommendation.status === "liked" ? null : { action: "like", label: "喜欢观察" };
  }
}

function renderSortIcon(sortState: RecommendationSortState, key: RecommendationSortKey) {
  if (sortState.key !== key) {
    return <ArrowUpDown size={14} />;
  }
  return sortState.direction === "asc" ? <ArrowUp size={14} /> : <ArrowDown size={14} />;
}

const DISMISSED_OPERATION_ALERTS_KEY = "fetchGithub:dismissedOperationAlerts";

function readDismissedOperationAlerts() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(DISMISSED_OPERATION_ALERTS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function writeDismissedOperationAlerts(ids: string[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(DISMISSED_OPERATION_ALERTS_KEY, JSON.stringify(ids));
}

function buildOperationAlerts(
  operations: DashboardSnapshot["operations"],
  queueStats: DashboardSnapshot["queueStats"]
) {
  const alerts: Array<{ id: string; level: "warning" | "danger"; text: string }> = [];
  const failedAiJobs = operations.aiJobs.filter((job) => job.status === "failed");
  const retryQueue = queueStats
    .filter((stat) => stat.status === "failed" || stat.status === "pending")
    .filter((stat) => stat.stage === "llm" || stat.stage === "embed");
  const pressureEvents = operations.resourceEvents.filter(
    (event) => event.status === "paused_by_memory" || event.status === "throttled"
  );
  const rateLimitJobs = operations.aiJobs.filter((job) =>
    `${job.providerName ?? ""} ${job.model} ${job.status}`.toLowerCase().includes("rate")
  );

  if (pressureEvents.length > 0) {
    alerts.push({
      id: "resource-pressure",
      level: pressureEvents.some((event) => event.status === "paused_by_memory") ? "danger" : "warning",
      text: `资源调节触发 ${pressureEvents.length} 次，最近一次：${pressureEvents[0].reason}`
    });
  }
  if (failedAiJobs.length > 0) {
    alerts.push({
      id: "ai-job-failed",
      level: "danger",
      text: `最近有 ${failedAiJobs.length} 个 AI 作业失败，请检查 provider、API key 或模型响应。`
    });
  }
  if (rateLimitJobs.length > 0) {
    alerts.push({
      id: "rate-limit",
      level: "warning",
      text: `检测到疑似 rate limit，请降低批量或调整 provider 限速配置。`
    });
  }
  for (const stat of retryQueue.slice(0, 3)) {
    if (stat.count > 0) {
      alerts.push({
        id: `queue-${stat.stage}-${stat.status}`,
        level: stat.status === "failed" ? "danger" : "warning",
        text: `${stat.stage} 阶段 ${stat.status} 队列还有 ${stat.count} 个候选。`
      });
    }
  }

  return alerts.slice(0, 5);
}

function recommendationStatusText(status: Recommendation["status"]) {
  switch (status) {
    case "new":
      return "新发现";
    case "viewed":
      return "已查看";
    case "saved":
      return "已收藏";
    case "liked":
      return "已喜欢";
    case "disliked":
      return "不喜欢";
    case "hidden":
      return "已隐藏";
    case "tracked":
      return "重点跟踪";
    case "to_validate":
      return "待验证";
    case "validating":
      return "验证中";
    case "monetization_ready":
      return "准备变现";
    case "abandoned":
      return "已放弃";
  }
}

function statusFromFeedbackAction(
  action: FeedbackAction,
  fallback: Recommendation["status"]
): Recommendation["status"] {
  switch (action) {
    case "save":
      return "saved";
    case "hide":
      return "hidden";
    case "restore":
      return "viewed";
    case "track":
      return "tracked";
    case "to_validate":
      return "to_validate";
    case "validating":
      return "validating";
    case "monetization_ready":
      return "monetization_ready";
    case "abandon":
      return "abandoned";
    case "like":
      return "liked";
    case "dislike":
      return "disliked";
  }
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

function SimpleStatsTable({
  rows,
  rowTitles = [],
  emptyText
}: {
  rows: string[][];
  rowTitles?: string[];
  emptyText: string;
}) {
  return (
    <div className="table-wrap">
      <table className="repo-table">
        <thead><tr><th>阶段</th><th>状态</th><th>数量</th></tr></thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={3} className="muted">{emptyText}</td></tr>
          ) : (
            rows.map((row, rowIndex) => (
              <tr key={row.join("-")} title={rowTitles[rowIndex] || undefined}>
                {row.map((cell, index) => <td key={index}>{cell}</td>)}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function TokenSummaryTable({
  rows,
  emptyText
}: {
  rows: DashboardSnapshot["operations"]["repoTokenSummary"];
  emptyText: string;
}) {
  return (
    <div className="table-wrap module-scroll">
      <table className="repo-table">
        <thead>
          <tr>
            <th>对象</th>
            <th>AI 作业</th>
            <th>Prompt</th>
            <th>Completion</th>
            <th>Total</th>
            <th>未知</th>
            <th>成本</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={7} className="muted">{emptyText}</td></tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                <td>{row.label}</td>
                <td>{row.jobCount}</td>
                <td>{row.promptTokens.toLocaleString()}</td>
                <td>{row.completionTokens.toLocaleString()}</td>
                <td>{row.totalTokens.toLocaleString()}</td>
                <td>{row.unknownJobCount > 0 ? `${row.unknownJobCount} 个作业` : "-"}</td>
                <td>{formatUsd(row.estimatedCostUsd)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function FailureReasonsTable({
  operations,
  queueStats
}: {
  operations: DashboardSnapshot["operations"];
  queueStats: DashboardSnapshot["queueStats"];
}) {
  const rows = [
    ...operations.aiJobs
      .filter((job) => job.status === "failed" && job.errorMessage)
      .map((job) => ({
        id: `ai-${job.id}`,
        type: "AI 作业",
        target: job.repoFullName ?? job.repoId,
        status: job.status,
        reason: job.errorMessage ?? ""
      })),
    ...queueStats
      .filter((stat) => (stat.failureReasons?.length ?? 0) > 0)
      .flatMap((stat) =>
        (stat.failureReasons ?? []).map((reason, index) => ({
          id: `queue-${stat.stage}-${stat.status}-${index}`,
          type: "候选队列",
          target: `${stat.stage}/${stat.status}`,
          status: `${stat.count} 个`,
          reason
        }))
      )
  ].slice(0, 50);

  return (
    <div className="table-wrap module-scroll">
      <table className="repo-table">
        <thead><tr><th>类型</th><th>对象</th><th>状态</th><th>原因</th></tr></thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={4} className="muted">暂无失败原因</td></tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                <td>{row.type}</td>
                <td>{row.target}</td>
                <td>{row.status}</td>
                <td className="muted">{row.reason}</td>
              </tr>
            ))
          )}
        </tbody>
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

function canCompleteJob(status: string) {
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

function formatUsd(value: number) {
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

function formatTokenValue(value: number, known: boolean) {
  return known ? value.toLocaleString() : "未知";
}

function formatTokenTotal(value: number, unknownJobCount: number) {
  const known = value.toLocaleString();
  return unknownJobCount > 0 ? `${known} / ${unknownJobCount} 未知` : known;
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
      return "待接入 adapter，可保存";
    case "quality_signal":
      return "质量评分信号，可保存";
    default:
      return capability;
  }
}

function sectionTitle(section: Section) {
  return sectionLabel(section);
}

function mergePreferenceState(
  current: DiscoveryProfile["config"]["preferences"],
  generated: GeneratedPreferences,
  mode: "merge" | "replace"
): DiscoveryProfile["config"]["preferences"] {
  if (mode === "replace") {
    return {
      keywords: uniqueStrings(generated.keywords).slice(0, 10),
      topics: uniqueStrings(generated.topics).slice(0, 10),
      languages: limitLanguages(generated.languages),
      excludeKeywords: uniqueStrings(generated.excludeKeywords).slice(0, 10),
      minStars: generated.minStars,
      pushedWithinDays: generated.pushedWithinDays,
      excludeArchived: generated.excludeArchived,
      excludeForks: generated.excludeForks
    };
  }

  return {
    keywords: uniqueStrings([...current.keywords, ...generated.keywords]).slice(0, 10),
    topics: uniqueStrings([...current.topics, ...generated.topics]).slice(0, 10),
    languages: limitLanguages({ ...current.languages, ...generated.languages }),
    excludeKeywords: uniqueStrings([...current.excludeKeywords, ...generated.excludeKeywords]).slice(0, 10),
    minStars: generated.minStars || current.minStars,
    pushedWithinDays: generated.pushedWithinDays || current.pushedWithinDays,
    excludeArchived: generated.excludeArchived,
    excludeForks: generated.excludeForks
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function limitLanguages(values: Record<string, number>) {
  return Object.fromEntries(Object.entries(values).slice(0, 6));
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
    case "operations":
      return "查看资源调节、队列积压、AI 作业和成本估算。";
  }
}
