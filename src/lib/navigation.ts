export type Section = "recommendations" | "profiles" | "jobs" | "github" | "providers" | "knowledge" | "operations";

export const sectionDefinitions: Array<{ id: Section; path: string; label: string }> = [
  { id: "recommendations", path: "/recommendations", label: "项目推荐" },
  { id: "profiles", path: "/profiles", label: "发现配置" },
  { id: "jobs", path: "/jobs", label: "扫描任务" },
  { id: "github", path: "/github", label: "我的 GitHub" },
  { id: "providers", path: "/providers", label: "AI 模型配置" },
  { id: "knowledge", path: "/knowledge", label: "知识库同步" },
  { id: "operations", path: "/operations", label: "运行观测" }
];

export function sectionFromPath(pathname: string | null): Section | undefined {
  if (!pathname || pathname === "/") {
    return "recommendations";
  }

  const firstSegment = pathname.split("/").filter(Boolean)[0];
  return sectionDefinitions.find((item) => item.path === `/${firstSegment}`)?.id;
}

export function sectionPath(section: Section) {
  return sectionDefinitions.find((item) => item.id === section)?.path ?? "/";
}

export function sectionLabel(section: Section) {
  return sectionDefinitions.find((item) => item.id === section)?.label ?? "fetchGithub";
}
