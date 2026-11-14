import type { KernelClient } from "../../core/KernelClient.js";

interface Entry { name: string; isDir: boolean; isSymlink: boolean }
const idPattern = /^\d{14}-[a-z0-9]{7}$/;
export async function ordinaryAssetLocations(k: KernelClient, paths: readonly string[], signal?: AbortSignal): Promise<Record<string, string>> {
  if (!paths.length) return {};
  const books = (await k.post<unknown>("/api/notebook/lsNotebooks", {}, { signal })).data;
  if (!books || typeof books !== "object" || !Array.isArray((books as any).notebooks)) throw new Error("Notebook inventory unavailable");
  const ids = new Set<string>();
  for (const b of (books as any).notebooks) {
    if (!b || typeof b.id !== "string" || !idPattern.test(b.id) || b.closed || b.encrypted) throw new Error("Only open ordinary notebooks can be scanned");
    ids.add(b.id);
  }
  const cache = new Map<string, Entry[]>();
  const list = async (path: string): Promise<Entry[]> => {
    if (cache.has(path)) return cache.get(path)!;
    if (cache.size > 5000) throw new Error("Resource directory scan limit reached");
    const rows = (await k.post<unknown>("/api/file/readDir", { path }, { signal })).data;
    if (!Array.isArray(rows)) throw new Error("Directory response unavailable");
    const entries = rows.map((r: any) => {
      if (!r || typeof r.name !== "string" || typeof r.isDir !== "boolean" || typeof r.isSymlink !== "boolean" || /[\/\\\0]/.test(r.name)) throw new Error("Directory entry cannot be verified");
      return r as Entry;
    }); cache.set(path, entries); return entries;
  };
  const data = await list("/data"), roots: string[] = [];
  if (data.some(e => e.name === "assets")) {
    const e = data.find(e => e.name === "assets")!; if (!e.isDir || e.isSymlink) throw new Error("Global assets directory is ambiguous"); roots.push("/data/assets");
  }
  const pending = data.filter(e => idPattern.test(e.name) && e.isDir).map(e => { if (!ids.has(e.name) || e.isSymlink) throw new Error("Unaccounted notebook directory"); return `/data/${e.name}`; });
  for (let i = 0; i < pending.length; i++) for (const e of await list(pending[i])) {
    if (!e.isDir) continue;
    if (e.name === "assets") { if (e.isSymlink) throw new Error("Symlinked assets directory"); roots.push(`${pending[i]}/assets`); }
    else if (idPattern.test(e.name)) { if (e.isSymlink) throw new Error("Symlinked document directory"); pending.push(`${pending[i]}/${e.name}`); }
  }
  const result: Record<string,string> = {};
  for (const raw of new Set(paths)) {
    if (!raw.startsWith("assets/") || /[?#\\]/.test(raw)) throw new Error("Nonordinary asset path");
    const parts = raw.slice(7).split("/").map(p => decodeURIComponent(p));
    if (parts.some(p => !p || p === "." || p === ".." || /[\/\\\0]/.test(p))) throw new Error("Invalid asset segment");
    const found: string[] = [];
    for (const root of roots) {
      let dir = root, exists = true;
      for (let i=0;i<parts.length;i++) {
        const matches = (await list(dir)).filter(e => e.name.toLowerCase() === parts[i].toLowerCase());
        if (!matches.length) { exists = false; break; }
        if (matches.length !== 1 || matches[0].name !== parts[i] || matches[0].isSymlink || matches[0].isDir === (i === parts.length-1)) throw new Error("Asset identity is ambiguous");
        dir += `/${parts[i]}`;
      }
      if (exists) found.push(dir);
    }
    if (found.length !== 1) throw new Error("Asset missing or ambiguous across physical directories"); result[raw] = found[0];
  }
  return result;
}
