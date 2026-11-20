// Ignore overlapping clipboard triggers while a read or confirmation is pending.
export function exclusiveAction() {
  let busy = false;
  return async (action: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try { await action(); } finally { busy = false; }
  };
}
export function clipboardShortcut(e: {key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean}): 'copy' | 'paste' | null {
  if (e.altKey) return null;
  const modifier = e.ctrlKey || e.metaKey;
  if (modifier && e.shiftKey && e.key.toLowerCase() === 'c') return 'copy';
  if ((modifier && e.key.toLowerCase() === 'v') || (e.shiftKey && e.key === 'Insert')) return 'paste';
  return null;
}
