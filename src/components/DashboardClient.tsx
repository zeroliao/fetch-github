"use client";

import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Brain,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Compass,
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
  SlidersHorizontal,
  Star,
  ThumbsDown,
  ThumbsUp,
  ClipboardCheck,
  X,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  sectionDefinitions,
  sectionFromPath,
  sectionLabel,
  sectionPath,
  type Section,
} from "@/lib/navigation";
import {
  normalizeOpportunityProfile,
  opportunityActionText,
} from "@/lib/opportunity";
import { getRecommendationSummaryZh } from "@/lib/recommendationText";
import type {
  AiProvider,
  DashboardSnapshot,
  DiscoveryProfile,
  FeedbackAction,
  GithubAccount,
  KnowledgeSync,
  Recommendation,
  ScanJob,
  UserGitHubRepo,
} from "@/lib/types";

const sectionIcons: Record<Section, React.ComponentType<{ size?: number }>> = {
  recommendations: Search,
  profiles: Settings,
  jobs: Activity,
  github: GitBranch,
  providers: Brain,
  knowledge: Database,
  operations: BarChart3,
};

const sections = sectionDefinitions.map((section) => ({
  ...section,
  icon: sectionIcons[section.id],
}));

const navigationGroups: Array<{ label: string; items: Section[] }> = [
  { label: "发现", items: ["recommendations", "profiles"] },
  { label: "数据与同步", items: ["github", "knowledge"] },
  { label: "系统", items: ["providers", "operations"] },
];

export function DashboardClient({
  initialData,
  initialSection = "recommendations",
}: {
  initialData: DashboardSnapshot;
  initialSection?: Section;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const activeSection = sectionFromPath(pathname) ?? initialSection;
  const [profiles, setProfiles] = useState(initialData.profiles);
  const [providers, setProviders] = useState(initialData.aiProviders);
  const [recommendations, setRecommendations] = useState(
    initialData.recommendations,
  );
  const [jobs, setJobs] = useState(initialData.jobs);
  const [githubAccounts, setGithubAccounts] = useState(
    initialData.githubAccounts,
  );
  const [githubRepos, setGithubRepos] = useState(initialData.githubRepos);
  const [knowledgeSyncs, setKnowledgeSyncs] = useState(
    initialData.knowledgeSyncs,
  );
  const [queueStats, setQueueStats] = useState(initialData.queueStats);
  const [operations, setOperations] = useState(initialData.operations);
  const [settings, setSettings] = useState(initialData.settings);
  const [selectedProfileId, setSelectedProfileId] = useState(
    initialData.profiles[0]?.id ?? "",
  );
  const [selectedRepo, setSelectedRepo] = useState<Recommendation | null>(null);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [message, setMessage] = useState("");

  const selectedProfile = profiles.find(
    (profile) => profile.id === selectedProfileId,
  );
  const stats = useMemo(() => {
    const profileItems = recommendations.filter(
      (item) => item.profileId === selectedProfileId,
    );
    return {
      recommendations: profileItems.filter(
        (item) =>
          !recommendationIsHidden(item) &&
          recommendationPreferenceStatus(item) === "pending" &&
          recommendationOpportunityStage(item) !== "abandoned",
      ).length,
      tracked: profileItems.filter(recommendationIsTracked).length,
      providers: providers.length,
      jobStatus: jobs[0] ? `${jobs[0].status} / ${jobs[0].stage}` : "idle",
    };
  }, [jobs, providers.length, recommendations, selectedProfileId]);

  async function refreshJobsAndQueue() {
    const [jobsResponse, queueResponse, operationsResponse, settingsResponse] =
      await Promise.all([
        fetch("/api/scans"),
        fetch("/api/queue"),
        fetch("/api/operations"),
        fetch("/api/settings"),
      ]);
    if (jobsResponse.ok) setJobs(await jobsResponse.json());
    if (queueResponse.ok) setQueueStats(await queueResponse.json());
    if (operationsResponse.ok) setOperations(await operationsResponse.json());
    if (settingsResponse.ok) setSettings(await settingsResponse.json());
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
        body: JSON.stringify({ profileId: selectedProfileId }),
      });
      const body = await response.json().catch(() => ({}));
      if (body?.id)
        setJobs((current) => [
          body,
          ...current.filter((job) => job.id !== body.id),
        ]);
      setMessage(
        response.ok
          ? "扫描任务已启动，worker 会按 checkpoint 继续低内存推进。"
          : (body.errorMessage ?? body.error ?? "扫描失败，请查看任务状态。"),
      );
      void refreshJobsAndQueue();
    } finally {
      setIsScanning(false);
    }
  }

  async function sendFeedback(
    recommendation: Recommendation,
    action: FeedbackAction,
  ) {
    const previousRecommendations = recommendations;
    const previousSelectedRepo = selectedRepo;
    const optimisticRecommendation = applyRecommendationFeedback(
      recommendation,
      action,
    );
    setRecommendations((current) =>
      current.map((item) =>
        item.id === recommendation.id ? optimisticRecommendation : item,
      ),
    );
    setSelectedRepo((current) =>
      current?.id === recommendation.id ? optimisticRecommendation : current,
    );

    try {
      const response = await fetch(
        `/api/repositories/${recommendation.repo.id}/feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profileId: recommendation.profileId, action }),
        },
      );
      if (response.ok) return;
      const body = await response.json().catch(() => ({}));
      setRecommendations(previousRecommendations);
      setSelectedRepo(previousSelectedRepo);
      setMessage(readApiError(body, "反馈保存失败。"));
    } catch (error) {
      setRecommendations(previousRecommendations);
      setSelectedRepo(previousSelectedRepo);
      setMessage(errorMessage(error, "反馈保存失败。"));
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  function navigateSection(section: Section) {
    router.push(sectionPath(section));
  }

  useEffect(() => {
    if (
      (activeSection === "recommendations" || activeSection === "knowledge") &&
      recommendations.length === 0
    ) {
      void refreshRecommendations();
    }
  }, [activeSection, recommendations.length]);

  useEffect(() => {
    if (!selectedRepo && !showPasswordDialog) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (showPasswordDialog) setShowPasswordDialog(false);
        else setSelectedRepo(null);
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [selectedRepo, showPasswordDialog]);

  async function toggleGlobalScan(enabled: boolean) {
    const previous = settings;
    setSettings({ ...settings, scanEnabled: enabled });
    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scanEnabled: enabled }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      setSettings(body);
      setMessage(
        enabled
          ? "全局扫描任务已开启。"
          : "全局扫描任务已关闭，不会启动新的扫描任务。",
      );
    } else {
      setSettings(previous);
      setMessage(body.error ?? "全局扫描开关更新失败。");
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <GitBranch size={20} />
          </span>
          <span className="brand-copy">
            <strong>fetchGithub</strong>
            <small>发现工作台</small>
          </span>
        </div>
        <nav className="nav-list" aria-label="主导航">
          {navigationGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map((sectionId) => {
                const section = sections.find((item) => item.id === sectionId)!;
                const Icon = section.icon;
                return (
                  <button
                    key={section.id}
                    className={`nav-button ${activeSection === section.id ? "active" : ""}`}
                    onClick={() => navigateSection(section.id)}
                    type="button"
                    aria-current={
                      activeSection === section.id ? "page" : undefined
                    }
                  >
                    <Icon size={17} />
                    <span>{section.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <label
            className="scan-status"
            title="关闭后不会创建、启动或恢复扫描任务"
          >
            <span
              className={`status-dot ${settings.scanEnabled ? "online" : ""}`}
              aria-hidden="true"
            />
            <span>
              <strong>
                {settings.scanEnabled ? "自动扫描已开启" : "自动扫描已暂停"}
              </strong>
              <small>{stats.jobStatus}</small>
            </span>
            <input
              type="checkbox"
              checked={settings.scanEnabled}
              onChange={(event) => void toggleGlobalScan(event.target.checked)}
              aria-label="全局扫描"
            />
          </label>
          <div className="sidebar-account-actions">
            <button
              className="sidebar-action"
              onClick={() => setShowPasswordDialog(true)}
              type="button"
            >
              <LockKeyhole size={16} />
              <span>账户安全</span>
            </button>
            <button
              className="sidebar-action icon-only"
              onClick={logout}
              type="button"
              title="退出登录"
              aria-label="退出登录"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main" id="main-content" tabIndex={-1}>
        <div className="toolbar">
          <div className="toolbar-title">
            <h1>{sectionTitle(activeSection)}</h1>
            <p>{sectionSubtitle(activeSection)}</p>
          </div>
          <div className="toolbar-actions">
            {(activeSection === "recommendations" ||
              activeSection === "profiles") && (
              <select
                className="select profile-select"
                aria-label="当前发现配置"
                value={selectedProfileId}
                onChange={(event) => setSelectedProfileId(event.target.value)}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            )}
            {activeSection === "recommendations" && (
              <button
                className="button primary"
                disabled={
                  !selectedProfileId || isScanning || !settings.scanEnabled
                }
                onClick={startScan}
                type="button"
              >
                {isScanning ? (
                  <RefreshCw className="spin" size={16} />
                ) : (
                  <Play size={16} />
                )}
                <span>{isScanning ? "正在创建" : "开始扫描"}</span>
              </button>
            )}
          </div>
        </div>

        {message && (
          <div className="notice page-notice" role="status">
            {message}
          </div>
        )}

        {activeSection === "recommendations" && (
          <RecommendationsPanel
            recommendations={recommendations}
            selectedProfileId={selectedProfileId}
            stats={stats}
            onSelect={setSelectedRepo}
            onFeedback={sendFeedback}
            onRefresh={refreshRecommendations}
            onTagsUpdated={(recommendation) =>
              setRecommendations((current) =>
                current.map((item) =>
                  item.id === recommendation.id ? recommendation : item,
                ),
              )
            }
          />
        )}
        {activeSection === "profiles" && (
          <ProfilesPanel
            profiles={profiles}
            selectedProfile={selectedProfile}
            onUpdated={(profile) =>
              setProfiles((current) =>
                current.map((item) =>
                  item.id === profile.id ? profile : item,
                ),
              )
            }
          />
        )}
        {activeSection === "github" && (
          <GitHubPanel
            settings={settings}
            accounts={githubAccounts}
            repos={githubRepos}
            onSettingsChanged={setSettings}
            onRepoUpdated={(repo) =>
              setGithubRepos((current) =>
                current.map((item) => (item.id === repo.id ? repo : item)),
              )
            }
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
            onChanged={(provider) =>
              setProviders((current) => {
                return current.some((item) => item.id === provider.id)
                  ? current.map((item) =>
                      item.id === provider.id ? provider : item,
                    )
                  : [...current, provider];
              })
            }
            onDeleted={(providerId) =>
              setProviders((current) =>
                current.filter((item) => item.id !== providerId),
              )
            }
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
          <div className="stack">
            <JobsPanel
              jobs={jobs}
              onRefresh={refreshJobsAndQueue}
              onJobUpdated={(job) =>
                setJobs((current) =>
                  current.map((item) => (item.id === job.id ? job : item)),
                )
              }
              onJobArchived={(jobId) =>
                setJobs((current) =>
                  current.filter((item) => item.id !== jobId),
                )
              }
            />
            <OperationsPanel
              operations={operations}
              queueStats={queueStats}
              onRefresh={refreshJobsAndQueue}
            />
          </div>
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
      {showPasswordDialog && (
        <PasswordDialog onClose={() => setShowPasswordDialog(false)} />
      )}
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
        body: JSON.stringify({ currentPassword, newPassword }),
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
          <button
            className="button icon"
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>
        <div className="form-grid password-grid">
          {message && (
            <div className="notice" role="status">
              {message}
            </div>
          )}
          <Field label="当前密码">
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </Field>
          <Field label="新密码">
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </Field>
          <Field label="确认新密码">
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </Field>
          <div className="form-actions">
            <button className="button" type="button" onClick={onClose}>
              关闭
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting ? "保存中" : "保存密码"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function SummaryTile({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  value: string | number;
}) {
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
  stats,
  onSelect,
  onFeedback,
  onRefresh,
  onTagsUpdated,
}: {
  recommendations: Recommendation[];
  selectedProfileId: string;
  stats: {
    recommendations: number;
    tracked: number;
    providers: number;
    jobStatus: string;
  };
  onSelect: (recommendation: Recommendation) => void;
  onFeedback: (
    recommendation: Recommendation,
    action: FeedbackAction,
  ) => Promise<void>;
  onRefresh: () => Promise<void>;
  onTagsUpdated: (recommendation: Recommendation) => void;
}) {
  const [opportunityFilter, setOpportunityFilter] =
    useState<OpportunityFilter>("all");
  const [groupFilter, setGroupFilter] = useState<GroupFilter>("all");
  const [preferenceFilter, setPreferenceFilter] =
    useState<PreferenceFilter>("pending");
  const [focusedClusterKey, setFocusedClusterKey] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<RecommendationStatusFilter>("visible");
  const [tagEditorRepo, setTagEditorRepo] = useState<Recommendation | null>(
    null,
  );
  const [sortState, setSortState] = useState<RecommendationSortState>({
    key: "score",
    direction: "desc",
  });
  const [semanticQuery, setSemanticQuery] = useState("");
  const [semanticSearch, setSemanticSearch] =
    useState<SemanticSearchState | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busyFeedback, setBusyFeedback] = useState("");
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const searchScores = semanticSearch?.scores ?? {};
  const searchIds = useMemo(
    () => (semanticSearch ? new Set(semanticSearch.ids) : undefined),
    [semanticSearch],
  );
  const focusedClusterLabel = useMemo(() => {
    if (!focusedClusterKey) return "";
    return (
      recommendations.find((item) => item.cluster?.key === focusedClusterKey)
        ?.cluster?.label ?? focusedClusterKey
    );
  }, [focusedClusterKey, recommendations]);
  const profileRecommendations = useMemo(
    () =>
      recommendations.filter(
        (item) => !selectedProfileId || item.profileId === selectedProfileId,
      ),
    [recommendations, selectedProfileId],
  );

  const visible = useMemo(() => {
    const filtered = profileRecommendations
      .filter((item) =>
        recommendationMatchesOpportunity(item, opportunityFilter),
      )
      .filter((item) =>
        recommendationMatchesGroup(item, groupFilter, focusedClusterKey),
      )
      .filter((item) => recommendationMatchesPreference(item, preferenceFilter))
      .filter((item) => recommendationMatchesStatus(item, statusFilter))
      .filter((item) => !searchIds || searchIds.has(item.id));

    return [...filtered].sort((left, right) =>
      compareRecommendations(left, right, sortState, searchScores),
    );
  }, [
    focusedClusterKey,
    groupFilter,
    opportunityFilter,
    preferenceFilter,
    profileRecommendations,
    searchIds,
    searchScores,
    sortState,
    statusFilter,
  ]);
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedVisible = visible.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const activeFilterCount = [
    opportunityFilter !== "all",
    groupFilter !== "all" || Boolean(focusedClusterKey),
    preferenceFilter !== "pending",
    statusFilter !== "visible",
  ].filter(Boolean).length;
  const activeQuickView =
    opportunityFilter === "all" &&
    preferenceFilter === "pending" &&
    statusFilter === "visible"
      ? "inbox"
      : opportunityFilter === "qualified" &&
          preferenceFilter === "all" &&
          statusFilter === "visible"
        ? "opportunity"
        : opportunityFilter === "all" &&
            preferenceFilter === "all" &&
            statusFilter === "tracked"
          ? "tracked"
          : opportunityFilter === "all" &&
              preferenceFilter === "all" &&
              statusFilter === "all"
            ? "all"
            : "custom";

  function applyQuickView(view: "inbox" | "opportunity" | "tracked" | "all") {
    setFocusedClusterKey("");
    setGroupFilter("all");
    setSemanticSearch(null);
    setSemanticQuery("");
    if (view === "inbox") {
      setOpportunityFilter("all");
      setPreferenceFilter("pending");
      setStatusFilter("visible");
    } else if (view === "opportunity") {
      setOpportunityFilter("qualified");
      setPreferenceFilter("all");
      setStatusFilter("visible");
    } else if (view === "tracked") {
      setOpportunityFilter("all");
      setPreferenceFilter("all");
      setStatusFilter("tracked");
    } else {
      setOpportunityFilter("all");
      setPreferenceFilter("all");
      setStatusFilter("all");
    }
  }

  useEffect(() => {
    setPage(1);
  }, [
    focusedClusterKey,
    groupFilter,
    opportunityFilter,
    preferenceFilter,
    searchIds,
    sortState,
    statusFilter,
  ]);

  async function runSemanticSearch(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const query = semanticQuery.trim();
    if (!query) {
      setSemanticSearch(null);
      setSortState({ key: "score", direction: "desc" });
      return;
    }

    setIsSearching(true);
    try {
      const params = new URLSearchParams({
        q: query,
        limit: "100",
      });
      if (selectedProfileId) {
        params.set("profileId", selectedProfileId);
      }
      const response = await fetch(
        `/api/recommendations/search?${params.toString()}`,
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSemanticSearch({
          ids: [],
          scores: {},
          mode: "lexical",
          warning: body.error ?? "语义搜索失败。",
        });
        return;
      }
      const results = Array.isArray(body.results) ? body.results : [];
      setSemanticSearch({
        ids: results.map((item: { id: string }) => item.id),
        scores: Object.fromEntries(
          results.map((item: { id: string; score: number }) => [
            item.id,
            Number(item.score) || 0,
          ]),
        ),
        mode: body.mode ?? "semantic",
        warning: body.warning,
      });
      setSortState({ key: "semantic", direction: "desc" });
    } finally {
      setIsSearching(false);
    }
  }

  function clearSemanticSearch() {
    setSemanticQuery("");
    setSemanticSearch(null);
    setSortState({ key: "score", direction: "desc" });
  }

  function toggleSort(key: RecommendationSortKey) {
    setSortState((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "asc" ? "desc" : "asc",
          }
        : {
            key,
            direction: key === "rank" ? "asc" : "desc",
          },
    );
  }

  function clearFocusedCluster() {
    setFocusedClusterKey("");
  }

  async function sendPreferenceFeedback(
    recommendation: Recommendation,
    action: "set_pending" | "like" | "dislike",
  ) {
    setBusyFeedback(`${recommendation.id}:${action}`);
    try {
      await onFeedback(recommendation, action);
    } finally {
      setBusyFeedback("");
    }
  }

  async function refreshList() {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <div className="discovery-workspace">
      <section className="discovery-overview" aria-label="发现概览">
        <button
          className={`metric-button ${activeQuickView === "inbox" ? "active" : ""}`}
          type="button"
          onClick={() => applyQuickView("inbox")}
        >
          <span className="metric-icon">
            <Compass size={17} />
          </span>
          <span>
            <small>待判断</small>
            <strong>{stats.recommendations}</strong>
          </span>
        </button>
        <button
          className={`metric-button ${activeQuickView === "opportunity" ? "active" : ""}`}
          type="button"
          onClick={() => applyQuickView("opportunity")}
        >
          <span className="metric-icon opportunity">
            <CheckCircle2 size={17} />
          </span>
          <span>
            <small>有机会</small>
            <strong>
              {
                profileRecommendations.filter(
                  (item) =>
                    recommendationOpportunityStatus(item) === "qualified",
                ).length
              }
            </strong>
          </span>
        </button>
        <button
          className={`metric-button ${activeQuickView === "tracked" ? "active" : ""}`}
          type="button"
          onClick={() => applyQuickView("tracked")}
        >
          <span className="metric-icon tracked">
            <Star size={17} />
          </span>
          <span>
            <small>重点跟踪</small>
            <strong>{stats.tracked}</strong>
          </span>
        </button>
        <button
          className={`metric-button ${activeQuickView === "all" ? "active" : ""}`}
          type="button"
          onClick={() => applyQuickView("all")}
        >
          <span className="metric-icon total">
            <Database size={17} />
          </span>
          <span>
            <small>全部结果</small>
            <strong>{profileRecommendations.length}</strong>
          </span>
        </button>
      </section>

      <section className="panel discovery-panel">
        <div className="discovery-heading">
          <div>
            <h2>项目队列</h2>
            <p>优先处理高分且尚未表态的项目，打开详情后完成判断。</p>
          </div>
          <div className="heading-actions">
            <span className="result-count">{visible.length} 个结果</span>
            <button
              className="button icon"
              type="button"
              onClick={() => void refreshList()}
              disabled={isRefreshing}
              title="刷新推荐"
              aria-label="刷新推荐"
            >
              <RefreshCw
                className={isRefreshing ? "spin" : undefined}
                size={16}
              />
            </button>
          </div>
        </div>
        <div className="list-controls">
          <form className="search-row" onSubmit={runSemanticSearch}>
            <div className="search-box">
              <Search size={17} aria-hidden="true" />
              <input
                className="input"
                value={semanticQuery}
                onChange={(event) => setSemanticQuery(event.target.value)}
                placeholder="描述你要找的项目，例如：适合做托管 SaaS 的 RAG 工具"
                aria-label="语义搜索项目"
              />
            </div>
            <button
              className="button primary"
              disabled={isSearching}
              type="submit"
            >
              {isSearching ? "搜索中" : "语义搜索"}
            </button>
            {semanticSearch && (
              <button
                className="button"
                onClick={clearSemanticSearch}
                type="button"
              >
                清除
              </button>
            )}
            <button
              className={`button filter-toggle ${showAdvancedFilters ? "active" : ""}`}
              onClick={() => setShowAdvancedFilters((value) => !value)}
              type="button"
              aria-expanded={showAdvancedFilters}
            >
              <SlidersHorizontal size={16} />
              <span>
                筛选{activeFilterCount ? ` ${activeFilterCount}` : ""}
              </span>
            </button>
          </form>
          {showAdvancedFilters && (
            <div className="filter-row advanced-filters">
              <label className="field inline-field">
                <span>机会</span>
                <select
                  className="select"
                  value={opportunityFilter}
                  onChange={(event) =>
                    setOpportunityFilter(
                      event.target.value as OpportunityFilter,
                    )
                  }
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
                  onChange={(event) =>
                    setGroupFilter(event.target.value as GroupFilter)
                  }
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
                  onChange={(event) =>
                    setStatusFilter(
                      event.target.value as RecommendationStatusFilter,
                    )
                  }
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
                  onChange={(event) =>
                    setPreferenceFilter(event.target.value as PreferenceFilter)
                  }
                >
                  {preferenceFilterOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {focusedClusterKey && (
                <button
                  className="button"
                  onClick={clearFocusedCluster}
                  type="button"
                >
                  清除当前分组
                </button>
              )}
              {focusedClusterLabel && (
                <span className="muted">当前分组：{focusedClusterLabel}</span>
              )}
              {semanticSearch?.warning && (
                <span className="muted">{semanticSearch.warning}</span>
              )}
            </div>
          )}
        </div>
        <div className="table-wrap">
          <table className="repo-table">
            <thead>
              <tr>
                <th>项目</th>
                <th>
                  <button
                    className="sort-button"
                    type="button"
                    onClick={() => toggleSort("score")}
                  >
                    <span>分数</span>
                    {renderSortIcon(sortState, "score")}
                  </button>
                </th>
                <th>
                  <button
                    className="sort-button"
                    type="button"
                    onClick={() => toggleSort("stars")}
                  >
                    <span>Stars</span>
                    {renderSortIcon(sortState, "stars")}
                  </button>
                </th>
                <th>语言</th>
                <th>判断依据</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty-table-cell">
                    <Search size={22} />
                    <strong>没有符合条件的项目</strong>
                    <span>调整搜索词或清除筛选后重试。</span>
                  </td>
                </tr>
              ) : (
                pagedVisible.map((recommendation, index) => (
                  <tr key={recommendation.id}>
                    <td className="project-cell">
                      <a
                        className="repo-link"
                        href={recommendation.repo.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <span>{recommendation.repo.fullName}</span>
                        <ExternalLink size={14} />
                      </a>
                      <div className="repo-summary">
                        {getRecommendationSummaryZh(recommendation)}
                      </div>
                      <div className="repo-meta">
                        <span>#{(currentPage - 1) * pageSize + index + 1}</span>
                        <span>{recommendation.cluster?.label ?? "未分组"}</span>
                        {(recommendation.tags ?? []).slice(0, 2).map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                      {semanticSearch &&
                        searchScores[recommendation.id] !== undefined && (
                          <div className="muted">
                            语义相关{" "}
                            {Math.round(searchScores[recommendation.id] * 100)}
                          </div>
                        )}
                    </td>
                    <td>
                      <div className="score">
                        <strong>
                          {Math.round(recommendation.scores.final * 100)}
                        </strong>
                        <div className="score-bar">
                          <div
                            className="score-fill"
                            style={{
                              width: `${recommendation.scores.final * 100}%`,
                            }}
                          />
                        </div>
                      </div>
                    </td>
                    <td>{recommendation.repo.stars.toLocaleString()}</td>
                    <td>{recommendation.repo.primaryLanguage}</td>
                    <td className="reason-cell">
                      <span className="opportunity-label">
                        {recommendation.opportunity?.type ?? "机会待分析"}
                      </span>
                      <strong>
                        {recommendation.reasons[0] ?? "综合评分较高"}
                      </strong>
                      <span>
                        {recommendation.opportunity
                          ? opportunityActionText(
                              recommendation.opportunity.suggestedAction,
                            )
                          : "建议继续观察"}
                      </span>
                    </td>
                    <td>
                      <div className="tags">
                        <span
                          className={`status ${preferenceStatusTone(recommendationPreferenceStatus(recommendation))}`}
                        >
                          喜好：
                          {preferenceStatusText(
                            recommendationPreferenceStatus(recommendation),
                          )}
                        </span>
                        <span
                          className={`status ${opportunityStatusTone(recommendationOpportunityStatus(recommendation))}`}
                        >
                          机会：
                          {opportunityStatusText(
                            recommendationOpportunityStatus(recommendation),
                          )}
                        </span>
                        <span
                          className={`status ${opportunityStageTone(recommendationOpportunityStage(recommendation))}`}
                        >
                          阶段：
                          {opportunityStageText(
                            recommendationOpportunityStage(recommendation),
                          )}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="action-row">
                        <IconButton
                          title={
                            recommendationPreferenceStatus(recommendation) ===
                            "liked"
                              ? "已喜欢"
                              : "喜欢"
                          }
                          icon={ThumbsUp}
                          active={
                            recommendationPreferenceStatus(recommendation) ===
                            "liked"
                          }
                          tone="positive"
                          onClick={() =>
                            void sendPreferenceFeedback(recommendation, "like")
                          }
                          disabled={busyFeedback.startsWith(
                            `${recommendation.id}:`,
                          )}
                          loading={busyFeedback === `${recommendation.id}:like`}
                        />
                        <IconButton
                          title="待定"
                          icon={RefreshCw}
                          active={
                            recommendationPreferenceStatus(recommendation) ===
                            "pending"
                          }
                          onClick={() =>
                            void sendPreferenceFeedback(
                              recommendation,
                              "set_pending",
                            )
                          }
                          disabled={busyFeedback.startsWith(
                            `${recommendation.id}:`,
                          )}
                          loading={
                            busyFeedback === `${recommendation.id}:set_pending`
                          }
                        />
                        <IconButton
                          title={
                            recommendationPreferenceStatus(recommendation) ===
                            "disliked"
                              ? "已不喜欢"
                              : "不喜欢"
                          }
                          icon={ThumbsDown}
                          active={
                            recommendationPreferenceStatus(recommendation) ===
                            "disliked"
                          }
                          tone="danger"
                          onClick={() =>
                            void sendPreferenceFeedback(
                              recommendation,
                              "dislike",
                            )
                          }
                          disabled={busyFeedback.startsWith(
                            `${recommendation.id}:`,
                          )}
                          loading={
                            busyFeedback === `${recommendation.id}:dislike`
                          }
                        />
                        <button
                          className="button detail-button"
                          type="button"
                          onClick={() => onSelect(recommendation)}
                        >
                          查看详情
                          <ChevronRight size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {visible.length > pageSize && (
          <div className="pagination-row">
            <button
              className="button"
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              上一页
            </button>
            <span className="muted">
              第 {currentPage} / {totalPages} 页，每页 {pageSize} 条
            </span>
            <button
              className="button"
              type="button"
              disabled={currentPage >= totalPages}
              onClick={() =>
                setPage((value) => Math.min(totalPages, value + 1))
              }
            >
              下一页
            </button>
          </div>
        )}
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
    </div>
  );
}

function RepoDrawer({
  recommendation,
  recommendations,
  onClose,
  onFeedback,
}: {
  recommendation: Recommendation;
  recommendations: Recommendation[];
  onClose: () => void;
  onFeedback: (
    recommendation: Recommendation,
    action: FeedbackAction,
  ) => Promise<void>;
}) {
  const [busyAction, setBusyAction] = useState<
    FeedbackAction | "hide_similar" | ""
  >("");
  const similarRecommendations = recommendations.filter(
    (item) =>
      item.id !== recommendation.id &&
      item.cluster?.key &&
      item.cluster.key === recommendation.cluster?.key &&
      !recommendationIsHidden(item) &&
      recommendationOpportunityStage(item) !== "abandoned",
  );

  async function hideSimilarRecommendations() {
    setBusyAction("hide_similar");
    try {
      for (const item of similarRecommendations) {
        await onFeedback(item, "hide");
      }
    } finally {
      setBusyAction("");
    }
  }

  async function updateRecommendation(action: FeedbackAction) {
    setBusyAction(action);
    try {
      await onFeedback(recommendation, action);
    } finally {
      setBusyAction("");
    }
  }

  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="drawer"
        aria-label="项目详情"
        role="dialog"
        aria-modal="true"
      >
        <div className="drawer-header">
          <div>
            <a
              className="repo-link"
              href={recommendation.repo.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>{recommendation.repo.fullName}</span>
              <ExternalLink size={15} />
            </a>
            <p className="muted">
              {getRecommendationSummaryZh(recommendation)}
            </p>
          </div>
          <button
            className="button icon"
            onClick={onClose}
            type="button"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>
        <div className="drawer-content">
          <div className="action-row wrap">
            <a
              className="button primary"
              href={recommendation.repo.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink size={15} />
              <span>打开 GitHub</span>
            </a>
            <button
              className={`button ${recommendationOpportunityStage(recommendation) === "pending_validation" ? "active" : ""}`}
              onClick={() => void updateRecommendation("to_validate")}
              type="button"
              disabled={Boolean(busyAction)}
            >
              <ClipboardCheck size={15} />
              {busyAction === "to_validate" ? "更新中" : "待验证"}
            </button>
            <button
              className={`button ${recommendationOpportunityStage(recommendation) === "validating" ? "active" : ""}`}
              onClick={() => void updateRecommendation("validating")}
              type="button"
              disabled={Boolean(busyAction)}
            >
              {busyAction === "validating" ? "更新中" : "验证中"}
            </button>
            <button
              className={`button ${recommendationOpportunityStage(recommendation) === "validated" ? "active" : ""}`}
              onClick={() => void updateRecommendation("mark_validated")}
              type="button"
              disabled={Boolean(busyAction)}
            >
              {busyAction === "mark_validated" ? "更新中" : "已验证"}
            </button>
            <button
              className={`button ${recommendationOpportunityStage(recommendation) === "monetization_ready" ? "active" : ""}`}
              onClick={() => void updateRecommendation("monetization_ready")}
              type="button"
              disabled={Boolean(busyAction)}
            >
              {busyAction === "monetization_ready" ? "更新中" : "准备变现"}
            </button>
            <button
              className={`button ${recommendationOpportunityStatus(recommendation) === "qualified" ? "active positive" : ""}`}
              onClick={() => void updateRecommendation("mark_qualified")}
              type="button"
              disabled={Boolean(busyAction)}
            >
              {busyAction === "mark_qualified" ? "更新中" : "符合机会条件"}
            </button>
            <button
              className={`button ${recommendationOpportunityStatus(recommendation) === "unassessed" ? "active" : ""}`}
              onClick={() => void updateRecommendation("reset_qualification")}
              type="button"
              disabled={Boolean(busyAction)}
            >
              {busyAction === "reset_qualification" ? "更新中" : "机会待评估"}
            </button>
            <button
              className={`button ${recommendationOpportunityStatus(recommendation) === "not_qualified" ? "active danger" : ""}`}
              onClick={() => void updateRecommendation("mark_not_qualified")}
              type="button"
              disabled={Boolean(busyAction)}
            >
              {busyAction === "mark_not_qualified"
                ? "更新中"
                : "不符合机会条件"}
            </button>
            <button
              className={`button ${recommendationPreferenceStatus(recommendation) === "liked" ? "active positive" : ""}`}
              onClick={() => void updateRecommendation("like")}
              type="button"
              disabled={Boolean(busyAction)}
            >
              <ThumbsUp size={15} />
              {busyAction === "like"
                ? "更新中"
                : recommendationPreferenceStatus(recommendation) === "liked"
                  ? "已喜欢"
                  : "喜欢"}
            </button>
            <button
              className={`button ${recommendationPreferenceStatus(recommendation) === "pending" ? "active" : ""}`}
              onClick={() => void updateRecommendation("set_pending")}
              type="button"
              disabled={Boolean(busyAction)}
            >
              <RefreshCw size={15} />
              {busyAction === "set_pending" ? "更新中" : "待定"}
            </button>
            <button
              className={`button ${recommendationPreferenceStatus(recommendation) === "disliked" ? "active danger" : ""}`}
              onClick={() => void updateRecommendation("dislike")}
              type="button"
              disabled={Boolean(busyAction)}
            >
              <ThumbsDown size={15} />
              {busyAction === "dislike"
                ? "更新中"
                : recommendationPreferenceStatus(recommendation) === "disliked"
                  ? "已不喜欢"
                  : "不喜欢"}
            </button>
            <button
              className={`button ${recommendationIsSaved(recommendation) ? "active" : ""}`}
              onClick={() =>
                void updateRecommendation(
                  recommendationIsSaved(recommendation) ? "unsave" : "save",
                )
              }
              type="button"
              disabled={Boolean(busyAction)}
            >
              {busyAction === "save" || busyAction === "unsave"
                ? "更新中"
                : recommendationIsSaved(recommendation)
                  ? "已收藏"
                  : "收藏"}
            </button>
            <button
              className={`button ${recommendationIsTracked(recommendation) ? "active" : ""}`}
              onClick={() =>
                void updateRecommendation(
                  recommendationIsTracked(recommendation) ? "untrack" : "track",
                )
              }
              type="button"
              disabled={Boolean(busyAction)}
            >
              {busyAction === "track" || busyAction === "untrack"
                ? "更新中"
                : recommendationIsTracked(recommendation)
                  ? "已跟踪"
                  : "跟踪"}
            </button>
            <button
              className={`button ${recommendationOpportunityStage(recommendation) === "abandoned" ? "active danger" : ""}`}
              onClick={() =>
                void updateRecommendation(
                  recommendationOpportunityStage(recommendation) === "abandoned"
                    ? "reopen"
                    : "abandon",
                )
              }
              type="button"
              disabled={Boolean(busyAction)}
            >
              {busyAction === "abandon" || busyAction === "reopen"
                ? "更新中"
                : recommendationOpportunityStage(recommendation) === "abandoned"
                  ? "重新观察"
                  : "放弃"}
            </button>
            <button
              className="button"
              onClick={() => void hideSimilarRecommendations()}
              disabled={
                Boolean(busyAction) || similarRecommendations.length === 0
              }
              type="button"
            >
              隐藏类似项目
            </button>
            {recommendationIsHidden(recommendation) ? (
              <button
                className="button"
                onClick={() => void updateRecommendation("restore")}
                type="button"
                disabled={Boolean(busyAction)}
              >
                恢复展示
              </button>
            ) : (
              <button
                className="button"
                onClick={() => void updateRecommendation("hide")}
                type="button"
                disabled={Boolean(busyAction)}
              >
                移出展示
              </button>
            )}
          </div>
          <DetailSection title="当前状态">
            {`喜好：${preferenceStatusText(recommendationPreferenceStatus(recommendation))}；机会：${opportunityStatusText(recommendationOpportunityStatus(recommendation))}；阶段：${opportunityStageText(recommendationOpportunityStage(recommendation))}；${recommendationCollectionStateText(recommendation)}。`}
          </DetailSection>
          {recommendation.cluster && (
            <DetailSection title="项目分组">
              {`${recommendation.cluster.label}。${recommendation.cluster.reason} 组内第 ${recommendation.cluster.rankInCluster ?? "-"} / ${recommendation.cluster.size ?? 1}。`}
            </DetailSection>
          )}
          <DetailSection title="项目摘要">
            {getRecommendationSummaryZh(recommendation)}
          </DetailSection>
          {recommendation.opportunity && (
            <>
              <DetailSection title="商业机会">
                {`${recommendation.opportunity.type}，建议动作：${opportunityActionText(recommendation.opportunity.suggestedAction)}。机会分 ${Math.round(recommendation.opportunity.score * 100)}，变现潜力 ${Math.round(recommendation.opportunity.monetizationScore * 100)}。`}
              </DetailSection>
              <ListSection
                title="目标客户"
                items={recommendation.opportunity.targetCustomers}
              />
              <ListSection
                title="变现路径"
                items={recommendation.opportunity.monetizationPaths}
              />
              <ChecklistSection
                title="机会验证清单"
                items={recommendation.opportunity.validationSteps}
              />
              <ListSection
                title="机会依据"
                items={recommendation.opportunity.evidence}
              />
            </>
          )}
          {recommendation.repo.description && (
            <DetailSection title="GitHub 原始描述">
              {recommendation.repo.description}
            </DetailSection>
          )}
          <ListSection title="推荐原因" items={recommendation.reasons} />
          <ListSection
            title="匹配信号"
            items={buildMatchSignals(recommendation)}
          />
          <ListSection title="风险点" items={recommendation.risks} />
          <ListSection
            title="关联我的项目"
            items={recommendation.relatedUserRepos.map(
              (repo) => `${repo.fullName}: ${repo.reason}`,
            )}
          />
          <ListSection
            title="同组类似项目"
            items={similarRecommendations
              .slice(0, 8)
              .map(
                (item) =>
                  `${item.repo.fullName}：${getRecommendationSummaryZh(item)}`,
              )}
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
  onUpdated,
}: {
  recommendation: Recommendation;
  recommendations: Recommendation[];
  onClose: () => void;
  onUpdated: (recommendation: Recommendation) => void;
}) {
  const existingTags = useMemo(
    () =>
      [...new Set(recommendations.flatMap((item) => item.tags ?? []))].sort(
        (a, b) => a.localeCompare(b),
      ),
    [recommendations],
  );
  const [tags, setTags] = useState<string[]>(recommendation.tags ?? []);
  const [newTag, setNewTag] = useState("");
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  function toggleTag(tag: string) {
    setTags((current) =>
      current.includes(tag)
        ? current.filter((item) => item !== tag)
        : [...current, tag],
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
      const response = await fetch(
        `/api/recommendations/${recommendation.id}/tags`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tags }),
        },
      );
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
          <button
            className="button icon"
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
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
            <button className="button" type="button" onClick={addTag}>
              新增
            </button>
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
              ) : (
                existingTags.map((tag) => (
                  <button
                    className={`tag-choice ${tags.includes(tag) ? "active" : ""}`}
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                  >
                    {tag}
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="form-actions">
            <button className="button" type="button" onClick={onClose}>
              关闭
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={isSaving}
            >
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
  onUpdated,
}: {
  profiles: DiscoveryProfile[];
  selectedProfile?: DiscoveryProfile;
  onUpdated: (profile: DiscoveryProfile) => void;
}) {
  const [message, setMessage] = useState("");
  const [enabled, setEnabled] = useState(selectedProfile?.enabled ?? true);
  const [missedRunPolicy, setMissedRunPolicy] = useState<
    DiscoveryProfile["config"]["schedule"]["missedRunPolicy"]
  >(selectedProfile?.config.schedule.missedRunPolicy ?? "skip");
  const [preferences, setPreferences] = useState<
    DiscoveryProfile["config"]["preferences"]
  >(
    selectedProfile?.config.preferences ?? {
      keywords: [],
      topics: [],
      languages: {},
      excludeKeywords: [],
      minStars: 0,
      pushedWithinDays: 365,
      excludeArchived: true,
      excludeForks: true,
    },
  );
  const [opportunity, setOpportunity] = useState(
    normalizeOpportunityProfile(selectedProfile?.config.opportunity),
  );
  const [minAvailableMemoryMb, setMinAvailableMemoryMb] = useState(
    selectedProfile?.config.resourcePolicy.minAvailableMemoryMb ??
      selectedProfile?.config.resourcePolicy.memory?.minAvailableMb ??
      512,
  );
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  useEffect(() => {
    if (!selectedProfile) return;
    setEnabled(selectedProfile.enabled);
    setMissedRunPolicy(selectedProfile.config.schedule.missedRunPolicy);
    setPreferences(selectedProfile.config.preferences);
    setOpportunity(
      normalizeOpportunityProfile(selectedProfile.config.opportunity),
    );
    setMinAvailableMemoryMb(
      selectedProfile.config.resourcePolicy.minAvailableMemoryMb ??
        selectedProfile.config.resourcePolicy.memory?.minAvailableMb ??
        512,
    );
  }, [selectedProfile]);

  async function saveProfile() {
    if (!selectedProfile) return;
    setIsSavingProfile(true);
    setMessage("正在保存发现配置...");
    const nextConfig: DiscoveryProfile["config"] = {
      schedule: { missedRunPolicy },
      limits: {},
      preferences,
      opportunity,
      resourcePolicy: { minAvailableMemoryMb },
      sources: selectedProfile.config.sources,
      ai: {},
    };

    try {
      const response = await fetch("/api/profiles/" + selectedProfile.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, config: nextConfig }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(readApiError(body, "发现配置保存失败。"));
        return;
      }
      onUpdated(body);
      setMessage("发现配置已保存，扫描时会按模型优先级自动选择配置。");
    } catch (error) {
      setMessage(errorMessage(error, "发现配置保存失败。"));
    } finally {
      setIsSavingProfile(false);
    }
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <h2>发现策略</h2>
            <p>持续扫描由可用内存控制，同类型模型按优先级自动选择。</p>
          </div>
        </div>
        <div className="list-panel">
          {message && (
            <div className="notice" role="status">
              {message}
            </div>
          )}
          {profiles.map((profile) => (
            <div className="row-item" key={profile.id}>
              <strong>{profile.name}</strong>
              <span className="muted">
                {profile.enabled ? "已启用" : "已停用"}
              </span>
              <TagList
                items={[
                  "模型：同类型按优先级自动选择",
                  "最低可用内存：" +
                    (profile.config.resourcePolicy.minAvailableMemoryMb ??
                      profile.config.resourcePolicy.memory?.minAvailableMb ??
                      512) +
                    " MB",
                  "漏跑策略：" +
                    missedRunPolicyText(
                      profile.config.schedule.missedRunPolicy,
                    ),
                ]}
              />
            </div>
          ))}
          {!selectedProfile ? (
            <div className="muted">请选择发现策略。</div>
          ) : (
            <div className="stack">
              <div className="panel-header compact-header">
                <div className="panel-title">
                  <h3>核心发现偏好</h3>
                  <p>这些条件负责召回项目，机会 Brief 只负责后续商业判断。</p>
                </div>
              </div>
              <div className="form-grid">
                <Field label="关键词">
                  <input
                    className="input"
                    value={preferences.keywords.join(", ")}
                    onChange={(event) =>
                      setPreferences({
                        ...preferences,
                        keywords: splitCsv(event.target.value),
                      })
                    }
                    placeholder="agent, llm, workflow"
                  />
                </Field>
                <Field label="Topics">
                  <input
                    className="input"
                    value={preferences.topics.join(", ")}
                    onChange={(event) =>
                      setPreferences({
                        ...preferences,
                        topics: splitCsv(event.target.value),
                      })
                    }
                    placeholder="ai, rag, automation"
                  />
                </Field>
                <Field label="语言权重">
                  <input
                    className="input"
                    value={formatLanguageWeights(preferences.languages)}
                    onChange={(event) =>
                      setPreferences({
                        ...preferences,
                        languages: parseLanguageWeights(event.target.value),
                      })
                    }
                    placeholder="TypeScript:1, Python:0.8"
                  />
                </Field>
                <Field label="排除关键词">
                  <input
                    className="input"
                    value={preferences.excludeKeywords.join(", ")}
                    onChange={(event) =>
                      setPreferences({
                        ...preferences,
                        excludeKeywords: splitCsv(event.target.value),
                      })
                    }
                    placeholder="crypto, gambling"
                  />
                </Field>
                <Field label="最低 Stars">
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={preferences.minStars}
                    onChange={(event) =>
                      setPreferences({
                        ...preferences,
                        minStars: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="最近推送天数">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={preferences.pushedWithinDays}
                    onChange={(event) =>
                      setPreferences({
                        ...preferences,
                        pushedWithinDays: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <label className="field checkbox-field">
                  <span>仓库过滤</span>
                  <span className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={preferences.excludeArchived}
                      onChange={(event) =>
                        setPreferences({
                          ...preferences,
                          excludeArchived: event.target.checked,
                        })
                      }
                    />
                    排除 archived
                  </span>
                  <span className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={preferences.excludeForks}
                      onChange={(event) =>
                        setPreferences({
                          ...preferences,
                          excludeForks: event.target.checked,
                        })
                      }
                    />
                    排除 fork
                  </span>
                </label>
              </div>
              <div className="panel-header compact-header">
                <div className="panel-title">
                  <h3>机会与运行策略</h3>
                  <p>只保留商业判断、内存阈值和漏跑处理。</p>
                </div>
              </div>
              <div className="form-grid">
                <label className="field checkbox-field">
                  <span>启用状态</span>
                  <span className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(event) => setEnabled(event.target.checked)}
                    />
                    参与持续扫描
                  </span>
                </label>
                <Field label="业务偏好 / 机会 Brief">
                  <textarea
                    className="input textarea"
                    maxLength={2000}
                    value={opportunity.brief ?? ""}
                    onChange={(event) =>
                      setOpportunity({
                        ...opportunity,
                        brief: event.target.value,
                      })
                    }
                    placeholder="描述目标客户、交付方式、偏好方向和需要排除的机会"
                  />
                </Field>
                <Field label="最低机会分">
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={opportunity.minOpportunityScore}
                    onChange={(event) =>
                      setOpportunity({
                        ...opportunity,
                        minOpportunityScore: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="最低可用内存 MB">
                  <input
                    className="input"
                    type="number"
                    min={128}
                    step={128}
                    value={minAvailableMemoryMb}
                    onChange={(event) =>
                      setMinAvailableMemoryMb(Number(event.target.value))
                    }
                  />
                </Field>
                <Field label="漏跑策略">
                  <select
                    className="select"
                    value={missedRunPolicy}
                    onChange={(event) =>
                      setMissedRunPolicy(
                        event.target
                          .value as DiscoveryProfile["config"]["schedule"]["missedRunPolicy"],
                      )
                    }
                  >
                    <option value="skip">跳过漏跑周期</option>
                    <option value="run_once">恢复后补跑一次</option>
                    <option value="resume">恢复未完成进度</option>
                  </select>
                </Field>
                <div className="form-actions">
                  <button
                    className="button primary"
                    type="button"
                    onClick={() => void saveProfile()}
                    disabled={
                      isSavingProfile ||
                      preferences.minStars < 0 ||
                      preferences.pushedWithinDays < 1 ||
                      minAvailableMemoryMb < 128 ||
                      opportunity.minOpportunityScore < 0 ||
                      opportunity.minOpportunityScore > 1
                    }
                  >
                    {isSavingProfile ? (
                      <RefreshCw className="spin" size={15} />
                    ) : (
                      <Save size={15} />
                    )}
                    {isSavingProfile ? "保存中" : "保存发现策略"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function JobsPanel({
  jobs,
  onRefresh,
  onJobUpdated,
  onJobArchived,
}: {
  jobs: ScanJob[];
  onRefresh: () => Promise<void>;
  onJobUpdated: (job: ScanJob) => void;
  onJobArchived: (jobId: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [busyJobId, setBusyJobId] = useState("");
  const hasActiveJobs = jobs.some((job) =>
    [
      "pending",
      "running",
      "throttled",
      "paused_by_memory",
      "paused_by_runtime",
      "retry_later",
    ].includes(job.status),
  );

  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = window.setInterval(() => void onRefresh(), 5000);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs, onRefresh]);

  async function updateJob(
    jobId: string,
    action: "pause" | "resume" | "complete",
  ) {
    setBusyJobId(jobId);
    try {
      const response = await fetch(`/api/scans/${jobId}/${action}`, {
        method: "POST",
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        onJobUpdated(body);
        setMessage(
          action === "pause"
            ? "扫描任务已暂停。"
            : action === "resume"
              ? "扫描任务已恢复。"
              : "扫描任务已手动完成。",
        );
        await onRefresh();
      } else {
        setMessage(readApiError(body, "扫描任务操作失败。"));
      }
    } catch (error) {
      setMessage(errorMessage(error, "扫描任务操作失败。"));
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
        setMessage(readApiError(body, "扫描任务归档失败。"));
      }
    } catch (error) {
      setMessage(errorMessage(error, "扫描任务归档失败。"));
    } finally {
      setBusyJobId("");
    }
  }

  async function manualRefresh() {
    setBusyJobId("refresh");
    try {
      await onRefresh();
      setMessage("扫描任务状态已刷新。");
    } catch (error) {
      setMessage(errorMessage(error, "扫描任务刷新失败。"));
    } finally {
      setBusyJobId("");
    }
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <h2>扫描周期与恢复</h2>
            <p>
              扫描周期是内部执行记录，仅在需要查看进度、处理异常或恢复时使用。
            </p>
          </div>
          <button
            className="button"
            type="button"
            onClick={() => void manualRefresh()}
            disabled={busyJobId === "refresh"}
          >
            <RefreshCw
              className={busyJobId === "refresh" ? "spin" : undefined}
              size={15}
            />
            {busyJobId === "refresh" ? "刷新中" : "刷新"}
          </button>
        </div>
        <div className="table-wrap">
          {message && (
            <div className="notice" role="status">
              {message}
            </div>
          )}
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
                <tr>
                  <td colSpan={12} className="muted">
                    暂无扫描任务
                  </td>
                </tr>
              ) : (
                jobs.map((job) => (
                  <Fragment key={job.id}>
                    <tr>
                      <td>{job.type}</td>
                      <td
                        title={
                          job.statusReason ?? job.errorMessage ?? undefined
                        }
                      >
                        <span className={`status ${job.status}`}>
                          {job.status}
                        </span>
                        {(job.statusReason || job.errorMessage) && (
                          <div className="muted">
                            {job.statusReason ?? job.errorMessage}
                          </div>
                        )}
                        {job.status === "exception" &&
                          !job.statusReason &&
                          !job.errorMessage && (
                            <div className="muted">
                              同类型 AI 模型均不可用，扫描已停止。
                            </div>
                          )}
                      </td>
                      <td>{job.stage}</td>
                      <td>{job.fetchedCount}</td>
                      <td>{job.newRepoCount}</td>
                      <td>{job.updatedRepoCount}</td>
                      <td>{job.unchangedRepoCount}</td>
                      <td>{job.candidateCount}</td>
                      <td>{job.failedCandidateCount}</td>
                      <td>{job.processedCount}</td>
                      <td>{job.analyzedCount}</td>
                      <td>
                        <div className="action-row">
                          {canPauseJob(job.status) && (
                            <button
                              className="button"
                              disabled={busyJobId === job.id}
                              onClick={() => void updateJob(job.id, "pause")}
                              type="button"
                            >
                              {busyJobId === job.id ? "处理中" : "暂停"}
                            </button>
                          )}
                          {canResumeJob(job.status) && (
                            <button
                              className="button"
                              disabled={busyJobId === job.id}
                              onClick={() => void updateJob(job.id, "resume")}
                              type="button"
                            >
                              {busyJobId === job.id
                                ? "恢复中"
                                : job.status === "exception"
                                  ? "处理后恢复"
                                  : "恢复"}
                            </button>
                          )}
                          {canCompleteJob(job.status) && (
                            <button
                              className="button"
                              disabled={busyJobId === job.id}
                              onClick={() => void updateJob(job.id, "complete")}
                              type="button"
                            >
                              {busyJobId === job.id ? "处理中" : "完成"}
                            </button>
                          )}
                          {canArchiveJob(job.status) && (
                            <button
                              className="button"
                              disabled={busyJobId === job.id}
                              onClick={() => void archiveJob(job.id)}
                              type="button"
                            >
                              {busyJobId === job.id ? "归档中" : "归档"}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {(job.errorResolution ||
                      job.status === "failed" ||
                      job.status === "exception") && (
                      <tr className="job-error-row">
                        <td colSpan={12}>
                          <div className="job-error" role="alert">
                            <AlertTriangle size={17} aria-hidden="true" />
                            <div>
                              <strong>
                                {job.errorMessage ?? job.statusReason}
                                {job.status === "exception" &&
                                  !job.errorMessage &&
                                  !job.statusReason &&
                                  "同类型 AI 模型均不可用，扫描已进入异常状态。"}
                              </strong>
                              {job.errorResolution && (
                                <p>
                                  <span>处理建议：</span>
                                  {job.errorResolution}
                                </p>
                              )}
                              {job.errorCode && (
                                <small>错误码：{job.errorCode}</small>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
  onSynced,
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
        body: JSON.stringify({ token: githubToken.trim() }),
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
        body: JSON.stringify({ includeOwned, includeStarred }),
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
      body: JSON.stringify({ githubAutoSyncEnabled: enabled }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      onSettingsChanged(body);
      setMessage(
        enabled ? "GitHub 每日被动同步已开启。" : "GitHub 每日被动同步已关闭。",
      );
    } else {
      setMessage(body.error ?? "GitHub 自动同步设置更新失败。");
    }
  }

  async function toggleSelected(repo: UserGitHubRepo) {
    const response = await fetch(`/api/github-context/repos/${repo.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedForContext: !repo.selectedForContext }),
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
        <button
          className="button primary"
          type="button"
          disabled={isSyncing}
          onClick={syncGithub}
        >
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
              ? accounts
                  .map(
                    (account) =>
                      `${account.username}（${account.lastSyncedAt ? formatTime(account.lastSyncedAt) : "未同步"}）`,
                  )
                  .join("，")
              : "尚未同步账号，请先配置 GITHUB_TOKEN。"}
          </span>
          <div className="action-row wrap">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={includeOwned}
                onChange={(event) => setIncludeOwned(event.target.checked)}
              />{" "}
              owned
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={includeStarred}
                onChange={(event) => setIncludeStarred(event.target.checked)}
              />{" "}
              starred
            </label>
          </div>
        </div>
        <div className="row-item">
          <strong>被动同步</strong>
          <span className="muted">
            每 {settings.githubAutoSyncIntervalHours} 小时最多同步一次
            {settings.githubLastAutoSyncedAt
              ? `，上次成功：${formatTime(settings.githubLastAutoSyncedAt)}`
              : "，尚未自动同步"}
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
          <span className="muted">
            仅写入服务器 .env.local，不会入库或展示明文。
          </span>
          <div className="action-row wrap">
            <input
              className="input"
              type="password"
              value={githubToken}
              onChange={(event) => setGithubToken(event.target.value)}
              placeholder="ghp_... 或 github_pat_..."
            />
            <button
              className="button"
              type="button"
              disabled={isSavingToken}
              onClick={saveGithubToken}
            >
              保存 Token
            </button>
          </div>
        </div>
        {repos.length === 0 ? (
          <div className="row-item">
            <span className="muted">暂无 GitHub 上下文项目。</span>
          </div>
        ) : (
          repos.map((repo) => (
            <div className="row-item" key={repo.id}>
              <strong>{repo.fullName}</strong>
              <span className="muted">{repo.description}</span>
              <TagList
                items={[
                  repo.primaryLanguage,
                  repo.visibility,
                  repo.selectedForContext ? "参与推荐" : "不参与推荐",
                  ...repo.topics,
                ]}
              />
              <div className="action-row">
                <button
                  className="button"
                  type="button"
                  onClick={() => toggleSelected(repo)}
                >
                  {repo.selectedForContext
                    ? "移出推荐上下文"
                    : "加入推荐上下文"}
                </button>
                <a
                  className="button icon"
                  href={`https://github.com/${repo.fullName}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="打开 GitHub"
                >
                  <ExternalLink size={15} />
                </a>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function ProvidersPanel({
  providers,
  onChanged,
  onDeleted,
}: {
  providers: AiProvider[];
  onChanged: (provider: AiProvider) => void;
  onDeleted: (providerId: string) => void;
}) {
  const [editingProvider, setEditingProvider] = useState<
    AiProvider | "new" | null
  >(null);
  const [message, setMessage] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const orderedProviders = useMemo(
    () =>
      [...providers].sort(
        (left, right) =>
          left.kind.localeCompare(right.kind) ||
          (left.priority ?? 100) - (right.priority ?? 100) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      ),
    [providers],
  );

  async function saveProvider(input: AiProviderFormValue) {
    const isEditing = input.id !== undefined;
    const response = await fetch(
      isEditing ? `/api/ai-providers/${input.id}` : "/api/ai-providers",
      {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          kind: input.kind,
          type: "openai_compatible",
          baseUrl: input.baseUrl,
          apiKeyValue: input.apiKeyValue || undefined,
          model: input.model,
          dimensions: input.kind === "embedding" ? input.dimensions : undefined,
          priority: input.priority,
          reasoningEffort:
            input.kind === "chat" ? input.reasoningEffort : undefined,
          enabled: input.enabled,
        }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      onChanged(body);
      setMessage(isEditing ? "AI 配置已修改。" : "AI 配置已创建。");
      setEditingProvider(null);
      return;
    }

    throw new Error(
      readApiError(body, isEditing ? "修改失败。" : "创建失败。"),
    );
  }

  async function patchProvider(provider: AiProvider) {
    setBusyAction(`${provider.id}:toggle`);
    setMessage(
      provider.enabled ? "正在停用 AI 配置..." : "正在启用 AI 配置...",
    );
    try {
      const response = await fetch(`/api/ai-providers/${provider.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !provider.enabled }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        onChanged(body);
        setMessage(body.enabled ? "AI 配置已启用。" : "AI 配置已停用。");
      } else {
        setMessage(readApiError(body, "更新失败。"));
      }
    } catch (error) {
      setMessage(errorMessage(error, "更新失败。"));
    } finally {
      setBusyAction("");
    }
  }

  async function deleteProvider(provider: AiProvider) {
    setBusyAction(`${provider.id}:delete`);
    setMessage("正在删除 AI 配置...");
    try {
      const response = await fetch(`/api/ai-providers/${provider.id}`, {
        method: "DELETE",
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        onDeleted(provider.id);
        setMessage("AI 配置已删除。历史分析记录会继续保留。");
      } else {
        setMessage(readApiError(body, "删除失败。"));
      }
    } catch (error) {
      setMessage(errorMessage(error, "删除失败。"));
    } finally {
      setBusyAction("");
    }
  }

  async function testProvider(provider: AiProvider) {
    setBusyAction(`${provider.id}:test`);
    setMessage("正在检测模型连接...");
    try {
      const response = await fetch(`/api/ai-providers/${provider.id}/test`, {
        method: "POST",
      });
      const body = await response.json().catch(() => ({}));
      setMessage(
        response.ok && body.ready
          ? "连接测试通过。"
          : `连接测试未通过：${body.checks?.reason ?? readApiError(body, "配置不可用")}`,
      );
    } catch (error) {
      setMessage(errorMessage(error, "连接测试失败。"));
    } finally {
      setBusyAction("");
    }
  }

  async function recoverProvider(provider: AiProvider) {
    setBusyAction(`${provider.id}:recover`);
    setMessage("正在执行轻量检测并尝试恢复...");
    try {
      const response = await fetch(`/api/ai-providers/${provider.id}/recover`, {
        method: "POST",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (body.provider?.id === provider.id) {
          onChanged(body.provider);
        }
        const reason = readApiError(body, "检测未通过，配置仍不可用。");
        setMessage(
          body.recoverySuggestion
            ? `${reason} 处理建议：${body.recoverySuggestion}`
            : reason,
        );
        return;
      }
      const updatedProvider = body.provider ?? body;
      if (updatedProvider?.id === provider.id) {
        onChanged(updatedProvider);
      }
      setMessage(body.message ?? "检测通过，AI 配置已恢复可用。");
    } catch (error) {
      setMessage(errorMessage(error, "恢复检测失败。"));
    } finally {
      setBusyAction("");
    }
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <h2>AI 配置</h2>
            <p>同类型模型按优先级自动选择；不可用配置会显示阻断原因。</p>
          </div>
          <button
            className="button primary"
            type="button"
            onClick={() => setEditingProvider("new")}
          >
            新增 AI 配置
          </button>
        </div>
        {message && (
          <div className="notice provider-notice" role="status">
            {message}
          </div>
        )}
        <div className="table-wrap provider-table-wrap">
          <table className="repo-table provider-table">
            <colgroup>
              <col className="provider-col-name" />
              <col className="provider-col-kind" />
              <col className="provider-col-model" />
              <col className="provider-col-priority" />
              <col className="provider-col-reasoning" />
              <col className="provider-col-url" />
              <col className="provider-col-status" />
              <col className="provider-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>模型</th>
                <th>优先级</th>
                <th>推理程度</th>
                <th>Base URL</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {orderedProviders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="muted">
                    暂无 AI 配置
                  </td>
                </tr>
              ) : (
                orderedProviders.map((provider) => {
                  const providerBusy = busyAction.startsWith(`${provider.id}:`);
                  const action = busyAction.split(":")[1];
                  return (
                    <tr key={provider.id}>
                      <td
                        className="provider-name-cell provider-truncated-cell"
                        title={provider.name}
                      >
                        {provider.name}
                      </td>
                      <td className="provider-kind-cell">{provider.kind}</td>
                      <td
                        className="provider-model-cell provider-truncated-cell"
                        title={provider.model}
                      >
                        {provider.model}
                      </td>
                      <td className="provider-priority-cell">
                        {provider.priority ?? 100}
                      </td>
                      <td className="provider-reasoning-cell">
                        {provider.kind === "chat"
                          ? reasoningEffortText(provider.reasoningEffort)
                          : "-"}
                      </td>
                      <td
                        className="provider-url-cell"
                        title={provider.baseUrl}
                      >
                        {provider.baseUrl}
                      </td>
                      <td className="provider-status-cell">
                        <div className="tags">
                          <span
                            className={`status ${provider.enabled ? "tracked" : "hidden"}`}
                          >
                            {provider.enabled ? "已启用" : "已停用"}
                          </span>
                          <span
                            className={`status ${providerAvailabilityTone(provider.availabilityStatus)}`}
                          >
                            {providerAvailabilityText(
                              provider.availabilityStatus,
                            )}
                          </span>
                        </div>
                        {provider.unavailableReason && (
                          <div className="muted">
                            原因：{provider.unavailableReason}
                          </div>
                        )}
                        {provider.recoverySuggestion && (
                          <div className="muted">
                            处理建议：{provider.recoverySuggestion}
                          </div>
                        )}
                        {provider.cooldownUntil &&
                          provider.availabilityStatus === "cooldown" && (
                            <div className="muted">
                              冷却至 {formatTime(provider.cooldownUntil)}
                            </div>
                          )}
                      </td>
                      <td className="provider-actions-cell">
                        <div className="action-row wrap">
                          <button
                            className="button"
                            onClick={() => setEditingProvider(provider)}
                            type="button"
                            disabled={providerBusy}
                          >
                            修改
                          </button>
                          <button
                            className="button"
                            onClick={() => patchProvider(provider)}
                            type="button"
                            disabled={providerBusy}
                          >
                            {action === "toggle"
                              ? "处理中"
                              : provider.enabled
                                ? "停用"
                                : "启用"}
                          </button>
                          <button
                            className="button"
                            onClick={() => testProvider(provider)}
                            type="button"
                            disabled={providerBusy}
                          >
                            {action === "test" ? "检测中" : "检测"}
                          </button>
                          {providerRequiresRecovery(provider) && (
                            <button
                              className="button primary"
                              onClick={() => recoverProvider(provider)}
                              type="button"
                              disabled={providerBusy || !provider.enabled}
                            >
                              <RefreshCw
                                className={
                                  action === "recover" ? "spin" : undefined
                                }
                                size={15}
                              />
                              {action === "recover" ? "恢复中" : "检测并恢复"}
                            </button>
                          )}
                          <button
                            className="button"
                            onClick={() => deleteProvider(provider)}
                            type="button"
                            disabled={providerBusy}
                          >
                            {action === "delete" ? "删除中" : "删除"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
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
  apiKeyValue: string;
  model: string;
  dimensions: number;
  priority: number;
  reasoningEffort: NonNullable<AiProvider["reasoningEffort"]>;
  enabled: boolean;
}

function AiProviderDialog({
  provider,
  onClose,
  onSave,
}: {
  provider?: AiProvider;
  onClose: () => void;
  onSave: (input: AiProviderFormValue) => Promise<void>;
}) {
  const [kind, setKind] = useState<"chat" | "embedding">(
    provider?.kind ?? "chat",
  );
  const [name, setName] = useState(provider?.name ?? "OPENAI_CHAT");
  const [baseUrl, setBaseUrl] = useState(
    provider?.baseUrl ?? "https://api.example.com/v1",
  );
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [model, setModel] = useState(provider?.model ?? "chat-model");
  const [dimensions, setDimensions] = useState(provider?.dimensions ?? 1536);
  const [priority, setPriority] = useState(provider?.priority ?? 100);
  const [reasoningEffort, setReasoningEffort] = useState<
    NonNullable<AiProvider["reasoningEffort"]>
  >(provider?.reasoningEffort ?? "default");
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const isEditing = Boolean(provider);

  function switchKind(nextKind: "chat" | "embedding") {
    setKind(nextKind);
    if (!isEditing) {
      setName(nextKind === "chat" ? "OPENAI_CHAT" : "EMBEDDING_MODEL");
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
        apiKeyValue,
        model,
        dimensions,
        priority,
        reasoningEffort,
        enabled,
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
          <button
            className="button icon"
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>
        <div className="form-grid provider-dialog-grid">
          {message && (
            <div className="notice" role="status">
              {message}
            </div>
          )}
          <Field label="类型">
            <select
              className="select"
              value={kind}
              disabled={isEditing}
              onChange={(event) =>
                switchKind(event.target.value as "chat" | "embedding")
              }
            >
              <option value="chat">chat</option>
              <option value="embedding">embedding</option>
            </select>
          </Field>
          <Field label="名称">
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Base URL">
            <input
              className="input"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Field>
          <Field label={isEditing ? "新 API Key（可不填）" : "API Key"}>
            <input
              className="input"
              type="password"
              value={apiKeyValue}
              onChange={(event) => setApiKeyValue(event.target.value)}
            />
          </Field>
          <p className="field-hint">
            模型名称同时作为 API Key 名称；名称变化时需要重新填写该模型的 API
            Key。名称需包含英文字母、数字或下划线。
          </p>
          <Field label="模型">
            <input
              className="input"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </Field>
          <Field label="优先级">
            <input
              className="input"
              type="number"
              min={1}
              max={10000}
              step={1}
              value={priority}
              onChange={(event) => setPriority(Number(event.target.value))}
              required
            />
          </Field>
          {kind === "chat" && (
            <Field label="推理程度">
              <select
                className="select"
                value={reasoningEffort}
                onChange={(event) =>
                  setReasoningEffort(
                    event.target.value as NonNullable<
                      AiProvider["reasoningEffort"]
                    >,
                  )
                }
              >
                <option value="default">默认</option>
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
              </select>
            </Field>
          )}
          {kind === "embedding" && (
            <Field label="向量维度">
              <input
                className="input"
                type="number"
                min={1}
                value={dimensions}
                onChange={(event) => setDimensions(Number(event.target.value))}
              />
            </Field>
          )}
          <label className="field checkbox-field">
            <span>状态</span>
            <span className="checkbox-row">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              启用
            </span>
          </label>
          <div className="form-actions">
            <button className="button" type="button" onClick={onClose}>
              关闭
            </button>
            <button
              className="button primary"
              type="submit"
              disabled={isSaving || priority < 1 || priority > 10000}
            >
              {isSaving && <RefreshCw className="spin" size={15} />}
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
  onSyncsChanged,
}: {
  recommendations: Recommendation[];
  syncs: KnowledgeSync[];
  onSyncsChanged: (syncs: KnowledgeSync[]) => void;
}) {
  const [message, setMessage] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [target, setTarget] = useState("local-derived-index");
  const [minScore, setMinScore] = useState(0.8);
  const candidates = recommendations.filter(
    (item) =>
      recommendationPreferenceStatus(item) === "liked" ||
      recommendationIsTracked(item) ||
      [
        "pending_validation",
        "validating",
        "validated",
        "monetization_ready",
      ].includes(recommendationOpportunityStage(item)) ||
      item.scores.final >= minScore,
  );

  async function runSync() {
    setIsSyncing(true);
    try {
      const response = await fetch("/api/knowledge-syncs/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, minScore }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(body.error ?? "知识库同步失败。");
        return;
      }

      const syncResponse = await fetch("/api/knowledge-syncs");
      if (syncResponse.ok) onSyncsChanged(await syncResponse.json());
      setMessage(
        `同步完成：新增 ${body.syncedCount}，跳过 ${body.skippedCount}，失败 ${body.failedCount ?? 0}。`,
      );
    } finally {
      setIsSyncing(false);
    }
  }

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <h2>知识库同步</h2>
            <p>当前作为可选派生能力，fetchGithub 仍是发现结果和评分来源。</p>
          </div>
          <div className="action-row wrap">
            <select
              className="select"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="local-derived-index">本地派生索引</option>
              <option value="ai-knowledge-base">ai-knowledge-base</option>
            </select>
            <input
              className="input compact-input"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={minScore}
              onChange={(event) => setMinScore(Number(event.target.value))}
            />
            <button
              className="button primary"
              type="button"
              disabled={isSyncing}
              onClick={runSync}
            >
              {isSyncing ? <RefreshCw size={15} /> : <Database size={15} />}
              同步 L4
            </button>
          </div>
        </div>
        <div className="list-panel">
          {message && <div className="notice">{message}</div>}
          <div className="row-item">
            <strong>同步范围</strong>
            <span className="muted">
              L4 项目：已喜欢、已跟踪，或最终分数不低于{" "}
              {Math.round(minScore * 100)}。
            </span>
          </div>
          <div className="row-item">
            <strong>当前目标</strong>
            <span className="muted">
              {target === "ai-knowledge-base"
                ? "写入同级 ai-knowledge-base 派生文档目录"
                : "仅记录 fetchGithub 派生索引状态"}
            </span>
          </div>
          <div className="row-item">
            <strong>当前候选数量</strong>
            <span className="muted">{candidates.length}</span>
          </div>
          <div className="row-item">
            <strong>已记录同步状态</strong>
            <span className="muted">{syncs.length}</span>
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <h2>待同步项目</h2>
            <p>生成 L4 Markdown、按 content hash 去重，并记录同步状态。</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="repo-table">
            <thead>
              <tr>
                <th>项目</th>
                <th>分数</th>
                <th>状态</th>
                <th>GitHub</th>
              </tr>
            </thead>
            <tbody>
              {candidates.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    暂无 L4 候选项目
                  </td>
                </tr>
              ) : (
                candidates.map((item) => (
                  <tr key={item.id}>
                    <td>{item.repo.fullName}</td>
                    <td>{Math.round(item.scores.final * 100)}</td>
                    <td>
                      {preferenceStatusText(
                        recommendationPreferenceStatus(item),
                      )}
                      {" / "}
                      {opportunityStageText(
                        recommendationOpportunityStage(item),
                      )}
                    </td>
                    <td>
                      <a
                        className="repo-link"
                        href={item.repo.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        打开 <ExternalLink size={14} />
                      </a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <div className="panel-header">
          <div className="panel-title">
            <h2>同步记录</h2>
            <p>后续接入 ai-knowledge-base 或 FastGPT 时沿用这些状态。</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="repo-table">
            <thead>
              <tr>
                <th>项目</th>
                <th>目标</th>
                <th>状态</th>
                <th>同步时间</th>
                <th>错误</th>
              </tr>
            </thead>
            <tbody>
              {syncs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    暂无同步记录
                  </td>
                </tr>
              ) : (
                syncs.map((sync) => (
                  <tr key={sync.id}>
                    <td>{sync.repoFullName ?? sync.repoId}</td>
                    <td>{sync.target}</td>
                    <td>{sync.status}</td>
                    <td>{sync.syncedAt ? formatTime(sync.syncedAt) : "-"}</td>
                    <td className="muted">{sync.errorMessage ?? "-"}</td>
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

function OperationsPanel({
  operations,
  queueStats,
  onRefresh,
}: {
  operations: DashboardSnapshot["operations"];
  queueStats: DashboardSnapshot["queueStats"];
  onRefresh: () => Promise<void>;
}) {
  const [dismissedAlerts, setDismissedAlerts] = useState<string[]>(() =>
    readDismissedOperationAlerts(),
  );
  const alerts = buildOperationAlerts(operations, queueStats).filter(
    (alert) => !dismissedAlerts.includes(alert.id),
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
          <button
            className="button"
            type="button"
            onClick={() => void onRefresh()}
          >
            <RefreshCw size={15} />
            刷新
          </button>
        </div>
        <div className="summary-grid inline-summary">
          <SummaryTile
            icon={Activity}
            label="资源事件"
            value={operations.resourceEvents.length}
          />
          <SummaryTile
            icon={Brain}
            label="AI 作业"
            value={operations.aiCostSummary.totalJobs}
          />
          <SummaryTile
            icon={Database}
            label="Token 用量"
            value={formatTokenTotal(
              operations.aiCostSummary.totalTokens,
              operations.aiCostSummary.unknownJobCount,
            )}
          />
          <SummaryTile
            icon={BarChart3}
            label="估算成本 USD"
            value={formatUsd(operations.aiCostSummary.estimatedCostUsd)}
          />
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

      <CollapsiblePanel
        title="资源调节事件"
        subtitle="ResourceGovernor 记录的批量大小和内存状态。"
      >
        <div className="table-wrap module-scroll">
          <table className="repo-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>任务</th>
                <th>阶段</th>
                <th>状态</th>
                <th>可用 MB</th>
                <th>RSS MB</th>
                <th>批量</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {operations.resourceEvents.length === 0 ? (
                <tr>
                  <td colSpan={8} className="muted">
                    暂无资源事件
                  </td>
                </tr>
              ) : (
                operations.resourceEvents.map((event) => (
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
                ))
              )}
            </tbody>
          </table>
        </div>
      </CollapsiblePanel>

      <CollapsiblePanel
        title="AI 作业与成本"
        subtitle="成本按 provider 可选 pricing 配置估算；未配置价格时为 0。"
      >
        <div className="table-wrap module-scroll">
          <table className="repo-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>项目</th>
                <th>Provider</th>
                <th>模型</th>
                <th>状态</th>
                <th>Prompt</th>
                <th>Completion</th>
                <th>成本</th>
              </tr>
            </thead>
            <tbody>
              {operations.aiJobs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="muted">
                    暂无 AI 作业
                  </td>
                </tr>
              ) : (
                operations.aiJobs.map((job) => (
                  <tr key={job.id}>
                    <td>{formatTime(job.createdAt)}</td>
                    <td>{job.repoFullName ?? job.repoId}</td>
                    <td>{job.providerName ?? job.providerId}</td>
                    <td>{job.model}</td>
                    <td title={job.errorMessage ?? undefined}>
                      <span className={`status ${job.status}`}>
                        {job.status}
                      </span>
                    </td>
                    <td>
                      {formatTokenValue(job.promptTokens, job.tokenUsageKnown)}
                    </td>
                    <td>
                      {formatTokenValue(
                        job.completionTokens,
                        job.tokenUsageKnown,
                      )}
                    </td>
                    <td>
                      {job.tokenUsageKnown
                        ? formatUsd(job.estimatedCostUsd)
                        : "未知"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </CollapsiblePanel>

      <CollapsiblePanel
        title="失败原因"
        subtitle="最近失败的 AI 作业和候选队列原因，便于直接定位配置、限流或模型响应问题。"
      >
        <FailureReasonsTable operations={operations} queueStats={queueStats} />
      </CollapsiblePanel>

      <CollapsiblePanel
        title="项目 Token 汇总"
        subtitle="按项目汇总最近 AI 分析 token，用于识别高消耗仓库。"
      >
        <TokenSummaryTable
          rows={operations.repoTokenSummary}
          emptyText="暂无项目 Token 统计"
        />
      </CollapsiblePanel>

      <CollapsiblePanel
        title="扫描 Token 汇总"
        subtitle="按扫描任务汇总最近 AI 分析 token，用于查看单次扫描总消耗。"
      >
        <TokenSummaryTable
          rows={operations.scanTokenSummary}
          emptyText="暂无扫描 Token 统计"
        />
      </CollapsiblePanel>

      <CollapsiblePanel
        title="候选队列"
        subtitle="扫描任务在各阶段的待处理、运行和重试数量。"
      >
        <SimpleStatsTable
          rows={queueStats.map((stat) => [
            stat.stage,
            stat.status,
            String(stat.count),
          ])}
          rowTitles={queueStats.map(
            (stat) => stat.failureReasons?.join("\n") ?? "",
          )}
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
  defaultOpen = true,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="panel collapsible-panel">
      <button
        className="panel-header collapsible-header"
        type="button"
        onClick={() => setOpen(!open)}
      >
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
  tone,
  disabled = false,
  loading = false,
}: {
  title: string;
  icon: React.ComponentType<{ size?: number }>;
  onClick: () => void;
  active?: boolean;
  tone?: "positive" | "danger";
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      className={`button icon ${active ? "active" : ""} ${active && tone ? tone : ""}`}
      title={title}
      aria-label={title}
      onClick={onClick}
      type="button"
      disabled={disabled}
      aria-busy={loading}
    >
      {loading ? <RefreshCw className="spin" size={15} /> : <Icon size={15} />}
    </button>
  );
}

function TagList({ items }: { items: string[] }) {
  return (
    <div className="tags">
      {items.filter(Boolean).map((item, index) => (
        <span className="tag" key={`${item}-${index}`}>
          {item}
        </span>
      ))}
    </div>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="detail-section">
      <h3>{title}</h3>
      <p>{children}</p>
    </section>
  );
}

function ListSection({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="detail-section">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p>暂无</p>
      ) : (
        <ul>
          {items.map((item, index) => (
            <li key={`${item}-${index}`}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ChecklistSection({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
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
    `规则分：${Math.round(recommendation.scores.rule * 100)}，上下文分：${Math.round(recommendation.scores.githubContextFit * 100)}，LLM 分：${Math.round(recommendation.scores.llmMatch * 100)}`,
    ...buildQualitySignalItems(recommendation),
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
        : "",
    ].filter(Boolean);
    if (usages.length) {
      items.push(`ecosyste.ms：${usages.join("，")}`);
    }
  }

  return items;
}

type RecommendationStatusFilter =
  "visible" | "all" | "saved" | "hidden" | "tracked";

type OpportunityFilter =
  | "all"
  | Recommendation["opportunityStatus"]
  | Recommendation["opportunityStage"];
type GroupFilter = "all" | "grouped" | "ungrouped";
type PreferenceFilter = "all" | Recommendation["preferenceStatus"];
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

const recommendationStatusFilterOptions: Array<{
  value: RecommendationStatusFilter;
  label: string;
}> = [
  { value: "visible", label: "可见项目" },
  { value: "all", label: "全部项目" },
  { value: "saved", label: "已收藏" },
  { value: "tracked", label: "重点跟踪" },
  { value: "hidden", label: "已隐藏" },
];

const opportunityFilterOptions: Array<{
  value: OpportunityFilter;
  label: string;
}> = [
  { value: "all", label: "全部机会" },
  { value: "qualified", label: "符合机会条件" },
  { value: "unassessed", label: "待评估" },
  { value: "not_qualified", label: "不符合条件" },
  { value: "observing", label: "观察中" },
  { value: "pending_validation", label: "待验证" },
  { value: "validating", label: "验证中" },
  { value: "validated", label: "已验证" },
  { value: "monetization_ready", label: "准备变现" },
  { value: "abandoned", label: "已放弃" },
];

const groupFilterOptions: Array<{ value: GroupFilter; label: string }> = [
  { value: "all", label: "全部分组" },
  { value: "grouped", label: "已分组" },
  { value: "ungrouped", label: "未分组" },
];

const preferenceFilterOptions: Array<{
  value: PreferenceFilter;
  label: string;
}> = [
  { value: "all", label: "全部喜好" },
  { value: "liked", label: "已喜欢" },
  { value: "disliked", label: "不喜欢" },
  { value: "pending", label: "待定" },
];

function recommendationMatchesOpportunity(
  recommendation: Recommendation,
  filter: OpportunityFilter,
) {
  if (filter === "all") {
    return true;
  }
  return (
    recommendationOpportunityStatus(recommendation) === filter ||
    recommendationOpportunityStage(recommendation) === filter
  );
}

function recommendationMatchesGroup(
  recommendation: Recommendation,
  filter: GroupFilter,
  focusedClusterKey: string,
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
  filter: RecommendationStatusFilter,
) {
  if (filter === "all") {
    return true;
  }
  if (filter === "visible") {
    return !recommendationIsHidden(recommendation);
  }
  if (filter === "hidden") {
    return recommendationIsHidden(recommendation);
  }
  if (filter === "saved") {
    return recommendationIsSaved(recommendation);
  }
  return recommendationIsTracked(recommendation);
}

function recommendationMatchesPreference(
  recommendation: Recommendation,
  filter: PreferenceFilter,
) {
  if (filter === "all") {
    return true;
  }
  return recommendationPreferenceStatus(recommendation) === filter;
}

function compareRecommendations(
  left: Recommendation,
  right: Recommendation,
  sortState: RecommendationSortState,
  semanticScores: Record<string, number>,
) {
  const rankFallback = left.rank - right.rank;
  const direction = sortState.direction === "asc" ? 1 : -1;
  switch (sortState.key) {
    case "score":
      return (
        direction * (left.scores.final - right.scores.final) || rankFallback
      );
    case "stars":
      return direction * (left.repo.stars - right.repo.stars) || rankFallback;
    case "semantic":
      return (
        direction *
          ((semanticScores[left.id] ?? 0) - (semanticScores[right.id] ?? 0)) ||
        rankFallback
      );
    case "rank":
      return direction * (left.rank - right.rank) || rankFallback;
  }
}

function renderSortIcon(
  sortState: RecommendationSortState,
  key: RecommendationSortKey,
) {
  if (sortState.key !== key) {
    return <ArrowUpDown size={14} />;
  }
  return sortState.direction === "asc" ? (
    <ArrowUp size={14} />
  ) : (
    <ArrowDown size={14} />
  );
}

const DISMISSED_OPERATION_ALERTS_KEY = "fetchGithub:dismissedOperationAlerts";

function readDismissedOperationAlerts() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(DISMISSED_OPERATION_ALERTS_KEY) ?? "[]",
    );
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function writeDismissedOperationAlerts(ids: string[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    DISMISSED_OPERATION_ALERTS_KEY,
    JSON.stringify(ids),
  );
}

function buildOperationAlerts(
  operations: DashboardSnapshot["operations"],
  queueStats: DashboardSnapshot["queueStats"],
) {
  const alerts: Array<{
    id: string;
    level: "warning" | "danger";
    text: string;
  }> = [];
  const failedAiJobs = operations.aiJobs.filter(
    (job) => job.status === "failed",
  );
  const retryQueue = queueStats
    .filter((stat) => stat.status === "failed" || stat.status === "pending")
    .filter((stat) => stat.stage === "llm" || stat.stage === "embed");
  const pressureEvents = operations.resourceEvents.filter(
    (event) =>
      event.status === "paused_by_memory" || event.status === "throttled",
  );
  const rateLimitJobs = operations.aiJobs.filter((job) =>
    `${job.providerName ?? ""} ${job.model} ${job.status}`
      .toLowerCase()
      .includes("rate"),
  );

  if (pressureEvents.length > 0) {
    alerts.push({
      id: "resource-pressure",
      level: pressureEvents.some((event) => event.status === "paused_by_memory")
        ? "danger"
        : "warning",
      text: `资源调节触发 ${pressureEvents.length} 次，最近一次：${pressureEvents[0].reason}`,
    });
  }
  if (failedAiJobs.length > 0) {
    alerts.push({
      id: "ai-job-failed",
      level: "danger",
      text: `最近有 ${failedAiJobs.length} 个 AI 作业失败，请检查 provider、API key 或模型响应。`,
    });
  }
  if (rateLimitJobs.length > 0) {
    alerts.push({
      id: "rate-limit",
      level: "warning",
      text: `检测到疑似 rate limit，请降低批量或调整 provider 限速配置。`,
    });
  }
  for (const stat of retryQueue.slice(0, 3)) {
    if (stat.count > 0) {
      alerts.push({
        id: `queue-${stat.stage}-${stat.status}`,
        level: stat.status === "failed" ? "danger" : "warning",
        text: `${stat.stage} 阶段 ${stat.status} 队列还有 ${stat.count} 个候选。`,
      });
    }
  }

  return alerts.slice(0, 5);
}

function legacyStatusFromFeedbackAction(
  action: FeedbackAction,
  fallback: Recommendation["status"],
): Recommendation["status"] {
  switch (action) {
    case "save":
      return "saved";
    case "unsave":
      return fallback === "saved" ? "viewed" : fallback;
    case "hide":
      return "hidden";
    case "restore":
      return "viewed";
    case "track":
      return "tracked";
    case "untrack":
      return fallback === "tracked" ? "viewed" : fallback;
    case "to_validate":
      return "to_validate";
    case "validating":
      return "validating";
    case "mark_validated":
      return "validating";
    case "mark_qualified":
    case "mark_not_qualified":
    case "reset_qualification":
      return fallback;
    case "monetization_ready":
      return "monetization_ready";
    case "abandon":
      return "abandoned";
    case "reopen":
      return fallback === "abandoned" ? "viewed" : fallback;
    case "like":
    case "set_liked":
      return "liked";
    case "dislike":
    case "set_disliked":
      return "disliked";
    case "set_pending":
      return fallback === "liked" || fallback === "disliked"
        ? "viewed"
        : fallback;
  }
}

function applyRecommendationFeedback(
  recommendation: Recommendation,
  action: FeedbackAction,
): Recommendation {
  const now = new Date().toISOString();
  const next: Recommendation = {
    ...recommendation,
    status: legacyStatusFromFeedbackAction(action, recommendation.status),
  };
  switch (action) {
    case "like":
    case "set_liked":
      return { ...next, preferenceStatus: "liked" };
    case "dislike":
    case "set_disliked":
      return { ...next, preferenceStatus: "disliked" };
    case "set_pending":
      return { ...next, preferenceStatus: "pending" };
    case "save":
      return { ...next, savedAt: now };
    case "unsave":
      return { ...next, savedAt: undefined };
    case "hide":
      return { ...next, hiddenAt: now };
    case "restore":
      return { ...next, hiddenAt: undefined };
    case "track":
      return { ...next, trackedAt: now };
    case "untrack":
      return { ...next, trackedAt: undefined };
    case "to_validate":
      return { ...next, opportunityStage: "pending_validation" };
    case "validating":
      return { ...next, opportunityStage: "validating" };
    case "mark_validated":
      return { ...next, opportunityStage: "validated" };
    case "mark_qualified":
      return { ...next, opportunityStatus: "qualified" };
    case "mark_not_qualified":
      return { ...next, opportunityStatus: "not_qualified" };
    case "reset_qualification":
      return { ...next, opportunityStatus: "unassessed" };
    case "monetization_ready":
      return { ...next, opportunityStage: "monetization_ready" };
    case "abandon":
      return { ...next, opportunityStage: "abandoned" };
    case "reopen":
      return { ...next, opportunityStage: "observing" };
  }
}

function recommendationPreferenceStatus(recommendation: Recommendation) {
  if (recommendation.preferenceStatus) return recommendation.preferenceStatus;
  if (recommendation.status === "liked") return "liked";
  if (recommendation.status === "disliked") return "disliked";
  return "pending";
}

function recommendationOpportunityStatus(recommendation: Recommendation) {
  if (recommendation.opportunityStatus) return recommendation.opportunityStatus;
  return recommendation.opportunity ? "qualified" : "unassessed";
}

function recommendationOpportunityStage(recommendation: Recommendation) {
  if (recommendation.opportunityStage) return recommendation.opportunityStage;
  switch (recommendation.status) {
    case "to_validate":
      return "pending_validation";
    case "validating":
      return "validating";
    case "monetization_ready":
      return "monetization_ready";
    case "abandoned":
      return "abandoned";
    default:
      return "observing";
  }
}

function recommendationIsSaved(recommendation: Recommendation) {
  return Boolean(recommendation.savedAt) || recommendation.status === "saved";
}

function recommendationIsHidden(recommendation: Recommendation) {
  return Boolean(recommendation.hiddenAt) || recommendation.status === "hidden";
}

function recommendationIsTracked(recommendation: Recommendation) {
  return (
    Boolean(recommendation.trackedAt) || recommendation.status === "tracked"
  );
}

function recommendationCollectionStateText(recommendation: Recommendation) {
  const states = [
    recommendationIsSaved(recommendation) ? "已收藏" : "未收藏",
    recommendationIsTracked(recommendation) ? "已跟踪" : "未跟踪",
    recommendationIsHidden(recommendation) ? "已隐藏" : "展示中",
  ];
  return states.join("；");
}

function preferenceStatusText(status: Recommendation["preferenceStatus"]) {
  return status === "liked"
    ? "喜欢"
    : status === "disliked"
      ? "不喜欢"
      : "待定";
}

function preferenceStatusTone(status: Recommendation["preferenceStatus"]) {
  return status === "liked"
    ? "tracked"
    : status === "disliked"
      ? "hidden"
      : "new";
}

function opportunityStatusText(status: Recommendation["opportunityStatus"]) {
  if (status === "qualified") return "符合条件";
  if (status === "not_qualified") return "不符合条件";
  return "待评估";
}

function opportunityStatusTone(status: Recommendation["opportunityStatus"]) {
  return status === "qualified"
    ? "tracked"
    : status === "not_qualified"
      ? "hidden"
      : "new";
}

function opportunityStageText(status: Recommendation["opportunityStage"]) {
  switch (status) {
    case "observing":
      return "观察中";
    case "pending_validation":
      return "待验证";
    case "validating":
      return "验证中";
    case "validated":
      return "已验证";
    case "monetization_ready":
      return "准备变现";
    case "abandoned":
      return "已放弃";
  }
}

function opportunityStageTone(status: Recommendation["opportunityStage"]) {
  return status === "abandoned"
    ? "hidden"
    : status === "observing"
      ? "new"
      : "tracked";
}

function splitCsv(value: string) {
  return value
    .split(/[,，]/)
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
        const [language, rawWeight] = item
          .split(":")
          .map((part) => part.trim());
        return [language, Number(rawWeight ?? 1)];
      })
      .filter(
        ([language, weight]) => language && Number.isFinite(weight as number),
      ),
  ) as Record<string, number>;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function SimpleStatsTable({
  rows,
  rowTitles = [],
  emptyText,
}: {
  rows: string[][];
  rowTitles?: string[];
  emptyText: string;
}) {
  return (
    <div className="table-wrap">
      <table className="repo-table">
        <thead>
          <tr>
            <th>阶段</th>
            <th>状态</th>
            <th>数量</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={3} className="muted">
                {emptyText}
              </td>
            </tr>
          ) : (
            rows.map((row, rowIndex) => (
              <tr key={row.join("-")} title={rowTitles[rowIndex] || undefined}>
                {row.map((cell, index) => (
                  <td key={index}>{cell}</td>
                ))}
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
  emptyText,
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
            <tr>
              <td colSpan={7} className="muted">
                {emptyText}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id}>
                <td>{row.label}</td>
                <td>{row.jobCount}</td>
                <td>{row.promptTokens.toLocaleString()}</td>
                <td>{row.completionTokens.toLocaleString()}</td>
                <td>{row.totalTokens.toLocaleString()}</td>
                <td>
                  {row.unknownJobCount > 0
                    ? `${row.unknownJobCount} 个作业`
                    : "-"}
                </td>
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
  queueStats,
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
        reason: job.errorMessage ?? "",
      })),
    ...queueStats
      .filter((stat) => (stat.failureReasons?.length ?? 0) > 0)
      .flatMap((stat) =>
        (stat.failureReasons ?? []).map((reason, index) => ({
          id: `queue-${stat.stage}-${stat.status}-${index}`,
          type: "候选队列",
          target: `${stat.stage}/${stat.status}`,
          status: `${stat.count} 个`,
          reason,
        })),
      ),
  ].slice(0, 50);

  return (
    <div className="table-wrap module-scroll">
      <table className="repo-table">
        <thead>
          <tr>
            <th>类型</th>
            <th>对象</th>
            <th>状态</th>
            <th>原因</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="muted">
                暂无失败原因
              </td>
            </tr>
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
  return [
    "paused_by_user",
    "paused_by_memory",
    "paused_by_runtime",
    "retry_later",
    "exception",
  ].includes(status);
}

function canCompleteJob(status: string) {
  return [
    "paused_by_user",
    "paused_by_memory",
    "paused_by_runtime",
    "retry_later",
  ].includes(status);
}

function canArchiveJob(status: string) {
  return ["completed", "failed", "exception"].includes(status);
}

function missedRunPolicyText(
  policy: DiscoveryProfile["config"]["schedule"]["missedRunPolicy"],
) {
  if (policy === "run_once") return "恢复后补跑一次";
  if (policy === "resume") return "恢复未完成进度";
  return "跳过漏跑周期";
}

function reasoningEffortText(value: AiProvider["reasoningEffort"]) {
  return value && value !== "default" ? value : "默认";
}

function providerAvailabilityText(status?: AiProvider["availabilityStatus"]) {
  switch (status) {
    case "available":
      return "可用";
    case "cooldown":
      return "冷却中";
    case "blocked_auth":
      return "认证阻断";
    case "blocked_permission":
      return "权限阻断";
    case "invalid_config":
      return "配置无效";
    case "recovering":
      return "恢复检测中";
    default:
      return "可用";
  }
}

function providerAvailabilityTone(status?: AiProvider["availabilityStatus"]) {
  return !status || status === "available"
    ? "tracked"
    : status === "cooldown" || status === "recovering"
      ? "new"
      : "hidden";
}

function providerRequiresRecovery(provider: AiProvider) {
  return [
    "blocked_auth",
    "blocked_permission",
    "invalid_config",
    "cooldown",
  ].includes(provider.availabilityStatus);
}

function readApiError(body: unknown, fallback: string) {
  if (!body || typeof body !== "object") return fallback;
  const candidate = body as {
    error?: unknown;
    errorMessage?: unknown;
    message?: unknown;
    details?: unknown;
  };
  for (const value of [
    candidate.errorMessage,
    candidate.error,
    candidate.message,
    candidate.details,
  ]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    hour12: false,
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

function sectionTitle(section: Section) {
  return sectionLabel(section);
}

function sectionSubtitle(section: Section) {
  switch (section) {
    case "recommendations":
      return "从候选队列中找到值得判断、跟踪或验证的项目。";
    case "profiles":
      return "定义要找什么、排除什么，以及如何运行发现策略。";
    case "jobs":
      return "追踪发现进度、checkpoint、限速与恢复状态。";
    case "github":
      return "选择用于个性化推荐的账号、仓库和上下文。";
    case "providers":
      return "管理分析模型与 Embedding 服务的连接和用量。";
    case "knowledge":
      return "把高价值发现整理为可检索的知识资产。";
    case "operations":
      return "检查资源压力、队列积压、AI 作业与成本。";
  }
}
