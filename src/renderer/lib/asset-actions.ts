import type { AssetImportResult, AssetInventory } from '@shared/types';
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

export async function trashAsset(docPath: string, assetPath: string): Promise<void> {
  await pipeline.dispatch('asset.trash', { docPath, assetPath });
}

export async function adoptAsset(docPath: string, source: string): Promise<AssetImportResult> {
  return pipeline.dispatch('asset.adopt', { docPath, source }) as Promise<AssetImportResult>;
}

export function markdownForAsset(asset: AssetImportResult | AssetInventory['assets'][number]): string {
  const label = asset.name
    .replace(/--[a-f\d]{12,64}(?=\.[^.]+$)/i, '')
    .replace(/\.[^.]+$/, '');
  return asset.kind === 'image'
    ? `![${label}](${asset.markdownUrl})`
    : `[${label}](${asset.markdownUrl})`;
}
