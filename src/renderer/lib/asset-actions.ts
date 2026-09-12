import type { AssetImportResult, AssetInventory, AssociatedPathEntry } from '@shared/types';
import { CHANNELS } from '@shared/protocol';
import { pipeline } from '@renderer/cpu';
import { projectScopeState, sameProjectScope } from '@renderer/stores/project-scope-state';

export async function listAssets(docPath: string): Promise<AssetInventory> {
  const scope = projectScopeState.get();
  if (!scope) throw new Error('[asset:list] no active project scope');
  const result = await window.api.invoke<
    { docPath: string; expectedScope: typeof scope },
    AssetInventory
  >(CHANNELS.ASSET_LIST, { docPath, expectedScope: scope });
  if (!sameProjectScope(scope, projectScopeState.get())) {
    throw new Error('[asset:list] stale project response');
  }
  return result;
}

export async function importAsset(docPath: string, file: File): Promise<AssetImportResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return pipeline.dispatch('asset.import', {
    docPath,
    name: file.name,
    mimeType: file.type,
    bytes,
  }) as Promise<AssetImportResult>;
}

export async function addAssociatedPath(docPath: string, targetPath: string): Promise<AssociatedPathEntry> {
  return pipeline.dispatch('asset.link-add', { docPath, targetPath }) as Promise<AssociatedPathEntry>;
}

export async function removeAssociatedPath(docPath: string, targetPath: string): Promise<void> {
  await pipeline.dispatch('asset.link-remove', { docPath, targetPath });
}

export async function openAssociatedPath(docPath: string, targetPath: string): Promise<void> {
  await pipeline.dispatch('shell.open-associated-path', { docPath, targetPath });
}

export async function revealAssociatedPath(docPath: string, targetPath: string): Promise<void> {
  await pipeline.dispatch('shell.reveal-associated-path', { docPath, targetPath });
}

export async function pickAssociatedPath(kind: 'file' | 'directory'): Promise<string | null> {
  return window.api.invoke<{ kind: typeof kind }, string | null>(CHANNELS.DIALOG_PICK_ASSET_PATH, { kind });
}

export function markdownForAsset(asset: AssetImportResult | AssetInventory['assets'][number]): string {
  const label = asset.name.replace(/\.[^.]+$/, '');
  return asset.kind === 'image'
    ? `![${label}](${asset.markdownUrl})`
    : `[${label}](${asset.markdownUrl})`;
}
