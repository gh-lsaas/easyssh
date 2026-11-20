export type Edge = 'left' | 'right' | 'top' | 'bottom';
export type PaneTree = { kind: 'pane'; session: string } | { kind: 'split'; axis: 'row' | 'column'; ratio: number; first: PaneTree; second: PaneTree };
export function paneIds(tree: PaneTree | null): string[] {
  if (!tree) return [];
  return tree.kind === 'pane' ? [tree.session] : [...paneIds(tree.first), ...paneIds(tree.second)];
}
export function removePane(tree: PaneTree | null, id: string): PaneTree | null {
  if (!tree) return null;
  if (tree.kind === 'pane') return tree.session === id ? null : tree;
  const first = removePane(tree.first, id), second = removePane(tree.second, id);
  return first && second ? {...tree, first, second} : first ?? second;
}
export function replacePane(tree: PaneTree, target: string, session: string): PaneTree {
  if (tree.kind === 'pane') return tree.session === target ? {kind:'pane', session} : tree;
  return {...tree, first:replacePane(tree.first, target, session), second:replacePane(tree.second, target, session)};
}
export function splitPane(tree: PaneTree | null, source: string, target: string, edge: Edge): PaneTree | null {
  if (!tree || source === target || !paneIds(tree).includes(target)) return tree;
  const base = removePane(tree, source)!;
  const visit = (node: PaneTree): PaneTree => {
    if (node.kind === 'split') return {...node, first:visit(node.first), second:visit(node.second)};
    if (node.session !== target) return node;
    const incoming: PaneTree = {kind:'pane', session:source};
    const before = edge === 'left' || edge === 'top';
    return {kind:'split', axis:edge === 'left' || edge === 'right' ? 'row' : 'column', ratio:0.5, first:before ? incoming : node, second:before ? node : incoming};
  };
  return visit(base);
}
export function reorderIds(ids: string[], source: string, target: string | null, after: boolean): string[] {
  if (!ids.includes(source) || source === target || (target !== null && !ids.includes(target))) return ids;
  const result = ids.filter(id => id !== source);
  result.splice(target === null ? result.length : result.indexOf(target) + (after ? 1 : 0), 0, source);
  return result;
}
